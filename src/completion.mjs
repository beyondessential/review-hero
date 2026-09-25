/**
 * Review Hero — Completion comment protocol
 *
 * The wire format tooling reads: the hidden block that ends every completion
 * comment, and the review result that goes into it. Kept apart from the
 * summary's human-facing formatting because this is a versioned contract —
 * COMPLETION_SCHEMA moves when the shape does, not when summary copy is
 * reworded.
 */

/** Marker that opens the machine-readable block in a completion comment. */
export const COMPLETION_MARKER = "review-hero:completion";

/**
 * Version of the completion block's shape. Adding a field keeps it; removing a
 * field or changing what one means increments it.
 */
export const COMPLETION_SCHEMA = 1;

/**
 * Build the hidden block that ends every completion comment: an HTML comment
 * holding a single-line JSON object.
 *
 * `>` is written as `>` so no value can close the HTML comment early.
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

/** Matches one completion block. Global, because a body may contain more than one. */
function blockPattern() {
  return new RegExp(`<!-- ${COMPLETION_MARKER} (\\{[^\\n]*?\\}) -->`, "g");
}

/**
 * Read the completion block out of a comment body.
 *
 * Takes the LAST block in the body. The genuine one is always appended last,
 * while the text before it can quote untrusted PR content — a review thread
 * body echoed into the local fix prompt, say — so an earlier block is someone
 * else's text rather than ours.
 *
 * This only picks out Review Hero's own block within a comment Review Hero
 * wrote. It cannot tell you the comment itself is Review Hero's: check the
 * comment's author before trusting what you read here.
 *
 * @returns {object | null} The parsed block, or null when the body has none.
 */
// spec: CMPL#machine-readable-block
export function parseCompletionBlock(body) {
  if (!body) return null;
  const matches = [...String(body).matchAll(blockPattern())].reverse();
  for (const match of matches) {
    try {
      return JSON.parse(match[1]);
    } catch {
      // Malformed. Fall back to an earlier block rather than losing a genuine
      // one to trailing junk.
    }
  }
  return null;
}

/**
 * Neutralise anything that reads as a completion block, for untrusted text
 * being embedded in a comment Review Hero posts.
 *
 * Defence in depth: `parseCompletionBlock` already prefers the genuine trailing
 * block, but a consumer may scan more loosely than we do.
 */
export function stripCompletionBlocks(text) {
  return String(text ?? "").replace(
    new RegExp(`<!--\\s*${COMPLETION_MARKER}[\\s\\S]*?-->`, "g"),
    "[redacted]",
  );
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
