/**
 * Review Hero — Second look
 *
 * Where consensus named contested areas, runs fresh checkers of the area's
 * agent over its contested findings. Each checker confirms or rejects each
 * finding, and every confirmation counts as a vote: a finding whose voters and
 * confirming checkers together reach the majority moves from dropped to kept.
 * The updated outcome is written back over the consensus file, so a second
 * look that fails or runs out of time leaves consensus as it stood.
 *
 * Environment variables:
 *   CONSENSUS_PATH      — Consensus outcome, read and rewritten
 *   AGENTS              — JSON array of { key, source } from triage
 *   AGENT_MODEL         — Model the checkers run on
 *   AGENT_PROVIDER      — "anthropic" or "openrouter"
 *   CONCURRENCY         — Most checker processes running at once (0 or unset: no ceiling)
 *   LOGS_DIR            — Where per-checker output goes
 *   REVIEW_HERO_DIR     — review-hero checkout (checker and base prompts)
 *   CALLER_BASE_DIR     — Caller checkout at the trusted ref (custom prompts)
 *   DIFF_PATH           — Filtered PR diff
 *   AI_RULES_PATH       — Repository AI rules (optional)
 *   PROJECT_CONTEXT     — Project context line (optional)
 *   PR_TITLE            — PR title
 *   CHECKER_MAX_TURNS   — Turn cap per checker (default 10)
 *   PROCESS_TIMEOUT_MS  — Time limit per checker process (default 6 minutes)
 *   TIME_BUDGET_MS      — Time the whole second look has, a little inside the
 *                         step's limit; process limits are cut to what is left (optional)
 *   GITHUB_STEP_SUMMARY — Job summary file (optional)
 */

// spec: RUN#second-look

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  agentPromptPath,
  cacheReadShare,
  createProcessRunner,
  logGroup,
  oneLine,
  primeRun,
  PRIMER_TIMEOUT_MS,
  runOutput,
  runWithWrapUp,
  WRAP_UP_TIMEOUT_MS,
  spawnClaude,
  startDriver,
} from "./agent-process.mjs";
import { writeConsensus } from "./consensus.mjs";
import { getEnvOrThrow } from "./lib.mjs";
import { ceilingFor, createScheduler, linuxMemoryProbe } from "./scheduler.mjs";
import { buildCheckerPrompt, extractJsonArray } from "../src/index.mjs";

export const DEFAULT_CHECKER_MAX_TURNS = 10;
/**
 * Time limit per checker process. Each is also cut to what is left of the
 * second look's time budget, so none outlasts the step.
 */
export const DEFAULT_CHECKER_TIMEOUT_MS = 6 * 60 * 1000;

const CHECKER_WRAP_UP_MESSAGE =
  "Stop exploring and reply with only your final JSON array of verdicts, one per finding, using what you have already checked. No other text.";

/**
 * How many checkers an area gets: as many as a finding from a single voter
 * needs to reach the majority, so unanimous confirmation can carry it.
 */
export function checkersPerArea(voters) {
  return Math.floor(voters / 2);
}

/**
 * Count, for each of `groupCount` findings, how many checkers confirmed it.
 * Each checker's answer is a JSON array of `{ finding, verdict }`; anything
 * else, or no verdict, counts as a rejection, and a checker counts once per
 * finding however often it repeats itself.
 */
export function tallyConfirmations(answers, groupCount) {
  const confirmations = new Array(groupCount).fill(0);
  for (const answer of answers) {
    const verdicts = typeof answer === "string" ? extractJsonArray(answer) : null;
    if (!verdicts) continue;
    const confirmed = new Set();
    for (const v of verdicts) {
      // Only an integer counts: coercing null, "" or false would read as
      // finding 0 and confirm it.
      const index = v?.finding;
      if (
        Number.isInteger(index) &&
        index >= 0 &&
        index < groupCount &&
        String(v?.verdict).toLowerCase() === "confirm"
      ) {
        confirmed.add(index);
      }
    }
    for (const index of confirmed) confirmations[index]++;
  }
  return confirmations;
}

/**
 * Move every contested finding whose voters and confirming checkers reach the
 * majority from dropped to kept. `confirmationsByArea[i][j]` is the number of
 * checkers that confirmed group `j` of contested area `i`.
 */
export function applySecondLook(consensus, confirmationsByArea) {
  const threshold = Math.floor(consensus.voters / 2) + 1;
  const promoted = [];
  const removed = new Set();
  const contested = consensus.contested.map((area, i) => ({
    ...area,
    groups: area.groups.map((group, j) => {
      const confirmations = confirmationsByArea[i]?.[j] ?? 0;
      const confirmed = group.supporters + confirmations >= threshold;
      if (confirmed) {
        promoted.push(group.representative);
        for (const d of group.dropped) removed.add(d);
      }
      return { ...group, confirmations, confirmed };
    }),
  }));
  return {
    ...consensus,
    kept: [...consensus.kept, ...promoted],
    dropped: consensus.dropped.filter((_, i) => !removed.has(i)),
    contested,
    secondLook: promoted.length,
  };
}

/**
 * Run every contested area's checkers and tally their verdicts. `prompts[i]` is
 * contested area `i`'s checker prompt, or undefined when it could not be built.
 * Resolves with the confirmations per area and one summary row per checker.
 * `onProgress` receives the confirmations so far each time an area settles, so
 * they can be saved before the step's time limit cuts the rest short.
 */
export async function runSecondLook({
  consensus,
  prompts,
  model,
  provider = "anthropic",
  maxTurns,
  concurrency = Infinity,
  memory = linuxMemoryProbe(),
  logsDir,
  env,
  timeoutMs = DEFAULT_CHECKER_TIMEOUT_MS,
  runClaude = spawnClaude,
  out = (text) => process.stdout.write(text),
  onRow = () => {},
  onProgress = () => {},
  now = Date.now,
  deadline = Infinity,
  scheduler = createScheduler({
    ceiling: ceilingFor(concurrency, memory, (line) => out(`::warning::${line}\n`)),
    memory,
    now,
    log: (line) => out(`${line}\n`),
  }),
}) {
  const { timed } = createProcessRunner({ scheduler, env, runClaude, timeoutMs, deadline, now, out });
  const count = checkersPerArea(consensus.voters);
  const rows = [];
  const tallies = consensus.contested.map((area) => area.groups.map(() => 0));
  const record = (row) => {
    rows.push(row);
    onRow(row);
  };
  // Every checker of an area sends the same prompt, so with more than one an
  // area primes the cache first, as an agent's voters do.
  const priming = count > 1 && provider !== "openrouter";

  // spec: RUN#prompt-cache-priming
  async function prime(area, i) {
    const label = `${area.agent} area ${i} (primer)`;
    try {
      const { result, envelope, outcome, waitedMs, ranMs, peakBytes, retries } = await primeRun({
        timed,
        label,
        prompt: prompts[i],
        model,
        timeoutMs: Math.min(PRIMER_TIMEOUT_MS, timeoutMs),
        logPath: join(logsDir, `${area.agent}-area-${i}-primer.json`),
        out,
      });
      out(logGroup(`${label}: ${outcome}`, result.stderr));
      record({
        agent: area.agent,
        run: `area ${i} primer`,
        waitedMs,
        ranMs,
        peakBytes,
        retries,
        turns: envelope?.num_turns,
        cacheRead: cacheReadShare(envelope?.usage),
        outcome,
      });
    } catch (err) {
      // A primer that fails still releases its area's checkers.
      out(`::warning::${label} failed unexpectedly: ${err.message}\n`);
    }
  }

  const confirmationsByArea = await Promise.all(
    consensus.contested.map(async (area, i) => {
      if (!prompts[i]) return area.groups.map(() => 0);
      // Queued before any checker, since every area reaches this point
      // before the first await.
      if (priming) await prime(area, i);
      const answers = await Promise.all(
        Array.from({ length: count }, async (_, checker) => {
          const label = `${area.agent} area ${i} checker ${checker}`;
          try {
            const { result: checked, waitedMs, ranMs, peakBytes, retries } = await timed(label, (run) =>
              runWithWrapUp({
                run,
                prompt: prompts[i],
                model,
                maxTurns,
                label,
                out,
                wrapUpMessage: CHECKER_WRAP_UP_MESSAGE,
                wrapUpTimeoutMs: Math.min(WRAP_UP_TIMEOUT_MS, timeoutMs),
              }),
            );
            const { result, envelope, stderr, wrappedUp } = checked;
            writeFileSync(join(logsDir, `${area.agent}-area-${i}-checker-${checker}.json`), runOutput(result));
            const answer = typeof envelope?.result === "string" ? envelope.result : null;
            const verdicts = answer === null ? null : extractJsonArray(answer);
            // Verdicts count however the run ended, so one stopped at its
            // time limit after answering is reported by its answer.
            let outcome = result.notStarted
              ? "not started"
              : verdicts
                ? "answered"
                : result.timedOut
                  ? "timed out"
                  : "no verdicts";
            if (wrappedUp) outcome += " after wrap-up";
            out(logGroup(`${label}: ${outcome}`, [stderr.trimEnd(), answer ?? ""].filter(Boolean).join("\n")));
            record({
              agent: area.agent,
              run: `area ${i} checker ${checker}`,
              waitedMs,
              ranMs,
              peakBytes,
              retries,
              turns: envelope?.num_turns,
              cacheRead: cacheReadShare(envelope?.usage),
              outcome,
            });
            return answer;
          } catch (err) {
            // A checker that fails only withholds its votes.
            out(`::warning::${label} failed unexpectedly: ${err.message}\n`);
            record({ agent: area.agent, run: `area ${i} checker ${checker}`, outcome: "error" });
            return null;
          }
        }),
      );
      tallies[i] = tallyConfirmations(answers, area.groups.length);
      onProgress(tallies.map((tally) => [...tally]));
      return tallies[i];
    }),
  );

  return { confirmationsByArea, rows };
}

/**
 * Build each contested area's checker prompt from its agent's own prompt. An
 * area whose agent prompt cannot be read gets no checkers.
 */
export function buildCheckerPrompts({ consensus, agents, reviewHeroDir, callerBaseDir, common, out = console.log }) {
  const checkerPrompt = readFileSync(join(reviewHeroDir, "prompts", "checker-prompt.md"), "utf-8");
  const sources = new Map(agents.map((a) => [a.key, a.source]));
  return consensus.contested.map((area) => {
    let agentPrompt;
    try {
      const path = agentPromptPath({ key: area.agent, source: sources.get(area.agent) }, { reviewHeroDir, callerBaseDir });
      agentPrompt = readFileSync(path, "utf-8");
    } catch (err) {
      out(`::warning::No second look for ${JSON.stringify(area.agent)}: cannot read its prompt (${err.message})`);
      return undefined;
    }
    return buildCheckerPrompt({
      ...common,
      checkerPrompt,
      agentPrompt,
      area: area.area,
      findings: area.groups.map((g) => g.representative),
    });
  });
}

async function main() {
  const consensusPath = getEnvOrThrow("CONSENSUS_PATH");
  const consensus = JSON.parse(readFileSync(consensusPath, "utf-8"));
  if (consensus.contested.length === 0 || checkersPerArea(consensus.voters) === 0) {
    console.log("No contested areas; nothing to check");
    return;
  }

  const maxTurns = parseInt(process.env.CHECKER_MAX_TURNS || "") || DEFAULT_CHECKER_MAX_TURNS;
  const { reviewHeroDir, callerBaseDir, common, ...driver } = startDriver({
    maxTurns,
    defaultTimeoutMs: DEFAULT_CHECKER_TIMEOUT_MS,
    summaryTitle: "Second look",
  });
  const prompts = buildCheckerPrompts({
    consensus,
    agents: JSON.parse(getEnvOrThrow("AGENTS")),
    reviewHeroDir,
    callerBaseDir,
    common,
  });

  const { confirmationsByArea } = await runSecondLook({
    ...driver,
    consensus,
    prompts,
    maxTurns,
    // Each settled area's verdicts are saved straight away, so they count
    // even when the step's time limit stops the areas still running.
    onProgress: (partial) => writeConsensus(consensusPath, applySecondLook(consensus, partial)),
  });

  const updated = applySecondLook(consensus, confirmationsByArea);
  for (const area of updated.contested) {
    for (const group of area.groups) {
      const f = group.representative;
      console.log(
        `${area.agent} ${oneLine(f.file)}:${oneLine(f.line)}: ${group.supporters} voter(s) + ${group.confirmations} checker(s) → ${group.confirmed ? "kept" : "dropped"}`,
      );
    }
  }
  console.log(`Second look confirmed ${updated.secondLook} finding(s)`);
  writeConsensus(consensusPath, updated);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`::error::run-checkers: ${err.message}`);
    process.exit(1);
  });
}
