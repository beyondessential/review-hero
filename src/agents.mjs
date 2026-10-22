/**
 * Review Hero — Agent discovery
 *
 * Determines which review agents exist: the built-in base agents (backed by
 * this repo's prompts/) and any custom agents a caller repo defines under
 * .github/review-hero/. Shared so a consumer runs the same agent set this
 * repo does.
 */

import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

/** The built-in review agents, keyed by the prompt filename they load. */
export const BASE_AGENTS = {
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

/**
 * Agent keys must be safe for use in filenames, artifact names, and shell
 * interpolation. Allow only lowercase alphanumeric characters and hyphens.
 */
export const VALID_AGENT_KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Result files name a voter with a `-voter-<n>` suffix, so a key ending in one
 * would be read back as a different agent's voter.
 */
const RESERVED_KEY_SUFFIX = /-voter-\d+$/;

export function isValidAgentKey(key) {
  return VALID_AGENT_KEY.test(key) && !RESERVED_KEY_SUFFIX.test(key);
}

/**
 * Load the caller repo's Review Hero config (.github/review-hero/config.yml).
 * Returns {} when the file is absent or unparseable.
 */
export function loadCallerConfig(callerDir) {
  const configPath = join(callerDir, ".github", "review-hero", "config.yml");
  if (!existsSync(configPath)) return {};
  try {
    return parseYaml(readFileSync(configPath, "utf-8")) ?? {};
  } catch (err) {
    console.warn(`Failed to parse ${configPath}: ${err.message}`);
    return {};
  }
}

/**
 * Discover the base agents whose prompt file is present in the review-hero
 * checkout's prompts/ directory.
 */
export function discoverBaseAgents(reviewHeroDir) {
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

/**
 * Discover custom agents from the caller repo's .github/review-hero/prompts/
 * directory, taking names and descriptions from `config` where provided.
 */
export function discoverCustomAgents(callerDir, config) {
  const promptsDir = join(callerDir, ".github", "review-hero", "prompts");
  if (!existsSync(promptsDir)) return [];

  const agents = [];
  const configAgents = config.agents || {};

  for (const file of readdirSync(promptsDir)) {
    if (!file.endsWith(".md")) continue;
    const key = file.replace(/\.md$/, "");

    if (!isValidAgentKey(key)) {
      console.warn(
        `Skipping custom agent prompt "${file}": key "${key}" is invalid (must match ${VALID_AGENT_KEY} and not end in -voter-<n>)`,
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

/** The most reviewers a generated plan runs, so planning never costs more than the fixed agents. */
export const MAX_GENERATED_REVIEWERS = 4;
const MAX_KEY_CHARS = 40;
const MAX_NAME_CHARS = 60;
const MAX_FOCUS_CHARS = 2000;

/**
 * The agents a generated plan runs, in the order planned. A key naming an
 * available agent runs that agent as written; any other entry is a reviewer
 * the plan wrote, kept only when its key, name and focus are usable. The plan
 * comes from a model that read the PR, so its name is reduced to plain words
 * before it reaches a comment.
 */
export function resolveReviewerPlan(planned, available) {
  const byKey = new Map(available.map((a) => [a.key, a]));
  const chosen = new Map();
  for (const entry of Array.isArray(planned) ? planned : []) {
    if (chosen.size >= MAX_GENERATED_REVIEWERS) break;
    const key = typeof entry?.key === "string" ? entry.key : "";
    if (chosen.has(key)) continue;
    if (byKey.has(key)) {
      chosen.set(key, byKey.get(key));
      continue;
    }
    const name = typeof entry?.name === "string"
      ? entry.name.replace(/[^\p{L}\p{N} &-]/gu, "").replace(/\s+/g, " ").trim().slice(0, MAX_NAME_CHARS)
      : "";
    const focus = typeof entry?.focus === "string" ? entry.focus.trim().slice(0, MAX_FOCUS_CHARS) : "";
    if (key.length > MAX_KEY_CHARS || !isValidAgentKey(key) || !name || !focus) continue;
    chosen.set(key, { key, name, description: focus, source: "generated", focus });
  }
  return [...chosen.values()];
}
