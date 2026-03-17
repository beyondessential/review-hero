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
 *   APP_SLUG            — GitHub App slug (for git commit identity, default: review-hero)
 *   MODEL               — Model to use (default: claude-sonnet-4-6)
 *   PROMPT_PATH         — Path to the auto-merge conflict resolution prompt
 *   PROJECT_CONTEXT     — Optional project context string
 *   CUSTOM_RULES_PATH   — Optional path to repo-specific rules
 *   AI_RULES_PATH       — Optional path to AI rules file
 *   BASE_SHA            — Base branch SHA to merge from
 *   BASE_REF            — Base branch name (for commit messages)
 */

import { execSync, execFileSync } from "node:child_process";
import * as core from "@actions/core";
import {
  getEnvOrThrow,
  createGitHubApi,
  configureGitIdentity,
  hasChanges,
  createCommit,
  pushChanges,
  excludeReviewHero,
  restoreReviewHero,
  runClaude,
  parseClaudeResult,
  buildBasePromptSections,
  copyCommitHelper,
  workflowLogsUrl,
} from "./lib.mjs";

// ── Config ───────────────────────────────────────────────────────────────────

const token = getEnvOrThrow("GITHUB_TOKEN");
const repo = getEnvOrThrow("GITHUB_REPOSITORY");
const prNumber = getEnvOrThrow("PR_NUMBER");

if (!/^\d+$/.test(prNumber)) {
  throw new Error("Invalid PR number — must be numeric");
}

const appId = process.env.REVIEW_HERO_APP_ID ?? "";
const appSlug = process.env.APP_SLUG || "review-hero";
const model = process.env.MODEL ?? "claude-sonnet-4-6";
const promptPath = getEnvOrThrow("PROMPT_PATH");
const projectContext = process.env.PROJECT_CONTEXT ?? "";
const customRulesPath = process.env.CUSTOM_RULES_PATH ?? "";
const aiRulesPath = process.env.AI_RULES_PATH ?? "";
const baseSha = getEnvOrThrow("BASE_SHA");
const baseRef = process.env.BASE_REF ?? "base branch";

const gh = createGitHubApi(token, repo);

// ── Merge operations ─────────────────────────────────────────────────────────

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
    // Exit code 1 means merge conflicts; anything else is a real failure
    if (err.status === 1) {
      const conflicted = getConflictedFiles();
      if (conflicted.length > 0) {
        return { conflicts: true, files: conflicted };
      }
    }
    throw new Error(`Merge failed: ${err.stderr || err.message}`);
  }
}

// ── Prompt building ──────────────────────────────────────────────────────────

function buildPrompt(conflictedFiles, { commitHelperPath } = {}) {
  const sections = buildBasePromptSections({
    projectContext,
    promptPath,
    commitHelperPath,
    customRulesPath,
    aiRulesPath,
    aiRulesLabel: "Follow them when resolving conflicts.",
  });

  const fileList = conflictedFiles
    .map((f, i) => `### Conflict #${i + 1}: \`${f}\``)
    .join("\n\n");
  sections.push(
    `## Conflicted Files (${conflictedFiles.length})\n\nThe following files have merge conflict markers that need resolution:\n\n${fileList}`,
  );

  return sections.join("\n\n");
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  excludeReviewHero();
  configureGitIdentity(appId, appSlug);

  console.log(`Auto-merging ${baseRef} into PR #${prNumber}`);

  const mergeResult = attemptMerge();

  if (!mergeResult.conflicts) {
    console.log("Merge completed cleanly — no conflicts");
    pushChanges();
    await gh.postComment(
      prNumber,
      `🦸 **Review Hero Auto-Merge** — Merged \`${baseRef}\` cleanly, no conflicts.`,
    );
    await gh.uncheckCheckbox(prNumber, "Auto-merge upstream", "#auto-merge");
    return;
  }

  const conflictedFiles = mergeResult.files;
  console.log(
    `Merge has ${conflictedFiles.length} conflicted file${conflictedFiles.length === 1 ? "" : "s"}: ${conflictedFiles.join(", ")}`,
  );

  const commitHelperPath = copyCommitHelper(prNumber);

  const prompt = buildPrompt(conflictedFiles, { commitHelperPath });
  const headBefore = execSync("git rev-parse HEAD", {
    encoding: "utf-8",
  }).trim();

  console.log("Running Claude to resolve conflicts...");
  let raw;
  try {
    const commitTool = `Bash(${commitHelperPath}:*)`;
    const gitLogTool = "Bash(git log:*)";
    raw = runClaude({
      prompt,
      model,
      tools: `Read,Edit,Glob,Grep,${commitTool},${gitLogTool}`,
      prNumber,
    });
  } catch (err) {
    console.error(`Claude failed: ${err.message}`);
    restoreReviewHero();

    const headAfterFailure = execSync("git rev-parse HEAD", {
      encoding: "utf-8",
    }).trim();
    const logsUrl = workflowLogsUrl(repo);

    if (headBefore !== headAfterFailure) {
      console.log(
        "Claude failed but made commits before failing — pushing partial fixes",
      );
      pushChanges();
      await gh.postComment(
        prNumber,
        `🦸 **Review Hero Auto-Merge** partially resolved conflicts before failing. ` +
          `Some resolutions were pushed, but the session did not finish.\n\n` +
          `Check the [workflow logs](${logsUrl}) for details.`,
      );
    } else {
      execSync("git merge --abort 2>/dev/null || true");
      await gh.postComment(
        prNumber,
        `🦸 **Review Hero Auto-Merge** failed — check the [workflow logs](${logsUrl}) for details.`,
      );
    }
    await gh.uncheckCheckbox(prNumber, "Auto-merge upstream", "#auto-merge");
    process.exit(1);
  }

  restoreReviewHero();

  const results = parseClaudeResult(raw);

  if (results.length > 0) {
    core.info("Auto-merge results:");
    for (const r of results) {
      const icon = r.status === "resolved" ? "✅" : "⏭️";
      const detail = r.status === "resolved" ? r.summary : r.reason;
      core.info(`  ${icon} #${r.id} ${r.file ?? ""} [${r.status}] ${detail ?? ""}`);
    }
  }

  // Check for remaining conflict markers
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

  // If conflict markers remain, abort — don't commit broken code
  if (remainingConflicts.length > 0) {
    execSync("git merge --abort 2>/dev/null || true");
    const logsUrl = workflowLogsUrl(repo);
    await gh.postComment(
      prNumber,
      `🦸 **Review Hero Auto-Merge** could not fully resolve all conflicts.\n\n` +
        `⚠️ Conflict markers still present in: ${remainingConflicts.map((f) => `\`${f}\``).join(", ")}. These need manual resolution.\n\n` +
        `[View logs](${logsUrl})`,
    );
    await gh.uncheckCheckbox(prNumber, "Auto-merge upstream", "#auto-merge");
    process.exit(1);
  }

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

  const logsUrl = workflowLogsUrl(repo);
  if (process.env.GITHUB_RUN_ID) {
    summaryParts.push(`\n\n[View logs](${logsUrl})`);
  }

  await gh.postComment(prNumber, summaryParts.join(""));
  await gh.uncheckCheckbox(prNumber, "Auto-merge upstream", "#auto-merge");
  console.log("Done");
}

main().catch(async (err) => {
  console.error(err);
  try {
    execSync("git merge --abort 2>/dev/null || true");
    await gh.postComment(
      prNumber,
      `🦸 **Review Hero Auto-Merge** failed — check the [workflow logs](${workflowLogsUrl(repo)}) for details.`,
    );
    await gh.uncheckCheckbox(prNumber, "Auto-merge upstream", "#auto-merge");
  } catch {
    // best effort
  }
  process.exit(1);
});
