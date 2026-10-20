import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

// spec: RUN#the-review-job
// The review job's `if:` and its first step both decide whether a description
// starts a review, one as an expression and one as a regex. Both are read from
// the workflow itself, so neither can change without this test seeing it.
const workflow = parse(readFileSync(new URL("../.github/workflows/review.yml", import.meta.url), "utf-8"));
const job = workflow.jobs.review;

/**
 * The job's checkbox gate for an edited pull request: whether the body
 * contains any of its literals, ignoring case as `contains()` does.
 */
const gateLiterals = [...job.if.matchAll(/contains\(github\.event\.pull_request\.body, '([^']+)'\)/g)].map((m) => m[1]);
const gate = (body) => gateLiterals.some((literal) => body.toLowerCase().includes(literal.toLowerCase()));

/** The first step's exact check, as the regex it runs. */
const check = (() => {
  const step = job.steps.find((s) => s.id === "check");
  const source = step.with.script.match(/core\.setOutput\('should_run', \/(.+)\/\.test\(body\)\)/)[1];
  return new RegExp(source);
})();

const box = (mark, spacing, label = "Run Review Hero", marker = "<!-- #ai-review -->") =>
  `## Review\n\n- [${mark}]${spacing}**${label}** ${marker}\n`;

const bodies = {
  "unticked template": box(" ", " ") + box(" ", " ", "Run Review Hero on Claude (before merge)", "<!-- #ai-review-claude -->"),
  "ticked, one space": box("x", " "),
  "ticked, two spaces": box("x", "  "),
  "ticked Claude box": box("x", " ", "Run Review Hero on Claude (before merge)", "<!-- #ai-review-claude -->"),
  "ticked, three spaces": box("x", "   "),
  "ticked, a tab": box("x", "\t"),
  "ticked with a capital X": box("X", " "),
  "ticked, no marker": box("x", " ", "Run Review Hero", ""),
  "no checkbox at all": "Just a description",
};

test("the workflow's checkbox gate and exact check are both found", () => {
  assert.ok(gateLiterals.length > 0);
  assert.ok(check.test(bodies["ticked, one space"]));
});

test("the job's gate never skips a description the exact check accepts", () => {
  for (const [name, body] of Object.entries(bodies)) {
    if (check.test(body)) assert.ok(gate(body), `gate skips "${name}", which the exact check accepts`);
  }
});

test("the job's gate starts no runner for an unticked template or a description without the box", () => {
  assert.equal(gate(bodies["unticked template"]), false);
  assert.equal(gate(bodies["no checkbox at all"]), false);
});

test("both agree on how much space may follow the box", () => {
  for (const name of ["ticked, one space", "ticked, two spaces", "ticked Claude box"]) {
    assert.ok(gate(bodies[name]) && check.test(bodies[name]), name);
  }
  for (const name of ["ticked, three spaces", "ticked, a tab"]) {
    assert.ok(!gate(bodies[name]) && !check.test(bodies[name]), name);
  }
});
