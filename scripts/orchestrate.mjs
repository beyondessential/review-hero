/**
 * Review Hero — Orchestrator
 *
 * Reads structured JSON findings from review agent artifacts, deduplicates
 * them, and posts a consolidated PR review via the GitHub API.
 *
 * Environment variables:
 *   GITHUB_TOKEN        — GitHub App token for posting reviews
 *   GITHUB_ACTIONS_TOKEN— Built-in Actions token (for unchecking the checkbox
 *                         without re-triggering the workflow)
 *   GITHUB_REPOSITORY   — owner/repo
 *   PR_NUMBER           — Pull request number
 *   ARTIFACTS_DIR       — Directory containing agent result files
 *   AGENT_NAMES         — JSON map of agent key → display name
 *   APP_SLUG            — Slug of the GitHub App (e.g. "review-hero")
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { buildLocalFixPrompt } from "./local-fix-prompt.mjs";

const VALID_SEVERITIES = new Set(["critical", "suggestion", "nitpick"]);
const VALID_AGENT_KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SEVERITY_ORDER = { critical: 0, suggestion: 1, nitpick: 2 };

// ── Helpers ──────────────────────────────────────────────────────────────────

function getEnvOrThrow(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function loadAgentNames() {
  const raw = process.env.AGENT_NAMES;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    console.warn("Failed to parse AGENT_NAMES, using empty map");
    return {};
  }
}

// ── Finding parsing ──────────────────────────────────────────────────────────

function validateFindings(findings, agentKey) {
  return findings
    .filter(
      (f) =>
        typeof f.file === "string" &&
        f.file &&
        VALID_SEVERITIES.has(f.severity) &&
        typeof f.comment === "string" &&
        f.comment &&
        typeof f.line === "number" &&
        f.line > 0,
    )
    .map((f) => ({
      file: f.file,
      line: f.line,
      severity: f.severity,
      comment: f.comment,
      agent: agentKey,
    }));
}

/**
 * Parse agent output. Returns null on parse failure (distinct from [] which
 * means "parsed OK, no findings").
 */
function parseAgentResult(filePath, agentKey) {
  try {
    const raw = readFileSync(filePath, "utf-8");

    // Claude CLI --output-format json wraps the response in a JSON object
    // with a "result" field containing the text output
    let text = raw;
    try {
      const parsed = JSON.parse(raw);
      if (parsed.result) {
        text = parsed.result;
      } else if (Array.isArray(parsed)) {
        return validateFindings(parsed, agentKey);
      }
    } catch {
      // Not valid JSON at top level — might be raw text with JSON embedded
    }

    // Extract JSON array from text by trying [start..end] pairs.
    let findings = null;
    let searchFrom = 0;
    outer: while (searchFrom < text.length) {
      const start = text.indexOf("[", searchFrom);
      if (start === -1) break;
      let searchEnd = text.length;
      while (searchEnd > start) {
        const end = text.lastIndexOf("]", searchEnd - 1);
        if (end <= start) break;
        try {
          const parsed = JSON.parse(text.slice(start, end + 1));
          if (Array.isArray(parsed)) {
            findings = parsed;
            break outer;
          }
        } catch {
          // Not valid JSON for this pair — try a shorter span
        }
        searchEnd = end;
      }
      searchFrom = start + 1;
    }

    if (!findings) {
      console.warn(`No JSON array found in ${filePath}`);
      return null;
    }

    return validateFindings(findings, agentKey);
  } catch (err) {
    console.warn(`Failed to parse ${filePath}: ${err.message}`);
    return null;
  }
}

// ── Deduplication ────────────────────────────────────────────────────────────

function deduplicateFindings(findings) {
  const sortedFindings = [...findings].sort((a, b) => {
    if (a.file !== b.file) return a.file.localeCompare(b.file);
    return a.line - b.line;
  });

  // Group findings by (file, approximate line) and merge overlapping ones
  const groups = new Map();

  for (const finding of sortedFindings) {
    let merged = false;
    for (const group of groups.values()) {
      if (
        group[0].file === finding.file &&
        Math.abs(group[0].line - finding.line) <= 3
      ) {
        const isDuplicate = group.some(
          (g) => g.agent === finding.agent && g.comment === finding.comment,
        );
        if (!isDuplicate) {
          group.push(finding);
        }
        merged = true;
        break;
      }
    }
    if (!merged) {
      const key = `${finding.file}:${finding.line}`;
      groups.set(key, [finding]);
    }
  }

  return groups;
}

// ── Comment formatting ───────────────────────────────────────────────────────

function buildInlineComment(group, agentNames) {
  return group
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
    .map((f) => {
      const agentName = agentNames[f.agent] ?? f.agent;
      return `**[${agentName}]** \`${f.severity}\`\n\n${f.comment}`;
    })
    .join("\n\n---\n\n");
}

function buildSummaryTable(nitpicks, agentNames) {
  if (nitpicks.length === 0) return "";

  const rows = nitpicks
    .map((f) => {
      const agentName = agentNames[f.agent] ?? f.agent;
      const shortComment =
        f.comment.length > 300 ? `${f.comment.slice(0, 297)}...` : f.comment;
      const escaped = shortComment
        .replace(/\\/g, "\\\\")
        .replace(/\|/g, "\\|")
        .replace(/\n/g, " ");
      return `| \`${f.file}\` | ${f.line} | ${agentName} | ${escaped} |`;
    })
    .join("\n");

  return `### Nitpicks\n\n| File | Line | Agent | Comment |\n|------|------|-------|---------|\n${rows}`;
}

// ── GitHub API ───────────────────────────────────────────────────────────────

async function githubApi(endpoint, options = {}, { token } = {}) {
  token ??= getEnvOrThrow("GITHUB_TOKEN");
  const repo = getEnvOrThrow("GITHUB_REPOSITORY");
  const baseUrl = `https://api.github.com/repos/${repo}`;

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
}

async function githubGraphQL(query, variables) {
  const token = getEnvOrThrow("GITHUB_TOKEN");
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
}

async function resolvePreviousReviewHeroThreads(prNumber, botLogin) {
  const repo = getEnvOrThrow("GITHUB_REPOSITORY");
  const [owner, name] = repo.split("/");

  const data = await githubGraphQL(
    `query($owner: String!, $repo: String!, $pr: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $pr) {
          reviewThreads(first: 100) {
            nodes {
              id
              isResolved
              comments(first: 1) {
                nodes {
                  author { login }
                }
              }
            }
          }
        }
      }
    }`,
    { owner, repo: name, pr: parseInt(prNumber) },
  );

  const threads = data.repository.pullRequest.reviewThreads.nodes;
  let resolved = 0;

  for (const thread of threads) {
    if (thread.isResolved) continue;
    const author = thread.comments.nodes[0]?.author?.login;
    if (author !== botLogin) continue;

    try {
      await githubGraphQL(
        `mutation($threadId: ID!) {
          resolveReviewThread(input: { threadId: $threadId }) {
            thread { id }
          }
        }`,
        { threadId: thread.id },
      );
      resolved++;
    } catch (err) {
      console.warn(`Failed to resolve thread ${thread.id}: ${err.message}`);
    }
  }

  if (resolved > 0) {
    console.log(
      `Resolved ${resolved} previous Review Hero thread${resolved === 1 ? "" : "s"}`,
    );
  }
}

async function getLatestCommit(prNumber) {
  const pr = await githubApi(`/pulls/${prNumber}`);
  return pr.head.sha;
}

async function postReview(prNumber, commitSha, inlineComments) {
  const body = {
    commit_id: commitSha,
    event: "COMMENT",
    comments: inlineComments.map((c) => ({
      path: c.path,
      line: c.line,
      side: "RIGHT",
      body: c.body,
    })),
  };

  await githubApi(`/pulls/${prNumber}/reviews`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

async function postComment(prNumber, body) {
  await githubApi(`/issues/${prNumber}/comments`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
}

async function uncheckReviewHero(prNumber) {
  try {
    const pr = await githubApi(`/pulls/${prNumber}`);
    const body = pr.body;
    if (!body) return;

    const updated = body.replace(
      /\[x\]\s+\*\*Run Review Hero\*\* <!-- #ai-review -->/,
      "[ ] **Run Review Hero** <!-- #ai-review -->",
    );

    if (updated === body) return;

    // Use the built-in Actions token so the PATCH doesn't trigger a
    // pull_request.edited event (app tokens do, built-in tokens don't)
    const actionsToken = process.env.GITHUB_ACTIONS_TOKEN;
    await githubApi(
      `/pulls/${prNumber}`,
      { method: "PATCH", body: JSON.stringify({ body: updated }) },
      { token: actionsToken },
    );
    console.log("Unchecked Review Hero checkbox");
  } catch (err) {
    console.warn(`Failed to uncheck checkbox: ${err.message}`);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const prNumber = getEnvOrThrow("PR_NUMBER");
  const artifactsDir = getEnvOrThrow("ARTIFACTS_DIR");
  const agentNames = loadAgentNames();
  const appSlug = process.env.APP_SLUG || "review-hero";
  const botLogin = `${appSlug}[bot]`;

  console.log(`Orchestrating AI review for PR #${prNumber}`);

  // Resolve previous Review Hero comments so they don't clutter the PR
  await resolvePreviousReviewHeroThreads(prNumber, botLogin);

  // Discover agent results. We support two layouts:
  //   1. <dir>/<key>-result.json  (current: merge-multiple flat files)
  //   2. <dir>/review-<key>/result.json  (legacy: per-artifact subdirs)
  // The flat-file layout is preferred because download-artifact with
  // merge-multiple avoids the single-artifact gotcha where a pattern
  // matching one artifact extracts directly into the target path without
  // creating a subdirectory.
  const agentResults = new Map(); // key → filePath

  try {
    for (const entry of readdirSync(artifactsDir, { withFileTypes: true })) {
      // Layout 1: <key>-result.json flat files
      if (entry.isFile()) {
        const match = entry.name.match(/^(.+)-result\.json$/);
        if (match && VALID_AGENT_KEY.test(match[1])) {
          agentResults.set(match[1], `${artifactsDir}/${entry.name}`);
        }
        continue;
      }

      // Layout 2: review-<key>/result.json subdirectories (fallback)
      if (entry.isDirectory() && entry.name.startsWith("review-")) {
        const key = entry.name.replace(/^review-/, "");
        if (!VALID_AGENT_KEY.test(key)) continue;
        if (agentResults.has(key)) continue; // flat file takes precedence
        const subPath = `${artifactsDir}/${entry.name}/result.json`;
        if (existsSync(subPath)) {
          agentResults.set(key, subPath);
        }
      }
    }
  } catch {
    // artifacts dir might not exist if all agents failed
  }

  // Collect findings from all agents
  const allFindings = [];
  let agentsCompleted = 0;
  let agentsFailed = 0;

  for (const [agentKey, filePath] of agentResults) {
    const findings = parseAgentResult(filePath, agentKey);
    if (findings === null) {
      const name = agentNames[agentKey] ?? agentKey;
      console.warn(`${name}: failed to parse output`);
      agentsFailed++;
      continue;
    }
    const name = agentNames[agentKey] ?? agentKey;
    console.log(`${name}: ${findings.length} findings`);
    allFindings.push(...findings);
    agentsCompleted++;
  }

  if (agentsCompleted === 0) {
    await postComment(
      prNumber,
      "🦸 **Review Hero** was requested but could not complete — all agents failed. Check the workflow logs for details.",
    );
    return;
  }

  // Deduplicate
  const groups = deduplicateFindings(allFindings);

  // Split by severity
  const inlineComments = [];
  const nitpicks = [];
  const counts = { critical: 0, suggestion: 0, nitpick: 0 };

  for (const [, group] of groups) {
    const highestSeverity = group.reduce(
      (min, f) =>
        SEVERITY_ORDER[f.severity] < SEVERITY_ORDER[min] ? f.severity : min,
      "nitpick",
    );

    for (const f of group) {
      counts[f.severity]++;
    }

    if (highestSeverity === "nitpick") {
      nitpicks.push(...group);
    } else {
      inlineComments.push({
        path: group[0].file,
        line: group[0].line,
        body: buildInlineComment(group, agentNames),
      });
    }
  }

  // Post inline review comments
  if (inlineComments.length > 0) {
    const commitSha = await getLatestCommit(prNumber);
    try {
      await postReview(prNumber, commitSha, inlineComments);
      console.log(`Posted ${inlineComments.length} inline review comments`);
    } catch (err) {
      console.error(`Failed to post inline review: ${err.message}`);
      // Fall back to posting inline comments in the summary
      const fallbackLines = inlineComments
        .map((c) => `**\`${c.path}:${c.line}\`**\n\n${c.body}`)
        .join("\n\n---\n\n");
      await postComment(
        prNumber,
        `🦸 **Review Hero** (could not post inline comments — showing here instead)\n\n${fallbackLines}`,
      );
    }
  }

  // Build and post summary
  const summaryParts = [
    `🦸 **Review Hero Summary**\n`,
    `**${agentsCompleted} agent${agentsCompleted === 1 ? "" : "s"}** reviewed this PR`,
    agentsFailed > 0 ? ` | ${agentsFailed} failed` : "",
    ` | ${counts.critical} critical | ${counts.suggestion} suggestion${counts.suggestion === 1 ? "" : "s"} | ${counts.nitpick} nitpick${counts.nitpick === 1 ? "" : "s"}`,
  ];

  if (allFindings.length === 0) {
    summaryParts.push("\n\nNo issues found. Looks good! ✅");
  }

  const nitpickTable = buildSummaryTable(nitpicks, agentNames);
  if (nitpickTable) {
    summaryParts.push(`\n\n${nitpickTable}`);
  }

  const localPrompt = buildLocalFixPrompt(allFindings);
  if (localPrompt) {
    summaryParts.push(localPrompt);
  }

  await postComment(prNumber, summaryParts.join(""));
  console.log("Posted summary comment");

  // Uncheck the Review Hero checkbox so subsequent edits don't re-trigger
  await uncheckReviewHero(prNumber);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
