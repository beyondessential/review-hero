/**
 * Review Hero — Orchestrator
 *
 * Reads structured JSON findings from review agent artifacts, applies voter
 * consensus (when multiple voters per agent), deduplicates, and posts a
 * consolidated PR review via the GitHub API.
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
 *   VOTERS              — Number of voters per agent (default: 1)
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { buildLocalFixPrompt } from "./local-fix-prompt.mjs";
import { join } from "node:path";
import { MAX_VOTERS } from "./lib.mjs";

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

function validateFindings(findings, agentKey, voter) {
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
      ...(voter !== undefined && { voter: `${agentKey}-${voter}` }),
    }));
}

/**
 * Parse agent output. Returns null on parse failure (distinct from [] which
 * means "parsed OK, no findings").
 */
function parseAgentResult(filePath, agentKey, voter) {
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
        return validateFindings(parsed, agentKey, voter);
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

    return validateFindings(findings, agentKey, voter);
  } catch (err) {
    console.warn(`Failed to parse ${filePath}: ${err.message}`);
    return null;
  }
}

// ── Voter consensus ──────────────────────────────────────────────────────────

/**
 * Apply voter consensus using Haiku to semantically determine whether
 * findings from different voters are about the same issue.
 *
 * Haiku receives all findings and returns which ones to keep — i.e. the
 * deduplicated set of issues that a majority of voters agree on.
 *
 * Falls back to keeping all findings (stripped of voter tags) on error.
 */
async function applyConsensus(findings, voterCount, { apiKey, baseUrl }) {
  if (voterCount <= 1) {
    return { kept: findings.map(({ voter, ...rest }) => rest), dropped: 0 };
  }

  if (!apiKey) {
    console.warn("No API key for consensus — keeping all findings");
    return { kept: findings.map(({ voter, ...rest }) => rest), dropped: 0 };
  }

  const threshold = Math.floor(voterCount / 2) + 1;

  const findingsList = findings
    .map((f, i) => {
      const safeComment = f.comment
        .slice(0, 300)
        .replace(/[\r\n]+/g, " ")
        .replace(/<\/?comment>/gi, "");
      const safeVoter = String(f.voter).replace(/[\r\n]+/g, " ");
      const safeFile = String(f.file)
        .replace(/[\r\n]+/g, " ")
        .replace(/<\/?comment>/gi, "");
      const safeLine = String(f.line).replace(/[\r\n]+/g, " ");
      return `${i}. [voter=${safeVoter}] [${f.severity}] ${safeFile}:${safeLine} — <comment>${safeComment}</comment>`;
    })
    .join("\n");

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
        max_tokens: 2000,
        messages: [
          {
            role: "user",
            content: `You are deduplicating code review findings from ${voterCount} independent voters. Each voter reviewed the same code independently. Findings from different voters about the SAME issue (even if worded differently or at slightly different lines) should be grouped together.

For each group of findings about the same issue, check if at least ${threshold} distinct voters flagged it. If yes, keep the single best-worded finding from that group. If fewer than ${threshold} voters flagged it, drop the entire group.

## Findings
${findingsList}

Output a JSON array of the finding indices (0-based) to KEEP — one per distinct issue that meets the ${threshold}-voter threshold. Pick the best-worded finding from each group. Output \`[]\` if none meet the threshold.`,
          },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`API ${response.status}: ${await response.text()}`);
    }

    const result = await response.json();
    const text = result.content?.[0]?.text ?? "";

    const match = text.match(/\[\s*(?:\d+\s*(?:,\s*\d+\s*)*)?\]/);
    if (!match) {
      console.warn("Consensus returned no parseable array — keeping all");
      return { kept: findings.map(({ voter, ...rest }) => rest), dropped: 0 };
    }

    const keptIndices = new Set(
      JSON.parse(match[0])
        .map(Number)
        .filter((n) => Number.isInteger(n) && n >= 0 && n < findings.length),
    );

    const kept = [];
    let dropped = 0;
    for (let i = 0; i < findings.length; i++) {
      if (keptIndices.has(i)) {
        const { voter, ...rest } = findings[i];
        kept.push(rest);
      } else {
        dropped++;
      }
    }

    console.log(
      `Consensus: kept ${kept.length} findings, dropped ${dropped} (${threshold}/${voterCount} voter threshold)`,
    );
    return { kept, dropped };
  } catch (err) {
    console.warn(`Consensus filter failed, keeping all: ${err.message}`);
    return { kept: findings.map(({ voter, ...rest }) => rest), dropped: 0 };
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

// ── Diff parsing ─────────────────────────────────────────────────────────

/**
 * Parse a unified diff to extract the set of commentable lines (RIGHT side)
 * for each file. Returns a Map of path → Set<line number>.
 */
function parseDiffLines(diffText) {
  const commentableLines = new Map();
  let currentFile = null;
  let rightLine = 0;

  for (const line of diffText.split("\n")) {
    // Reset on new file boundary
    if (line.startsWith("diff --git ")) {
      currentFile = null;
      rightLine = 0;
      continue;
    }

    const fileMatch = line.match(/^\+\+\+ b\/(.+)$/);
    if (fileMatch) {
      currentFile = fileMatch[1];
      if (!commentableLines.has(currentFile)) {
        commentableLines.set(currentFile, new Set());
      }
      continue;
    }

    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (hunkMatch) {
      rightLine = parseInt(hunkMatch[1]);
      if (!currentFile) continue;
      // Context and added lines in this hunk are commentable
      continue;
    }

    if (!currentFile || rightLine === 0) continue;

    if (line.startsWith("+")) {
      // Added line — commentable on RIGHT side
      commentableLines.get(currentFile).add(rightLine);
      rightLine++;
    } else if (line.startsWith("-")) {
      // Removed line — doesn't increment right line counter
    } else if (line.startsWith("\\")) {
      // "No newline at end of file" — skip
    } else {
      // Context line — commentable on RIGHT side
      commentableLines.get(currentFile).add(rightLine);
      rightLine++;
    }
  }

  return commentableLines;
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

async function getPRDiff(prNumber) {
  const repo = getEnvOrThrow("GITHUB_REPOSITORY");
  const token = getEnvOrThrow("GITHUB_TOKEN");
  const response = await fetch(
    `https://api.github.com/repos/${repo}/pulls/${prNumber}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.v3.diff",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (!response.ok) {
    throw new Error(`Failed to fetch PR diff: ${response.status}`);
  }
  return response.text();
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
  const voterCount = Math.max(
    1,
    Math.min(parseInt(process.env.VOTERS || "1") || 1, MAX_VOTERS),
  );
  const apiKey = process.env.ANTHROPIC_API_KEY || "";
  const anthropicBaseUrl =
    process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";

  console.log(`Orchestrating AI review for PR #${prNumber}`);
  if (voterCount > 1) {
    console.log(`Voter consensus enabled: ${voterCount} voters per agent`);
  }

  // Resolve previous Review Hero comments so they don't clutter the PR
  await resolvePreviousReviewHeroThreads(prNumber, botLogin);

  // ── Scan for results ──────────────────────────────────────────────────
  // Result files follow one of two patterns:
  //   {key}-result.json          (single voter / voters=1)
  //   {key}-voter-{n}-result.json (multi-voter)
  const RESULT_PATTERN = /^(.+?)(?:-voter-(\d+))?-result\.json$/;
  const agentResults = []; // { agentKey, voter, filePath }

  function scanForResults(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        scanForResults(fullPath);
      } else if (entry.isFile()) {
        const match = entry.name.match(RESULT_PATTERN);
        if (match && VALID_AGENT_KEY.test(match[1])) {
          agentResults.push({
            agentKey: match[1],
            voter: match[2] !== undefined ? parseInt(match[2]) : undefined,
            filePath: fullPath,
          });
        }
      }
    }
  }

  scanForResults(artifactsDir);

  // ── Collect findings ──────────────────────────────────────────────────
  const allFindings = [];
  let agentsCompleted = 0;
  let agentsFailed = 0;
  const seenAgentVoters = new Set();

  for (const { agentKey, voter, filePath } of agentResults) {
    const dedupKey = voter !== undefined ? `${agentKey}-${voter}` : agentKey;
    if (seenAgentVoters.has(dedupKey)) continue;
    seenAgentVoters.add(dedupKey);

    const findings = parseAgentResult(filePath, agentKey, voter);
    if (findings === null) {
      const name = agentNames[agentKey] ?? agentKey;
      const voterLabel = voter !== undefined ? ` (voter ${voter})` : "";
      console.warn(`${name}${voterLabel}: failed to parse output`);
      agentsFailed++;
      continue;
    }
    const name = agentNames[agentKey] ?? agentKey;
    const voterLabel = voter !== undefined ? ` (voter ${voter})` : "";
    console.log(`${name}${voterLabel}: ${findings.length} findings`);
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

  // ── Apply voter consensus ─────────────────────────────────────────────
  // Each agent runs voterCount independent voters. The threshold should be
  // based on voterCount, not the total unique voter IDs across all agents
  // (which would be N×voterCount and make consensus impossible to reach).
  const consensus = await applyConsensus(allFindings, voterCount, {
    apiKey,
    baseUrl: anthropicBaseUrl,
  });
  const findings = consensus.kept;
  const consensusDropped = consensus.dropped;

  // ── Deduplicate ───────────────────────────────────────────────────────
  const groups = deduplicateFindings(findings);

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

  // Post inline review comments — filter to lines in the diff
  if (inlineComments.length > 0) {
    let diffCommentableLines;
    try {
      const diffText = await getPRDiff(prNumber);
      diffCommentableLines = parseDiffLines(diffText);
    } catch (err) {
      console.warn(`Failed to fetch PR diff for filtering: ${err.message}`);
      diffCommentableLines = null;
    }

    let validComments = inlineComments;
    let droppedComments = [];
    if (diffCommentableLines) {
      validComments = [];
      for (const c of inlineComments) {
        const fileLines = diffCommentableLines.get(c.path);
        if (fileLines && fileLines.has(c.line)) {
          validComments.push(c);
        } else {
          droppedComments.push(c);
        }
      }
      if (droppedComments.length > 0) {
        console.log(
          `Filtered ${droppedComments.length} comment(s) on lines outside the diff`,
        );
      }
    }

    const commitSha = await getLatestCommit(prNumber);

    if (validComments.length > 0) {
      try {
        await postReview(prNumber, commitSha, validComments);
        console.log(`Posted ${validComments.length} inline review comments`);
      } catch (err) {
        console.error(`Failed to post inline review: ${err.message}`);
        // Move all to fallback
        droppedComments = [...validComments, ...droppedComments];
      }
    }

    // Post any comments that couldn't be inlined as a regular comment
    if (droppedComments.length > 0) {
      const fallbackLines = droppedComments
        .map((c) => `**\`${c.path}:${c.line}\`**\n\n${c.body}`)
        .join("\n\n---\n\n");
      await postComment(
        prNumber,
        `🦸 **Review Hero** (${droppedComments.length} comment${droppedComments.length === 1 ? "" : "s"} on lines outside the diff)\n\n${fallbackLines}`,
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

  // Show filtering stats when non-trivial filtering occurred
  const filterStats = [];
  if (voterCount > 1) {
    filterStats.push(`consensus ${voterCount} voters`);
  }
  if (consensusDropped > 0) {
    filterStats.push(`${consensusDropped} below threshold`);
  }
  if (filterStats.length > 0) {
    summaryParts.push(` | Filtering: ${filterStats.join(", ")}`);
  }

  if (findings.length === 0) {
    summaryParts.push("\n\nNo issues found. Looks good! ✅");
  }

  const nitpickTable = buildSummaryTable(nitpicks, agentNames);
  if (nitpickTable) {
    summaryParts.push(`\n\n${nitpickTable}`);
  }

  // Collapse each dedup group into a single item so the local fix prompt
  // doesn't contain near-duplicate entries that were already merged during
  // deduplication.  Each group shares a (file, ~line) so we take the first
  // finding's location and join the unique comments.
  const dedupedFindings = [...groups.values()].map((group) => ({
    file: group[0].file,
    line: group[0].line,
    comment: [...new Set(group.map((f) => f.comment))].join("\n\n"),
  }));

  const localPrompt = buildLocalFixPrompt(dedupedFindings);
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
