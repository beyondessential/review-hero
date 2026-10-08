/**
 * Review Hero — Run agents
 *
 * Runs every selected agent's voters as parallel Claude CLI processes in one
 * job. The work is almost all waiting on the model, so one runner holds many
 * voters, and setup is paid once instead of per voter.
 *
 * Environment variables:
 *   AGENTS_JSON      — Triage's agent list: [{ key, source, voter }]
 *   AGENT_MODEL      — Model the agents run on
 *   AGENT_PROVIDER   — "anthropic" or "openrouter"
 *   MAX_TURNS        — Turn budget per voter
 *   PR_TITLE         — Pull request title
 *   PROJECT_CONTEXT  — Optional project description from the caller's config
 *   REVIEW_HERO_DIR  — Review Hero checkout (prompts/, scripts/)
 *   CALLER_BASE_DIR  — Caller config checked out at the trusted ref
 *   DIFF_PATH        — Filtered PR diff
 *   AI_RULES_PATH    — Repository AI rules (may be empty)
 *   RESULTS_DIR      — Where each voter's result JSON is written
 *   CONCURRENCY      — Claude processes running at once (default 8)
 */

import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ALLOWED_TOOLS = "Read,Glob,Grep,Bash(git log:*),Bash(git show:*),Bash(git diff:*)";
const VOTER_TIMEOUT_MS = 20 * 60 * 1000;
const WRAP_UP_TURNS = 3;
const WRAP_UP_PROMPT =
  "You are out of turns. Stop exploring and reply with only your final JSON array of findings, using what you have already confirmed (exactly [] if none).";

export function buildPrompt({ agent, reviewHeroDir, callerBaseDir, projectContext, aiRules, maxTurns, prTitle, diff }) {
  const softCap = maxTurns > 4 ? maxTurns - 3 : maxTurns - 1;
  const specialisation =
    agent.source === "base"
      ? readFileSync(join(reviewHeroDir, "prompts", `${agent.key}.md`), "utf8")
      : // Custom prompts come from the trusted ref so a PR cannot inject its own.
        readFileSync(join(callerBaseDir, ".github/review-hero/prompts", `${agent.key}.md`), "utf8");
  return [
    projectContext ? `## Project Context\n\n${projectContext}\n\n` : "",
    readFileSync(join(reviewHeroDir, "prompts/agent-prompt.md"), "utf8"),
    "\n\n",
    specialisation,
    aiRules
      ? `\n\n## Repository AI Rules\n\nThis repository defines the following AI coding rules. Follow them when reviewing.\n\n${aiRules}`
      : "",
    `\n\n## Turn budget\n\nYou have at most ${maxTurns} agent turns for this review, and every tool call spends one. Stop exploring by turn ${softCap} and spend the remainder writing up findings. Prioritise the highest-risk changes, sample files selectively rather than reading them end-to-end, and make your final message the JSON array (exactly \`[]\` if you found nothing). Returning fewer high-confidence findings on time beats being cut off mid-exploration with no output at all.\n`,
    `\n\n## PR Title\n\n${prTitle}\n\n## PR Diff\n\n\`\`\`diff\n`,
    diff,
    "```\n",
  ].join("");
}

export function limit(concurrency) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= concurrency || queue.length === 0) return;
    active++;
    const { task, resolve, reject } = queue.shift();
    task()
      .then(resolve, reject)
      .finally(() => {
        active--;
        next();
      });
  };
  return (task) =>
    new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject });
      next();
    });
}

function runClaude({ label, args, inputPath, input, outputPath }) {
  return new Promise((resolve) => {
    const stdin = inputPath ? openSync(inputPath, "r") : "pipe";
    const stdout = openSync(outputPath, "w");
    const child = spawn("claude", ["-p", ...args], { stdio: [stdin, stdout, "pipe"] });
    if (input !== undefined) child.stdin.end(input);
    child.stderr.on("data", (chunk) => {
      for (const line of chunk.toString().split("\n")) if (line) console.log(`[${label}] ${line}`);
    });
    const timer = setTimeout(() => {
      console.log(`::warning::${label} still running after ${VOTER_TIMEOUT_MS / 60000} minutes, stopping it`);
      child.kill("SIGTERM");
    }, VOTER_TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (typeof stdin === "number") closeSync(stdin);
      closeSync(stdout);
      resolve(code ?? 1);
    });
  });
}

function readResult(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

async function main() {
  const env = process.env;
  const agents = JSON.parse(env.AGENTS_JSON);
  const maxTurns = Number(env.MAX_TURNS);
  const model = env.AGENT_MODEL;
  const reviewHeroDir = env.REVIEW_HERO_DIR;
  const resultsDir = env.RESULTS_DIR;
  const aiRules = existsSync(env.AI_RULES_PATH) && statSync(env.AI_RULES_PATH).size > 0
    ? readFileSync(env.AI_RULES_PATH, "utf8")
    : "";
  mkdirSync(resultsDir, { recursive: true });
  const run = limit(Number(env.CONCURRENCY || 8));
  const baseArgs = [
    "--permission-mode", "dontAsk",
    "--output-format", "json",
    "--model", model,
    "--allowedTools", ALLOWED_TOOLS,
    "--exclude-dynamic-system-prompt-sections",
  ];
  const cacheStats = (path, ...flags) =>
    spawnSync("node", [join(reviewHeroDir, "scripts/cache-stats.mjs"), path, ...flags], { stdio: "inherit" });

  // Callers pick their own Node version, so no Map.groupBy.
  const byAgent = new Map();
  for (const agent of agents) byAgent.set(agent.key, [...(byAgent.get(agent.key) ?? []), agent]);
  const failed = [];

  async function runVoter(agent, promptPath) {
    const name = agent.voter ? `${agent.key}-voter-${agent.voter}` : agent.key;
    const resultPath = join(resultsDir, `${name}-result.json`);
    let code = await runClaude({
      label: name,
      args: [...baseArgs, "--max-turns", String(maxTurns)],
      inputPath: promptPath,
      outputPath: resultPath,
    });
    cacheStats(resultPath, "--label", name);

    // A capped voter has done its reading but written nothing, so resume its
    // session and ask for the findings it already has.
    let result = readResult(resultPath);
    if (code !== 0 && result.subtype === "error_max_turns" && result.session_id) {
      console.log(`::notice::${name} hit max-turns (${maxTurns}); resuming it to write up findings`);
      const resumedPath = `${resultPath}.resumed`;
      code = await runClaude({
        label: `${name} wrap-up`,
        args: ["--resume", result.session_id, ...baseArgs, "--max-turns", String(WRAP_UP_TURNS)],
        input: WRAP_UP_PROMPT,
        outputPath: resumedPath,
      });
      renameSync(resumedPath, resultPath);
      result = readResult(resultPath);
    }

    // Still capped: the orchestrator counts it as non-contributing.
    if (code !== 0 && result.subtype === "error_max_turns") {
      console.log(`::warning::${name} hit max-turns even after the wrap-up, skipping it`);
    } else if (code !== 0) {
      console.log(`::error::${name} exited with status ${code}`);
      failed.push(name);
    }
  }

  await Promise.all(
    [...byAgent].map(async ([key, voters]) => {
      const promptPath = join(resultsDir, `../prompt-${key}.md`);
      writeFileSync(
        promptPath,
        buildPrompt({
          agent: voters[0],
          reviewHeroDir,
          callerBaseDir: env.CALLER_BASE_DIR,
          projectContext: env.PROJECT_CONTEXT,
          aiRules,
          maxTurns,
          prTitle: env.PR_TITLE,
          diff: readFileSync(env.DIFF_PATH, "utf8"),
        }),
      );

      // Voters share a byte-identical prompt, so one request lands first to
      // write Anthropic's prompt cache and the rest read it. OpenRouter
      // models don't use that cache.
      if (voters.length > 1 && env.AGENT_PROVIDER === "anthropic") {
        const primePath = join(resultsDir, `../prime-${key}.json`);
        await run(() =>
          runClaude({
            label: `prime ${key}`,
            args: [...baseArgs, "--max-turns", "1"],
            inputPath: promptPath,
            outputPath: primePath,
          }),
        );
        cacheStats(primePath, "--label", `prime ${key}`, "--require-write");
      }
      await Promise.all(voters.map((voter) => run(() => runVoter(voter, promptPath))));
    }),
  );

  if (failed.length) {
    console.log(`::error::${failed.length} voter(s) failed: ${failed.join(", ")}`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
