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
 *   CONCURRENCY         — Most checker processes running at once (0 or unset: no ceiling)
 *   LOGS_DIR            — Where per-checker output goes
 *   REVIEW_HERO_DIR     — review-hero checkout (checker and base prompts)
 *   CALLER_BASE_DIR     — Caller checkout at the trusted ref (custom prompts)
 *   DIFF_PATH           — Filtered PR diff
 *   AI_RULES_PATH       — Repository AI rules (optional)
 *   PROJECT_CONTEXT     — Project context line (optional)
 *   PR_TITLE            — PR title
 *   CHECKER_MAX_TURNS   — Turn cap per checker (default 10)
 *   PROCESS_TIMEOUT_MS  — Time limit per checker process (default 10 minutes)
 *   GITHUB_STEP_SUMMARY — Job summary file (optional)
 */

// spec: RUN#second-look

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  agentEnv,
  cacheReadShare,
  runWithWrapUp,
  spawnClaude,
  summaryHeader,
  summaryRow,
} from "./run-agents.mjs";
import { writeConsensus } from "./consensus.mjs";
import { createScheduler, linuxMemoryProbe, parseCeiling } from "./scheduler.mjs";
import { buildCheckerPrompt, extractJsonArray, isValidAgentKey } from "../src/index.mjs";

export const DEFAULT_CHECKER_MAX_TURNS = 10;
export const DEFAULT_CHECKER_TIMEOUT_MS = 10 * 60 * 1000;

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
      const index = Number(v?.finding);
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
 */
export async function runSecondLook({
  consensus,
  prompts,
  model,
  maxTurns,
  concurrency = Infinity,
  memory = linuxMemoryProbe(),
  logsDir,
  env,
  timeoutMs = DEFAULT_CHECKER_TIMEOUT_MS,
  runClaude = spawnClaude,
  out = (text) => process.stdout.write(text),
  onRow = () => {},
  now = Date.now,
  scheduler = createScheduler({ ceiling: concurrency, memory, now, log: (line) => out(`${line}\n`) }),
}) {
  const count = checkersPerArea(consensus.voters);
  const rows = [];

  const confirmationsByArea = await Promise.all(
    consensus.contested.map(async (area, i) => {
      if (!prompts[i]) return area.groups.map(() => 0);
      const answers = await Promise.all(
        Array.from({ length: count }, async (_, checker) => {
          const label = `${area.agent} area ${i} checker ${checker}`;
          try {
            const { result: settled, waitedMs, ranMs, peakBytes, retries } = await scheduler.withSlot((slot) => {
              out(`Started ${label}\n`);
              const run = (args, input) =>
                runClaude({
                  args,
                  input,
                  env,
                  timeoutMs,
                  onSpawn: slot.onSpawn,
                  onExit: slot.onExit,
                  onEvent: slot.onEvent,
                });
              return runWithWrapUp({
                run,
                prompt: prompts[i],
                model,
                maxTurns,
                label,
                out,
                wrapUpMessage: CHECKER_WRAP_UP_MESSAGE,
              });
            });
            const { result, envelope, stderr, wrappedUp } = settled;
            writeFileSync(join(logsDir, `${area.agent}-area-${i}-checker-${checker}.json`), result.stdout);
            const answer = typeof envelope?.result === "string" ? envelope.result : null;
            const verdicts = answer === null ? null : extractJsonArray(answer);
            let outcome = result.timedOut ? "timed out" : verdicts ? "answered" : "no verdicts";
            if (wrappedUp) outcome += " after wrap-up";
            out(
              `::group::${label}: ${outcome}\n${stderr.trim() ? `${stderr.trimEnd()}\n` : ""}${answer ?? ""}\n::endgroup::\n`,
            );
            const row = {
              agent: area.agent,
              run: `area ${i} checker ${checker}`,
              waitedMs,
              ranMs,
              peakBytes,
              retries,
              turns: envelope?.num_turns,
              cacheRead: cacheReadShare(envelope?.usage),
              outcome,
            };
            rows.push(row);
            onRow(row);
            return answer;
          } catch (err) {
            // A checker that fails only withholds its votes.
            out(`::warning::${label} failed unexpectedly: ${err.message}\n`);
            const row = { agent: area.agent, run: `area ${i} checker ${checker}`, outcome: "error" };
            rows.push(row);
            onRow(row);
            return null;
          }
        }),
      );
      return tallyConfirmations(answers, area.groups.length);
    }),
  );

  return { confirmationsByArea, rows };
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function readOptional(path) {
  if (!path || !existsSync(path)) return "";
  return readFileSync(path, "utf-8");
}

/**
 * Build each contested area's checker prompt from its agent's own prompt. An
 * area whose agent prompt cannot be read gets no checkers.
 */
export function buildCheckerPrompts({ consensus, agents, reviewHeroDir, callerBaseDir, common, out = console.log }) {
  const checkerPrompt = readFileSync(join(reviewHeroDir, "prompts", "checker-prompt.md"), "utf-8");
  const sources = new Map(agents.map((a) => [a.key, a.source]));
  return consensus.contested.map((area) => {
    if (!isValidAgentKey(area.agent)) {
      out(`::warning::No second look for invalid agent key ${JSON.stringify(area.agent)}`);
      return undefined;
    }
    // Custom prompts come from the trusted ref, so a PR cannot inject one.
    const agentPromptPath =
      sources.get(area.agent) === "base"
        ? join(reviewHeroDir, "prompts", `${area.agent}.md`)
        : join(callerBaseDir, ".github", "review-hero", "prompts", `${area.agent}.md`);
    let agentPrompt;
    try {
      agentPrompt = readFileSync(agentPromptPath, "utf-8");
    } catch (err) {
      out(`::warning::No second look for ${area.agent}: cannot read its prompt (${err.message})`);
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
  const consensusPath = requireEnv("CONSENSUS_PATH");
  const consensus = JSON.parse(readFileSync(consensusPath, "utf-8"));
  if (consensus.contested.length === 0 || checkersPerArea(consensus.voters) === 0) {
    console.log("No contested areas; nothing to check");
    return;
  }

  const logsDir = requireEnv("LOGS_DIR");
  mkdirSync(logsDir, { recursive: true });
  const maxTurns = parseInt(process.env.CHECKER_MAX_TURNS || "") || DEFAULT_CHECKER_MAX_TURNS;

  const prompts = buildCheckerPrompts({
    consensus,
    agents: JSON.parse(requireEnv("AGENTS")),
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

  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) appendFileSync(summaryPath, `\n${summaryHeader("Second look")}`);

  const { confirmationsByArea } = await runSecondLook({
    consensus,
    prompts,
    model: requireEnv("AGENT_MODEL"),
    maxTurns,
    concurrency: parseCeiling(process.env.CONCURRENCY),
    logsDir,
    env: agentEnv(process.env),
    timeoutMs: parseInt(process.env.PROCESS_TIMEOUT_MS || "") || DEFAULT_CHECKER_TIMEOUT_MS,
    onRow: summaryPath ? (row) => appendFileSync(summaryPath, summaryRow(row)) : undefined,
  });

  const updated = applySecondLook(consensus, confirmationsByArea);
  for (const area of updated.contested) {
    for (const group of area.groups) {
      const f = group.representative;
      console.log(
        `${area.agent} ${f.file}:${f.line}: ${group.supporters} voter(s) + ${group.confirmations} checker(s) → ${group.confirmed ? "kept" : "dropped"}`,
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
