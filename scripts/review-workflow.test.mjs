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

// ── Posting ──────────────────────────────────────────────────────────────────

// spec: RUN#posting
const post = workflow.jobs.post;
const uses = (step, action) => step.uses?.startsWith(`${action}@`);
const mentions = (value, text) => JSON.stringify(value).includes(text);

test("the GitHub App token is minted only in the posting job, on a fresh slim runner", () => {
  assert.ok(!job.steps.some((s) => uses(s, "actions/create-github-app-token")));
  assert.ok(!mentions(job, "REVIEW_HERO_PRIVATE_KEY"));
  assert.ok(post.steps.some((s) => uses(s, "actions/create-github-app-token")));
  assert.equal(post["runs-on"], "ubuntu-slim");
  assert.equal(post.needs, "review");
});

test("posting checks out review-hero and the trusted config at the commits recorded before the agents ran", () => {
  const checkouts = post.steps.filter((s) => uses(s, "actions/checkout"));
  assert.match(checkouts.find((s) => s.with.path === ".review-hero").with.ref, /needs\.review\.outputs\.review_hero_sha/);
  assert.match(checkouts.find((s) => s.with.path === ".caller-base").with.ref, /needs\.review\.outputs\.trusted_sha/);
  const record = job.steps.findIndex((s) => s.id === "trusted-refs");
  const agents = job.steps.findIndex((s) => s.name === "Run review agents");
  assert.ok(record !== -1 && record < agents);
  assert.ok(checkouts.every((s) => s.with["persist-credentials"] === false));
});

test("posting reads the review's results from the artifact the review job uploads, and suppressions afresh", () => {
  const upload = job.steps.find((s) => uses(s, "actions/upload-artifact"));
  const download = post.steps.find((s) => uses(s, "actions/download-artifact"));
  assert.equal(download.with.name, upload.with.name);
  assert.equal(download.with.path, upload.with.path);
  const orchestrate = post.steps.find((s) => s.name === "Run orchestrator");
  for (const name of ["CONSENSUS_PATH", "ARTIFACTS_DIR"]) {
    assert.ok(orchestrate.env[name].startsWith(`${upload.with.path}/`), name);
  }
  assert.ok(!orchestrate.env.SUPPRESSIONS_PATH.startsWith(`${upload.with.path}/`));
  assert.ok(post.steps.some((s) => s.name === "Prepare suppressions" && s.run.includes(".caller-base/")));
});

test("the review job's working files that posting reads sit under the uploaded directory", () => {
  const upload = job.steps.find((s) => uses(s, "actions/upload-artifact"));
  const agents = job.steps.find((s) => s.name === "Run review agents");
  for (const name of ["RESULTS_DIR", "CONSENSUS_PATH"]) {
    assert.ok(agents.env[name].startsWith(`${upload.with.path}/`), name);
  }
});

test("the Claude CLI installed is the newest release at least a week old", () => {
  const install = job.steps.find((s) => s.name === "Install Claude CLI");
  assert.match(install.run, /npm install -g --before="\$before" @anthropic-ai\/claude-code/);
  assert.match(install.run, /Date\.now\(\) - 7 \* 24 \* 60 \* 60 \* 1000/);
});
