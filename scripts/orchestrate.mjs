/**
 * Review Hero — Orchestrator
 *
 * Reads structured JSON findings from review agent artifacts, applies voter
 * consensus (when multiple voters per agent), filters against suppression
 * rules, deduplicates, and posts a consolidated PR review via the GitHub API.
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
 *   SUPPRESSIONS_PATH   — Path to local suppressions YAML file (optional)
 *   GLOBAL_SUPPRESSIONS_PATH — Path to global suppressions YAML file (optional)
 *   ANTHROPIC_API_KEY   — API key for Haiku-based filtering (optional)
 *   ANTHROPIC_BASE_URL  — Custom base URL for the Anthropic API (optional)
 */

import { readdirSync } from "node:fs";
import { buildLocalFixPrompt } from "./local-fix-prompt.mjs";
import {
  findRejectedFindings,
  generateSuppressions,
} from "./learn-from-reactions.mjs";
import { join } from "node:path";
import { MAX_VOTERS } from "./lib.mjs";
import {
  parseAgentResult,
  extractJsonArray,
  applyConsensus,
  groupAllFindings,
  loadSuppressions,
  filterWithSuppressions,
  VALID_AGENT_KEY,
  SUMMARY_HEADER,
  buildSummaryHeader,
  buildSummaryTable,
  createAnthropicModelCaller,
} from "../src/index.mjs";

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

// ── Comment formatting ───────────────────────────────────────────────────────

function buildInlineComment(f, agentNames) {
  const agentName = agentNames[f.agent] ?? f.agent;
  return `**[${agentName}]** \`${f.severity}\`\n\n${f.comment}`;
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
    // GraphQL returns login without "[bot]" suffix, REST includes it
    const botBase = botLogin.replace(/\[bot\]$/, "");
    if (author !== botLogin && author !== botBase) continue;

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

async function countPreviousRounds(prNumber) {
  let count = 0;
  for (let page = 1; ; page++) {
    const comments = await githubApi(
      `/issues/${prNumber}/comments?per_page=100&page=${page}`,
    );
    count += comments.filter((c) => c.body?.startsWith(SUMMARY_HEADER)).length;
    if (comments.length < 100) return count;
  }
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
  const suppressionsPath = process.env.SUPPRESSIONS_PATH || "";
  const apiKey = process.env.ANTHROPIC_API_KEY || "";
  const anthropicBaseUrl =
    process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
  const repo = getEnvOrThrow("GITHUB_REPOSITORY");

  // The filtering stages reach the model through a caller-supplied function;
  // this repo backs it with the Anthropic API. Null when no key is set, which
  // makes consensus, grouping, and suppression keep every finding.
  const callModel = apiKey
    ? createAnthropicModelCaller({ apiKey, baseUrl: anthropicBaseUrl })
    : null;

  console.log(`Orchestrating AI review for PR #${prNumber}`);
  if (voterCount > 1) {
    console.log(`Voter consensus enabled: ${voterCount} voters per agent`);
  }

  // ── Learn from reactions ──────────────────────────────────────────────
  // Before resolving old threads, check for thumbs-down reactions so we
  // can generate ephemeral suppression rules for this review cycle.
  let learnedSuppressions = [];
  if (apiKey) {
    try {
      const rejected = await findRejectedFindings(
        githubGraphQL,
        repo,
        prNumber,
        botLogin,
      );
      if (rejected.length > 0) {
        console.log(
          `Found ${rejected.length} thumbs-down reaction${rejected.length === 1 ? "" : "s"} on previous review`,
        );
        learnedSuppressions = await generateSuppressions(rejected, {
          apiKey,
          baseUrl: anthropicBaseUrl,
        });
        if (learnedSuppressions.length > 0) {
          console.log(
            `Generated ${learnedSuppressions.length} suppression${learnedSuppressions.length === 1 ? "" : "s"} from developer feedback`,
          );
        }
      }
    } catch (err) {
      console.warn(`Reaction learning failed: ${err.message}`);
    }
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
  // Apply consensus per agent so that cross-agent findings about the same
  // line aren't incorrectly grouped and dropped. Each agent's voters are
  // independent — a bugs voter and a performance voter flagging the same
  // line are distinct findings, not duplicates.
  let findings = [];
  let allDroppedFindings = [];

  if (voterCount > 1) {
    const findingsByAgent = new Map();
    for (const f of allFindings) {
      const agentKey = f.agent;
      if (!findingsByAgent.has(agentKey)) findingsByAgent.set(agentKey, []);
      findingsByAgent.get(agentKey).push(f);
    }

    const entries = [...findingsByAgent.entries()];
    const results = await Promise.all(
      entries.map(([, agentFindings]) =>
        applyConsensus(agentFindings, voterCount, callModel)
      )
    );
    for (const c of results) {
      findings.push(...c.kept);
      allDroppedFindings.push(...c.droppedFindings);
    }
  } else {
    findings = allFindings.map(({ voter, ...rest }) => rest);
  }

  // ── Apply suppression filter ──────────────────────────────────────────
  const globalSuppressionsPath = process.env.GLOBAL_SUPPRESSIONS_PATH || "";
  const localSuppressions = loadSuppressions(suppressionsPath);
  const globalSuppressions = loadSuppressions(globalSuppressionsPath);
  const allSuppressions = [...globalSuppressions, ...localSuppressions, ...learnedSuppressions];
  let suppressedCount = 0;

  if (allSuppressions.length > 0 && apiKey && findings.length > 0) {
    console.log(
      `Filtering against ${allSuppressions.length} suppression rule${allSuppressions.length === 1 ? "" : "s"} (${globalSuppressions.length} global, ${localSuppressions.length} local, ${learnedSuppressions.length} learned)`,
    );
    try {
      const { kept, suppressed } = await filterWithSuppressions(
        findings,
        allSuppressions,
        callModel,
      );
      suppressedCount = suppressed.length;
      if (suppressedCount > 0) {
        console.log(`Suppressed ${suppressedCount} finding(s)`);
        for (const f of suppressed) {
          console.log(`  suppressed: ${f.file}:${f.line} — ${f.comment.slice(0, 80)}`);
        }
      }
      findings = kept;
    } catch (err) {
      console.warn(`Suppression filter failed: ${err.message}`);
    }
  }


  // ── Phase 2: Cross-agent grouping ────────────────────────────────────
  // Group ALL findings (kept + dropped) across all agents using Sonnet.
  // Groups where any member passed consensus → post inline.
  // Groups where no member passed → show in dropdown.
  const { keptGroups, droppedGroups } = await groupAllFindings(
    findings,
    allDroppedFindings,
    callModel,
  );

  // Split kept groups by severity
  const inlineComments = [];
  const nitpicks = [];
  const counts = { critical: 0, suggestion: 0, nitpick: 0 };

  for (const group of keptGroups) {
    const f = group.representative;
    counts[f.severity]++;

    if (f.severity === "nitpick") {
      nitpicks.push(f);
    } else {
      inlineComments.push({
        path: f.file,
        line: f.line,
        body: buildInlineComment(f, agentNames),
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
  let round = null;
  try {
    round = (await countPreviousRounds(prNumber)) + 1;
  } catch (err) {
    console.warn(`Failed to count previous rounds: ${err.message}`);
  }

  const summaryParts = [
    buildSummaryHeader({ round, agentsCompleted, agentsFailed, counts }),
  ];

  // Show filtering stats when non-trivial filtering occurred
  const filterStats = [];
  if (voterCount > 1) {
    filterStats.push(`consensus ${voterCount} voters`);
  }
  if (droppedGroups.length > 0) {
    filterStats.push(`${droppedGroups.length} below threshold`);
  }
  if (suppressedCount > 0) {
    filterStats.push(`${suppressedCount} suppressed`);
  }
  if (filterStats.length > 0) {
    summaryParts.push(` | Filtering: ${filterStats.join(", ")}`);
  }

  if (keptGroups.length === 0) {
    summaryParts.push("\n\nNo issues found. Looks good!");
  }

  // Show dropped groups in a collapsed section
  if (droppedGroups.length > 0) {
    const sorted = [...droppedGroups].sort((a, b) => {
      const fa = a.representative, fb = b.representative;
      if (fa.file !== fb.file) return fa.file.localeCompare(fb.file);
      return fa.line - fb.line;
    });

    const droppedRows = sorted.map((group) => {
      const f = group.representative;
      const agentName = agentNames[f.agent] ?? f.agent;
      const shortComment =
        f.comment.length > 200 ? `${f.comment.slice(0, 197)}...` : f.comment;
      const escaped = shortComment
        .replace(/\\/g, "\\\\")
        .replace(/\|/g, "\\|")
        .replace(/\n/g, " ");
      return `| \`${f.file}:${f.line}\` | ${agentName} | \`${f.severity}\` | ${escaped} |`;
    }).join("\n");

    summaryParts.push(
      `\n\n<details>\n<summary>Below consensus threshold (${sorted.length} unique issue${sorted.length === 1 ? "" : "s"} not confirmed by majority)</summary>\n\n` +
      `| Location | Agent | Severity | Comment |\n|----------|-------|----------|---------|\n${droppedRows}\n\n</details>`,
    );
  }

  const nitpickTable = buildSummaryTable(nitpicks, agentNames);
  if (nitpickTable) {
    summaryParts.push(`\n\n${nitpickTable}`);
  }

  // Use representative comments for the local fix prompt
  const dedupedFindings = keptGroups.map((g) => ({
    file: g.representative.file,
    line: g.representative.line,
    comment: g.representative.comment,
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

// Only orchestrate when run directly, so the parsing helpers can be imported
// by tests without kicking off a full review run.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { parseAgentResult, extractJsonArray, buildSummaryHeader };
