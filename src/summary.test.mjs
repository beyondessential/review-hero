import assert from "node:assert/strict";
import { test } from "node:test";

import { formatCommitLink, buildSummaryHeader } from "./index.mjs";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const link = (overrides) =>
  formatCommitLink({ serverUrl: "https://github.com", repo: "o/r", prNumber: 7, sha: SHA, ...overrides });

test("a commit link shows the short SHA and points at the commit within the PR", () => {
  assert.equal(link(), `[\`0123456\`](https://github.com/o/r/pull/7/commits/${SHA})`);
});

test("a commit link is refused for anything but a full SHA", () => {
  for (const sha of [null, undefined, "", "0123456", `${SHA}0`, "main", "](evil)"]) {
    assert.equal(link({ sha }), null);
  }
});

test("a commit link is refused when any other part could break out of the markdown", () => {
  assert.equal(link({ repo: "o/r) [gotcha](https://evil.example" }), null);
  assert.equal(link({ repo: "not-a-repo" }), null);
  assert.equal(link({ prNumber: "7) [gotcha](https://evil.example" }), null);
  assert.equal(link({ prNumber: "" }), null);
  assert.equal(link({ serverUrl: "javascript:alert(1)" }), null);
  assert.equal(link({ serverUrl: "http://github.com" }), null);
  assert.equal(link({ serverUrl: "not a url" }), null);
});

test("the summary header names the reviewed commit after the round", () => {
  const header = buildSummaryHeader({
    round: 2,
    commitLink: "[`abc1234`](https://github.com/o/r/pull/7/commits/abc)",
    agentsCompleted: 3,
    agentsFailed: 0,
    counts: { critical: 0, suggestion: 0, nitpick: 0 },
  });
  assert.equal(
    header.split("\n")[0],
    "🦸 **Review Hero Summary** (round 2) · reviewed [`abc1234`](https://github.com/o/r/pull/7/commits/abc)",
  );
});
