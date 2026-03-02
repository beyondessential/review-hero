/**
 * Review Hero — Auto-Fix
 *
 * Fetches unresolved review comments and/or CI failures from a PR,
 * pipes them to Claude CLI to apply fixes, then commits and pushes the result.
 *
 * Claude runs inside a Docker sandbox container with no sudo, no secrets in
 * the environment (except the Anthropic API key via a mounted file), and
 * --cap-drop=ALL. See run-in-sandbox.mjs for details.
 *
 * Environment variables:
 *   GITHUB_TOKEN        — GitHub token (with contents:write, pull-requests:write, actions:read)
 *   GITHUB_REPOSITORY   — owner/repo
 *   PR_NUMBER           — Pull request number
 *   ANTHROPIC_API_KEY   — API key for Claude CLI (passed to sandbox via file mount)
 *   REVIEW_HERO_APP_ID  — App ID for git commit identity
 *   MODEL               — Model to use (default: claude-sonnet-4-6)
 *   FIX_REVIEWS         — 'true' to fix unresolved review comments
 *   FIX_CI              — 'true' to fix CI failures
 *   PROMPT_PATH         — Path to the base auto-fix prompt
 *   PROJECT_CONTEXT     — Optional project context string (e.g. "You are reviewing a PR for **Tamanu**, a healthcare management system.")
 *   CUSTOM_RULES_PATH   — Optional path to repo-specific rules to append to the prompt
 *   SELF_WORKFLOW        — Name of this workflow (to exclude from CI failure checks)
 *   SANDBOX_SCRIPT      — Path to run-in-sandbox.mjs (default: .review-hero/scripts/run-in-sandbox.mjs)
 *   SANDBOX_IMAGE       — Docker image name for the sandbox (default: claude-sandbox:latest)
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  copyFileSync,
  chmodSync,
} from "node:fs";
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
const fixReviews = process.env.FIX_REVIEWS === "true";
const fixCI = process.env.FIX_CI === "true";
const promptPath = getEnvOrThrow("PROMPT_PATH");
const projectContext = process.env.PROJECT_CONTEXT ?? "";
const customRulesPath = process.env.CUSTOM_RULES_PATH ?? "";
const aiRulesPath = process.env.AI_RULES_PATH ?? "";
const selfWorkflow = process.env.SELF_WORKFLOW ?? "Review Hero Auto-Fix";
const sandboxScript =
  process.env.SANDBOX_SCRIPT ?? ".review-hero/scripts/run-in-sandbox.mjs";
const sandboxImage = process.env.SANDBOX_IMAGE ?? "claude-sandbox:latest";
const sandboxDisabled = process.env.SANDBOX_DISABLED === "true";

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

async function githubGraphQL(query, variables) {
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

// ── Data fetching ────────────────────────────────────────────────────────────

async function fetchUnresolvedComments() {
  const [owner, name] = repo.split("/");

  const data = await githubGraphQL(
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
  const pr = await githubApi(`/pulls/${prNumber}`);
  const headSha = pr.head.sha;

  console.log(`Fetching CI failures for commit ${headSha.slice(0, 7)}`);

  const runsData = await githubApi(
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
    const jobsData = await githubApi(
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
  const sections = [];

  // Project context (if provided by the caller's config.yml)
  if (projectContext) {
    sections.push(`## Project Context\n\n${projectContext}`);
  }

  // Base auto-fix prompt — replace the placeholder helper path with the
  // actual (possibly /tmp-copied) path so Claude invokes the right script.
  let basePrompt = readFileSync(promptPath, "utf-8");
  if (commitHelperPath) {
    basePrompt = basePrompt.replaceAll(
      ".review-hero/scripts/git-commit-fix.mjs",
      commitHelperPath,
    );
  }
  sections.push(basePrompt);

  // Custom rules from the consumer repo (if present)
  if (customRulesPath && existsSync(customRulesPath)) {
    sections.push(readFileSync(customRulesPath, "utf-8"));
  }

  // AI rules from other tools (non-CLAUDE.md — CLAUDE.md is read natively by Claude CLI)
  if (aiRulesPath) {
    try {
      const aiRules = readFileSync(aiRulesPath, "utf-8").trim();
      if (aiRules) {
        sections.push(
          `## Repository AI Rules\n\nThis repository defines the following AI coding rules. Follow them when applying fixes.\n\n${aiRules}`,
        );
      }
    } catch {
      // No AI rules file or unreadable — skip
    }
  }

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

// ── Claude execution ─────────────────────────────────────────────────────────

// Container path where the commit helper is mounted by run-in-sandbox.mjs
const CONTAINER_COMMIT_HELPER = "/tools/git-commit-fix.mjs";

function runClaude(prompt, { commitHelperHostPath } = {}) {
  if (!/^[a-z0-9.-]+$/.test(model)) {
    throw new Error(`Invalid model name: ${model}`);
  }

  const promptFile = `/tmp/auto-fix-prompt-${prNumber}-${Date.now()}.md`;
  writeFileSync(promptFile, prompt);

  if (!fixCI && !commitHelperHostPath) {
    throw new Error(
      "commitHelperHostPath is required when not running in CI fix mode",
    );
  }

  // ── Unsandboxed execution ──────────────────────────────────────────────
  // When dangerousDisableSandbox is set, run Claude CLI directly on the
  // runner. The user has accepted the risk that Claude has access to the
  // full runner environment, including workflow secrets.
  if (sandboxDisabled) {
    // Without a container, the commit helper path is the host path directly.
    const tools = fixCI
      ? "Read,Edit,Glob,Grep,Bash"
      : `Read,Edit,Glob,Grep,Bash(${commitHelperHostPath}:*)`;

    const raw = execFileSync(
      "claude",
      [
        "-p",
        "--output-format",
        "json",
        "--model",
        model,
        "--max-turns",
        "30",
        "--allowedTools",
        tools,
      ],
      {
        input: readFileSync(promptFile, "utf-8"),
        encoding: "utf-8",
        timeout: 10 * 60 * 1000,
        maxBuffer: 10 * 1024 * 1024,
        // In unsandboxed mode, inherit the full environment. The user has
        // opted out of isolation via dangerousDisableSandbox.
        env: {
          ...process.env,
        },
      },
    );

    logClaudeSession(raw);
    return raw;
  }

  // ── Sandboxed execution ────────────────────────────────────────────────
  // CI fixes need full Bash to run builds/tests/linters. Review-only fixes
  // get Bash scoped to the git-commit-fix helper so Claude can commit per-fix
  // without having unrestricted shell access.

  const sandboxConfig = {
    mode: fixCI ? "ci-fix" : "review-fix",
    prompt: promptFile,
    model,
    maxTurns: 30,
    tools: [
      "Read",
      "Edit",
      "Glob",
      "Grep",
      fixCI ? "Bash" : `Bash(${CONTAINER_COMMIT_HELPER}:*)`,
    ],
    image: sandboxImage,
  };

  if (commitHelperHostPath) {
    sandboxConfig.commitHelper = commitHelperHostPath;
  }

  const configFile = `/tmp/sandbox-config-${prNumber}-${Date.now()}.json`;
  writeFileSync(configFile, JSON.stringify(sandboxConfig));

  const raw = execFileSync("node", [sandboxScript, configFile], {
    encoding: "utf-8",
    timeout: 10 * 60 * 1000,
    maxBuffer: 10 * 1024 * 1024,
    // Only pass the minimum env the sandbox script needs.
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    },
  });

  logClaudeSession(raw);
  return raw;
}

function logClaudeSession(raw) {
  try {
    const parsed = JSON.parse(raw);

    // Log cost and usage stats
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

    // Log the full response in a collapsible group
    const transcript = typeof parsed.result === "string" ? parsed.result : raw;
    core.startGroup("Claude auto-fix transcript");
    try {
      core.info(transcript);
    } finally {
      core.endGroup();
    }
  } catch {
    // JSON parse failed — log the raw output directly
    core.startGroup("Claude auto-fix output (raw)");
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
    // Not valid JSON at top level — search for embedded array below
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

// ── Git operations ───────────────────────────────────────────────────────────

function hasChanges() {
  return Boolean(
    execSync("git status --porcelain --ignore-submodules", {
      encoding: "utf-8",
    }).trim(),
  );
}

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

function createCommit(commitMessage) {
  configureGitIdentity();
  execSync("git add -A");
  // Remove .review-hero from the index — it's our tooling checkout, not part
  // of the caller's repo. Git sees it as a "subproject commit" because it
  // contains its own .git directory and we never want that committed.
  execSync("git rm -rf --cached --ignore-unmatch .review-hero");
  execFileSync("git", ["commit", "-m", commitMessage]);
}

function pushChanges() {
  execSync("git push");
  console.log("Pushed auto-fix commits");
}

// ── Secret scanning ──────────────────────────────────────────────────────────

/**
 * Scan all commits between headBefore and HEAD for leaked secrets.
 * Returns { leaked: true, detail: string } if a secret pattern is found,
 * or { leaked: false } if clean.
 *
 * This is a defence-in-depth measure — the Docker sandbox should prevent
 * Claude from accessing most secrets, but if prompt injection somehow
 * succeeds in extracting the API key (e.g. from /run/secrets/api-key inside
 * the container) and writing it to a file, this scan catches it before push.
 */
function scanCommitsForSecrets(headBefore) {
  const diff = execFileSync("git", ["diff", `${headBefore}..HEAD`], {
    encoding: "utf-8",
  });
  const messages = execFileSync(
    "git",
    ["log", `${headBefore}..HEAD`, "--format=%s%n%b"],
    { encoding: "utf-8" },
  );
  const combined = diff + "\n" + messages;

  // Known secret format patterns
  const patterns = [
    { regex: /sk-ant-[a-zA-Z0-9_-]{20,}/, name: "Anthropic API key" },
    { regex: /ghp_[a-zA-Z0-9]{36,}/, name: "GitHub personal access token" },
    { regex: /ghs_[a-zA-Z0-9]{36,}/, name: "GitHub server-to-server token" },
    { regex: /ghu_[a-zA-Z0-9]{36,}/, name: "GitHub user-to-server token" },
    { regex: /github_pat_[a-zA-Z0-9_]{22,}/, name: "GitHub fine-grained PAT" },
    {
      regex: /-----BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY-----/,
      name: "PEM private key",
    },
  ];

  for (const { regex, name } of patterns) {
    if (regex.test(combined)) {
      return { leaked: true, detail: `pattern match: ${name}` };
    }
  }

  // Check for exact values of the secrets we know about. We compare the raw
  // values rather than logging them so we don't accidentally leak them in the
  // workflow output.
  const knownSecretEntries = [
    ["ANTHROPIC_API_KEY", process.env.ANTHROPIC_API_KEY],
    ["GITHUB_TOKEN", process.env.GITHUB_TOKEN],
    ["REVIEW_HERO_PRIVATE_KEY", process.env.REVIEW_HERO_PRIVATE_KEY],
  ];

  for (const [name, value] of knownSecretEntries) {
    if (!value || value.length < 8) {
      console.warn(
        `Warning: secret scanning skipped for ${name} — not set or too short`,
      );
    }
  }

  const knownSecrets = knownSecretEntries
    .map(([, value]) => value)
    .filter((s) => s && s.length >= 8);

  for (const secret of knownSecrets) {
    if (combined.includes(secret)) {
      return { leaked: true, detail: "exact secret value match" };
    }
  }

  return { leaked: false };
}

// ── GitHub interactions ──────────────────────────────────────────────────────

async function resolveThread(threadId) {
  try {
    await githubGraphQL(
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
    await githubGraphQL(
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

async function postComment(body) {
  await githubApi(`/issues/${prNumber}/comments`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
}

async function uncheckCheckboxes() {
  try {
    const pr = await githubApi(`/pulls/${prNumber}`);
    if (!pr.body) return;

    let updated = pr.body;
    if (fixReviews) {
      updated = updated.replace(
        /\[x\]\s+\*\*Auto-fix review suggestions\*\* <!-- #auto-fix -->/,
        "[ ] **Auto-fix review suggestions** <!-- #auto-fix -->",
      );
    }
    if (fixCI) {
      updated = updated.replace(
        /\[x\]\s+\*\*Auto-fix CI failures\*\* <!-- #auto-fix-ci -->/,
        "[ ] **Auto-fix CI failures** <!-- #auto-fix-ci -->",
      );
    }

    if (updated === pr.body) return;

    await githubApi(`/pulls/${prNumber}`, {
      method: "PATCH",
      body: JSON.stringify({ body: updated }),
    });
    console.log("Unchecked auto-fix checkbox(es)");
  } catch (err) {
    console.warn(`Failed to uncheck checkbox: ${err.message}`);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Exclude .review-hero from git tracking. It's a nested checkout of the
  // review-hero repo (with its own .git dir) used only for scripts/prompts.
  // Without this, `git add -A` records it as a subproject commit in the PR.
  const excludePath = ".git/info/exclude";
  const excludeContent = execSync(`cat "${excludePath}" 2>/dev/null || true`, {
    encoding: "utf-8",
  });
  if (!excludeContent.includes(".review-hero")) {
    execSync(`mkdir -p .git/info && echo ".review-hero" >> "${excludePath}"`);
  }

  // Configure git identity before Claude runs so its commits use the bot identity
  configureGitIdentity();

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
    await postComment("🦸 **Review Hero Auto-Fix** — Nothing to fix.");
    await uncheckCheckboxes();
    return;
  }

  // Copy the commit helper to /tmp. When sandboxed, it is mounted read-only
  // into the Docker container at /tools/git-commit-fix.mjs. When unsandboxed,
  // Claude invokes it directly at this host path.
  const commitHelperSrc = ".review-hero/scripts/git-commit-fix.mjs";
  const commitHelperTmp = `/tmp/git-commit-fix-${prNumber}-${Date.now()}.mjs`;
  copyFileSync(commitHelperSrc, commitHelperTmp);
  chmodSync(commitHelperTmp, 0o755);

  // When sandboxed, the prompt references the container path (/tools/...)
  // since Claude sees the helper mounted there. When unsandboxed, use the
  // host path directly since there is no container path remapping.
  const prompt = buildPrompt(comments, ciFailures, {
    commitHelperPath: sandboxDisabled
      ? commitHelperTmp
      : CONTAINER_COMMIT_HELPER,
  });
  const headBefore = execSync("git rev-parse HEAD", {
    encoding: "utf-8",
  }).trim();
  console.log(
    sandboxDisabled
      ? "Running Claude directly on runner to apply fixes (sandbox disabled)..."
      : "Running Claude in sandbox to apply fixes...",
  );
  let raw;
  try {
    raw = runClaude(prompt, { commitHelperHostPath: commitHelperTmp });
  } catch (err) {
    console.error(`Claude failed: ${err.message}`);

    // Restore .review-hero/ before any recovery work
    execSync("git checkout -- .review-hero/ 2>/dev/null || true");

    // Even though Claude failed/timed out, it may have already committed some
    // fixes via the git-commit-fix helper. Push those partial results rather
    // than discarding them — partial fixing is better than nothing.
    const headAfterFailure = execSync("git rev-parse HEAD", {
      encoding: "utf-8",
    }).trim();
    if (headBefore !== headAfterFailure) {
      console.log(
        "Claude failed but made commits before failing — scanning and pushing partial fixes",
      );
      const partialScan = scanCommitsForSecrets(headBefore);
      if (partialScan.leaked) {
        core.error(
          `Secret detected in partial commits (${partialScan.detail}) — resetting`,
        );
        execSync(`git reset --hard ${headBefore}`);
        await postComment(
          `🦸 **Review Hero Auto-Fix** aborted — detected potential secret leakage in committed content. ` +
            `No changes were pushed. Check the workflow logs.`,
        );
        await uncheckCheckboxes();
        process.exit(1);
      }
      pushChanges();
      await postComment(
        `🦸 **Review Hero Auto-Fix** partially completed before failing. ` +
          `Some fixes were pushed, but the session did not finish.\n\n` +
          `Check the [workflow logs](${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID ?? ""}) for details.`,
      );
    } else {
      await postComment(
        `🦸 **Review Hero Auto-Fix** failed — check the [workflow logs](${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID ?? ""}) for details.`,
      );
    }
    await uncheckCheckboxes();
    process.exit(1);
  }

  // Restore .review-hero/ in case Claude modified it via the Edit tool.
  // This is a defence-in-depth measure — the commit helper is already copied
  // to /tmp, but we also don't want any worktree edits to .review-hero/
  // leaking into the leftover sweep commit.
  execSync("git checkout -- .review-hero/ 2>/dev/null || true");

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

  // Count CI fixes
  const fixedCICount = ciFailures.filter((_, i) => {
    const result = resultById.get(comments.length + i + 1);
    return result?.status === "fixed";
  }).length;

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
    // Defence-in-depth: scan all committed diffs and messages for leaked
    // secrets before pushing. The Docker sandbox should prevent Claude from
    // accessing most secrets, but prompt injection could potentially extract
    // the API key from /run/secrets/api-key inside the container and embed
    // it in a file or commit message.
    const scanResult = scanCommitsForSecrets(headBefore);
    if (scanResult.leaked) {
      core.error(
        `Secret detected in commits (${scanResult.detail}) — resetting to ${headBefore}`,
      );
      execFileSync(["git", "reset", "--hard", headBefore]);
      await postComment(
        `🦸 **Review Hero Auto-Fix** aborted — detected potential secret leakage in committed content. ` +
          `No changes were pushed. Check the workflow logs.`,
      );
      await uncheckCheckboxes();
      process.exit(1);
    }

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

  const serverUrl = process.env.GITHUB_SERVER_URL ?? "https://github.com";
  const runId = process.env.GITHUB_RUN_ID;
  if (runId) {
    summaryParts.push(
      `\n\n[View logs](${serverUrl}/${repo}/actions/runs/${runId})`,
    );
  }

  await postComment(summaryParts.join(""));
  await uncheckCheckboxes();
  console.log("Done");
}

main().catch(async (err) => {
  console.error(err);
  try {
    const serverUrl = process.env.GITHUB_SERVER_URL ?? "https://github.com";
    const runId = process.env.GITHUB_RUN_ID;
    const logsUrl = runId
      ? `${serverUrl}/${repo}/actions/runs/${runId}`
      : `${serverUrl}/${repo}/actions`;
    await postComment(
      `🦸 **Review Hero Auto-Fix** failed — check the [workflow logs](${logsUrl}) for details.`,
    );
    await uncheckCheckboxes();
  } catch {
    // best effort
  }
  process.exit(1);
});
