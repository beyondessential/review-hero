import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SUMMARY_HEADER,
  COMPLETION_SCHEMA,
  formatCommitLink,
  buildCompletionBlock,
  parseCompletionBlock,
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
