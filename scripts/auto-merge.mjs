/**
 * Review Hero — Auto-Merge
 *
 * Merges the PR's base branch into the head branch. If there are merge
 * conflicts, pipes them to Claude CLI to resolve intelligently, then
 * commits and pushes the result.
 *
 * Environment variables:
 *   GITHUB_TOKEN        — GitHub token (with contents:write, pull-requests:write)
 *   GITHUB_REPOSITORY   — owner/repo
 *   PR_NUMBER           — Pull request number
 *   ANTHROPIC_API_KEY   — API key for Claude CLI
 *   REVIEW_HERO_APP_ID  — App ID for git commit identity
 *   MODEL               — Model to use (default: claude-sonnet-4-6)
 *   PROMPT_PATH         — Path to the auto-merge conflict resolution prompt
 *   PROJECT_CONTEXT     — Optional project context string
 *   CUSTOM_RULES_PATH   — Optional path to repo-specific rules
 *   BASE_SHA            — Base branch SHA to merge from
 *   BASE_REF            — Base branch name (for commit messages)
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync, chmodSync } from "node:fs";
import { execSync, execFileSync } from "node:child_process";
import * as core from "@actions/core";

// ── Helpers ──────────────────────────────────────────────────────────────────

function getEnvOrThrow(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

const token = getEnvOrThrow("GITHUB_TOKEN");
const repo = getEnvOrThrow("GITHUB_REPOSITORY");
const prNumber = getEnvOrThrow("PR_NUMBER");

if (!/^\d+$/.test(prNumber)) {
  throw new Error("Invalid PR number — must be numeric");
}

const appId = process.env.REVIEW_HERO_APP_ID ?? "";
const model = process.env.MODEL ?? "claude-sonnet-4-6";
const promptPath = getEnvOrThrow("PROMPT_PATH");
const projectContext = process.env.PROJECT_CONTEXT ?? "";
const customRulesPath = process.env.CUSTOM_RULES_PATH ?? "";
const aiRulesPath = process.env.AI_RULES_PATH ?? "";
const baseSha = getEnvOrThrow("BASE_SHA");
const baseRef = process.env.BASE_REF ?? "base branch";

// ── GitHub API ───────────────────────────────────────────────────────────────

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry(fn, attempts = 3) {
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

async function githubApi(endpoint, options = {}) {
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

async function postComment(body) {
  await githubApi(`/issues/${prNumber}/comments`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
}

async function uncheckCheckbox() {
  try {
    const pr = await githubApi(`/pulls/${prNumber}`);
    if (!pr.body) return;

    const updated = pr.body.replace(
      /\[x\]\s+\*\*Auto-merge upstream\*\* <!-- #auto-merge -->/,
      "[ ] **Auto-merge upstream** <!-- #auto-merge -->",
    );

    if (updated === pr.body) return;

    await githubApi(`/pulls/${prNumber}`, {
      method: "PATCH",
      body: JSON.stringify({ body: updated }),
    });
    console.log("Unchecked auto-merge checkbox");
  } catch (err) {
    console.warn(`Failed to uncheck checkbox: ${err.message}`);
  }
}

// ── Git operations ───────────────────────────────────────────────────────────

function configureGitIdentity() {
  if (appId && !/^\d+$/.test(appId)) {
    throw new Error("Invalid app ID");
  }

  const botName = "review-hero[bot]";
  const botEmail = appId
    ? `${appId}+review-hero[bot]@users.noreply.github.com`
    : "review-hero[bot]@users.noreply.github.com";

  execSync(`git config user.name "${botName}"`);
  execSync(`git config user.email "${botEmail}"`);
}

function hasChanges() {
  return Boolean(
    execSync("git status --porcelain --ignore-submodules", {
      encoding: "utf-8",
    }).trim(),
  );
}

function getConflictedFiles() {
  const output = execSync("git diff --name-only --diff-filter=U", {
    encoding: "utf-8",
  }).trim();
  return output ? output.split("\n").filter(Boolean) : [];
}

function attemptMerge() {
  try {
    execFileSync("git", ["merge", "--no-edit", baseSha], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { conflicts: false };
  } catch (err) {
    // Check if the failure was due to merge conflicts
    const conflicted = getConflictedFiles();
    if (conflicted.length > 0) {
      return { conflicts: true, files: conflicted };
    }
    // Some other merge failure
    throw new Error(`Merge failed: ${err.stderr || err.message}`);
  }
}

function createCommit(commitMessage) {
  configureGitIdentity();
  execSync("git add -A");
  execSync("git rm -rf --cached --ignore-unmatch .review-hero");
  execFileSync("git", ["commit", "-m", commitMessage]);
}

function pushChanges() {
  execSync("git push");
  console.log("Pushed auto-merge commits");
}

// ── Prompt building ──────────────────────────────────────────────────────────

function buildPrompt(conflictedFiles, { commitHelperPath } = {}) {
  const sections = [];

  if (projectContext) {
    sections.push(`## Project Context\n\n${projectContext}`);
  }

  let basePrompt = readFileSync(promptPath, "utf-8");
  if (commitHelperPath) {
    basePrompt = basePrompt.replaceAll(
      ".review-hero/scripts/git-commit-fix.mjs",
      commitHelperPath,
    );
  }
  sections.push(basePrompt);

  if (customRulesPath && existsSync(customRulesPath)) {
    sections.push(readFileSync(customRulesPath, "utf-8"));
  }

  if (aiRulesPath) {
    try {
      const aiRules = readFileSync(aiRulesPath, "utf-8").trim();
      if (aiRules) {
        sections.push(
          `## Repository AI Rules\n\nThis repository defines the following AI coding rules. Follow them when resolving conflicts.\n\n${aiRules}`,
        );
      }
    } catch {
      // No AI rules file — skip
    }
  }

  const fileList = conflictedFiles
    .map((f, i) => `### Conflict #${i + 1}: \`${f}\``)
    .join("\n\n");
  sections.push(
    `## Conflicted Files (${conflictedFiles.length})\n\nThe following files have merge conflict markers that need resolution:\n\n${fileList}`,
  );

  return sections.join("\n\n");
}

// ── Claude execution ─────────────────────────────────────────────────────────

function runClaude(prompt, { commitHelperPath } = {}) {
  if (!/^[a-z0-9.-]+$/.test(model)) {
    throw new Error(`Invalid model name: ${model}`);
  }

  const tmpPath = `/tmp/auto-merge-prompt-${prNumber}-${Date.now()}.md`;
  writeFileSync(tmpPath, prompt);

  if (!commitHelperPath) {
    throw new Error("commitHelperPath is required");
  }
  const commitTool = `Bash(${commitHelperPath}:*)`;
  const tools = `Read,Edit,Glob,Grep,${commitTool}`;

  const raw = execSync(
    `cat "${tmpPath}" | claude -p ` +
      `--output-format json ` +
      `--model "${model}" ` +
      `--max-turns 30 ` +
      `--allowedTools "${tools}"`,
    {
      encoding: "utf-8",
      timeout: 10 * 60 * 1000,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env },
    },
  );

  logClaudeSession(raw);
  return raw;
}

function logClaudeSession(raw) {
  try {
    const parsed = JSON.parse(raw);

    const stats = [];
    if (parsed.model) stats.push(`Model: ${parsed.model}`);
    if (parsed.num_turns != null) {
      if (parsed.max_turns != null) {
        stats.push(`Turns: ${parsed.num_turns} (of ${parsed.max_turns} max)`);
      } else {
        stats.push(`Turns: ${parsed.num_turns} (of 30 max)`);
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
    }
    if (stats.length > 0) {
      core.info(`Claude session: ${stats.join(" | ")}`);
    }

    const transcript = typeof parsed.result === "string" ? parsed.result : raw;
    core.startGroup("Claude auto-merge transcript");
    try {
      core.info(transcript);
    } finally {
      core.endGroup();
    }
  } catch {
    core.startGroup("Claude auto-merge output (raw)");
    try {
      core.info(raw);
    } finally {
      core.endGroup();
    }
  }
}

function parseClaudeResult(raw) {
  let text = raw;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.result)) return parsed.result;
    if (parsed.result) text = parsed.result;
    else if (Array.isArray(parsed)) return parsed;
  } catch {
    // Not valid JSON — search for embedded array
  }

  let searchFrom = 0;
  while (searchFrom < text.length) {
    const start = text.indexOf("[", searchFrom);
    if (start === -1) break;
    let searchEnd = text.length;
    while (searchEnd > start) {
      const end = text.lastIndexOf("]", searchEnd - 1);
      if (end <= start) break;
      try {
        const arr = JSON.parse(text.slice(start, end + 1));
        if (Array.isArray(arr)) return arr;
      } catch {
        // try shorter span
      }
      searchEnd = end;
    }
    searchFrom = start + 1;
  }

  return [];
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Exclude .review-hero from git tracking
  const excludePath = ".git/info/exclude";
  const excludeContent = execSync(`cat "${excludePath}" 2>/dev/null || true`, {
    encoding: "utf-8",
  });
  if (!excludeContent.includes(".review-hero")) {
    execSync(`mkdir -p .git/info && echo ".review-hero" >> "${excludePath}"`);
  }

  configureGitIdentity();

  console.log(`Auto-merging ${baseRef} into PR #${prNumber}`);

  // Attempt the merge
  const mergeResult = attemptMerge();

  if (!mergeResult.conflicts) {
    // Clean merge — no conflicts
    console.log("Merge completed cleanly — no conflicts");
    pushChanges();
    await postComment(
      `🦸 **Review Hero Auto-Merge** — Merged \`${baseRef}\` cleanly, no conflicts.`,
    );
    await uncheckCheckbox();
    return;
  }

  // There are conflicts — use Claude to resolve them
  const conflictedFiles = mergeResult.files;
  console.log(
    `Merge has ${conflictedFiles.length} conflicted file${conflictedFiles.length === 1 ? "" : "s"}: ${conflictedFiles.join(", ")}`,
  );

  // Copy the commit helper to /tmp so Claude cannot modify it
  const commitHelperSrc = ".review-hero/scripts/git-commit-fix.mjs";
  const commitHelperTmp = `/tmp/git-commit-fix-${prNumber}-${Date.now()}.mjs`;
  copyFileSync(commitHelperSrc, commitHelperTmp);
  chmodSync(commitHelperTmp, 0o755);

  const prompt = buildPrompt(conflictedFiles, {
    commitHelperPath: commitHelperTmp,
  });
  const headBefore = execSync("git rev-parse HEAD", {
    encoding: "utf-8",
  }).trim();

  console.log("Running Claude to resolve conflicts...");
  let raw;
  try {
    raw = runClaude(prompt, { commitHelperPath: commitHelperTmp });
  } catch (err) {
    console.error(`Claude failed: ${err.message}`);

    execSync("git checkout -- .review-hero/ 2>/dev/null || true");

    // Check if Claude made partial progress
    const headAfterFailure = execSync("git rev-parse HEAD", {
      encoding: "utf-8",
    }).trim();
    if (headBefore !== headAfterFailure) {
      console.log(
        "Claude failed but made commits before failing — pushing partial fixes",
      );
      pushChanges();
      await postComment(
        `🦸 **Review Hero Auto-Merge** partially resolved conflicts before failing. ` +
          `Some resolutions were pushed, but the session did not finish.\n\n` +
          `Check the [workflow logs](${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID ?? ""}) for details.`,
      );
    } else {
      // Abort the merge so the branch isn't left in a conflicted state
      execSync("git merge --abort 2>/dev/null || true");
      await postComment(
        `🦸 **Review Hero Auto-Merge** failed — check the [workflow logs](${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID ?? ""}) for details.`,
      );
    }
    await uncheckCheckbox();
    process.exit(1);
  }

  // Restore .review-hero/ in case Claude modified it
  execSync("git checkout -- .review-hero/ 2>/dev/null || true");

  const results = parseClaudeResult(raw);

  if (results.length > 0) {
    core.info("Auto-merge results:");
    for (const r of results) {
      const icon = r.status === "resolved" ? "✅" : "⏭️";
      const detail = r.status === "resolved" ? r.summary : r.reason;
      core.info(`  ${icon} #${r.id} ${r.file ?? ""} [${r.status}] ${detail ?? ""}`);
    }
  }

  // Check for any remaining conflict markers in the working tree
  const remainingConflicts = [];
  try {
    const grepResult = execSync(
      'git grep -l "^<<<<<<<" -- ":(exclude).review-hero" 2>/dev/null || true',
      { encoding: "utf-8" },
    ).trim();
    if (grepResult) {
      remainingConflicts.push(...grepResult.split("\n").filter(Boolean));
    }
  } catch {
    // No remaining conflicts
  }

  // Catch any remaining uncommitted changes
  if (hasChanges()) {
    createCommit(`merge: resolve conflicts from ${baseRef}`);
  }

  const headAfter = execSync("git rev-parse HEAD", {
    encoding: "utf-8",
  }).trim();
  const hasCommitsToPush = headBefore !== headAfter;

  if (hasCommitsToPush) {
    pushChanges();
  } else {
    console.log("No commits to push");
  }

  // Build summary
  const resolvedCount = results.filter((r) => r.status === "resolved").length;
  const skippedCount = results.filter((r) => r.status === "skipped").length;
  const summaryParts = [`🦸 **Review Hero Auto-Merge**\n`];

  if (hasCommitsToPush) {
    summaryParts.push(
      `Merged \`${baseRef}\` and resolved ${resolvedCount} conflict${resolvedCount === 1 ? "" : "s"}.`,
    );
  } else {
    summaryParts.push("No changes were needed.");
  }

  if (skippedCount > 0) {
    summaryParts.push(
      `\n\n⚠️ ${skippedCount} conflict${skippedCount === 1 ? " was" : "s were"} skipped and may need manual resolution.`,
    );
  }

  if (remainingConflicts.length > 0) {
    summaryParts.push(
      `\n\n⚠️ Conflict markers still present in: ${remainingConflicts.map((f) => `\`${f}\``).join(", ")}. These need manual resolution.`,
    );
  }

  const serverUrl = process.env.GITHUB_SERVER_URL ?? "https://github.com";
  const runId = process.env.GITHUB_RUN_ID;
  if (runId) {
    summaryParts.push(
      `\n\n[View logs](${serverUrl}/${repo}/actions/runs/${runId})`,
    );
  }

  await postComment(summaryParts.join(""));
  await uncheckCheckbox();
  console.log("Done");
}

main().catch(async (err) => {
  console.error(err);
  try {
    // Abort the merge if still in progress
    execSync("git merge --abort 2>/dev/null || true");
    const serverUrl = process.env.GITHUB_SERVER_URL ?? "https://github.com";
    const runId = process.env.GITHUB_RUN_ID;
    const logsUrl = runId
      ? `${serverUrl}/${repo}/actions/runs/${runId}`
      : `${serverUrl}/${repo}/actions`;
    await postComment(
      `🦸 **Review Hero Auto-Merge** failed — check the [workflow logs](${logsUrl}) for details.`,
    );
    await uncheckCheckbox();
  } catch {
    // best effort
  }
  process.exit(1);
});
