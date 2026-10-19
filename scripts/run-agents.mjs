/**
 * Review Hero — Run review agents
 *
 * Runs every selected review agent, and each of its voters, as concurrent
 * Claude CLI processes inside the one review job. The agents spend their time
 * waiting on the model, so one runner carries them all; what this script adds
 * over firing them off at once is:
 *
 * 1. A concurrency cap, so a large custom-agent setup cannot exhaust the
 *    runner or the API rate limit
 * 2. Prompt cache priming: with several voters on Anthropic, each agent first
 *    makes a single-turn run that writes the shared prompt prefix, and its
 *    voters start once it returns
 * 3. A wrap-up resume for a voter that hits its turn cap or answers without a
 *    findings array
 * 4. One fresh run for a voter slot that crashed or came back empty
 * 5. Results written as each voter settles, under the names the orchestrator
 *    scans for, plus a log group per process and a job summary table
 *
 * Environment variables:
 *   AGENTS              — JSON array of { key, source } from triage
 *   VOTERS              — Voters per agent, from triage
 *   MAX_TURNS           — Turn cap per voter run, from triage
 *   AGENT_MODEL         — Model the agents run on
 *   AGENT_PROVIDER      — "anthropic" or "openrouter"
 *   CONCURRENCY         — Most agent processes running at once (default 8)
 *   RESULTS_DIR         — Where voter results go, for the orchestrator
 *   LOGS_DIR            — Where primer output and per-process logs go
 *   REVIEW_HERO_DIR     — review-hero checkout (base prompts)
 *   CALLER_BASE_DIR     — Caller checkout at the trusted ref (custom prompts)
 *   DIFF_PATH           — Filtered PR diff
 *   AI_RULES_PATH       — Repository AI rules (optional)
 *   PROJECT_CONTEXT     — Project context line (optional)
 *   PR_TITLE            — PR title
 *   PROCESS_TIMEOUT_MS  — Time limit per agent process (default 20 minutes)
 *   GITHUB_STEP_SUMMARY — Job summary file (optional)
 *
 * Agent processes inherit only an allowlisted environment, so no GitHub token
 * reaches them however the step is configured.
 */

import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { formatCacheStats, resultFileName } from "./lib.mjs";
import {
  buildReviewAgentPrompt,
  isValidAgentKey,
  parseAgentResult,
} from "../src/index.mjs";

export const DEFAULT_CONCURRENCY = 8;
export const DEFAULT_PROCESS_TIMEOUT_MS = 20 * 60 * 1000;
const KILL_GRACE_MS = 10_000;
const WRAP_UP_MAX_TURNS = 3;

const ALLOWED_TOOLS =
  "Read,Glob,Grep,Bash(git log:*),Bash(git show:*),Bash(git diff:*)";

const WRAP_UP_MESSAGE =
  "Stop exploring and reply with only your final JSON array of findings, using what you have already confirmed (exactly [] if none). No other text.";

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
]);
const ALLOWED_ENV_PREFIXES = ["ANTHROPIC_", "CLAUDE_CODE_", "LC_"];

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

// ── Concurrency ──────────────────────────────────────────────────────────────

/**
 * A first-in, first-out pool of `limit` slots. A finishing task hands its slot
 * straight to the longest waiter, so the order work is queued in is the order
 * it starts. Primers are queued before any voter exists, which is what gives
 * them the first slots.
 */
// spec: RUN#concurrency
export function createSlotPool(limit) {
  let active = 0;
  const waiting = [];
  return async function withSlot(fn) {
    if (active < limit) {
      active++;
    } else {
      await new Promise((resolve) => waiting.push(resolve));
    }
    try {
      return await fn();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

export function parseConcurrency(raw) {
  if (raw === undefined || raw === "") return DEFAULT_CONCURRENCY;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`CONCURRENCY must be a positive integer, got "${raw}"`);
  }
  return value;
}

// ── Claude CLI ───────────────────────────────────────────────────────────────

/**
 * Run the Claude CLI once. Resolves with its exit code and output, never
 * rejects for a failed run: a process that cannot start reports code -1.
 */
export function spawnClaude({ args, input, env, timeoutMs }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("claude", args, { env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      resolve({ code: -1, timedOut: false, stdout: "", stderr: String(err) });
      return;
    }

    const stdout = [];
    const stderr = [];
    let timedOut = false;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve(result);
    };

    let killTimer;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
    }, timeoutMs);

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (err) => {
      stderr.push(Buffer.from(String(err)));
      finish({
        code: -1,
        timedOut,
        stdout: Buffer.concat(stdout).toString("utf-8"),
        stderr: Buffer.concat(stderr).toString("utf-8"),
      });
    });
    child.on("close", (code) => {
      finish({
        code: code ?? -1,
        timedOut,
        stdout: Buffer.concat(stdout).toString("utf-8"),
        stderr: Buffer.concat(stderr).toString("utf-8"),
      });
    });

    // A process that exits before reading its prompt closes stdin under us.
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

function claudeArgs({ model, maxTurns, resume }) {
  const args = ["-p"];
  if (resume) args.push("--resume", resume);
  args.push(
    "--permission-mode",
    "dontAsk",
    "--output-format",
    "json",
    "--model",
    model,
    "--max-turns",
    String(maxTurns),
    "--allowedTools",
    ALLOWED_TOOLS,
  );
  // Keeps per-machine detail out of the system prompt, so the cacheable
  // prefix is the same for every voter.
  if (!resume) args.push("--exclude-dynamic-system-prompt-sections");
  return args;
}

// ── Classifying a run ────────────────────────────────────────────────────────

function parseEnvelope(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function answeredWithArray(envelope) {
  return typeof envelope?.result === "string" && envelope.result.includes("[");
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

// ── Reporting ────────────────────────────────────────────────────────────────

function sessionStats(envelope) {
  if (!envelope) return [];
  const stats = [];
  if (envelope.num_turns != null) stats.push(`Turns: ${envelope.num_turns}`);
  if (envelope.duration_ms != null) {
    stats.push(`Duration: ${(envelope.duration_ms / 1000).toFixed(1)}s`);
  }
  if (envelope.total_cost_usd != null) {
    stats.push(`Cost: $${Number(envelope.total_cost_usd).toFixed(4)}`);
  }
  stats.push(...formatCacheStats(envelope.usage));
  return stats;
}

function cacheReadShare(usage) {
  const read = usage?.cache_read_input_tokens ?? 0;
  const written = usage?.cache_creation_input_tokens ?? 0;
  return read + written > 0 ? `${Math.round((read / (read + written)) * 100)}%` : "";
}

/**
 * One process's log as a single collapsible group. It is written in one call
 * so concurrent processes finishing together cannot interleave their lines.
 */
// spec: RUN#logs
function logGroup(out, { label, outcome, envelope, stderr }) {
  const lines = [`::group::${label}: ${outcome}`];
  const stats = sessionStats(envelope);
  if (stats.length > 0) lines.push(stats.join(" | "));
  if (stderr.trim()) lines.push(stderr.trimEnd());
  if (typeof envelope?.result === "string") lines.push(envelope.result);
  lines.push("::endgroup::");
  out(lines.join("\n") + "\n");
}

export function summaryTable(rows) {
  const lines = [
    "### Review agent runs",
    "",
    "| Agent | Run | Attempt | Turns | Cache read | Outcome |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const row of rows) {
    lines.push(
      `| ${row.agent} | ${row.run} | ${row.attempt ?? ""} | ${row.turns ?? ""} | ${row.cacheRead ?? ""} | ${row.outcome} |`,
    );
  }
  return lines.join("\n") + "\n";
}

/** Write through a temporary file, so a reader never sees half a result. */
function writeAtomic(path, contents) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, contents);
  renameSync(tmp, path);
}

// ── The review ───────────────────────────────────────────────────────────────

/**
 * Run every agent's primer and voters. Resolves with one summary row per
 * process once all of them have settled.
 */
export async function runAgents({
  agents,
  prompts,
  voters,
  maxTurns,
  model,
  provider,
  concurrency,
  resultsDir,
  logsDir,
  env,
  timeoutMs = DEFAULT_PROCESS_TIMEOUT_MS,
  runClaude = spawnClaude,
  out = (text) => process.stdout.write(text),
}) {
  const withSlot = createSlotPool(concurrency);
  const rows = [];

  const run = (args, input) => runClaude({ args, input, env, timeoutMs });

  // spec: RUN#prompt-cache-priming
  async function prime(agent) {
    const label = `${agent.key} (primer)`;
    const result = await withSlot(() =>
      run(claudeArgs({ model, maxTurns: 1 }), prompts[agent.key]),
    );
    writeFileSync(join(logsDir, `${agent.key}-primer.json`), result.stdout);
    const envelope = parseEnvelope(result.stdout);
    const written = envelope?.usage?.cache_creation_input_tokens ?? 0;
    // Hitting the one-turn cap is the expected way for a primer to end. What
    // matters is whether the first request wrote the prefix.
    const outcome = written > 0 ? "primed" : "wrote no cache";
    if (written === 0) {
      out(
        `::warning::${label} wrote no cache tokens; its voters will not share a prefix\n`,
      );
    }
    logGroup(out, { label, outcome, envelope, stderr: result.stderr });
    rows.push({
      agent: agent.key,
      run: "primer",
      turns: envelope?.num_turns,
      cacheRead: cacheReadShare(envelope?.usage),
      outcome,
    });
  }

  // One attempt at a voter slot: the run itself, then its wrap-up resume when
  // it needs one. The slot is held across both, so a resume does not queue
  // behind fresh work while its session is still warm.
  async function attempt(agent, voter, attemptNumber) {
    const label =
      voters > 1 ? `${agent.key} voter ${voter}` : agent.key;
    const fullLabel =
      attemptNumber > 1 ? `${label} (attempt ${attemptNumber})` : label;
    const resultPath = join(resultsDir, resultFileName(agent.key, voter, voters));

    return withSlot(async () => {
      let result = await run(
        claudeArgs({ model, maxTurns }),
        prompts[agent.key],
      );
      let envelope = parseEnvelope(result.stdout);
      let stderr = result.stderr;

      const reason = result.timedOut ? null : wrapUpReason(result, envelope, maxTurns);
      if (reason && envelope?.session_id) {
        out(`::notice::Agent ${fullLabel} ${reason}; resuming it to write up findings\n`);
        const resumed = await run(
          claudeArgs({ model, maxTurns: WRAP_UP_MAX_TURNS, resume: envelope.session_id }),
          WRAP_UP_MESSAGE,
        );
        const resumedEnvelope = parseEnvelope(resumed.stdout);
        stderr += resumed.stderr;
        // A failed wrap-up keeps the original result.
        if (resumed.code === 0 && answeredWithArray(resumedEnvelope)) {
          result = resumed;
          envelope = resumedEnvelope;
        }
      }

      // spec: RUN#wrap-up-retries-and-replacements
      // Written as soon as the attempt settles, so a later failure in the job
      // still leaves the orchestrator this result.
      writeAtomic(resultPath, result.stdout);

      let outcome;
      if (result.timedOut) {
        outcome = "timed out";
      } else if (!envelope) {
        outcome = "crashed";
      } else if (parseAgentResult(resultPath, agent.key, voters > 1 ? voter : undefined) !== null) {
        outcome = "usable";
      } else if (result.code !== 0 && envelope.subtype !== "error_max_turns") {
        outcome = "crashed";
      } else {
        outcome = "empty";
      }

      writeFileSync(
        join(logsDir, `${resultFileName(agent.key, voter, voters).replace(/-result\.json$/, "")}-attempt-${attemptNumber}.log`),
        stderr,
      );
      logGroup(out, { label: fullLabel, outcome, envelope, stderr });
      rows.push({
        agent: agent.key,
        run: voters > 1 ? `voter ${voter}` : "voter",
        attempt: attemptNumber,
        turns: envelope?.num_turns,
        cacheRead: cacheReadShare(envelope?.usage),
        outcome,
      });
      return outcome;
    });
  }

  // A slot gets one fresh run after its first, whether that first run crashed
  // or came back empty. A timed-out run is not retried, so one slow voter
  // cannot double the length of the review.
  async function voterSlot(agent, voter) {
    const first = await attempt(agent, voter, 1);
    if (first === "crashed" || first === "empty") {
      const what = first === "crashed" ? "retrying it" : "replacing it with a fresh voter";
      out(`::warning::Agent ${agent.key}${voters > 1 ? ` voter ${voter}` : ""} ${first}; ${what}\n`);
      const second = await attempt(agent, voter, 2);
      if (second !== "usable") {
        out(`::warning::Agent ${agent.key}${voters > 1 ? ` voter ${voter}` : ""} contributes nothing (${second})\n`);
      }
    } else if (first === "timed out") {
      out(`::warning::Agent ${agent.key}${voters > 1 ? ` voter ${voter}` : ""} timed out and contributes nothing\n`);
    }
  }

  const priming = voters > 1 && provider !== "openrouter";

  // Every primer is queued before any voter, so primers take the first slots.
  const primed = new Map(
    priming ? agents.map((agent) => [agent.key, prime(agent)]) : [],
  );

  await Promise.all(
    agents.map(async (agent) => {
      // A primer that fails still releases its voters.
      await primed.get(agent.key)?.catch(() => {});
      await Promise.all(
        Array.from({ length: voters }, (_, voter) => voterSlot(agent, voter)),
      );
    }),
  );

  return rows;
}

// ── Main ─────────────────────────────────────────────────────────────────────

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function readOptional(path) {
  if (!path || !existsSync(path)) return "";
  return readFileSync(path, "utf-8");
}

/** Build each agent's prompt once, so all its runs send the same bytes. */
export function buildPrompts({ agents, reviewHeroDir, callerBaseDir, common }) {
  const basePrompt = readFileSync(join(reviewHeroDir, "prompts", "agent-prompt.md"), "utf-8");
  const prompts = {};
  for (const agent of agents) {
    if (!isValidAgentKey(agent.key)) {
      throw new Error(`Invalid agent key: ${agent.key}`);
    }
    // Custom prompts come from the trusted ref, so a PR cannot inject one.
    const agentPromptPath =
      agent.source === "base"
        ? join(reviewHeroDir, "prompts", `${agent.key}.md`)
        : join(callerBaseDir, ".github", "review-hero", "prompts", `${agent.key}.md`);
    prompts[agent.key] = buildReviewAgentPrompt({
      ...common,
      basePrompt,
      agentPrompt: readFileSync(agentPromptPath, "utf-8"),
    });
  }
  return prompts;
}

async function main() {
  const agents = JSON.parse(requireEnv("AGENTS"));
  const voters = Math.max(1, parseInt(process.env.VOTERS || "1") || 1);
  const maxTurns = parseInt(requireEnv("MAX_TURNS"));
  const model = requireEnv("AGENT_MODEL");
  const provider = process.env.AGENT_PROVIDER || "anthropic";
  const concurrency = parseConcurrency(process.env.CONCURRENCY);
  const resultsDir = requireEnv("RESULTS_DIR");
  const logsDir = requireEnv("LOGS_DIR");
  const timeoutMs =
    parseInt(process.env.PROCESS_TIMEOUT_MS || "") || DEFAULT_PROCESS_TIMEOUT_MS;

  mkdirSync(resultsDir, { recursive: true });
  mkdirSync(logsDir, { recursive: true });

  const prompts = buildPrompts({
    agents,
    reviewHeroDir: requireEnv("REVIEW_HERO_DIR"),
    callerBaseDir: requireEnv("CALLER_BASE_DIR"),
    common: {
      projectContext: process.env.PROJECT_CONTEXT || "",
      aiRules: readOptional(process.env.AI_RULES_PATH),
      maxTurns,
      prTitle: process.env.PR_TITLE || "",
      diff: readFileSync(requireEnv("DIFF_PATH"), "utf-8"),
    },
  });
  for (const agent of agents) {
    console.log(`Prompt for ${agent.key}: ${Buffer.byteLength(prompts[agent.key])} bytes`);
  }
  console.log(
    `Running ${agents.length} agent(s) × ${voters} voter(s), at most ${concurrency} at once`,
  );

  const rows = await runAgents({
    agents,
    prompts,
    voters,
    maxTurns,
    model,
    provider,
    concurrency,
    resultsDir,
    logsDir,
    env: agentEnv(process.env),
    timeoutMs,
  });

  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryTable(rows));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`::error::run-agents: ${err.message}`);
    process.exit(1);
  });
}
