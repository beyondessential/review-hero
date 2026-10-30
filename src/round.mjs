/**
 * Review Hero — A review round as data
 *
 * The payload a review posts to a caller-named URL alongside its GitHub
 * comments: the round's result and every kept finding as fields, so a receiver
 * need not parse them back out of comment text. Its JSON Schema is published
 * in `schemas/`, one file per version.
 */

import { effectiveEndLine } from "./findings.mjs";

/**
 * Version of the payload's shape. Adding a field keeps it; removing a field or
 * changing what one means increments it.
 */
export const FINDINGS_SCHEMA = 1;

/**
 * Where this version's JSON Schema is published. The repository keeps one file
 * per version, so the file for a version stays put while its compatible
 * additions edit it in place.
 */
export const FINDINGS_SCHEMA_URL = `https://raw.githubusercontent.com/beyondessential/review-hero/main/schemas/findings-round.v${FINDINGS_SCHEMA}.json`;

/**
 * The kept findings of a round, one per group: the group's representative with
 * its severity, agent, location, voter count and comment. A finding with no
 * end line has a null `endLine`, and one whose voter count the review cannot
 * tell has a null `supporters`.
 *
 * Grouping can pick a finding consensus dropped as a kept group's
 * representative, and a dropped finding has no voter count. Its group then
 * takes the highest voter count among its members, which is what kept it. A
 * kept representative whose count is unknown stays unknown.
 *
 * @param {Array<{representative: object}>} keptGroups From `groupAllFindings`.
 * @param {Record<string, string>} [agentNames] Agent key to display name.
 */
// spec: FPOST#findings
export function buildRoundFindings(keptGroups, agentNames = {}) {
  // A kept finding always carries `supporters`, a number or null for "cannot
  // tell"; a dropped one carries none, so only then do the members stand in.
  const countOf = ({ representative, members = [] }) => {
    if (representative.supporters !== undefined) {
      return Number.isInteger(representative.supporters) ? representative.supporters : null;
    }
    const counts = members.map((m) => m.supporters).filter(Number.isInteger);
    return counts.length > 0 ? Math.max(...counts) : null;
  };
  return keptGroups.map((group) => {
    const f = group.representative;
    return {
      severity: f.severity,
      agent: { key: f.agent, name: agentNames[f.agent] ?? f.agent },
      path: f.file,
      startLine: f.line,
      endLine: effectiveEndLine(f) ?? null,
      supporters: countOf(group),
      comment: f.comment,
    };
  });
}

/**
 * The payload for one round. `result` is the object `buildReviewResult` makes,
 * which goes in as the completion block reports it, less its `kind`. Each
 * finding gets an identifier unique within the run attempt, and the id of its
 * GitHub review comment (`commentIds[i]` for finding `i`) or null when it was
 * not posted inline.
 *
 * @param {object} args
 * @param {string} args.repository    `owner/name`.
 * @param {number} args.prNumber
 * @param {number} args.runId         GitHub Actions run id.
 * @param {number} args.runAttempt
 * @param {{ref: string|null, sha: string|null}} args.reviewHero
 * @param {object} args.result        From `buildReviewResult`.
 * @param {Array} args.findings       From `buildRoundFindings`.
 * @param {Array<number|null>} [args.commentIds]
 */
// spec: FPOST#payload
export function buildFindingsPayload({ repository, prNumber, runId, runAttempt, reviewHero, result, findings, commentIds = [] }) {
  const { kind, ...round } = result;
  return {
    $schema: FINDINGS_SCHEMA_URL,
    schema: FINDINGS_SCHEMA,
    repository,
    prNumber,
    runId,
    runAttempt,
    reviewHero,
    ...round,
    findings: findings.map((f, i) => ({
      id: `${runId}-${runAttempt}-${i + 1}`,
      ...f,
      commentId: commentIds[i] ?? null,
    })),
  };
}
