import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildPrompts, runAgents, freshRunMinimum, DEFAULT_PROCESS_TIMEOUT_MS } from "./run-agents.mjs";

/** The time a fresh run needs left, at the voter time limit tests run with. */
const MIN_FRESH_RUN_MS = freshRunMinimum(DEFAULT_PROCESS_TIMEOUT_MS);
import { summaryRow, WRAP_UP_TIMEOUT_MS } from "./agent-process.mjs";
import { RESULT_FILE_PATTERN, resultFileName } from "./lib.mjs";
import { parseAgentResult } from "../src/index.mjs";

// ── Fake Claude CLI ──────────────────────────────────────────────────────────

function envelope(result, extra = {}) {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result,
    num_turns: 4,
    session_id: "session",
    usage: { cache_read_input_tokens: 900, cache_creation_input_tokens: 100 },
    ...extra,
  });
}

const USABLE = { code: 0, timedOut: false, stdout: envelope("[]"), stderr: "" };
const PROSE = { code: 0, timedOut: false, stdout: envelope("Looks fine to me."), stderr: "" };
const CRASH = { code: 1, timedOut: false, stdout: "", stderr: "boom" };
const CAPPED = {
  code: 1,
  timedOut: false,
  stdout: envelope(undefined, { subtype: "error_max_turns", is_error: true }),
  stderr: "",
};
const TIMED_OUT = { code: 143, timedOut: true, stdout: "", stderr: "" };
const PRIMED = {
  code: 1,
  timedOut: false,
  stdout: envelope(undefined, {
    subtype: "error_max_turns",
    usage: { cache_creation_input_tokens: 5000 },
  }),
  stderr: "",
};

/**
 * A stand-in for `spawnClaude`. Prompts are the agent keys, so each call knows
 * its agent; `respond` picks the result. Records when each call starts and
 * ends on one shared clock, and the most calls ever running at once.
 */
function fakeClaude(respond = () => USABLE) {
  const calls = [];
  let clock = 0;
  let active = 0;
  let peak = 0;
  const runClaude = async ({ args, input, env, timeoutMs }) => {
    const maxTurns = args[args.indexOf("--max-turns") + 1];
    const resume = args.includes("--resume");
    const call = {
      agent: resume ? null : input,
      kind: resume ? "resume" : maxTurns === "1" ? "primer" : "voter",
      env,
      args,
      timeoutMs,
      start: clock++,
    };
    calls.push(call);
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setImmediate(resolve));
    active--;
    call.end = clock++;
    return respond(call, calls);
  };
  return { runClaude, calls, peak: () => peak };
}

function dirs() {
  const root = mkdtempSync(join(tmpdir(), "run-agents-"));
  const resultsDir = join(root, "results");
  const logsDir = join(root, "logs");
  mkdirSync(resultsDir);
  mkdirSync(logsDir);
  return { resultsDir, logsDir };
}

function review(fake, overrides = {}) {
  const agents = overrides.agents ?? [{ key: "bugs", source: "base" }];
  const output = [];
  const { resultsDir, logsDir } = dirs();
  return {
    resultsDir,
    output,
    rows: runAgents({
      agents,
      prompts: Object.fromEntries(agents.map((a) => [a.key, a.key])),
      voters: 3,
      maxTurns: 20,
      model: "claude-sonnet-5",
      provider: "anthropic",
      concurrency: 8,
      memory: null,
      resultsDir,
      logsDir,
      env: { ANTHROPIC_API_KEY: "key" },
      runClaude: fake.runClaude,
      out: (text) => output.push(text),
      ...overrides,
    }),
  };
}

// ── Concurrency ──────────────────────────────────────────────────────────────

test("at most the concurrency cap of agent processes run at once", async () => {
  const fake = fakeClaude();
  const agents = ["bugs", "design", "security"].map((key) => ({ key, source: "base" }));
  await review(fake, { agents, concurrency: 2 }).rows;
  assert.equal(fake.calls.length, 3 + 9);
  assert.equal(fake.peak(), 2);
});

// ── Priming ──────────────────────────────────────────────────────────────────

test("every primer starts before any voter, and an agent's voters wait for its primer", async () => {
  const fake = fakeClaude((call) => (call.kind === "primer" ? PRIMED : USABLE));
  const agents = ["bugs", "design"].map((key) => ({ key, source: "base" }));
  await review(fake, { agents, concurrency: 2 }).rows;

  const primers = fake.calls.filter((c) => c.kind === "primer");
  const voters = fake.calls.filter((c) => c.kind === "voter");
  assert.equal(primers.length, 2);
  assert.ok(Math.max(...primers.map((c) => c.start)) < Math.min(...voters.map((c) => c.start)));
  for (const primer of primers) {
    for (const voter of voters.filter((c) => c.agent === primer.agent)) {
      assert.ok(voter.start > primer.end, `${primer.agent} voter started before its primer ended`);
    }
  }
});

test("a primer that fails still releases its voters", async () => {
  const fake = fakeClaude((call) => (call.kind === "primer" ? CRASH : USABLE));
  const { output, rows } = review(fake);
  const result = await rows;
  assert.equal(fake.calls.filter((c) => c.kind === "voter").length, 3);
  assert.ok(result.every((row) => row.run === "primer" || row.outcome === "usable"));
  assert.ok(output.some((line) => line.includes("wrote no cache tokens")));
});

test("a single voter runs without a primer", async () => {
  const fake = fakeClaude();
  await review(fake, { voters: 1 }).rows;
  assert.deepEqual(fake.calls.map((c) => c.kind), ["voter"]);
});

test("voters on OpenRouter run without a primer", async () => {
  const fake = fakeClaude();
  await review(fake, { provider: "openrouter" }).rows;
  assert.deepEqual(fake.calls.map((c) => c.kind), ["voter", "voter", "voter"]);
});

// ── Wrap-up ──────────────────────────────────────────────────────────────────

test("a capped voter is resumed for its findings, and the resumed answer is its result", async () => {
  const fake = fakeClaude((call) => (call.kind === "resume" ? USABLE : CAPPED));
  const { resultsDir, rows } = review(fake, { voters: 1 });
  const [row] = await rows;
  assert.deepEqual(fake.calls.map((c) => c.kind), ["voter", "resume"]);
  assert.equal(row.outcome, "usable after wrap-up");
  assert.equal(readFileSync(join(resultsDir, "bugs-result.json"), "utf-8"), USABLE.stdout);
});

test("a voter that answers in prose is resumed for its findings", async () => {
  const fake = fakeClaude((call) => (call.kind === "resume" ? USABLE : PROSE));
  const [row] = await review(fake, { voters: 1 }).rows;
  assert.deepEqual(fake.calls.map((c) => c.kind), ["voter", "resume"]);
  assert.equal(row.outcome, "usable after wrap-up");
});

test("a failed wrap-up keeps the original result", async () => {
  let voterRuns = 0;
  const fake = fakeClaude((call) => {
    if (call.kind === "resume") return CRASH;
    voterRuns++;
    return voterRuns === 1 ? CAPPED : USABLE;
  });
  const { rows } = review(fake, { voters: 1 });
  const result = await rows;
  assert.equal(result[0].outcome, "empty");
  assert.equal(result[1].outcome, "usable");
});

// ── Retries and replacements ─────────────────────────────────────────────────

test("a crashed voter is retried once from scratch", async () => {
  const fake = fakeClaude((call, calls) => (calls.length === 1 ? CRASH : USABLE));
  const result = await review(fake, { voters: 1 }).rows;
  assert.deepEqual(result.map((r) => [r.attempt, r.outcome]), [[1, "crashed"], [2, "usable"]]);
});

test("an empty voter is replaced once by a fresh voter", async () => {
  let voterRuns = 0;
  const fake = fakeClaude((call) => {
    if (call.kind === "resume") return PROSE;
    voterRuns++;
    return voterRuns === 1 ? PROSE : USABLE;
  });
  const result = await review(fake, { voters: 1 }).rows;
  assert.deepEqual(result.map((r) => [r.attempt, r.outcome]), [[1, "empty"], [2, "usable"]]);
});

test("a slot gets one fresh run whatever went wrong, never two", async () => {
  const fake = fakeClaude(() => CRASH);
  const { output, rows } = review(fake, { voters: 1 });
  const result = await rows;
  assert.deepEqual(result.map((r) => r.outcome), ["crashed", "crashed"]);
  assert.ok(output.some((line) => line.includes("contributes nothing")));
});

test("a timed-out voter is not retried and gets no wrap-up", async () => {
  const fake = fakeClaude(() => TIMED_OUT);
  const result = await review(fake, { voters: 1 }).rows;
  assert.deepEqual(fake.calls.map((c) => c.kind), ["voter"]);
  assert.deepEqual(result.map((r) => r.outcome), ["timed out"]);
});

// ── Results ──────────────────────────────────────────────────────────────────

test("every voter slot writes a result the orchestrator recognises", async () => {
  const fake = fakeClaude((call) => (call.kind === "primer" ? PRIMED : USABLE));
  const agents = ["bugs", "my-rules"].map((key) => ({ key, source: "base" }));
  const { resultsDir, rows } = review(fake, { agents });
  await rows;
  const names = readdirSync(resultsDir).sort();
  assert.deepEqual(names, [
    "bugs-voter-0-result.json",
    "bugs-voter-1-result.json",
    "bugs-voter-2-result.json",
    "my-rules-voter-0-result.json",
    "my-rules-voter-1-result.json",
    "my-rules-voter-2-result.json",
  ]);
  for (const name of names) {
    const match = name.match(RESULT_FILE_PATTERN);
    assert.ok(match);
    assert.ok(["bugs", "my-rules"].includes(match[1]));
  }
});

test("result file names round-trip through the orchestrator's pattern", () => {
  assert.deepEqual([...resultFileName("my-rules", 0, 1).match(RESULT_FILE_PATTERN)].slice(1), ["my-rules", undefined]);
  assert.deepEqual([...resultFileName("my-rules", 4, 5).match(RESULT_FILE_PATTERN)].slice(1), ["my-rules", "4"]);
});

test("the job summary has a row per process", async () => {
  const fake = fakeClaude((call) => (call.kind === "primer" ? PRIMED : USABLE));
  const rows = await review(fake).rows;
  const table = rows.map(summaryRow).join("");
  assert.equal(table.split("\n").filter((line) => line.startsWith("| bugs |")).length, 4);
  assert.match(table, /\| bugs \| primer \|  \| \d+s \| \d+s \|  \| 0 \| 4 \| 0% \| primed \|/);
  assert.match(table, /\| bugs \| voter 0 \| 1 \| \d+s \| \d+s \|  \| 0 \| 4 \| 90% \| usable \|/);
});

test("each process's log is written as one group", async () => {
  const fake = fakeClaude();
  const { output, rows } = review(fake, { voters: 1 });
  await rows;
  const group = output.find((text) => text.startsWith("::group::bugs: usable"));
  assert.ok(group);
  assert.ok(group.trimEnd().endsWith("::endgroup::"));
});

test("an answer cannot run workflow commands from the job log", async () => {
  const planted = '::error title=Forged::owned\n::add-mask::secret\n[]';
  const fake = fakeClaude(() => ({ code: 0, timedOut: false, stdout: envelope(planted), stderr: "::warning::from stderr" }));
  const { output, rows } = review(fake, { voters: 1 });
  await rows;
  const group = output.find((text) => text.startsWith("::group::bugs: usable"));
  const lines = group.trimEnd().split("\n");
  const token = lines[1].match(/^::stop-commands::(.+)$/)?.[1];
  assert.ok(token, "command processing is stopped before the body");
  const resume = lines.indexOf(`::${token}::`);
  assert.equal(resume, lines.length - 2);
  assert.ok(lines.slice(2, resume).includes("::error title=Forged::owned"));
  assert.equal(lines.at(-1), "::endgroup::");
});

test("a voter's row covers its wrap-up, with turns summed over both runs", async () => {
  const fake = fakeClaude((call) => (call.kind === "resume" ? USABLE : CAPPED));
  const [row] = await review(fake, { voters: 1 }).rows;
  assert.equal(row.outcome, "usable after wrap-up");
  assert.equal(row.turns, 8);
});

test("an answer with a stray bracket but no findings array still gets its wrap-up", async () => {
  const stray = { code: 0, timedOut: false, stdout: envelope("I read [src/x.mjs] and it looks fine."), stderr: "" };
  const fake = fakeClaude((call) => (call.kind === "resume" ? USABLE : stray));
  const [row] = await review(fake, { voters: 1 }).rows;
  assert.deepEqual(fake.calls.map((c) => c.kind), ["voter", "resume"]);
  assert.equal(row.outcome, "usable after wrap-up");
});

test("a wrap-up sends the same system prompt flag as the voter it resumes", async () => {
  const fake = fakeClaude((call) => (call.kind === "resume" ? USABLE : CAPPED));
  await review(fake, { voters: 1 }).rows;
  for (const call of fake.calls) {
    assert.ok(call.args.includes("--exclude-dynamic-system-prompt-sections"));
  }
});

test("a wrap-up gets the short wrap-up limit, not the voter's full one", async () => {
  const fake = fakeClaude((call) => (call.kind === "resume" ? USABLE : CAPPED));
  await review(fake, { voters: 1, timeoutMs: 20 * 60 * 1000 }).rows;
  const [voter, resume] = fake.calls;
  assert.equal(voter.timeoutMs, 20 * 60 * 1000);
  assert.equal(resume.timeoutMs, WRAP_UP_TIMEOUT_MS);
  assert.ok(WRAP_UP_TIMEOUT_MS < voter.timeoutMs);
});

test("a primer gets the short primer time limit, and voters the full one", async () => {
  const fake = fakeClaude((call) => (call.kind === "primer" ? PRIMED : USABLE));
  await review(fake, { timeoutMs: 1000, primerTimeoutMs: 10 }).rows;
  assert.ok(fake.calls.filter((c) => c.kind === "primer").every((c) => c.timeoutMs === 10));
  assert.ok(fake.calls.filter((c) => c.kind === "voter").every((c) => c.timeoutMs === 1000));
});

test("an unexpected error in one voter costs only that voter", async () => {
  const fake = fakeClaude((call, calls) => {
    if (call.agent === "bugs" && calls.filter((c) => c.agent === "bugs").length === 1) {
      throw new Error("disk full");
    }
    return call.kind === "primer" ? PRIMED : USABLE;
  });
  const agents = ["bugs", "design"].map((key) => ({ key, source: "base" }));
  const { output, rows } = review(fake, { agents });
  const result = await rows;
  assert.ok(output.some((line) => line.includes("failed unexpectedly")));
  assert.equal(result.filter((r) => r.agent === "design" && r.outcome === "usable").length, 3);
});

test("each process logs when it starts, and its row says how long it waited", async () => {
  let clock = 0;
  const fake = fakeClaude();
  const { output, rows } = review(fake, { voters: 1, now: () => (clock += 1000) });
  const [row] = await rows;
  assert.ok(output.includes("Started bugs\n"));
  assert.ok(row.waitedMs > 0);
  assert.ok(row.ranMs > 0);
});

test("every row is handed over as it settles", async () => {
  const seen = [];
  const fake = fakeClaude((call) => (call.kind === "primer" ? PRIMED : USABLE));
  const rows = await review(fake, { onRow: (row) => seen.push(row) }).rows;
  assert.deepEqual(seen, rows);
});

test("every process's time limit is cut to what is left before the deadline", async () => {
  let clock = 0;
  const fake = fakeClaude();
  await review(fake, { voters: 1, timeoutMs: 20 * 60 * 1000, now: () => clock, deadline: 7 * 60 * 1000 }).rows;
  assert.equal(fake.calls[0].timeoutMs, 7 * 60 * 1000);
});

test("a crashed voter gets no fresh run when too little time is left", async () => {
  let clock = 0;
  const fake = fakeClaude(() => {
    clock = 10 * 60 * 1000;
    return CRASH;
  });
  const { output, rows } = review(fake, { voters: 1, now: () => clock, deadline: 10 * 60 * 1000 + MIN_FRESH_RUN_MS - 1 });
  const result = await rows;
  assert.deepEqual(result.map((r) => r.outcome), ["crashed"]);
  assert.ok(output.some((line) => line.includes("too little time left for a fresh run")));
});

test("a crashed voter still gets its fresh run with time to spare", async () => {
  let clock = 0;
  const fake = fakeClaude((call, calls) => (calls.length === 1 ? CRASH : USABLE));
  const result = await review(fake, { voters: 1, now: () => clock, deadline: MIN_FRESH_RUN_MS + 1 }).rows;
  assert.deepEqual(result.map((r) => r.outcome), ["crashed", "usable"]);
});

test("a fresh run needs half a voter's time limit left", () => {
  assert.equal(freshRunMinimum(20 * 60 * 1000), 10 * 60 * 1000);
});

test("work admitted after the deadline starts no process", async () => {
  let clock = 0;
  const fake = fakeClaude();
  const { resultsDir, output, rows } = review(fake, { voters: 1, now: () => clock, deadline: 0 });
  const result = await rows;
  assert.equal(fake.calls.length, 0);
  assert.deepEqual(result.map((r) => r.outcome), ["not started"]);
  assert.ok(output.includes("Not starting bugs: too little time left\n"));
  assert.equal(parseAgentResult(join(resultsDir, "bugs-result.json"), "bugs"), null);
});

test("a fresh run admitted with too little time left does not start", async () => {
  // One slot: bugs crashes with time to spare, so its fresh run is queued,
  // but design's run uses up the time before the fresh run is admitted.
  let clock = 0;
  const deadline = 20 * 60 * 1000;
  const fake = fakeClaude((call) => {
    if (call.agent === "bugs") return CRASH;
    clock = deadline - MIN_FRESH_RUN_MS + 1;
    return USABLE;
  });
  const agents = ["bugs", "design"].map((key) => ({ key, source: "base" }));
  const result = await review(fake, { agents, voters: 1, concurrency: 1, now: () => clock, deadline }).rows;
  assert.equal(fake.calls.length, 2);
  assert.deepEqual(result.map((r) => `${r.agent} ${r.outcome}`), ["bugs crashed", "design usable", "bugs not started"]);
});

test("a voter stopped at its time limit after answering counts by its answer", async () => {
  const fake = fakeClaude(() => ({ ...USABLE, code: -1, timedOut: true }));
  const { output, rows } = review(fake, { voters: 1 });
  const result = await rows;
  assert.deepEqual(result.map((r) => r.outcome), ["usable"]);
  assert.equal(fake.calls.length, 1);
  assert.ok(!output.some((line) => line.includes("contributes nothing")));
});

test("a run with no result writes one marked failed, never its raw output", async () => {
  // Cut part way through a line, a stream's tail can still hold an array that
  // would read as an empty set of findings.
  const rawTail = 'ool_use"}]}}\n{"type":"assistant","message":{"content":[{"type":"text","text":"Reading"}]}}\n';
  const fake = fakeClaude(() => ({ code: 143, timedOut: true, stdout: "", rawTail, stderr: "" }));
  const { resultsDir, rows } = review(fake, { voters: 1 });
  const [row] = await rows;
  assert.equal(row.outcome, "timed out");
  const resultPath = join(resultsDir, "bugs-result.json");
  assert.equal(JSON.parse(readFileSync(resultPath, "utf-8")).is_error, true);
  assert.equal(parseAgentResult(resultPath, "bugs"), null);
});

test("a voter that fails unexpectedly writes a result marked failed", async () => {
  const runClaude = () => {
    throw new Error("unexpected");
  };
  const { resultsDir, rows } = review(fakeClaude(), { voters: 1, runClaude });
  const [row] = await rows;
  assert.equal(row.outcome, "error");
  assert.equal(parseAgentResult(join(resultsDir, "bugs-result.json"), "bugs"), null);
});

// ── Environment ──────────────────────────────────────────────────────────────

test("the review passes its environment to every process unchanged", async () => {
  const fake = fakeClaude((call) => (call.kind === "primer" ? PRIMED : USABLE));
  await review(fake).rows;
  assert.ok(fake.calls.every((c) => c.env.ANTHROPIC_API_KEY === "key" && !("GITHUB_TOKEN" in c.env)));
});

// ── Prompts ──────────────────────────────────────────────────────────────────

test("custom agent prompts come from the trusted checkout", () => {
  const root = mkdtempSync(join(tmpdir(), "run-agents-prompts-"));
  const reviewHeroDir = join(root, ".review-hero");
  const callerBaseDir = join(root, ".caller-base");
  mkdirSync(join(reviewHeroDir, "prompts"), { recursive: true });
  mkdirSync(join(callerBaseDir, ".github", "review-hero", "prompts"), { recursive: true });
  writeFileSync(join(reviewHeroDir, "prompts", "agent-prompt.md"), "Base.");
  writeFileSync(join(reviewHeroDir, "prompts", "bugs.md"), "Bugs.");
  writeFileSync(join(callerBaseDir, ".github", "review-hero", "prompts", "house.md"), "House rules.");

  const prompts = buildPrompts({
    agents: [
      { key: "bugs", source: "base" },
      { key: "house", source: "custom" },
    ],
    reviewHeroDir,
    callerBaseDir,
    common: { maxTurns: 20, diff: "+x\n" },
  });
  assert.ok(prompts.bugs.startsWith("Base.\n\nBugs."));
  assert.ok(prompts.house.startsWith("Base.\n\nHouse rules."));
});

function promptDirs() {
  const root = mkdtempSync(join(tmpdir(), "run-agents-prompts-"));
  const reviewHeroDir = join(root, ".review-hero");
  mkdirSync(join(reviewHeroDir, "prompts"), { recursive: true });
  writeFileSync(join(reviewHeroDir, "prompts", "agent-prompt.md"), "Base.");
  writeFileSync(join(reviewHeroDir, "prompts", "bugs.md"), "Bugs.");
  return { reviewHeroDir, callerBaseDir: join(root, ".caller-base") };
}

test("an agent key that could escape the prompts directory is skipped", () => {
  const warnings = [];
  const prompts = buildPrompts({
    ...promptDirs(),
    agents: [
      { key: "../../etc/passwd", source: "custom" },
      { key: "bugs", source: "base" },
    ],
    common: { maxTurns: 20, diff: "" },
    out: (line) => warnings.push(line),
  });
  assert.deepEqual(Object.keys(prompts), ["bugs"]);
  assert.match(warnings.join("\n"), /::warning::Skipping agent "\.\.\/\.\.\/etc\/passwd": cannot read its prompt \(invalid agent key/);
});

test("an agent whose prompt cannot be read is skipped, and the rest still run", () => {
  const warnings = [];
  const prompts = buildPrompts({
    ...promptDirs(),
    agents: [
      { key: "house", source: "custom" },
      { key: "bugs", source: "base" },
    ],
    common: { maxTurns: 20, diff: "" },
    out: (line) => warnings.push(line),
  });
  assert.deepEqual(Object.keys(prompts), ["bugs"]);
  assert.match(warnings.join("\n"), /::warning::Skipping agent "house": cannot read its prompt/);
});

// ── Streaming ────────────────────────────────────────────────────────────────

test("the CLI loads no settings, MCP servers or skills from the PR checkout, wrap-ups included", async () => {
  const fake = fakeClaude((call) => (call.kind === "voter" ? PROSE : USABLE));
  await review(fake, { voters: 1 }).rows;
  assert.equal(fake.calls.length, 2);
  for (const { args } of fake.calls) {
    assert.equal(args[args.indexOf("--setting-sources") + 1], "user");
    assert.ok(args.includes("--strict-mcp-config"));
    assert.ok(args.includes("--disable-slash-commands"));
  }
});

test("the CLI streams its output so retries can be seen", async () => {
  const fake = fakeClaude();
  await review(fake, { voters: 1 }).rows;
  const { args } = fake.calls[0];
  assert.equal(args[args.indexOf("--output-format") + 1], "stream-json");
  assert.ok(args.includes("--verbose"));
});

test("rate-limit retries reported by a run reach the scheduler and the row", async () => {
  const fake = fakeClaude();
  const runClaude = async (options) => {
    options.onEvent?.({ type: "system", subtype: "api_retry", error_status: 429, retry_delay_ms: 0 });
    return fake.runClaude(options);
  };
  const lines = [];
  const [row] = await review(fake, { voters: 1, runClaude, out: (text) => lines.push(text) }).rows;
  assert.equal(row.retries, 1);
  assert.ok(lines.some((l) => l.includes("Provider throttling (HTTP 429)")));
});

