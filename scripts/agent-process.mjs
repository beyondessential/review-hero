/**
 * Review Hero — Agent processes
 *
 * What the agent driver and the second look share for running Claude CLI
 * processes: the allowlisted environment they run with, the CLI runner and
 * its arguments, the wrap-up resume, admission through the scheduler to a
 * deadline, the trusted prompt path, and the summary table's rows.
 */

import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getEnvOrThrow, readOptional } from "./lib.mjs";
import { parseCeiling, processTree } from "./scheduler.mjs";
import { extractJsonArray, isValidAgentKey } from "../src/index.mjs";

/**
 * A wrap-up only writes up what the run already found, in a few turns, so it
 * gets far less time than a run. Its own limit keeps a run and its wrap-up
 * inside the step that holds them.
 */
export const WRAP_UP_TIMEOUT_MS = 5 * 60 * 1000;
const KILL_GRACE_MS = 10_000;

const ALLOWED_TOOLS =
  "Read,Glob,Grep,Bash(git log:*),Bash(git show:*),Bash(git diff:*)";

const WRAP_UP_MESSAGE =
  "Stop exploring and reply with only your final JSON array of findings, using what you have already confirmed (exactly [] if none). No other text.";

/** Wrap-up turns for a capped or array-less run. */
export const WRAP_UP_MAX_TURNS = 3;

// ── Environment for agent processes ──────────────────────────────────────────

const ALLOWED_ENV_NAMES = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "TZ",
  "TMPDIR",
  "TERM",
  "CI",
  "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "API_TIMEOUT_MS",
  // Named one by one, not by prefix, so a variable added to the step later
  // cannot reach an agent unnoticed.
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
]);
const ALLOWED_ENV_PREFIXES = ["LC_"];

/**
 * The environment an agent process runs with: what the CLI needs to start and
 * reach the model, and nothing else. A prompt-injected agent can read its own
 * environment, so a GitHub token here could be echoed into a finding.
 */
// spec: RUN#credentials
export function agentEnv(parentEnv) {
  const env = {};
  for (const [name, value] of Object.entries(parentEnv)) {
    if (value === undefined) continue;
    if (
      ALLOWED_ENV_NAMES.has(name) ||
      ALLOWED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))
    ) {
      env[name] = value;
    }
  }
  return env;
}

// ── Claude CLI ───────────────────────────────────────────────────────────────

/** Raw output kept for a run that never produced a result, for diagnosis. */
const RAW_TAIL_BYTES = 64 * 1024;

/**
 * Run the Claude CLI once. Resolves with its exit code and output, never
 * rejects for a failed run: a process that cannot start reports code -1.
 *
 * The CLI streams JSON events, one per line. Each is handed to `onEvent` as it
 * arrives (rate-limit retries among them), and `stdout` resolves to the final
 * result event: the same envelope `--output-format json` would print. A run
 * that never reached a result has an empty `stdout`, and the tail of its raw
 * output in `rawTail` for diagnosis. That tail is never a result: cut part way
 * through a line, it can still hold a JSON array that reads as findings.
 * `onSpawn` and `onExit` report the process id, so its memory can be measured.
 * A run past its time limit is stopped along with every process it spawned.
 */
export function spawnClaude({ args, input, env, timeoutMs, onSpawn = () => {}, onExit = () => {}, onEvent = () => {} }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("claude", args, { env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      resolve({ code: -1, timedOut: false, stdout: "", stderr: String(err) });
      return;
    }
    onSpawn(child.pid);

    let pending = "";
    let resultLine = null;
    let rawTail = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const takeLine = (line) => {
      if (!line.trim()) return;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event?.type === "result") resultLine = line;
      try {
        onEvent(event);
      } catch {
        // Reporting must never break the run.
      }
    };

    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      takeLine(pending);
      onExit(child.pid);
      resolve({
        code,
        timedOut,
        stdout: resultLine ?? "",
        ...(resultLine === null && { rawTail }),
        stderr,
      });
    };

    // The CLI runs ripgrep and git as children, which would otherwise outlive
    // it and hold its output open.
    const killTree = (signal) => {
      for (const pid of processTree(child.pid)) {
        try {
          process.kill(pid, signal);
        } catch {
          // Already gone.
        }
      }
    };
    let killTimer;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree("SIGTERM");
      killTimer = setTimeout(() => killTree("SIGKILL"), KILL_GRACE_MS);
    }, timeoutMs);

    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => {
      rawTail = (rawTail + chunk).slice(-RAW_TAIL_BYTES);
      const lines = (pending + chunk).split("\n");
      pending = lines.pop();
      for (const line of lines) takeLine(line);
    });
    // Only the tail of stderr is kept, so a CLI stuck logging cannot grow
    // without bound before its time limit stops it.
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-RAW_TAIL_BYTES);
    });
    child.on("error", (err) => {
      stderr = (stderr + String(err)).slice(-RAW_TAIL_BYTES);
      finish(-1);
    });
    child.on("close", (code) => finish(code ?? -1));

    // A process that exits before reading its prompt closes stdin under us.
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

export function claudeArgs({ model, maxTurns, resume }) {
  const args = ["-p"];
  if (resume) args.push("--resume", resume);
  args.push(
    "--permission-mode",
    "dontAsk",
    // Streamed so rate-limit retries are seen as they happen; the runner
    // keeps the final result event as the run's envelope.
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    model,
    "--max-turns",
    String(maxTurns),
    "--allowedTools",
    ALLOWED_TOOLS,
  );
  // Keeps per-machine detail out of the system prompt, so the cacheable
  // prefix is the same for every voter and for a voter's wrap-up.
  args.push("--exclude-dynamic-system-prompt-sections");
  // spec: RUN#credentials
  // The CLI runs in the PR checkout, and would otherwise load the PR's own
  // project settings (hooks run shell commands, and permission rules widen
  // the tools), its MCP servers and its skills. User settings stay, for the
  // trusted global rules the workflow installs.
  args.push("--setting-sources", "user", "--strict-mcp-config", "--disable-slash-commands");
  return args;
}

// ── Classifying a run ────────────────────────────────────────────────────────

export function parseEnvelope(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function answeredWithArray(envelope) {
  return (
    typeof envelope?.result === "string" &&
    extractJsonArray(envelope.result) !== null
  );
}

/**
 * Why a run needs its wrap-up resume, or null when it does not: a capped
 * agent has done its reading but written nothing, and one that answered in
 * prose with no array wrote nothing usable.
 */
export function wrapUpReason(run, envelope, maxTurns) {
  if (run.code !== 0 && envelope?.subtype === "error_max_turns") {
    return `hit max-turns (${maxTurns})`;
  }
  if (run.code === 0 && envelope && !answeredWithArray(envelope)) {
    return "answered without a findings array";
  }
  return null;
}

/**
 * Run the CLI once, then resume it for its answer when it hit its turn cap or
 * answered without an array. A failed wrap-up keeps the original result; a
 * successful one is merged into it, so the envelope covers both runs.
 * `run(args, input, limitMs)` runs the CLI; the wrap-up gets `wrapUpTimeoutMs`.
 */
export async function runWithWrapUp({
  run,
  prompt,
  model,
  maxTurns,
  label,
  out,
  wrapUpMessage = WRAP_UP_MESSAGE,
  wrapUpTimeoutMs = WRAP_UP_TIMEOUT_MS,
}) {
  let result = await run(claudeArgs({ model, maxTurns }), prompt);
  let envelope = parseEnvelope(result.stdout);
  let stderr = result.stderr;
  let wrappedUp = false;

  const reason = result.timedOut ? null : wrapUpReason(result, envelope, maxTurns);
  if (reason && envelope?.session_id) {
    out(`::notice::Agent ${label} ${reason}; resuming it to write up\n`);
    const resumed = await run(
      claudeArgs({ model, maxTurns: WRAP_UP_MAX_TURNS, resume: envelope.session_id }),
      wrapUpMessage,
      wrapUpTimeoutMs,
    );
    const resumedEnvelope = parseEnvelope(resumed.stdout);
    stderr += resumed.stderr;
    if (resumed.code === 0 && answeredWithArray(resumedEnvelope)) {
      result = resumed;
      envelope = mergeWrapUp(envelope, resumedEnvelope);
      wrappedUp = true;
    }
  }
  return { result, envelope, stderr, wrappedUp };
}

// ── Reporting ────────────────────────────────────────────────────────────────

/**
 * The share of cacheable input read from the cache. A run that reported usage
 * but touched no cache shows as "none", so a missed prefix stands out rather
 * than reading like a blank cell.
 */
export function cacheReadShare(usage) {
  if (!usage) return "";
  const read = usage.cache_read_input_tokens ?? 0;
  const written = usage.cache_creation_input_tokens ?? 0;
  return read + written > 0 ? `${Math.round((read / (read + written)) * 100)}%` : "none";
}

/**
 * One envelope standing for a voter and its wrap-up: the wrap-up's answer,
 * with turns, duration, cost and cache use summed over both runs, so the
 * summary reflects the whole voter rather than the short resume.
 */
export function mergeWrapUp(original, wrapUp) {
  const sum = (a, b) => (a == null && b == null ? undefined : (a ?? 0) + (b ?? 0));
  const usage = {};
  for (const key of new Set([
    ...Object.keys(original?.usage ?? {}),
    ...Object.keys(wrapUp?.usage ?? {}),
  ])) {
    const a = original?.usage?.[key];
    const b = wrapUp?.usage?.[key];
    usage[key] = typeof a === "number" || typeof b === "number" ? sum(a, b) : (b ?? a);
  }
  return {
    ...wrapUp,
    num_turns: sum(original?.num_turns, wrapUp?.num_turns),
    duration_ms: sum(original?.duration_ms, wrapUp?.duration_ms),
    total_cost_usd: sum(original?.total_cost_usd, wrapUp?.total_cost_usd),
    usage,
  };
}

export function summaryHeader(title) {
  return [
    `### ${title}`,
    "",
    "| Agent | Run | Attempt | Waited | Ran | Peak memory | API retries | Turns | Cache read | Outcome |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    "",
  ].join("\n");
}

export function summaryRow(row) {
  const secs = (ms) => (ms == null ? "" : `${Math.round(ms / 1000)}s`);
  const mb = (bytes) => (bytes == null ? "" : `${Math.round(bytes / (1024 * 1024))} MB`);
  return `| ${row.agent} | ${row.run} | ${row.attempt ?? ""} | ${secs(row.waitedMs)} | ${secs(row.ranMs)} | ${mb(row.peakBytes)} | ${row.retries ?? ""} | ${row.turns ?? ""} | ${row.cacheRead ?? ""} | ${row.outcome} |\n`;
}

/** What a run left behind for diagnosis: its result, or its raw output. */
export function runOutput(result) {
  return result.stdout || result.rawTail || "";
}

// ── Admission and deadline ───────────────────────────────────────────────────

/**
 * Turn the step's time budget into a deadline. The workflow passes a budget a
 * little inside the step's own time limit, so processes stop, and their
 * results and summary rows are written, before the step would be killed.
 */
export function deadlineFrom(budgetMs, now = Date.now) {
  const budget = Number(budgetMs);
  return Number.isFinite(budget) && budget > 0 ? now() + budget : Infinity;
}

/** What a run resolves with when there was no time left to start it. */
export const NOT_STARTED = Object.freeze({ code: -1, timedOut: false, notStarted: true, stdout: "", stderr: "" });

/**
 * Admission for agent processes, shared by the agent and checker drivers.
 * `timed(label, fn, { minTimeMs })` waits for the scheduler to admit the work,
 * logs the moment it starts, and hands `fn` a CLI runner
 * `run(args, input, limitMs)` wired to the scheduler, so the processes it
 * starts are measured and their rate-limit retries hold back further starts.
 * Every process's time limit is cut to what is left before `deadline`, so no
 * run outlasts the step. Work admitted with no time left, or less than
 * `minTimeMs`, starts no process: its runner resolves with `NOT_STARTED`.
 * `timeLeft()` says how long remains.
 */
export function createProcessRunner({
  scheduler,
  env,
  runClaude = spawnClaude,
  timeoutMs,
  deadline = Infinity,
  now = Date.now,
  out,
}) {
  const timeLeft = () => Math.max(0, deadline - now());
  function timed(label, fn, { minTimeMs = 0 } = {}) {
    return scheduler.withSlot((slot) => {
      const left = timeLeft();
      const admitted = left > 0 && left >= minTimeMs;
      out(admitted ? `Started ${label}\n` : `Not starting ${label}: too little time left\n`);
      const run = (args, input, limitMs = timeoutMs) => {
        const limit = Math.min(limitMs, timeLeft());
        if (!admitted || limit <= 0) return Promise.resolve(NOT_STARTED);
        return runClaude({
          args,
          input,
          env,
          timeoutMs: limit,
          onSpawn: slot.onSpawn,
          onExit: slot.onExit,
          onEvent: slot.onEvent,
        });
      };
      return fn(run);
    });
  }
  return { timed, timeLeft };
}

// ── Priming ──────────────────────────────────────────────────────────────────

/** A primer only has to send its first request, so it gets far less time. */
export const PRIMER_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Run a primer: one single-turn run of `prompt` that writes it to the prompt
 * cache, so the runs started after it read that prefix instead of each
 * writing their own. Its output goes to `logPath`. Resolves with the run, its
 * envelope, its outcome ("primed", "wrote no cache" or "not started") and the
 * admission timing. The primer is queued before this returns, so primers
 * started together keep their order ahead of whatever is queued after them.
 */
// spec: RUN#prompt-cache-priming
export async function primeRun({ timed, label, prompt, model, timeoutMs = PRIMER_TIMEOUT_MS, logPath, out }) {
  const { result, ...timing } = await timed(label, (run) =>
    run(claudeArgs({ model, maxTurns: 1 }), prompt, timeoutMs),
  );
  writeFileSync(logPath, runOutput(result));
  const envelope = parseEnvelope(result.stdout);
  const written = envelope?.usage?.cache_creation_input_tokens ?? 0;
  // Hitting the one-turn cap is the expected way for a primer to end. What
  // matters is whether the first request wrote the prefix.
  const outcome = result.notStarted ? "not started" : written > 0 ? "primed" : "wrote no cache";
  if (outcome === "wrote no cache") {
    out(`::warning::${label} wrote no cache tokens; the runs after it will not share a prefix\n`);
  }
  return { result, envelope, outcome, ...timing };
}

// ── Driver setup ─────────────────────────────────────────────────────────────

/**
 * Start a driver from its step's environment: the settings the agent driver
 * and the second look both read, under the same names, so the two cannot
 * drift apart on them. Creates the logs directory, and opens the driver's
 * table in the job summary; `onRow` appends a row to it, a row at a time, so
 * the table survives the step being stopped at its time limit.
 *
 * `maxTurns` goes into the prompt inputs, and `defaultTimeoutMs` is the
 * per-process limit when `PROCESS_TIMEOUT_MS` is unset.
 */
export function startDriver({ maxTurns, defaultTimeoutMs, summaryTitle }) {
  const logsDir = getEnvOrThrow("LOGS_DIR");
  mkdirSync(logsDir, { recursive: true });
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) appendFileSync(summaryPath, `\n${summaryHeader(summaryTitle)}`);
  return {
    model: getEnvOrThrow("AGENT_MODEL"),
    provider: process.env.AGENT_PROVIDER || "anthropic",
    concurrency: parseCeiling(process.env.CONCURRENCY),
    logsDir,
    reviewHeroDir: getEnvOrThrow("REVIEW_HERO_DIR"),
    callerBaseDir: getEnvOrThrow("CALLER_BASE_DIR"),
    common: {
      projectContext: process.env.PROJECT_CONTEXT || "",
      aiRules: readOptional(process.env.AI_RULES_PATH),
      maxTurns,
      prTitle: process.env.PR_TITLE || "",
      diff: readFileSync(getEnvOrThrow("DIFF_PATH"), "utf-8"),
    },
    env: agentEnv(process.env),
    timeoutMs: parseInt(process.env.PROCESS_TIMEOUT_MS || "") || defaultTimeoutMs,
    deadline: deadlineFrom(process.env.TIME_BUDGET_MS),
    onRow: summaryPath ? (row) => appendFileSync(summaryPath, summaryRow(row)) : undefined,
  };
}

// ── Trusted prompts ──────────────────────────────────────────────────────────

/**
 * Where an agent's own prompt is read from. Base agents come from the
 * review-hero checkout, and every other agent from the caller's checkout at
 * the trusted ref, never the PR branch, so a pull request cannot inject an
 * agent prompt. Throws for a key that is not safe in a path.
 */
/** An agent's own prompt: a generated reviewer carries its focus, every other agent reads its prompt file. */
export function readAgentPrompt(agent, dirs) {
  if (agent.source === "generated") return `# Agent: ${agent.name}\n\nFocus: ${agent.focus}\n`;
  return readFileSync(agentPromptPath(agent, dirs), "utf-8");
}

export function agentPromptPath({ key, source }, { reviewHeroDir, callerBaseDir }) {
  if (!isValidAgentKey(key)) throw new Error(`invalid agent key ${JSON.stringify(key)}`);
  return source === "base"
    ? join(reviewHeroDir, "prompts", `${key}.md`)
    : join(callerBaseDir, ".github", "review-hero", "prompts", `${key}.md`);
}
