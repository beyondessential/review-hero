/**
 * Review Hero — Run review agents
 *
 * Runs every selected review agent, and each of its voters, as concurrent
 * Claude CLI processes inside the one review job. The agents spend their time
 * waiting on the model, so one runner carries them all; what this script adds
 * over firing them off at once is:
 *
 * 1. Admission by the runner's free memory and the provider's rate limits,
 *    with the `concurrency` input as an optional ceiling (see scheduler.mjs)
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
 *   CONCURRENCY         — Most agent processes running at once (0 or unset: no ceiling)
 *   RESULTS_DIR         — Where voter results go, for the orchestrator
 *   LOGS_DIR            — Where primer output and per-process logs go
 *   REVIEW_HERO_DIR     — review-hero checkout (base prompts)
 *   CALLER_BASE_DIR     — Caller checkout at the trusted ref (custom prompts)
 *   DIFF_PATH           — Filtered PR diff
 *   AI_RULES_PATH       — Repository AI rules (optional)
 *   PROJECT_CONTEXT     — Project context line (optional)
 *   PR_TITLE            — PR title
 *   PROCESS_TIMEOUT_MS  — Time limit per agent process (default 20 minutes)
 *   TIME_BUDGET_MS      — Time the whole run has, a little inside the step's
 *                         limit; process limits are cut to what is left (optional)
 *   GITHUB_STEP_SUMMARY — Job summary file (optional)
 *
 * Agent processes inherit only an allowlisted environment, so no GitHub token
 * reaches them however the step is configured.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  agentPromptPath,
  cacheReadShare,
  createProcessRunner,
  primeRun,
  PRIMER_TIMEOUT_MS,
  runWithWrapUp,
  spawnClaude,
  startDriver,
} from "./agent-process.mjs";
import { formatCacheStats, getEnvOrThrow, logGroup, resultFileName, votersFromEnv } from "./lib.mjs";
import { ceilingFor, createScheduler, linuxMemoryProbe } from "./scheduler.mjs";
import { buildReviewAgentPrompt, parseAgentResult } from "../src/index.mjs";

export const DEFAULT_PROCESS_TIMEOUT_MS = 20 * 60 * 1000;
/**
 * The time a fresh run for a crashed or empty voter needs left to start: half
 * a voter's time limit. Voters often run most of their limit, so one started
 * with less would most likely be stopped before it answered, its cost spent
 * for nothing.
 */
export function freshRunMinimum(timeoutMs) {
  return timeoutMs / 2;
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

/** One process's log: its stats, stderr and answer, as one group. */
function logRun(out, { label, outcome, envelope, stderr }) {
  const lines = [];
  const stats = sessionStats(envelope);
  if (stats.length > 0) lines.push(stats.join(" | "));
  if (stderr.trim()) lines.push(stderr.trimEnd());
  if (typeof envelope?.result === "string") lines.push(envelope.result);
  out(logGroup(`${label}: ${outcome}`, lines.join("\n")));
}

/** Write through a temporary file, so a reader never sees half a result. */
function writeAtomic(path, contents) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, contents);
  renameSync(tmp, path);
}

/**
 * The result written for a run that left no envelope of its own, so whoever
 * reads it later counts the run as failed.
 */
export function failedEnvelope(subtype) {
  return JSON.stringify({ type: "result", subtype, is_error: true });
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
  concurrency = Infinity,
  memory = linuxMemoryProbe(),
  resultsDir,
  logsDir,
  env,
  timeoutMs = DEFAULT_PROCESS_TIMEOUT_MS,
  primerTimeoutMs = PRIMER_TIMEOUT_MS,
  runClaude = spawnClaude,
  out = (text) => process.stdout.write(text),
  onRow = () => {},
  now = Date.now,
  deadline = Infinity,
  scheduler = createScheduler({
    ceiling: ceilingFor(concurrency, memory, (line) => out(`::warning::${line}\n`)),
    memory,
    now,
    log: (line) => out(`${line}\n`),
  }),
}) {
  const rows = [];
  const record = (row) => {
    rows.push(row);
    onRow(row);
  };
  const { timed, timeLeft } = createProcessRunner({ scheduler, env, runClaude, timeoutMs, deadline, now, out });

  // spec: RUN#prompt-cache-priming
  async function prime(agent) {
    const label = `${agent.key} (primer)`;
    const { result, envelope, outcome, waitedMs, ranMs, peakBytes, retries } = await primeRun({
      timed,
      label,
      prompt: prompts[agent.key],
      model,
      timeoutMs: primerTimeoutMs,
      logPath: join(logsDir, `${agent.key}-primer.json`),
      out,
    });
    logRun(out, { label, outcome, envelope, stderr: result.stderr });
    record({
      agent: agent.key,
      run: "primer",
      waitedMs,
      ranMs,
      peakBytes,
      retries,
      turns: envelope?.num_turns,
      cacheRead: cacheReadShare(envelope?.usage),
      outcome,
    });
  }

  // One attempt at a voter slot: the run itself, then its wrap-up resume when
  // it needs one. The slot is held across both, so a resume does not queue
  // behind fresh work while its session is still warm.
  async function attempt(agent, voter, attemptNumber, { minTimeMs } = {}) {
    const label =
      voters > 1 ? `${agent.key} voter ${voter}` : agent.key;
    const fullLabel =
      attemptNumber > 1 ? `${label} (attempt ${attemptNumber})` : label;
    const resultPath = join(resultsDir, resultFileName(agent.key, voter, voters));
    const logBase = join(logsDir, `${resultFileName(agent.key, voter, voters).replace(/-result\.json$/, "")}-attempt-${attemptNumber}`);

    const { result: settled, waitedMs, ranMs, peakBytes, retries } = await timed(
      fullLabel,
      (run) =>
        runWithWrapUp({
          run,
          prompt: prompts[agent.key],
          model,
          maxTurns,
          label: fullLabel,
          out,
        }),
      { minTimeMs },
    );
    const { result, envelope, stderr, wrappedUp } = settled;

    // spec: RUN#wrap-up-retries-and-replacements
    // Written as soon as the attempt settles, so a later failure in the job
    // still leaves the orchestrator this result. A run with no envelope
    // writes one marking it failed; its raw output goes to the logs.
    if (envelope) {
      writeAtomic(resultPath, result.stdout);
    } else {
      writeAtomic(
        resultPath,
        failedEnvelope(result.notStarted ? "not_started" : result.timedOut ? "timed_out" : "no_result"),
      );
      if (result.rawTail) writeFileSync(`${logBase}.out`, result.rawTail);
    }

    // Classified from the file just written, by the parser consensus uses, so
    // the outcome matches what the review counts. A run stopped at its time
    // limit after it had already answered counts by its answer.
    let outcome;
    if (result.notStarted) {
      outcome = "not started";
    } else if (envelope && parseAgentResult(resultPath, agent.key, voters > 1 ? voter : undefined) !== null) {
      outcome = "usable";
    } else if (result.timedOut) {
      outcome = "timed out";
    } else if (!envelope) {
      outcome = "crashed";
    } else if (result.code !== 0 && envelope.subtype !== "error_max_turns") {
      outcome = "crashed";
    } else {
      outcome = "empty";
    }

    writeFileSync(`${logBase}.log`, stderr);
    const shown = wrappedUp ? `${outcome} after wrap-up` : outcome;
    logRun(out, { label: fullLabel, outcome: shown, envelope, stderr });
    record({
      agent: agent.key,
      run: voters > 1 ? `voter ${voter}` : "voter",
      attempt: attemptNumber,
      waitedMs,
      ranMs,
      peakBytes,
      retries,
      turns: envelope?.num_turns,
      cacheRead: cacheReadShare(envelope?.usage),
      outcome: shown,
    });
    return outcome;
  }

  // A slot gets one fresh run after its first, whether that first run crashed
  // or came back empty, as long as it is admitted with enough time left to be
  // useful. A timed-out run is not retried, so one slow voter cannot double
  // the length of the review.
  async function voterSlot(agent, voter) {
    const name = `${agent.key}${voters > 1 ? ` voter ${voter}` : ""}`;
    try {
      const first = await attempt(agent, voter, 1);
      if ((first === "crashed" || first === "empty") && timeLeft() < freshRunMinimum(timeoutMs)) {
        out(`::warning::Agent ${name} ${first}, with too little time left for a fresh run; it contributes nothing\n`);
      } else if (first === "crashed" || first === "empty") {
        const what = first === "crashed" ? "retrying it" : "replacing it with a fresh voter";
        out(`::warning::Agent ${name} ${first}; ${what}\n`);
        const second = await attempt(agent, voter, 2, { minTimeMs: freshRunMinimum(timeoutMs) });
        if (second !== "usable") {
          out(`::warning::Agent ${name} contributes nothing (${second})\n`);
        }
      } else if (first === "timed out" || first === "not started") {
        out(`::warning::Agent ${name} ${first} and contributes nothing\n`);
      }
    } catch (err) {
      // An unexpected error costs this voter, never the rest of the review.
      // A voter that wrote no result gets one marked failed, so it counts as
      // a failed run.
      out(`::warning::Agent ${name} failed unexpectedly and contributes nothing: ${err.message}\n`);
      const resultPath = join(resultsDir, resultFileName(agent.key, voter, voters));
      try {
        if (!existsSync(resultPath)) writeAtomic(resultPath, failedEnvelope("error"));
      } catch {
        // Nothing more to do: the voter already contributes nothing.
      }
      record({
        agent: agent.key,
        run: voters > 1 ? `voter ${voter}` : "voter",
        outcome: "error",
      });
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
      try {
        await primed.get(agent.key);
      } catch (err) {
        out(`::warning::${agent.key} (primer) failed unexpectedly: ${err.message}\n`);
      }
      await Promise.all(
        Array.from({ length: voters }, (_, voter) => voterSlot(agent, voter)),
      );
    }),
  );

  return rows;
}

// ── Main ─────────────────────────────────────────────────────────────────────

/**
 * Build each agent's prompt once, so all its runs send the same bytes. An
 * agent whose prompt cannot be read is left out with a warning, so one
 * misconfigured custom agent costs only itself.
 */
export function buildPrompts({ agents, reviewHeroDir, callerBaseDir, common, out = console.log }) {
  const basePrompt = readFileSync(join(reviewHeroDir, "prompts", "agent-prompt.md"), "utf-8");
  const prompts = {};
  for (const agent of agents) {
    let agentPrompt;
    try {
      agentPrompt = readFileSync(agentPromptPath(agent, { reviewHeroDir, callerBaseDir }), "utf-8");
    } catch (err) {
      out(`::warning::Skipping agent ${JSON.stringify(agent.key)}: cannot read its prompt (${err.message})`);
      continue;
    }
    prompts[agent.key] = buildReviewAgentPrompt({ ...common, basePrompt, agentPrompt });
  }
  return prompts;
}

async function main() {
  const agents = JSON.parse(getEnvOrThrow("AGENTS"));
  const voters = votersFromEnv();
  const maxTurns = parseInt(getEnvOrThrow("MAX_TURNS"));
  const resultsDir = getEnvOrThrow("RESULTS_DIR");
  mkdirSync(resultsDir, { recursive: true });
  const { reviewHeroDir, callerBaseDir, common, ...driver } = startDriver({
    maxTurns,
    defaultTimeoutMs: DEFAULT_PROCESS_TIMEOUT_MS,
    summaryTitle: "Review agent runs",
  });

  const prompts = buildPrompts({ agents, reviewHeroDir, callerBaseDir, common });
  const runnable = agents.filter((agent) => agent.key in prompts);
  for (const agent of runnable) {
    console.log(`Prompt for ${agent.key}: ${Buffer.byteLength(prompts[agent.key])} bytes`);
  }
  console.log(
    `Running ${runnable.length} agent(s) × ${voters} voter(s), ${driver.concurrency === Infinity ? "as many at once as memory and the provider allow" : `at most ${driver.concurrency} at once`}`,
  );

  await runAgents({ ...driver, agents: runnable, prompts, voters, maxTurns, resultsDir });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`::error::run-agents: ${err.message}`);
    process.exit(1);
  });
}
