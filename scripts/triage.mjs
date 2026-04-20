/**
 * Review Hero — Triage
 *
 * 1. Reads the PR diff and strips ignored file patterns
 * 2. Discovers base agents (from review-hero prompts/) and custom agents
 *    (from the caller repo's .github/review-hero/)
 * 3. Calls Claude Haiku to select which agents are relevant
 * 4. Calculates max-turns based on filtered diff size
 * 5. Outputs matrix, max_turns, and agent_names for downstream jobs
 *
 * Environment variables:
 *   DIFF_PATH           — Path to the raw PR diff file
 *   ANTHROPIC_API_KEY   — API key for Claude
 *   ANTHROPIC_BASE_URL  — Optional custom base URL for the Anthropic API
 *   REVIEW_HERO_DIR     — Path to the review-hero checkout (prompts/, scripts/)
 *   CALLER_REPO_DIR     — Path to the caller repo checkout (workspace root)
 *   FILTERED_DIFF_PATH  — Where to write the filtered diff for agents to consume
 */

import {
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  appendFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { execSync } from "node:child_process";
import { MAX_VOTERS } from "./lib.mjs";

// ── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_IGNORE_PATTERNS = [
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "Cargo.lock",
  "go.sum",
  "composer.lock",
  "Gemfile.lock",
  "poetry.lock",
  "bun.lockb",
  "flake.lock",
  "*.generated.*",
];

const BASE_AGENTS = {
  bugs: {
    name: "Bugs & Correctness",
    description:
      "Logic errors, edge cases, null access, race conditions, concurrency, type mismatches, error handling",
  },
  performance: {
    name: "Performance",
    description:
      "Expensive loops, unbounded growth, N+1 queries, resource exhaustion, unnecessary allocations, missing pagination",
  },
  design: {
    name: "Design & Architecture",
    description:
      "Architecture, separation of concerns, wrong abstractions, DRY violations, over-engineering",
  },
  security: {
    name: "Security",
    description:
      "Injection, XSS, auth bypass, sensitive data exposure, input validation, path traversal, SSRF, hardcoded secrets",
  },
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function envOrDie(name) {
  const val = process.env[name];
  if (!val) {
    console.error(`Missing ${name}`);
    process.exit(1);
  }
  return val;
}

/**
 * Agent keys must be safe for use in filenames, artifact names, and shell
 * interpolation. Allow only lowercase alphanumeric characters and hyphens.
 */
const VALID_AGENT_KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function isValidAgentKey(key) {
  return VALID_AGENT_KEY.test(key);
}

/**
 * Rudimentary glob match — supports `*` (any within segment) and `**` (any
 * path depth).  Good enough for lockfile patterns; we don't need full minimatch.
 */
function globMatch(pattern, filePath) {
  // Direct basename match (e.g. "package-lock.json" matches "foo/package-lock.json")
  if (!pattern.includes("/") && !pattern.includes("**")) {
    const name = basename(filePath);
    return simpleWildcard(pattern, name);
  }
  // Path-based patterns with **
  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "__GLOBSTAR__")
    .replace(/\*/g, "[^/]*")
    .replace(/__GLOBSTAR__/g, ".*");
  return new RegExp(`^${regex}$`).test(filePath);
}

function simpleWildcard(pattern, str) {
  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${regex}$`).test(str);
}

/**
 * Split a unified diff into per-file sections and filter out ignored files.
 * Returns { filtered: string, removedFiles: string[] }.
 */
function filterDiff(rawDiff, patterns) {
  const sections = [];
  let current = null;

  for (const line of rawDiff.split("\n")) {
    const fileMatch = line.match(/^diff --git a\/.+ b\/(.+)$/);
    if (fileMatch) {
      if (current) sections.push(current);
      current = { file: fileMatch[1], lines: [line] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) sections.push(current);

  const removedFiles = [];
  const kept = [];

  for (const section of sections) {
    const dominated = patterns.some((p) => globMatch(p, section.file));
    if (dominated) {
      removedFiles.push(section.file);
    } else {
      kept.push(section.lines.join("\n"));
    }
  }

  return { filtered: kept.join("\n"), removedFiles };
}

// ── Config loading ──────────────────────────────────────────────────────────

function loadCallerConfig(callerDir) {
  const configPath = join(callerDir, ".github", "review-hero", "config.yml");
  if (!existsSync(configPath)) return {};
  try {
    const json = execSync(`yq -o=json '.' ${configPath}`, {
      encoding: "utf-8",
    });
    return JSON.parse(json);
  } catch (err) {
    console.warn(`Failed to parse ${configPath}: ${err.message}`);
    return {};
  }
}

// ── Agent discovery ─────────────────────────────────────────────────────────

function discoverBaseAgents(reviewHeroDir) {
  const promptsDir = join(reviewHeroDir, "prompts");
  const agents = [];

  for (const [key, meta] of Object.entries(BASE_AGENTS)) {
    const promptFile = `${key}.md`;
    const promptPath = join(promptsDir, promptFile);
    if (!existsSync(promptPath)) {
      console.warn(`Base prompt missing: ${promptPath}`);
      continue;
    }
    agents.push({
      key,
      name: meta.name,
      description: meta.description,
      source: "base",
    });
  }

  return agents;
}

function discoverCustomAgents(callerDir, config) {
  const promptsDir = join(callerDir, ".github", "review-hero", "prompts");
  if (!existsSync(promptsDir)) return [];

  const agents = [];
  const configAgents = config.agents || {};

  for (const file of readdirSync(promptsDir)) {
    if (!file.endsWith(".md")) continue;
    const key = file.replace(/\.md$/, "");

    if (!isValidAgentKey(key)) {
      console.warn(
        `Skipping custom agent prompt "${file}": key "${key}" is invalid (must match ${VALID_AGENT_KEY})`,
      );
      continue;
    }

    const meta = configAgents[key] || {};

    agents.push({
      key,
      name:
        meta.name ||
        key.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      description: meta.description || `Custom review agent: ${key}`,
      source: "custom",
    });
  }

  return agents;
}

// ── Main ────────────────────────────────────────────────────────────────────

const diffPath = envOrDie("DIFF_PATH");
const apiKey = envOrDie("ANTHROPIC_API_KEY");
const baseUrl = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
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
const changedFiles = [
  ...filteredDiff.matchAll(/^diff --git a\/.+ b\/(.+)$/gm),
].map((m) => m[1]);

const diffLines = filteredDiff
  .split("\n")
  .filter((l) => l.startsWith("+") || l.startsWith("-")).length;

// Choose model based on diff size — Opus for large PRs where deeper
// reasoning pays off, Sonnet for everything else.
const defaultModel = (process.env.DEFAULT_MODEL || "claude-sonnet-4-6").replace(
  /[\r\n]/g,
  "",
);
const OPUS_THRESHOLD = 500;
const agentModel =
  diffLines >= OPUS_THRESHOLD ? "claude-opus-4-6" : defaultModel;

// Scale max-turns with diff size.
const isOpus = agentModel.includes("opus");
let maxTurns;
if (diffLines < 100) {
  maxTurns = 3;
} else if (diffLines < OPUS_THRESHOLD) {
  maxTurns = 5;
} else {
  maxTurns = 10;
}

// Discover all agents
const baseAgents = discoverBaseAgents(reviewHeroDir);
const customAgents = discoverCustomAgents(callerDir, config);
const allAgents = [...baseAgents, ...customAgents];

// Ask Haiku which agents are relevant
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
  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
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

// Build matrix for the review-agent job
const rawVoters = Math.max(1, parseInt(process.env.VOTERS || "1") || 1);
if (rawVoters > MAX_VOTERS) {
  console.warn(
    `Voters capped at ${MAX_VOTERS} (requested ${rawVoters}) to stay within GitHub Actions matrix limits and control API cost`,
  );
}
const voters = Math.min(rawVoters, MAX_VOTERS);

const matrix = {
  agents:
    voters > 1
      ? selectedAgents.flatMap((a) =>
          Array.from({ length: voters }, (_, i) => ({
            key: a.key,
            source: a.source,
            voter: String(i),
          })),
        )
      : selectedAgents.map((a) => ({
          key: a.key,
          source: a.source,
          voter: "",
        })),
};

console.log(
  `Diff: ${diffLines} changed lines across ${changedFiles.length} files`,
);
console.log(
  `Agents: ${selectedAgents.map((a) => a.key).join(", ")} (${selectedAgents.length}/${allAgents.length})`,
);
console.log(`Max turns: ${maxTurns}`);
console.log(`Model: ${agentModel}${isOpus ? " (upgraded for large PR)" : ""}`);
if (voters > 1) {
  console.log(
    `Voters: ${voters} per agent (${matrix.agents.length} total jobs)`,
  );
}

// Output for GitHub Actions
const outputFile = process.env.GITHUB_OUTPUT;
if (outputFile) {
  appendFileSync(outputFile, `matrix=${JSON.stringify(matrix)}\n`);
  appendFileSync(outputFile, `max_turns=${maxTurns}\n`);
  appendFileSync(outputFile, `agent_model=${agentModel}\n`);
  appendFileSync(outputFile, `agent_names=${JSON.stringify(agentNames)}\n`);
}
