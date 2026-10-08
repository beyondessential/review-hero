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
 *   MAX_TURNS        — Turn budget per voter
 *   PR_TITLE         — Pull request title
 *   PROJECT_CONTEXT  — Optional project description from the caller's config
 *   REVIEW_HERO_DIR  — Review Hero checkout (prompts/, scripts/)
 *   CALLER_BASE_DIR  — Caller config checked out at the trusted ref
 *   DIFF_PATH        — Filtered PR diff
 *   AI_RULES_PATH    — Repository AI rules (may be empty)
 *   RESULTS_DIR      — Where each voter's result JSON is written
 */

import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";

const CONCURRENCY = 8;
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

function runClaude(label, args, input, outputPath) {
  return new Promise((resolve) => {
    const stdout = openSync(outputPath, "w");
    const child = spawn("claude", ["-p", ...args], { stdio: ["pipe", stdout, "pipe"] });
    child.stdin.end(input);
    child.stderr.on("data", (chunk) => {
      for (const line of chunk.toString().split("\n")) if (line) console.log(`[${label}] ${line}`);
    });
    const timer = setTimeout(() => {
      console.log(`::warning::${label} still running after ${VOTER_TIMEOUT_MS / 60000} minutes, stopping it`);
      child.kill("SIGTERM");
    }, VOTER_TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
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
  const maxTurns = Number(env.MAX_TURNS);
  const args = [
    "--permission-mode", "dontAsk",
    "--output-format", "json",
    "--model", env.AGENT_MODEL,
    "--allowedTools", "Read,Glob,Grep,Bash(git log:*),Bash(git show:*),Bash(git diff:*)",
    "--exclude-dynamic-system-prompt-sections",
  ];
  const promptInputs = {
    reviewHeroDir: env.REVIEW_HERO_DIR,
    callerBaseDir: env.CALLER_BASE_DIR,
    projectContext: env.PROJECT_CONTEXT,
    aiRules: existsSync(env.AI_RULES_PATH) ? readFileSync(env.AI_RULES_PATH, "utf8") : "",
    maxTurns,
    prTitle: env.PR_TITLE,
    diff: readFileSync(env.DIFF_PATH, "utf8"),
  };
  mkdirSync(env.RESULTS_DIR, { recursive: true });
  const run = limit(CONCURRENCY);
  const failed = [];

  async function runVoter(agent) {
    const name = agent.voter ? `${agent.key}-voter-${agent.voter}` : agent.key;
    const resultPath = join(env.RESULTS_DIR, `${name}-result.json`);
    let code = await runClaude(name, [...args, "--max-turns", String(maxTurns)], buildPrompt({ agent, ...promptInputs }), resultPath);
    spawnSync("node", [join(env.REVIEW_HERO_DIR, "scripts/cache-stats.mjs"), resultPath, "--label", name], { stdio: "inherit" });

    // A capped voter has done its reading but written nothing, so resume its
    // session and ask for the findings it already has.
    let result = readResult(resultPath);
    if (code !== 0 && result.subtype === "error_max_turns" && result.session_id) {
      console.log(`::notice::${name} hit max-turns (${maxTurns}); resuming it to write up findings`);
      code = await runClaude(
        `${name} wrap-up`,
        ["--resume", result.session_id, ...args, "--max-turns", String(WRAP_UP_TURNS)],
        WRAP_UP_PROMPT,
        `${resultPath}.resumed`,
      );
      renameSync(`${resultPath}.resumed`, resultPath);
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

  await Promise.all(JSON.parse(env.AGENTS_JSON).map((agent) => run(() => runVoter(agent))));
  if (failed.length) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
