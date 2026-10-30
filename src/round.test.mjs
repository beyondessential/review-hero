import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

import {
  buildFindingsPayload,
  buildReviewResult,
  buildRoundFindings,
  commentLines,
  effectiveEndLine,
  FINDINGS_SCHEMA,
  FINDINGS_SCHEMA_URL,
  diffGitPath,
  filterDiff,
  matchCommentIds,
  parseHunks,
  validateFindings,
} from "./index.mjs";

const schema = JSON.parse(readFileSync(new URL("../schemas/findings-round.v1.json", import.meta.url), "utf-8"));

/** The keywords `validate` checks, or carries as annotation only. */
const KNOWN_KEYWORDS = new Set([
  "$schema", "$id", "title", "description",
  "type", "const", "enum", "minimum", "minLength", "pattern", "items", "required", "properties",
]);

/**
 * The subset of JSON Schema the published schema uses, so the repo needs no
 * validator dependency. A keyword it does not check fails outright, so the
 * schema cannot gain a constraint this test silently ignores.
 */
function validate(value, node, path = "$") {
  const unknown = Object.keys(node).filter((k) => !KNOWN_KEYWORDS.has(k));
  if (unknown.length > 0) throw new Error(`${path}: the schema test does not check ${unknown.join(", ")}`);
  const errors = [];
  const types = node.type === undefined ? null : [].concat(node.type);
  const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);
  if (types && !types.some((t) => t === typeOf(value) || (t === "number" && typeof value === "number"))) {
    return [`${path}: expected ${types.join("|")}, got ${typeOf(value)}`];
  }
  if ("const" in node && value !== node.const) errors.push(`${path}: expected ${node.const}`);
  if (node.enum && !node.enum.includes(value)) errors.push(`${path}: ${value} not in enum`);
  if (typeof value === "number" && node.minimum !== undefined && value < node.minimum) errors.push(`${path}: below minimum`);
  if (typeof value === "string") {
    if (node.minLength !== undefined && value.length < node.minLength) errors.push(`${path}: too short`);
    if (node.pattern && !new RegExp(node.pattern).test(value)) errors.push(`${path}: does not match ${node.pattern}`);
  }
  if (Array.isArray(value) && node.items) {
    value.forEach((v, i) => errors.push(...validate(v, node.items, `${path}[${i}]`)));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of node.required ?? []) if (!(key in value)) errors.push(`${path}: missing ${key}`);
    for (const [key, sub] of Object.entries(node.properties ?? {})) {
      if (key in value) errors.push(...validate(value[key], sub, `${path}.${key}`));
    }
  }
  return errors;
}

const SHA = "a".repeat(40);
const group = (f) => ({ representative: f, members: [f] });
const f = (over = {}) => ({ file: "src/a.ts", line: 10, severity: "suggestion", comment: "Null deref.", agent: "bugs", supporters: 2, ...over });

const build = (groups, over = {}) => {
  const result = buildReviewResult({
    reviewedSha: SHA,
    agentsCompleted: 2,
    agentsFailed: 0,
    voters: 3,
    model: "claude-sonnet-5",
    keptGroups: groups,
    ...over,
  });
  return buildFindingsPayload({
    repository: "acme/widgets",
    prNumber: 7,
    runId: 123,
    runAttempt: 2,
    reviewHero: { ref: "v1", sha: SHA },
    result,
    findings: buildRoundFindings(groups, { bugs: "Bugs" }),
    commentIds: over.commentIds,
  });
};

// spec: FPOST#payload
test("a built payload validates against the published schema", () => {
  const payload = build(
    [group(f({ endLine: 14 })), group(f({ severity: "nitpick", agent: "design", supporters: null })), group(f({ severity: "critical", line: 3 }))],
    { commentIds: [501, null, 502] },
  );
  assert.deepEqual(validate(payload, schema), []);
  assert.equal(payload.schema, FINDINGS_SCHEMA);
  assert.equal(schema.properties.schema.const, FINDINGS_SCHEMA);
});

// spec: FPOST#payload
test("the payload links to its own schema, which names itself the same way", () => {
  const payload = build([]);
  assert.equal(payload.$schema, FINDINGS_SCHEMA_URL);
  assert.equal(schema.$id, FINDINGS_SCHEMA_URL);
  assert.equal(schema.properties.$schema.const, FINDINGS_SCHEMA_URL);
  assert.ok(FINDINGS_SCHEMA_URL.endsWith(`/schemas/findings-round.v${FINDINGS_SCHEMA}.json`));
});

test("the schema test refuses a keyword it does not check", () => {
  assert.throws(() => validate({}, { type: "object", additionalProperties: false }), /does not check additionalProperties/);
});

test("a round with no findings and a failed round validate too", () => {
  assert.deepEqual(validate(build([]), schema), []);
  const failed = build([], { agentsCompleted: 0, agentsFailed: 3 });
  assert.deepEqual(validate(failed, schema), []);
  assert.equal(failed.outcome, "failed");
  assert.deepEqual(failed.findings, []);
});

test("the schema refuses a payload missing a required field or with a bad value", () => {
  const payload = build([group(f())]);
  const { runId, ...withoutRun } = payload;
  assert.notDeepEqual(validate(withoutRun, schema), []);
  const { $schema, ...withoutLink } = payload;
  assert.notDeepEqual(validate(withoutLink, schema), []);
  assert.notDeepEqual(validate({ ...payload, outcome: "done" }, schema), []);
  assert.notDeepEqual(validate({ ...payload, findings: [{ ...payload.findings[0], severity: "blocker" }] }, schema), []);
});

// spec: FPOST#payload
test("the payload carries the result as the completion block reports it, without its kind", () => {
  const groups = [group(f()), group(f({ severity: "nitpick" }))];
  const result = buildReviewResult({ reviewedSha: SHA, agentsCompleted: 2, agentsFailed: 0, voters: 3, model: "m", keptGroups: groups });
  const payload = build(groups, { model: "m" });
  const { kind, ...round } = result;
  for (const [key, value] of Object.entries(round)) assert.deepEqual(payload[key], value, key);
  assert.equal("kind" in payload, false);
  assert.deepEqual(
    [payload.counts.critical, payload.counts.suggestion, payload.counts.nitpick],
    [0, 1, 1],
  );
  assert.equal(payload.findings.length, payload.counts.critical + payload.counts.suggestion + payload.counts.nitpick);
});

// spec: FPOST#findings
test("each finding has an id unique within the run attempt, its agent's key and name, and its comment id or null", () => {
  const payload = build([group(f()), group(f({ agent: "design" })), group(f())], { commentIds: [9, undefined] });
  assert.deepEqual(payload.findings.map((x) => x.id), ["123-2-1", "123-2-2", "123-2-3"]);
  assert.deepEqual(payload.findings.map((x) => x.agent), [
    { key: "bugs", name: "Bugs" },
    { key: "design", name: "design" },
    { key: "bugs", name: "Bugs" },
  ]);
  assert.deepEqual(payload.findings.map((x) => x.commentId), [9, null, null]);
});

// spec: FPOST#findings
test("a finding's end line is null unless it covers more than its start line, and the voter count null unless known", () => {
  const payload = build([
    group(f()),
    group(f({ endLine: 10 })),
    group(f({ endLine: 12, supporters: null })),
    group(f({ supporters: undefined })),
  ]);
  assert.deepEqual(payload.findings.map((x) => [x.startLine, x.endLine, x.supporters]), [
    [10, null, 2],
    [10, null, 2],
    [10, 12, null],
    [10, null, null],
  ]);
});

// spec: FPOST#findings
test("the comment is the agent's, unshortened and without the inline comment's formatting", () => {
  const long = "x".repeat(5000);
  const [finding] = build([group(f({ comment: long }))]).findings;
  assert.equal(finding.comment, long);
});

// spec: FPOST#findings
test("a group takes its representative's location, voter count and range", () => {
  const rep = f({ line: 20, endLine: 25, supporters: 3, agent: "design" });
  const [finding] = build([{ representative: rep, members: [f({ line: 5, supporters: 9 }), rep] }]).findings;
  assert.deepEqual([finding.startLine, finding.endLine, finding.supporters, finding.agent.key], [20, 25, 3, "design"]);
});

// spec: RUN#findings
test("one test decides a finding's range for its inline comment and its posted data alike", () => {
  const hunks = parseHunks("--- a/a.ts\n+++ b/a.ts\n@@ -1,0 +1,30 @@\n" + "+x\n".repeat(30));
  for (const endLine of [14, 10, 9, "14", 14.5, null, undefined]) {
    const finding = { file: "a.ts", line: 10, endLine, severity: "nitpick", comment: "c", agent: "bugs" };
    const end = effectiveEndLine(finding);
    assert.equal(end, endLine === 14 ? 14 : undefined);
    const [posted] = buildRoundFindings([group(finding)]);
    assert.equal(posted.endLine, end ?? null);
    assert.equal(commentLines(finding, hunks).startLine === undefined, end === undefined);
  }
});

test("a finding whose line is not a whole number is dropped, as the payload needs one", () => {
  const raw = (line) => ({ file: "a.ts", line, severity: "suggestion", comment: "c" });
  assert.deepEqual(validateFindings([raw(12), raw(12.5), raw("12"), raw(0)], "bugs").map((f) => f.line), [12]);
});

test("a path git quotes is decoded to the path a finding names", () => {
  const diff = [
    'diff --git "a/src/\\346\\226\\207.ts" "b/src/\\346\\226\\207.ts"',
    '--- "a/src/\\346\\226\\207.ts"',
    '+++ "b/src/\\346\\226\\207.ts"',
    "@@ -1 +1,3 @@",
    " x",
    "+y",
    "+z",
    '--- "a/say \\"hi\\".ts"',
    '+++ "b/say \\"hi\\".ts"',
    "@@ -1 +1,2 @@",
    " x",
    "+y",
    "",
  ].join("\n");
  const hunks = parseHunks(diff);
  assert.deepEqual([...hunks.keys()], ["src/文.ts", 'say "hi".ts']);
  assert.deepEqual(commentLines({ file: "src/文.ts", line: 1, endLine: 3 }, hunks), { line: 3, startLine: 1 });
});

test("a path git quotes keeps characters outside the BMP whole", () => {
  const diff = ['+++ "b/\\"\u{1F600}\\".ts"', "@@ -0,0 +1,2 @@", "+a", "+b", ""].join("\n");
  assert.deepEqual([...parseHunks(diff).keys()], ['"\u{1F600}".ts']);
});

// spec: FPOST#findings
test("a kept group whose representative consensus dropped takes its members' voter count", () => {
  const dropped = f({ supporters: undefined });
  delete dropped.supporters;
  const kept = [f({ supporters: 2 }), f({ supporters: 3 })];
  const [finding] = buildRoundFindings([{ representative: dropped, members: [dropped, ...kept] }]);
  assert.equal(finding.supporters, 3);
  // A kept representative whose count is unknown stays unknown.
  const unknown = f({ supporters: null });
  const [other] = buildRoundFindings([{ representative: unknown, members: [unknown, f({ supporters: 3 })] }]);
  assert.equal(other.supporters, null);
});

// spec: RUN#findings
test("an agent's end line is kept only when it is an integer past the start line", () => {
  const raw = (endLine) => ({ file: "a.ts", line: 10, severity: "suggestion", comment: "c", endLine });
  const kept = validateFindings([raw(14), raw(10), raw(9), raw("14"), raw(14.5), raw(null), raw(undefined)], "bugs");
  assert.deepEqual(kept.map((x) => x.endLine), [14, undefined, undefined, undefined, undefined, undefined, undefined]);
  assert.ok(kept.slice(1).every((x) => !("endLine" in x)));
});

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 one
+two
 three
 four
@@ -20,2 +21,3 @@ function x() {
 keep
-old
+new
+newer
diff --git a/gone.ts b/gone.ts
deleted file mode 100644
--- a/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-a
-b
diff --git a/b.ts b/b.ts
new file mode 100644
--- /dev/null
+++ b/b.ts
@@ -0,0 +1 @@
+++ looks like a header
`;

test("hunks are read from a unified diff, per file, on the new side", () => {
  const hunks = parseHunks(DIFF);
  assert.deepEqual(hunks.get("src/a.ts"), [{ start: 1, end: 4 }, { start: 21, end: 23 }]);
  assert.equal(hunks.has("gone.ts"), false);
  assert.deepEqual(hunks.get("b.ts"), [{ start: 1, end: 1 }]);
  assert.equal(parseHunks("").size, 0);
  assert.equal(parseHunks(undefined).size, 0);
});

// spec: RUN#findings
test("an inline comment spans its finding's lines only when both ends lie in one hunk", () => {
  const hunks = parseHunks(DIFF);
  const at = (line, endLine) => commentLines({ file: "src/a.ts", line, endLine }, hunks);
  assert.deepEqual(at(21, 23), { line: 23, startLine: 21 });
  assert.deepEqual(at(2, 4), { line: 4, startLine: 2 });
  // Across the gap between two hunks, or running past the end of one.
  assert.deepEqual(at(3, 22), { line: 3 });
  assert.deepEqual(at(22, 30), { line: 22 });
  // No end line, a degenerate range, an unknown file or no diff at all.
  assert.deepEqual(at(2, undefined), { line: 2 });
  assert.deepEqual(at(5, 5), { line: 5 });
  assert.deepEqual(commentLines({ file: "other.ts", line: 2, endLine: 3 }, hunks), { line: 2 });
  assert.deepEqual(commentLines({ file: "src/a.ts", line: 2, endLine: 3 }, undefined), { line: 2 });
});

// spec: FPOST#findings
test("each inline comment is matched to the review comment at its place with its text", () => {
  const posted = [
    { path: "a.ts", line: 10, body: "first" },
    { path: "a.ts", line: 10, body: "second" },
    { path: "b.ts", line: 3, body: "third" },
  ];
  // Listed out of order, one outdated (no `line`, only `original_line`).
  const listed = [
    { id: 3, path: "b.ts", line: null, original_line: 3, body: "third" },
    { id: 2, path: "a.ts", line: 10, body: "second" },
    { id: 1, path: "a.ts", line: 10, body: "first" },
  ];
  assert.deepEqual(matchCommentIds(posted, listed), [1, 2, 3]);
});

// spec: FPOST#findings
test("a comment GitHub did not list gets null, and a listed comment is claimed once", () => {
  const posted = [
    { path: "a.ts", line: 10, body: "x" },
    { path: "a.ts", line: 10, body: "x" },
    { path: "c.ts", line: 1, body: "gone" },
  ];
  const listed = [{ id: 7, path: "a.ts", line: 10, body: "x" }];
  assert.deepEqual(matchCommentIds(posted, listed), [7, null, null]);
  // The same place stands in when GitHub changed the text.
  assert.deepEqual(matchCommentIds([{ path: "a.ts", line: 10, body: "x" }], [{ id: 8, path: "a.ts", line: 10, body: "x\n" }]), [8]);
  assert.deepEqual(matchCommentIds([], listed), []);
});

// spec: FPOST#findings
test("findings sharing a line never swap ids when their text was rewritten", () => {
  const posted = [
    { path: "a.ts", line: 10, body: "first" },
    { path: "a.ts", line: 10, body: "second" },
  ];
  // Both rewritten: which is which cannot be told, so neither gets an id.
  const rewritten = [
    { id: 2, path: "a.ts", line: 10, body: "second\n" },
    { id: 1, path: "a.ts", line: 10, body: "first\n" },
  ];
  assert.deepEqual(matchCommentIds(posted, rewritten), [null, null]);
  // One rewritten: the other matches on its text first, and the one left over
  // takes the one comment left at the place.
  const one = [
    { id: 1, path: "a.ts", line: 10, body: "first\n" },
    { id: 2, path: "a.ts", line: 10, body: "second" },
  ];
  assert.deepEqual(matchCommentIds(posted, one), [1, 2]);
});

// spec: FPOST#findings
test("a multi-line comment and a single-line one ending on the same line are kept apart", () => {
  const posted = [
    { path: "a.ts", startLine: 10, line: 15, body: "span" },
    { path: "a.ts", line: 15, body: "single" },
  ];
  // Both rewritten, so only the place can tell them apart.
  const listed = [
    { id: 2, path: "a.ts", start_line: null, line: 15, body: "single\n" },
    { id: 1, path: "a.ts", start_line: 10, line: 15, body: "span\n" },
  ];
  assert.deepEqual(matchCommentIds(posted, listed), [1, 2]);
  // An outdated comment is matched on the lines it was posted on.
  const outdated = [{ id: 3, path: "a.ts", line: null, start_line: null, original_start_line: 10, original_line: 15, body: "span" }];
  assert.deepEqual(matchCommentIds([posted[0]], outdated), [3]);
});

test("every stage that splits a diff by file reads a git-quoted header's path the same way", () => {
  const diff = [
    "diff --git a/plain.ts b/plain.ts",
    "--- a/plain.ts",
    "+++ b/plain.ts",
    "@@ -1 +1,2 @@",
    " x",
    "+y",
    'diff --git "a/src/\\346\\226\\207.ts" "b/src/\\346\\226\\207.ts"',
    '--- "a/src/\\346\\226\\207.ts"',
    '+++ "b/src/\\346\\226\\207.ts"',
    "@@ -1 +1,2 @@",
    " x",
    "+y",
  ].join("\n");
  // Filtering out the plain file must not take the quoted one with it.
  const { filtered, removedFiles } = filterDiff(diff, ["plain.ts"]);
  assert.deepEqual(removedFiles, ["plain.ts"]);
  assert.deepEqual(filtered.split("\n").map(diffGitPath).filter(Boolean), ["src/文.ts"]);
  assert.deepEqual([...parseHunks(filtered).keys()], ["src/文.ts"]);
});
