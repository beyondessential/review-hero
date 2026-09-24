import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SUMMARY_HEADER,
  COMPLETION_SCHEMA,
  formatCommitLink,
  buildCompletionBlock,
  parseCompletionBlock,
  buildReviewResult,
} from "./index.mjs";

const SHA = "0123456789abcdef0123456789abcdef01234567";

// ── Commit links ─────────────────────────────────────────────────────────────

test("a commit link shows the short SHA and points at the commit within the PR", () => {
  assert.equal(
    formatCommitLink({ serverUrl: "https://github.com", repo: "o/r", prNumber: 7, sha: SHA }),
    `[\`0123456\`](https://github.com/o/r/pull/7/commits/${SHA})`,
  );
});

test("a commit link is refused for anything but a full SHA", () => {
  for (const sha of [null, undefined, "", "0123456", `${SHA}0`, "main", "](evil)"]) {
    assert.equal(
      formatCommitLink({ serverUrl: "https://github.com", repo: "o/r", prNumber: 7, sha }),
      null,
    );
  }
});

// ── Completion block ─────────────────────────────────────────────────────────

test("the completion block is a single-line HTML comment with the schema first", () => {
  const block = buildCompletionBlock({ kind: "review", outcome: "completed", reviewedSha: SHA });
  assert.equal(
    block,
    `<!-- review-hero:completion {"schema":${COMPLETION_SCHEMA},"kind":"review","outcome":"completed","reviewedSha":"${SHA}"} -->`,
  );
  assert.ok(!block.includes("\n"));
});

test("no value can close the HTML comment early", () => {
  const block = buildCompletionBlock({
    kind: "auto-fix",
    outcome: "failed",
    reviewHero: { ref: "feature/--> <b>x</b>\nnext", sha: null },
  });
  const inner = block.slice("<!-- ".length, -" -->".length);
  assert.ok(!inner.includes(">"), inner);
  assert.ok(!block.includes("\n"));
  assert.equal(parseCompletionBlock(block).reviewHero.ref, "feature/--> <b>x</b>\nnext");
});

test("the completion block round-trips out of a full comment body", () => {
  const fields = {
    kind: "review",
    outcome: "completed",
    reviewedSha: SHA,
    counts: { agentsCompleted: 5, agentsFailed: 0, critical: 1 },
    runUrl: "https://github.com/o/r/actions/runs/1",
    reviewHero: { ref: "v1", sha: SHA },
  };
  const body =
    `${SUMMARY_HEADER} (round 1)\n**5 agents** reviewed this PR\n\n` +
    "<details>\n<summary>Local fix prompt</summary>\n\n````\n<!-- not ours -->\n````\n\n</details>\n\n" +
    buildCompletionBlock(fields);
  assert.deepEqual(parseCompletionBlock(body), { schema: COMPLETION_SCHEMA, ...fields });
});

test("a comment without a completion block parses to null", () => {
  assert.equal(parseCompletionBlock(`${SUMMARY_HEADER}\nNo issues found.`), null);
  assert.equal(parseCompletionBlock(undefined), null);
  assert.equal(parseCompletionBlock("<!-- review-hero:completion {not json} -->"), null);
});

// ── Review result ────────────────────────────────────────────────────────────

const group = (severity) => ({ representative: { severity }, members: [] });

test("a review result counts kept groups by severity and reports the filtering figures", () => {
  assert.deepEqual(
    buildReviewResult({
      reviewedSha: SHA,
      agentsCompleted: 4,
      agentsFailed: 1,
      voters: 3,
      keptGroups: [group("critical"), group("suggestion"), group("suggestion"), group("nitpick")],
      droppedGroups: [group("suggestion"), group("nitpick")],
      suppressedCount: 2,
    }),
    {
      kind: "review",
      outcome: "completed",
      reviewedSha: SHA,
      counts: {
        agentsCompleted: 4,
        agentsFailed: 1,
        voters: 3,
        critical: 1,
        suggestion: 2,
        nitpick: 1,
        belowThreshold: 2,
        suppressed: 2,
      },
    },
  );
});

test("a review where no agent completed is a failed result with zero counts", () => {
  const result = buildReviewResult({ reviewedSha: SHA, agentsCompleted: 0, agentsFailed: 3, voters: 1 });
  assert.equal(result.outcome, "failed");
  assert.deepEqual(result.counts, {
    agentsCompleted: 0,
    agentsFailed: 3,
    voters: 1,
    critical: 0,
    suggestion: 0,
    nitpick: 0,
    belowThreshold: 0,
    suppressed: 0,
  });
});

test("a review result serialises into the review completion block", () => {
  const result = buildReviewResult({ reviewedSha: SHA, agentsCompleted: 1, agentsFailed: 0, voters: 1 });
  const block = buildCompletionBlock({ ...result, runUrl: null, reviewHero: { ref: null, sha: null } });
  assert.deepEqual(parseCompletionBlock(block), {
    schema: COMPLETION_SCHEMA,
    ...result,
    runUrl: null,
    reviewHero: { ref: null, sha: null },
  });
});
