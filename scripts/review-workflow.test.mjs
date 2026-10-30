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

// ── Posting findings ─────────────────────────────────────────────────────────

// spec: FPOST#turning-it-on
test("the findings URL is an optional input, empty by default, and reaches only the orchestrator", () => {
  const input = workflow.on.workflow_call.inputs["findings-url"];
  assert.equal(input.type, "string");
  assert.equal(input.default, "");
  const orchestrate = post.steps.find((s) => s.name === "Run orchestrator");
  assert.equal(orchestrate.env.FINDINGS_URL, "${{ inputs.findings-url }}");
  assert.ok(!mentions(job, "findings-url"));
});

// spec: RUN#credentials
test("only the posting job can request an identity token", () => {
  // A job that declares permissions gets exactly those, so leaving out
  // `id-token` keeps it from the review job whatever the caller granted.
  assert.ok(job.permissions && typeof job.permissions === "object");
  assert.ok(!("id-token" in job.permissions));
  assert.ok(!mentions(job.steps, "ACTIONS_ID_TOKEN"));
  // Declaring it on the posting job would fail the whole workflow at startup
  // for a caller that does not grant it, so the posting job inherits instead.
  assert.equal(post.permissions, undefined);
  assert.equal(workflow.permissions, undefined);
});

test("the review job's permissions cover everything its steps read with the workflow token", () => {
  assert.deepEqual(job.permissions, { contents: "read" });
  // The one use of the workflow token in the job is the compare call for the diff.
  const users = job.steps.filter((s) => mentions(s, "github.token"));
  assert.deepEqual(users.map((s) => s.name), ["Get PR diff"]);
  assert.match(users[0].run, /gh api[\s\S]*compare/);
});

// spec: FPOST#when-a-review-posts
test("the orchestrator is given the diff the agents reviewed, from the uploaded artifact", () => {
  const upload = job.steps.find((s) => uses(s, "actions/upload-artifact"));
  const orchestrate = post.steps.find((s) => s.name === "Run orchestrator");
  assert.ok(orchestrate.env.DIFF_PATH.startsWith(`${upload.with.path}/`));
  const triage = job.steps.find((s) => s.id === "triage");
  assert.equal(orchestrate.env.DIFF_PATH, triage.env.FILTERED_DIFF_PATH);
});

// spec: FPOST#turning-it-on
test("this repo's own caller grants the identity-token permission to the calling job alone", () => {
  const caller = parse(readFileSync(new URL("../.github/workflows/ai-review.yml", import.meta.url), "utf-8"));
  assert.equal(caller.permissions, undefined);
  assert.equal(caller.jobs.review.permissions["id-token"], "write");
  assert.ok(caller.jobs.review.with["findings-url"].startsWith("https://"));
});
