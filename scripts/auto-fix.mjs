/**
 * Review Hero — Auto-Fix
 *
 * Fetches unresolved review comments and/or CI failures from a PR,
 * pipes them to Claude CLI to apply fixes, then commits and pushes the result.
 *
 * Environment variables:
 *   GITHUB_TOKEN        — GitHub token (with contents:write, pull-requests:write, actions:read)
 *   GITHUB_REPOSITORY   — owner/repo
 *   PR_NUMBER           — Pull request number
 *   ANTHROPIC_API_KEY   — API key for Claude CLI
 *   REVIEW_HERO_APP_ID  — App ID for git commit identity
 *   APP_SLUG            — GitHub App slug (for git commit identity, default: review-hero)
 *   MODEL               — Model to use (default: claude-sonnet-4-6)
 *   FIX_REVIEWS         — 'true' to fix unresolved review comments
 *   FIX_CI              — 'true' to fix CI failures
 *   PROMPT_PATH         — Path to the base auto-fix prompt
 *   PROJECT_CONTEXT     — Optional project context string (e.g. "You are reviewing a PR for **Tamanu**, a healthcare management system.")
 *   CUSTOM_RULES_PATH   — Optional path to repo-specific rules to append to the prompt
 *   AI_RULES_PATH       — Optional path to AI rules file
 *   SELF_WORKFLOW        — Name of this workflow (to exclude from CI failure checks)
 */

import { execSync, execFileSync } from "node:child_process";
import * as core from "@actions/core";
import { buildLocalFixPrompt } from "./local-fix-prompt.mjs";
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
const fixReviews = process.env.FIX_REVIEWS === "true";
const fixCI = process.env.FIX_CI === "true";
const promptPath = getEnvOrThrow("PROMPT_PATH");
const projectContext = process.env.PROJECT_CONTEXT ?? "";
const customRulesPath = process.env.CUSTOM_RULES_PATH ?? "";
const aiRulesPath = process.env.AI_RULES_PATH ?? "";
const selfWorkflow = process.env.SELF_WORKFLOW ?? "Review Hero Auto-Fix";

const gh = createGitHubApi(token, repo);

// ── Data fetching ────────────────────────────────────────────────────────────

async function fetchUnresolvedComments() {
  const [owner, name] = repo.split("/");

  const data = await gh.graphql(
    `query($owner: String!, $repo: String!, $pr: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $pr) {
          reviewThreads(first: 100) {
            nodes {
              id
              isResolved
              isOutdated
              comments(first: 10) {
                nodes {
                  body
                  path
                  line
                  author {
                    login
                  }
                }
              }
            }
          }
        }
      }
    }`,
    { owner, repo: name, pr: parseInt(prNumber) },
  );

  const threads = data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
  const comments = [];

  for (const thread of threads) {
    if (thread.isResolved) continue;
    // Note: we intentionally don't skip outdated threads (thread.isOutdated).
    // Threads can be marked outdated by later commits even when the line itself
    // hasn't changed, so we still want to attempt fixes on them.
    if (!thread.id) continue;

    const firstComment = thread.comments?.nodes?.[0];
    if (!firstComment?.path) continue;

    const bodies = (thread.comments?.nodes ?? [])
      .map((c) => `${c.author?.login ?? "unknown"}: ${c.body ?? ""}`)
      .join("\n\n");

    comments.push({
      file: firstComment.path,
      line: firstComment.line,
      comment: bodies,
      threadId: thread.id,
    });
  }

  return comments;
}

const LOG_LINES_PER_JOB = 500;
const MAX_CI_LOG_CHARS = 50_000;

function stripAnsiAndTimestamps(log) {
  return (
    log
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\[[0-9;]*m/g, "")
      .replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z /gm, "")
  );
}

function truncateLog(log, maxLines) {
  const lines = log.split("\n");
  if (lines.length <= maxLines) return log;
  return (
    `... (${lines.length - maxLines} lines truncated)\n` +
    lines.slice(-maxLines).join("\n")
  );
}

async function fetchJobLog(jobId) {
  const response = await fetch(
    `https://api.github.com/repos/${repo}/actions/jobs/${jobId}/logs`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
      },
      redirect: "follow",
    },
  );

  if (!response.ok) {
    console.warn(`Failed to fetch log for job ${jobId}: ${response.status}`);
    return null;
  }

  return response.text();
}

async function fetchCIFailures() {
  const pr = await gh.api(`/pulls/${prNumber}`);
  const headSha = pr.head.sha;

  console.log(`Fetching CI failures for commit ${headSha.slice(0, 7)}`);

  const runsData = await gh.api(
    `/actions/runs?head_sha=${headSha}&per_page=100`,
  );
  const runs = (runsData.workflow_runs ?? []).filter(
    (r) => r.name !== selfWorkflow,
  );

  if (runs.length === 0) return [];

  console.log(
    `Checking ${runs.length} workflow run${runs.length === 1 ? "" : "s"} for failed jobs`,
  );

  const failures = [];
  let totalChars = 0;

  for (const run of runs) {
    const jobsData = await gh.api(
      `/actions/runs/${run.id}/jobs?filter=latest&per_page=100`,
    );
    const failedJobs = (jobsData.jobs ?? []).filter(
      (j) => j.conclusion === "failure",
    );

    for (const job of failedJobs) {
      if (totalChars >= MAX_CI_LOG_CHARS) break;

      const rawLog = await fetchJobLog(job.id);
      if (!rawLog) continue;

      const cleaned = stripAnsiAndTimestamps(rawLog);
      const truncated = truncateLog(cleaned, LOG_LINES_PER_JOB);
      const capped = truncated.slice(-(MAX_CI_LOG_CHARS - totalChars));
      totalChars += capped.length;

      failures.push({
        workflow: run.name,
        job: job.name,
        log: capped,
      });
    }
  }

  return failures;
}

// ── Prompt building ──────────────────────────────────────────────────────────

function buildPrompt(comments, ciFailures, { commitHelperPath } = {}) {
  const sections = buildBasePromptSections({
    projectContext,
    promptPath,
    commitHelperPath,
    customRulesPath,
    aiRulesPath,
    aiRulesLabel: "Follow them when applying fixes.",
  });

  if (comments.length > 0) {
    const commentsList = comments
      .map(
        (c, i) =>
          `### Comment #${i + 1}: \`${c.file}${c.line ? `:${c.line}` : ""}\`\n\n${c.comment}`,
      )
      .join("\n\n---\n\n");
    sections.push(
      `## Review Comments to Fix (${comments.length})\n\n${commentsList}`,
    );
  }

  if (ciFailures.length > 0) {
    const failuresList = ciFailures
      .map(
        (f, i) =>
          `### CI Failure #${comments.length + i + 1}: ${f.workflow} / ${f.job}\n\n\`\`\`\n${f.log}\n\`\`\``,
      )
      .join("\n\n---\n\n");
    sections.push(
      `## CI Failures to Fix (${ciFailures.length})\n\n${failuresList}`,
    );
  }

  return sections.join("\n\n");
}

// ── GitHub interactions ──────────────────────────────────────────────────────

async function resolveThread(threadId) {
  try {
    await gh.graphql(
      `mutation($threadId: ID!) {
        resolveReviewThread(input: { threadId: $threadId }) {
          thread { id }
        }
      }`,
      { threadId },
    );
  } catch (err) {
    console.warn(`Failed to resolve thread ${threadId}: ${err.message}`);
  }
}

async function replyToThread(threadId, body) {
  try {
    await gh.graphql(
      `mutation($threadId: ID!, $body: String!) {
        addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) {
          comment { id }
        }
      }`,
      { threadId, body },
    );
  } catch (err) {
    console.warn(`Failed to reply to thread ${threadId}: ${err.message}`);
  }
}

async function uncheckCheckboxes() {
  if (fixReviews) {
    await gh.uncheckCheckbox(prNumber, "Auto-fix review suggestions", "#auto-fix");
  }
  if (fixCI) {
    await gh.uncheckCheckbox(prNumber, "Auto-fix CI failures", "#auto-fix-ci");
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  excludeReviewHero();
  configureGitIdentity(appId, appSlug);

  console.log(
    `Auto-fixing PR #${prNumber} (reviews: ${fixReviews}, ci: ${fixCI})`,
  );

  const comments = fixReviews ? await fetchUnresolvedComments() : [];
  const ciFailures = fixCI ? await fetchCIFailures() : [];

  if (fixReviews) {
    console.log(
      `Found ${comments.length} unresolved review comment${comments.length === 1 ? "" : "s"}`,
    );
  }
  if (fixCI) {
    console.log(
      `Found ${ciFailures.length} CI failure${ciFailures.length === 1 ? "" : "s"}`,
    );
  }

  if (comments.length === 0 && ciFailures.length === 0) {
    await gh.postComment(prNumber, "🦸 **Review Hero Auto-Fix** — Nothing to fix.");
    await uncheckCheckboxes();
    return;
  }

  // Copy the commit helper to /tmp so Claude cannot modify it via the Edit
  // tool during the session — the Bash restriction only limits which scripts
  // can be *executed*, but Edit has unrestricted write access to the worktree.
  const commitHelperPath = copyCommitHelper(prNumber);

  const prompt = buildPrompt(comments, ciFailures, { commitHelperPath });
  const headBefore = execSync("git rev-parse HEAD", {
    encoding: "utf-8",
  }).trim();
  console.log("Running Claude to apply fixes...");
  let raw;
  try {
    // CI fixes need full Bash to run builds/tests/linters. Review-only fixes
    // get Bash scoped to the git-commit-fix helper so Claude can commit per-fix
    // without having unrestricted shell access.
    const commitTool = `Bash(${commitHelperPath}:*)`;
    const tools = fixCI
      ? "Read,Edit,Glob,Grep,Bash"
      : `Read,Edit,Glob,Grep,${commitTool}`;
    raw = runClaude({ prompt, model, tools, prNumber });
  } catch (err) {
    console.error(`Claude failed: ${err.message}`);
    restoreReviewHero();

    // Even though Claude failed/timed out, it may have already committed some
    // fixes via the git-commit-fix helper. Push those partial results rather
    // than discarding them — partial fixing is better than nothing.
    const headAfterFailure = execSync("git rev-parse HEAD", {
      encoding: "utf-8",
    }).trim();
    const logsUrl = workflowLogsUrl(repo);

    if (headBefore !== headAfterFailure) {
      console.log(
        "Claude failed but made commits before failing — pushing partial fixes",
      );
      pushChanges();
      // Filter out comments on files already touched by the partial commits
      // so the local fix prompt only contains genuinely outstanding items.
      const touchedFiles = new Set(
        execFileSync("git", ["diff", "--name-only", `${headBefore}..HEAD`], {
          encoding: "utf-8",
        })
          .trim()
          .split("\n")
          .filter(Boolean),
      );
      const remainingComments = comments.filter(
        (c) => !touchedFiles.has(c.file),
      );
      const partialMsg =
        `🦸 **Review Hero Auto-Fix** partially completed before failing. ` +
        `Some fixes were pushed, but the session did not finish.\n\n` +
        `Check the [workflow logs](${logsUrl}) for details.` +
        buildLocalFixPrompt(remainingComments);
      await gh.postComment(prNumber, partialMsg);
    } else {
      const failMsg =
        `🦸 **Review Hero Auto-Fix** failed — check the [workflow logs](${logsUrl}) for details.` +
        buildLocalFixPrompt(comments);
      await gh.postComment(prNumber, failMsg);
    }
    await uncheckCheckboxes();
    process.exit(1);
  }

  // Restore .review-hero/ in case Claude modified it via the Edit tool.
  // This is a defence-in-depth measure — the commit helper is already copied
  // to /tmp, but we also don't want any worktree edits to .review-hero/
  // leaking into the leftover sweep commit.
  restoreReviewHero();

  const results = parseClaudeResult(raw);
  const resultById = new Map(results.map((r) => [Number(r.id), r]));

  // Log parsed results table
  if (results.length > 0) {
    core.info("Auto-fix results:");
    for (const r of results) {
      const icon = r.status === "fixed" ? "✅" : "⏭️";
      const detail = r.status === "fixed" ? r.summary : r.reason;
      core.info(`  ${icon} #${r.id} [${r.status}] ${detail ?? ""}`);
    }
  }

  // Determine which comments were fixed vs skipped
  const fixedComments = [];
  const skippedComments = [];
  for (let i = 0; i < comments.length; i++) {
    const id = i + 1;
    const result = resultById.get(id);
    if (result?.status === "fixed") {
      fixedComments.push(comments[i]);
    } else if (result?.status === "skipped") {
      skippedComments.push({
        ...comments[i],
        reason: result.reason ?? "Unknown",
      });
    } else {
      skippedComments.push({
        ...comments[i],
        reason: "No response from Claude",
      });
    }
  }

  // Determine which CI failures were fixed vs skipped
  const fixedCIFailures = [];
  const skippedCIFailures = [];
  for (let i = 0; i < ciFailures.length; i++) {
    const id = comments.length + i + 1;
    const result = resultById.get(id);
    if (result?.status === "fixed") {
      fixedCIFailures.push(ciFailures[i]);
    } else {
      skippedCIFailures.push({
        ...ciFailures[i],
        reason: result?.reason ?? "No response from Claude",
      });
    }
  }
  const fixedCICount = fixedCIFailures.length;

  // Build commit message
  const msgParts = [];
  if (fixedComments.length > 0)
    msgParts.push(
      `${fixedComments.length} review suggestion${fixedComments.length === 1 ? "" : "s"}`,
    );
  if (fixedCICount > 0)
    msgParts.push(`${fixedCICount} CI failure${fixedCICount === 1 ? "" : "s"}`);

  let commitFallback = "fix: auto-fix changes";
  if (fixReviews && !fixCI) commitFallback = "fix: auto-fix review suggestions";
  if (fixCI && !fixReviews) commitFallback = "fix: auto-fix CI failures";

  const commitMessage =
    msgParts.length > 0
      ? `fix: auto-fix ${msgParts.join(" and ")}`
      : commitFallback;

  // Claude should have committed per-fix, but catch any remaining uncommitted
  // changes as a final sweep (e.g. files Claude forgot to stage).
  const hasLeftovers = hasChanges();
  if (hasLeftovers) {
    const leftoverFiles = execSync(
      "git status --porcelain=v2 --no-renames --ignore-submodules",
      { encoding: "utf-8" },
    )
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        // porcelain v2: untracked/ignored lines are "? path" or "! path"
        if (l.startsWith("? ") || l.startsWith("! ")) return l.slice(2);
        // ordinary changed entry: "1 XY sub mH mI mW hH hI path"
        // path may contain spaces — join everything after the 8th field
        return l.split(" ").slice(8).join(" ");
      });
    console.log(
      `Committing leftover uncommitted changes: ${leftoverFiles.join(", ")}`,
    );
    createCommit(commitMessage);
  }

  // Check if there are any commits to push (Claude's per-fix commits and/or
  // the leftover commit above). Compare HEAD now against HEAD before Claude ran;
  // avoids relying on @{u} which requires an upstream tracking ref to exist.
  const headAfter = execSync("git rev-parse HEAD", {
    encoding: "utf-8",
  }).trim();
  const hasCommitsToPush = headBefore !== headAfter;

  let pushed = false;
  if (hasCommitsToPush) {
    pushChanges();
    pushed = true;
  } else {
    console.log("No commits to push");
  }

  // Resolve fixed threads and reply on skipped threads
  if (pushed) {
    let resolved = 0;
    for (const comment of fixedComments) {
      await resolveThread(comment.threadId);
      resolved++;
    }
    console.log(
      `Resolved ${resolved} review thread${resolved === 1 ? "" : "s"}`,
    );
  }

  for (const comment of skippedComments) {
    await replyToThread(
      comment.threadId,
      `🦸 **Review Hero Auto-Fix** skipped this comment: ${comment.reason}`,
    );
  }

  // Post summary
  const summaryParts = ["🦸 **Review Hero Auto-Fix**\n"];

  if (pushed) {
    const fixedParts = [];
    if (fixedComments.length > 0)
      fixedParts.push(
        `${fixedComments.length} review comment${fixedComments.length === 1 ? "" : "s"}`,
      );
    if (fixedCICount > 0)
      fixedParts.push(
        `${fixedCICount} CI failure${fixedCICount === 1 ? "" : "s"}`,
      );
    const fixDescription =
      fixedParts.length > 0 ? fixedParts.join(" and ") : "changes";
    summaryParts.push(`Applied fixes for ${fixDescription}.`);
  } else {
    summaryParts.push("No file changes were needed.");
  }

  if (skippedComments.length > 0) {
    summaryParts.push(
      `\n\nSkipped ${skippedComments.length} comment${skippedComments.length === 1 ? "" : "s"} (replied on each thread).`,
    );
  }

  const logsUrl = workflowLogsUrl(repo);
  if (process.env.GITHUB_RUN_ID) {
    summaryParts.push(`\n\n[View logs](${logsUrl})`);
  }

  const localPrompt = buildLocalFixPrompt(skippedComments);
  if (localPrompt) {
    summaryParts.push(localPrompt);
  }

  await gh.postComment(prNumber, summaryParts.join(""));
  await uncheckCheckboxes();
  console.log("Done");
}

main().catch(async (err) => {
  console.error(err);
  try {
    await gh.postComment(
      prNumber,
      `🦸 **Review Hero Auto-Fix** failed — check the [workflow logs](${workflowLogsUrl(repo)}) for details.`,
    );
    await uncheckCheckboxes();
  } catch {
    // best effort
  }
  process.exit(1);
});
