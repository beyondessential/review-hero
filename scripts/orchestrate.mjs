/**
 * Review Hero — Orchestrator
 *
 * Reads the consensus outcome (the findings voter consensus and any second
 * look kept and dropped), filters against suppression rules, deduplicates,
 * and posts a consolidated PR review via the GitHub API.
 *
 * Environment variables:
 *   GITHUB_TOKEN        — GitHub App token for posting reviews
 *   GITHUB_ACTIONS_TOKEN— Built-in Actions token (for unchecking the checkbox
 *                         without re-triggering the workflow)
 *   GITHUB_REPOSITORY   — owner/repo
 *   PR_NUMBER           — Pull request number
 *   REVIEWED_SHA        — PR head commit the agents reviewed
 *   REVIEW_HERO_REF     — Review Hero ref the caller asked for (optional)
 *   CONSENSUS_PATH      — Consensus outcome from the consensus step and any second look
 *   ARTIFACTS_DIR       — Agent result files, posted from without consensus when
 *                         there is no consensus outcome
 *   VOTERS              — Voters each agent ran, reported when there is no consensus outcome
 *   AGENT_NAMES         — JSON map of agent key → display name
 *   APP_SLUG            — Slug of the GitHub App (e.g. "review-hero")
 *   SUPPRESSIONS_PATH   — Path to local suppressions YAML file (optional)
 *   GLOBAL_SUPPRESSIONS_PATH — Path to global suppressions YAML file (optional)
 *   ANTHROPIC_API_KEY   — API key for Haiku-based filtering (optional)
 *   ANTHROPIC_BASE_URL  — Custom base URL for the Anthropic API (optional)
 */

import { readFileSync } from "node:fs";
import { buildLocalFixPrompt } from "./local-fix-prompt.mjs";
import {
  findRejectedFindings,
  generateSuppressions,
} from "./learn-from-reactions.mjs";
import { MAX_VOTERS, createCompletionReporter } from "./lib.mjs";
import { outcomeWithoutConsensus } from "./consensus.mjs";
import {
  parseAgentResult,
  extractJsonArray,
  groupAllFindings,
  loadSuppressions,
  filterWithSuppressions,
  SUMMARY_HEADER,
  buildSummaryHeader,
  buildSummaryTable,
  buildReviewResult,
  stripCompletionBlocks,
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

    const updated = body.replace(/\[x\](\s+\*\*Run Review Hero[^*\r\n]*\*\* <!-- #ai-review(?:-claude)? -->)/g, "[ ]$1");

    if (updated === body) return;

    // Use the built-in Actions token so the PATCH doesn't trigger a
    // pull_request.edited event (app tokens do, built-in tokens don't)
    const actionsToken = process.env.GITHUB_ACTIONS_TOKEN;
    await githubApi(
      `/pulls/${prNumber}`,
      { method: "PATCH", body: JSON.stringify({ body: updated }) },
      { token: actionsToken },
    );
    console.log("Unchecked Review Hero checkboxes");
  } catch (err) {
    console.warn(`Failed to uncheck checkbox: ${err.message}`);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const prNumber = getEnvOrThrow("PR_NUMBER");
  // spec: CMPL#reviewed-commit
  const reviewedSha = getEnvOrThrow("REVIEWED_SHA");
  const consensusPath = getEnvOrThrow("CONSENSUS_PATH");
  const agentNames = loadAgentNames();
  const appSlug = process.env.APP_SLUG || "review-hero";
  const botLogin = `${appSlug}[bot]`;
  const suppressionsPath = process.env.SUPPRESSIONS_PATH || "";
  const apiKey = process.env.ANTHROPIC_API_KEY || "";
  const anthropicBaseUrl =
    process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
  const repo = getEnvOrThrow("GITHUB_REPOSITORY");
  const completion = createCompletionReporter({ repo, prNumber });
  const reviewedLink = completion.link(reviewedSha);

  // The filtering stages reach the model through a caller-supplied function;
  // this repo backs it with the Anthropic API. Null when no key is set, which
  // makes grouping and suppression keep every finding.
  const callModel = apiKey
    ? createAnthropicModelCaller({ apiKey, baseUrl: anthropicBaseUrl })
    : null;

  console.log(`Orchestrating AI review for PR #${prNumber}`);

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

  // ── Read the consensus outcome ────────────────────────────────────
  // The consensus step, and any second look after it, ran without the
  // GitHub token. When it left no outcome (it failed or ran out of time),
  // post from the agents' result files with every finding kept.
  let consensus;
  try {
    consensus = JSON.parse(readFileSync(consensusPath, "utf-8"));
  } catch (err) {
    console.log(
      `::warning::No consensus outcome (${err.message}); posting every agent finding without consensus`,
    );
    consensus = outcomeWithoutConsensus(
      process.env.ARTIFACTS_DIR || "",
      Math.max(1, Math.min(parseInt(process.env.VOTERS || "1") || 1, MAX_VOTERS)),
    );
  }
  const { agentsCompleted, agentsFailed } = consensus;
  const voterCount = consensus.voters;
  const secondLook = consensus.secondLook ?? 0;

  if (agentsCompleted === 0) {
    const block = completion.block(
      buildReviewResult({
        reviewedSha,
        agentsCompleted,
        agentsFailed,
        voters: voterCount,
        model: process.env.AGENT_MODEL,
      }),
    );
    await postComment(
      prNumber,
      `🦸 **Review Hero** was requested${reviewedLink ? ` for ${reviewedLink}` : ""} but could not complete — all agents failed. Check the workflow logs for details.\n\n${block}`,
    );
    return;
  }

  let findings = consensus.kept;
  const allDroppedFindings = consensus.dropped;

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

  const result = buildReviewResult({
    reviewedSha,
    agentsCompleted,
    agentsFailed,
    voters: voterCount,
    model: process.env.AGENT_MODEL,
    keptGroups,
    droppedGroups,
    suppressedCount,
    secondLook,
  });

  // Split kept groups by severity
  const inlineComments = [];
  const nitpicks = [];

  for (const group of keptGroups) {
    const f = group.representative;

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
  // Anchored to the reviewed commit even if the PR has moved on since, so the
  // comments sit on the code the agents actually saw.
  if (inlineComments.length > 0) {
    try {
      await postReview(prNumber, reviewedSha, inlineComments);
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
    buildSummaryHeader({
      round,
      commitLink: reviewedLink,
      model: process.env.AGENT_MODEL,
      agentsCompleted,
      agentsFailed,
      counts: result.counts,
    }),
  ];

  // Show filtering stats when non-trivial filtering occurred
  const filterStats = [];
  if (voterCount > 1) {
    filterStats.push(`consensus ${voterCount} voters`);
  }
  if (droppedGroups.length > 0) {
    filterStats.push(`${droppedGroups.length} below threshold`);
  }
  // spec: RUN#second-look
  if (secondLook > 0) {
    filterStats.push(`${secondLook} confirmed on a second look`);
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

  // Everything above quotes the pull request one way or another — finding text,
  // file paths, the fix prompt. Strip anything block-shaped from the lot before
  // the genuine block goes on the end, so a new section can't reintroduce the
  // hole by forgetting to sanitise its own cells.
  // spec: CMPL#telling-review-heros-own-block-apart
  const body = stripCompletionBlocks(summaryParts.join("")) +
    `\n\n${completion.block(result)}`;

  await postComment(prNumber, body);
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
