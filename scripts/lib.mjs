/**
 * Review Hero — Shared utilities
 *
 * Common helpers used by auto-fix and other action scripts.
 */

import { readFileSync, writeFileSync, copyFileSync, chmodSync } from "node:fs";
import { execSync, execFileSync } from "node:child_process";
import * as core from "@actions/core";

// Prompt assembly and result parsing live in the shared library so the
// Actions side and any external consumer share one implementation.
export { buildBasePromptSections, parseClaudeResult } from "../src/prompt.mjs";

// ── Constants ────────────────────────────────────────────────────────────────

/** Maximum number of voters allowed per agent (matches GitHub Actions matrix limits). */
export const MAX_VOTERS = 10;

// ── Environment ──────────────────────────────────────────────────────────────

export function getEnvOrThrow(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

// ── GitHub API ───────────────────────────────────────────────────────────────

export async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry(fn, attempts = 3) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt < attempts - 1) {
        console.warn(`Attempt ${attempt + 1} failed, retrying: ${err.message}`);
        await sleep(1000 * (attempt + 1));
      } else {
        throw err;
      }
    }
  }
}

export function createGitHubApi(token, repo) {
  async function api(endpoint, options = {}) {
    const baseUrl = `https://api.github.com/repos/${repo}`;

    return withRetry(async () => {
      const response = await fetch(`${baseUrl}${endpoint}`, {
        ...options,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
          ...options.headers,
        },
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`GitHub API ${response.status}: ${body}`);
      }

      return response.json();
    });
  }

  async function graphql(query, variables) {
    return withRetry(async () => {
      const response = await fetch("https://api.github.com/graphql", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query, variables }),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`GitHub GraphQL ${response.status}: ${body}`);
      }

      const result = await response.json();
      if (result.errors) {
        throw new Error(`GraphQL errors: ${JSON.stringify(result.errors)}`);
      }
      return result.data;
    });
  }

  async function postComment(prNumber, body) {
    await api(`/issues/${prNumber}/comments`, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
  }

  async function uncheckCheckboxes(prNumber, checkboxes) {
    try {
      const pr = await api(`/pulls/${prNumber}`);
      if (!pr.body) return;

      let updated = pr.body;
      const unchecked = [];
      for (const { label, anchor } of checkboxes) {
        const pattern = new RegExp(
          `\\[x\\]\\s+\\*\\*${escapeRegExp(label)}\\*\\* <!-- ${escapeRegExp(anchor)} -->`,
        );
        const replacement = `[ ] **${label}** <!-- ${anchor} -->`;
        const next = updated.replace(pattern, () => replacement);
        if (next !== updated) {
          updated = next;
          unchecked.push(label);
        }
      }

      if (updated === pr.body) return;

      await api(`/pulls/${prNumber}`, {
        method: "PATCH",
        body: JSON.stringify({ body: updated }),
      });
      for (const label of unchecked) console.log(`Unchecked ${label} checkbox`);
    } catch (err) {
      console.warn(`Failed to uncheck checkbox: ${err.message}`);
    }
  }

  async function uncheckCheckbox(prNumber, label, anchor) {
    return uncheckCheckboxes(prNumber, [{ label, anchor }]);
  }

  return { api, graphql, postComment, uncheckCheckboxes, uncheckCheckbox };
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── Git operations ───────────────────────────────────────────────────────────

export function configureGitIdentity(appId, appSlug) {
  if (appId && !/^\d+$/.test(appId)) {
    throw new Error("Invalid app ID");
  }

  const botName = `${appSlug}[bot]`;
  const botEmail = appId
    ? `${appId}+${appSlug}[bot]@users.noreply.github.com`
    : `${appSlug}[bot]@users.noreply.github.com`;

  execFileSync("git", ["config", "user.name", botName]);
  execFileSync("git", ["config", "user.email", botEmail]);
}

export function hasChanges() {
  return Boolean(
    execSync("git status --porcelain --ignore-submodules", {
      encoding: "utf-8",
    }).trim(),
  );
}

// Callers must invoke configureGitIdentity() before calling createCommit().
export function createCommit(commitMessage) {
  execSync("git add -A");
  // Remove .review-hero from the index — it's our tooling checkout, not part
  // of the caller's repo. Git sees it as a "subproject commit" because it
  // contains its own .git directory and we never want that committed.
  execSync("git rm -rf --cached --ignore-unmatch .review-hero");
  execFileSync("git", ["commit", "-m", commitMessage]);
}

function isNonFastForward(errMsg) {
  return /non-fast-forward|fetch first|cannot lock ref/i.test(errMsg);
}

export function pushChanges() {
  try {
    execSync("git push");
  } catch (pushErr) {
    const errMsg = pushErr.stderr?.toString() ?? pushErr.message ?? String(pushErr);
    if (!isNonFastForward(errMsg)) {
      throw pushErr;
    }
    console.warn("Push rejected (non-fast-forward) — pulling with rebase and retrying");
    const branch = execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf-8" }).trim();
    try {
      execFileSync("git", ["pull", "--rebase", "origin", branch]);
    } catch (rebaseErr) {
      try {
        execSync("git rebase --abort");
      } catch (abortErr) {
        console.warn(`git rebase --abort failed: ${abortErr.message}`);
      }
      throw rebaseErr;
    }
    execSync("git push");
  }
  console.log("Pushed changes");
}

export function excludeReviewHero() {
  const excludePath = ".git/info/exclude";
  const excludeContent = execSync(`cat "${excludePath}" 2>/dev/null || true`, {
    encoding: "utf-8",
  });
  if (!excludeContent.includes(".review-hero")) {
    execSync(`mkdir -p .git/info && echo ".review-hero" >> "${excludePath}"`);
  }
}

export function restoreReviewHero() {
  execSync("git checkout -- .review-hero/ 2>/dev/null || true");
}

// ── Claude execution ─────────────────────────────────────────────────────────

export function runClaude({ prompt, model, tools, prNumber, maxTurns = 30 }) {
  if (!/^[a-z0-9.-]+$/.test(model)) {
    throw new Error(`Invalid model name: ${model}`);
  }

  const tmpPath = `/tmp/review-hero-prompt-${prNumber}-${Date.now()}.md`;
  writeFileSync(tmpPath, prompt);

  const raw = execFileSync(
    "claude",
    [
      "-p",
      "--dangerously-skip-permissions",
      "--output-format", "json",
      "--model", model,
      "--max-turns", String(maxTurns),
      "--allowedTools", tools,
      // Keeps per-machine detail (cwd, env info, git status) out of the system
      // prompt so the cacheable prefix is stable across runners.
      "--exclude-dynamic-system-prompt-sections",
    ],
    {
      input: readFileSync(tmpPath, "utf-8"),
      encoding: "utf-8",
      timeout: 10 * 60 * 1000,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env },
    },
  );

  logClaudeSession(raw);
  return raw;
}

/**
 * Summarise prompt-cache usage for a session.
 *
 * `cache_read_input_tokens` are billed at a fraction of base input, while
 * `cache_creation_input_tokens` are billed at a premium — so the read share
 * is the number that tells us whether prefix sharing is actually working.
 * Without this, a cache hit and a cache miss look identical in the logs.
 */
export function formatCacheStats(usage) {
  if (!usage) return [];

  const read = usage.cache_read_input_tokens ?? 0;
  const written = usage.cache_creation_input_tokens ?? 0;
  if (read === 0 && written === 0) return [];

  const stats = [
    `Cache read: ${read.toLocaleString()}`,
    `Cache write: ${written.toLocaleString()}`,
  ];

  const cacheable = read + written;
  if (cacheable > 0) {
    stats.push(`Cache hit rate: ${Math.round((read / cacheable) * 100)}%`);
  }
  return stats;
}

export function logClaudeSession(raw, label = "Claude") {
  try {
    const parsed = JSON.parse(raw);

    const stats = [];
    if (parsed.model) stats.push(`Model: ${parsed.model}`);
    if (parsed.num_turns != null) {
      if (parsed.max_turns != null) {
        stats.push(`Turns: ${parsed.num_turns} (of ${parsed.max_turns} max)`);
      } else {
        stats.push(`Turns: ${parsed.num_turns}`);
      }
    }
    if (parsed.duration_ms != null) {
      const secs = (parsed.duration_ms / 1000).toFixed(1);
      stats.push(`Duration: ${secs}s`);
    }
    if (parsed.cost_usd != null) {
      stats.push("Cost: $" + Number(parsed.cost_usd).toFixed(4));
    }
    if (parsed.usage) {
      const u = parsed.usage;
      if (u.input_tokens != null)
        stats.push(`Input tokens: ${u.input_tokens.toLocaleString()}`);
      if (u.output_tokens != null)
        stats.push(`Output tokens: ${u.output_tokens.toLocaleString()}`);
      stats.push(...formatCacheStats(u));
    }
    if (stats.length > 0) {
      core.info(`${label} session: ${stats.join(" | ")}`);
    }

    const transcript = typeof parsed.result === "string" ? parsed.result : raw;
    core.startGroup(`${label} transcript`);
    try {
      core.info(transcript);
    } finally {
      core.endGroup();
    }
  } catch {
    core.startGroup(`${label} output (raw)`);
    try {
      core.info(raw);
    } finally {
      core.endGroup();
    }
  }
}

// ── Commit helper ────────────────────────────────────────────────────────────

export function copyCommitHelper(prNumber) {
  const src = ".review-hero/scripts/git-commit-fix.mjs";
  const dest = `/tmp/git-commit-fix-${prNumber}-${Date.now()}.mjs`;
  copyFileSync(src, dest);
  chmodSync(dest, 0o755);
  return dest;
}

// ── Workflow logs URL ────────────────────────────────────────────────────────

export function workflowLogsUrl(repo) {
  const rawServerUrl = process.env.GITHUB_SERVER_URL ?? "https://github.com";
  let serverUrl = "https://github.com";
  try {
    const parsed = new URL(rawServerUrl);
    if (parsed.protocol === "https:" && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(parsed.hostname)) {
      serverUrl = parsed.origin;
    }
  } catch {
    // Invalid URL — fall back to default
  }
  const rawRunId = process.env.GITHUB_RUN_ID;
  const runId = /^\d+$/.test(rawRunId ?? "") ? rawRunId : null;
  const safeRepo = /^[\w.-]+\/[\w.-]+$/.test(repo ?? "") ? repo : null;
  if (!safeRepo) return `${serverUrl}/actions`;
  return runId
    ? `${serverUrl}/${safeRepo}/actions/runs/${runId}`
    : `${serverUrl}/${safeRepo}/actions`;
}
