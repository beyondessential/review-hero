/**
 * Review Hero — Triage
 *
 * 1. Reads the PR diff and strips ignored file patterns
 * 2. Discovers base agents (from review-hero prompts/) and custom agents
 *    (from the caller repo's .github/review-hero/)
 * 3. Asks the filter model which agents are relevant
 * 4. Picks the agents' model from the PR description
 * 5. Sets the voter count every agent runs, scaled to the diff
 * 6. Outputs agents, voters, max_turns, and agent_names for later steps
 *
 * Environment variables:
 *   DIFF_PATH           — Path to the raw PR diff file
 *   OPENROUTER_API_KEY  — OpenRouter API key
 *   REVIEW_HERO_DIR     — Path to the review-hero checkout (prompts/, scripts/)
 *   CALLER_REPO_DIR     — Path to the caller repo checkout at the trusted ref
 *   FILTERED_DIFF_PATH  — Where to write the filtered diff for agents to consume
 *   PR_BODY             — PR description, read for the model marker
 *   VOTERS              — Requested voters per agent, before scaling to the diff
 */

import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { chooseAgentModel, voterCountForDiff } from "./lib.mjs";
import {
  DEFAULT_IGNORE_PATTERNS,
  diffGitPath,
  filterDiff,
  loadCallerConfig,
  discoverBaseAgents,
  discoverCustomAgents,
} from "../src/index.mjs";
import {
  FILTER_MODEL,
  OPENROUTER_BASE_URL,
  openRouterHeaders,
} from "../src/openrouter.mjs";

// ── Helpers ──────────────────────────────────────────────────────────────────

function envOrDie(name) {
  const val = process.env[name];
  if (!val) {
    console.error(`Missing ${name}`);
    process.exit(1);
  }
  return val;
}


// ── Main ────────────────────────────────────────────────────────────────────

const diffPath = envOrDie("DIFF_PATH");
const apiKey = envOrDie("OPENROUTER_API_KEY");
const reviewHeroDir = envOrDie("REVIEW_HERO_DIR");
const callerDir = envOrDie("CALLER_REPO_DIR");
const filteredDiffPath = envOrDie("FILTERED_DIFF_PATH");

const config = loadCallerConfig(callerDir);
const rawDiff = readFileSync(diffPath, "utf-8");

// Merge ignore patterns
const ignorePatterns = [
  ...DEFAULT_IGNORE_PATTERNS,
  ...(config.ignore_patterns || []),
];

const { filtered: filteredDiff, removedFiles } = filterDiff(
  rawDiff,
  ignorePatterns,
);
writeFileSync(filteredDiffPath, filteredDiff);

if (removedFiles.length > 0) {
  console.log(
    `Filtered ${removedFiles.length} ignored file(s): ${removedFiles.join(", ")}`,
  );
}

// Extract changed file paths from the filtered diff
const changedFiles = filteredDiff
  .split("\n")
  .map(diffGitPath)
  .filter((path) => path !== null);

const diffLines = filteredDiff
  .split("\n")
  .filter((l) => l.startsWith("+") || l.startsWith("-")).length;

const maxTurns = 20;
const { model: agentModel, warning: modelWarning } = chooseAgentModel({
  body: process.env.PR_BODY,
});
if (modelWarning) console.log(`::warning::${modelWarning}`);

// Discover all agents
const baseAgents = discoverBaseAgents(reviewHeroDir);
const customAgents = discoverCustomAgents(callerDir, config);
const allAgents = [...baseAgents, ...customAgents];

// Ask the filter model which agents are relevant
const agentKeys = allAgents.map((a) => a.key);
const agentList = allAgents
  .map((a) => `- ${a.key}: ${a.description}`)
  .join("\n");

const triagePrompt = `You are triaging a PR for code review. Given the changed files below, decide which review agents are relevant. Only include agents that are likely to find issues for these specific changes. Always include "bugs".

## Available agents
${agentList}

## Changed files (${changedFiles.length} files, ~${diffLines} changed lines)
${changedFiles.join("\n")}`;

const selectAgentsTool = {
  name: "select_agents",
  description:
    "Select which review agents should run for this PR. Always include bugs.",
  input_schema: {
    type: "object",
    properties: {
      agents: {
        type: "array",
        items: { type: "string", enum: agentKeys },
        description: "Agent keys to run",
      },
    },
    required: ["agents"],
  },
};

let selectedKeys;
try {
  const response = await fetch(`${OPENROUTER_BASE_URL}/v1/messages`, {
    method: "POST",
    headers: openRouterHeaders(apiKey),
    body: JSON.stringify({
      model: FILTER_MODEL,
      max_tokens: 200,
      messages: [{ role: "user", content: triagePrompt }],
      tools: [selectAgentsTool],
      tool_choice: { type: "tool", name: "select_agents" },
    }),
  });

  if (!response.ok) {
    throw new Error(`API ${response.status}: ${await response.text()}`);
  }

  const result = await response.json();
  const toolUse = result.content.find((block) => block.type === "tool_use");

  if (!toolUse || !Array.isArray(toolUse.input?.agents)) {
    throw new Error(
      `Unexpected triage output: ${JSON.stringify(result.content)}`,
    );
  }

  selectedKeys = toolUse.input.agents;
} catch (err) {
  console.warn(`Triage failed, running all agents: ${err.message}`);
  selectedKeys = allAgents.map((a) => a.key);
}

// Ensure bugs is always included
if (!selectedKeys.includes("bugs")) {
  selectedKeys.unshift("bugs");
}

const selectedAgents = allAgents.filter((a) => selectedKeys.includes(a.key));

// Build agent_names map for the orchestrator
const agentNames = {};
for (const a of allAgents) {
  agentNames[a.key] = a.name;
}

// One voter count for every agent, scaled to the diff.
const rawVoters = Math.max(1, parseInt(process.env.VOTERS || "1") || 1);
const voters = voterCountForDiff(diffLines, rawVoters);
if (voters !== rawVoters) {
  console.log(
    `Voters set to ${voters} (requested ${rawVoters}) for a diff of ${diffLines} changed lines`,
  );
}

const agents = selectedAgents.map((a) => ({ key: a.key, source: a.source }));

console.log(
  `Diff: ${diffLines} changed lines across ${changedFiles.length} files`,
);
console.log(
  `Agents: ${selectedAgents.map((a) => a.key).join(", ")} (${selectedAgents.length}/${allAgents.length})`,
);
console.log(`Max turns: ${maxTurns}`);
console.log(`Model: ${agentModel}`);
console.log(
  `Voters: ${voters} per agent (${agents.length * voters} agent runs)`,
);

// Output for GitHub Actions
const outputFile = process.env.GITHUB_OUTPUT;
if (outputFile) {
  appendFileSync(outputFile, `agents=${JSON.stringify(agents)}\n`);
  appendFileSync(outputFile, `voters=${voters}\n`);
  appendFileSync(outputFile, `max_turns=${maxTurns}\n`);
  appendFileSync(outputFile, `agent_model=${agentModel}\n`);
  appendFileSync(outputFile, `agent_names=${JSON.stringify(agentNames)}\n`);
}
