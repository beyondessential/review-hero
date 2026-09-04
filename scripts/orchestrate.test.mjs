import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseAgentResult } from "./orchestrate.mjs";

const dir = mkdtempSync(join(tmpdir(), "review-hero-parse-"));

/** Write `contents` to a temp file and parse it as agent output. */
function parse(name, contents, { agent = "project-conventions", voter = 0 } = {}) {
  const path = join(dir, name);
  writeFileSync(path, typeof contents === "string" ? contents : JSON.stringify(contents));
  return parseAgentResult(path, agent, voter);
}

test("parses a findings array embedded in the CLI result field", () => {
  const findings = [
    { file: "src/app.ts", line: 12, severity: "suggestion", comment: "Handle null." },
  ];
  const result = parse("with-findings-result.json", {
    type: "result",
    subtype: "success",
    is_error: false,
    result: `Here are my findings:\n\n${JSON.stringify(findings)}`,
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].file, "src/app.ts");
  assert.equal(result[0].agent, "project-conventions");
  assert.equal(result[0].voter, "project-conventions-0");
});

test("a prose result with no array is a failure — agents must emit [] for no findings", () => {
  // Mirrors project-conventions-voter-2-result.json: successful run whose
  // result field is prose with no JSON array. The output contract requires
  // an array, so prose can't be distinguished from a truncated answer.
  const result = parse("prose-result.json", {
    type: "result",
    subtype: "success",
    is_error: false,
    result:
      "No project-convention issues found in this diff — spelling, file naming, and design-system usage are all consistent.",
  });
  assert.equal(result, null);
});

test("an explicit empty array is zero findings, not a failure", () => {
  const result = parse("empty-array-result.json", {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "[]",
  });
  assert.deepEqual(result, []);
});

test("an errored (max-turns) run is a failure and its metadata arrays are never mined for findings", () => {
  // Mirrors project-conventions-voter-1-result.json: is_error with no result
  // field, but with an `iterations` array in the envelope metadata.
  const result = parse("max-turns-result.json", {
    type: "result",
    subtype: "error_max_turns",
    is_error: true,
    num_turns: 6,
    errors: ["Reached maximum number of turns (5)"],
    usage: { iterations: [{ input_tokens: 2, output_tokens: 213 }] },
  });
  assert.equal(result, null);
});

test("parses a bare JSON array written as the whole file", () => {
  const result = parse("bare-array-result.json", [
    { file: "a.ts", line: 3, severity: "critical", comment: "Oops." },
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].severity, "critical");
});

test("drops entries that are not valid findings", () => {
  const result = parse("mixed-result.json", {
    is_error: false,
    result: JSON.stringify([
      { file: "a.ts", line: 3, severity: "critical", comment: "Real." },
      { file: "b.ts", line: 0, severity: "critical", comment: "Bad line." },
      { file: "c.ts", line: 5, severity: "banana", comment: "Bad severity." },
    ]),
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].file, "a.ts");
});

test("a missing file is a failure", () => {
  assert.equal(parseAgentResult(join(dir, "nope.json"), "bugs", undefined), null);
});
