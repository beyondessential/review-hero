/**
 * Review Hero — Summary formatting
 *
 * Formats the consolidated review summary a reviewer sees: the header line and
 * the nitpick table. Also builds the pieces every completion comment shares:
 * commit links and the hidden machine-readable block. Shared so a consumer
 * presents the same summary this repo does.
 */

/** Leading marker for a Review Hero summary comment, used to detect prior rounds. */
export const SUMMARY_HEADER = "🦸 **Review Hero Summary**";

/** Severity sort order, most to least severe. */
export const SEVERITY_ORDER = { critical: 0, suggestion: 1, nitpick: 2 };

/** Marker that opens the machine-readable block in a completion comment. */
export const COMPLETION_MARKER = "review-hero:completion";

/**
 * Version of the completion block's shape. Adding a field keeps it; removing a
 * field or changing what one means increments it.
 */
export const COMPLETION_SCHEMA = 1;

const FULL_SHA = /^[0-9a-f]{40}$/;

/**
 * Link a commit within its pull request, shown as its short SHA.
 *
 * @returns {string | null} Markdown link, or null when `sha` is not a full SHA.
 */
export function formatCommitLink({ serverUrl, repo, prNumber, sha }) {
  if (!FULL_SHA.test(sha ?? "")) return null;
  return `[\`${sha.slice(0, 7)}\`](${serverUrl}/${repo}/pull/${prNumber}/commits/${sha})`;
}

/**
 * Build the hidden block that ends every completion comment: an HTML comment
 * holding a single-line JSON object.
 *
 * `>` is written as `\u003e` so no value can close the HTML comment early.
 * JSON only has `>` inside strings, where the escape is equivalent.
 */
// spec: CMPL#machine-readable-block
export function buildCompletionBlock(fields) {
  const json = JSON.stringify({ schema: COMPLETION_SCHEMA, ...fields }).replace(
    />/g,
    "\\u003e",
  );
  return `<!-- ${COMPLETION_MARKER} ${json} -->`;
}

/**
 * Read the completion block out of a comment body.
 *
 * @returns {object | null} The parsed block, or null when the body has none.
 */
export function parseCompletionBlock(body) {
  const match = body?.match(/<!-- review-hero:completion (\{[^\n]*?\}) -->/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

/**
 * The result of a review round as data: the `review` completion block's fields
 * other than the run metadata (`schema`, `runUrl`, `reviewHero`). Built from the
 * review pipeline's outputs, so a consumer running the review itself gets the
 * same figures the hosted review reports.
 *
 * @param {object} args
 * @param {string} args.reviewedSha   The commit that was reviewed.
 * @param {number} args.agentsCompleted
 * @param {number} args.agentsFailed
 * @param {number} args.voters        Voters per agent.
 * @param {Array<{representative: {severity: string}}>} [args.keptGroups]
 *   Groups that passed consensus, from `groupAllFindings`.
 * @param {Array} [args.droppedGroups] Groups below the consensus threshold.
 * @param {number} [args.suppressedCount] Findings removed by suppression rules.
 */
// spec: CMPL#review
export function buildReviewResult({
  reviewedSha,
  agentsCompleted,
  agentsFailed,
  voters,
  keptGroups = [],
  droppedGroups = [],
  suppressedCount = 0,
}) {
  const severities = { critical: 0, suggestion: 0, nitpick: 0 };
  for (const group of keptGroups) severities[group.representative.severity]++;
  return {
    kind: "review",
    outcome: agentsCompleted > 0 ? "completed" : "failed",
    reviewedSha,
    counts: {
      agentsCompleted,
      agentsFailed,
      voters,
      ...severities,
      belowThreshold: droppedGroups.length,
      suppressed: suppressedCount,
    },
  };
}

export function buildSummaryHeader({ round, commitLink, agentsCompleted, agentsFailed, counts }) {
  return (
    `${SUMMARY_HEADER}${round ? ` (round ${round})` : ""}` +
    `${commitLink ? ` · reviewed ${commitLink}` : ""}\n` +
    `**${agentsCompleted} agent${agentsCompleted === 1 ? "" : "s"}** reviewed this PR` +
    (agentsFailed > 0 ? ` | ${agentsFailed} failed` : "") +
    ` | ${counts.critical} critical` +
    ` | ${counts.suggestion} suggestion${counts.suggestion === 1 ? "" : "s"}` +
    ` | ${counts.nitpick} nitpick${counts.nitpick === 1 ? "" : "s"}`
  );
}

export function buildSummaryTable(nitpicks, agentNames) {
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
