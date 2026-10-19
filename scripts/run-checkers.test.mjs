import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applySecondLook,
  buildCheckerPrompts,
  checkersPerArea,
  runSecondLook,
  tallyConfirmations,
} from "./run-checkers.mjs";

const finding = (line) => ({ file: "a.ts", line, severity: "suggestion", comment: `at ${line}`, agent: "bugs" });

/** One contested area holding two lone findings, the second reported twice by the same voter. */
function consensus(voters = 3) {
  return {
    voters,
    agentsCompleted: voters,
    agentsFailed: 0,
    kept: [finding(1)],
    dropped: [finding(5), finding(6), finding(7), finding(30)],
    contested: [
      {
        agent: "bugs",
        area: "retry loop",
        groups: [
          { representative: finding(5), supporters: 1, dropped: [0] },
          { representative: finding(6), supporters: 1, dropped: [1, 2] },
        ],
      },
    ],
    secondLook: 0,
  };
}

const answer = (verdicts) => JSON.stringify(verdicts.map(([finding, verdict]) => ({ finding, verdict })));

test("an area gets as many checkers as a lone finding needs to reach the majority", () => {
  assert.equal(checkersPerArea(1), 0);
  assert.equal(checkersPerArea(2), 1);
  assert.equal(checkersPerArea(3), 1);
  assert.equal(checkersPerArea(5), 2);
});

test("confirmations are counted once per checker, and anything unclear is a rejection", () => {
  const answers = [
    answer([[0, "confirm"], [0, "confirm"], [1, "reject"]]),
    answer([[0, "CONFIRM"], [1, "maybe"], [7, "confirm"]]),
    "I could not decide.",
    null,
  ];
  assert.deepEqual(tallyConfirmations(answers, 2), [2, 0]);
});

test("a confirmed finding moves from dropped to kept, with its group's other members", () => {
  const updated = applySecondLook(consensus(), [[1, 0]]);
  assert.deepEqual(updated.kept.map((f) => f.line), [1, 5]);
  assert.deepEqual(updated.dropped.map((f) => f.line), [6, 7, 30]);
  assert.equal(updated.secondLook, 1);
  assert.deepEqual(updated.contested[0].groups.map((g) => [g.confirmations, g.confirmed]), [[1, true], [0, false]]);
});

test("with five voters a lone finding needs both checkers", () => {
  const five = consensus(5);
  assert.equal(applySecondLook(five, [[1, 0]]).secondLook, 0);
  assert.equal(applySecondLook(five, [[2, 0]]).secondLook, 1);
});

test("no verdicts leave consensus as it stood", () => {
  const before = consensus();
  const after = applySecondLook(before, []);
  assert.deepEqual(after.kept, before.kept);
  assert.deepEqual(after.dropped, before.dropped);
  assert.equal(after.secondLook, 0);
});

test("checkers run under the cap, see their area's prompt, and their verdicts are tallied", async () => {
  const twoAreas = { ...consensus(5), contested: [...consensus(5).contested, { ...consensus(5).contested[0], area: "other" }] };
  let active = 0;
  let peak = 0;
  const seen = [];
  const runClaude = async ({ input }) => {
    seen.push(input);
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setImmediate(resolve));
    active--;
    const result = input === "area 0" ? answer([[0, "confirm"]]) : answer([[1, "confirm"]]);
    return { code: 0, timedOut: false, stdout: JSON.stringify({ result, num_turns: 3 }), stderr: "" };
  };
  const rows = [];
  const { confirmationsByArea } = await runSecondLook({
    consensus: twoAreas,
    prompts: ["area 0", "area 1"],
    model: "m",
    maxTurns: 10,
    concurrency: 3,
    memory: null,
    logsDir: mkdtempSync(join(tmpdir(), "checkers-")),
    env: {},
    runClaude,
    out: () => {},
    onRow: (row) => rows.push(row),
  });
  assert.equal(seen.length, 4);
  assert.equal(peak, 3);
  assert.deepEqual(confirmationsByArea, [[2, 0], [0, 2]]);
  assert.equal(rows.length, 4);
  assert.ok(rows.every((r) => r.outcome === "answered"));
});

test("a checker that throws only withholds its votes", async () => {
  let calls = 0;
  const runClaude = async () => {
    if (calls++ === 0) throw new Error("boom");
    return { code: 0, timedOut: false, stdout: JSON.stringify({ result: answer([[0, "confirm"]]) }), stderr: "" };
  };
  const output = [];
  const { confirmationsByArea } = await runSecondLook({
    consensus: consensus(5),
    prompts: ["area 0"],
    model: "m",
    maxTurns: 10,
    concurrency: 1,
    memory: null,
    logsDir: mkdtempSync(join(tmpdir(), "checkers-")),
    env: {},
    runClaude,
    out: (text) => output.push(text),
  });
  assert.deepEqual(confirmationsByArea, [[1, 0]]);
  assert.ok(output.some((line) => line.includes("failed unexpectedly")));
});

test("an area without a prompt gets no checkers", async () => {
  const { confirmationsByArea } = await runSecondLook({
    consensus: consensus(),
    prompts: [undefined],
    model: "m",
    maxTurns: 10,
    concurrency: 1,
    memory: null,
    logsDir: mkdtempSync(join(tmpdir(), "checkers-")),
    env: {},
    runClaude: async () => {
      throw new Error("not called");
    },
    out: () => {},
  });
  assert.deepEqual(confirmationsByArea, [[0, 0]]);
});

test("checker prompts use the area agent's prompt from the right checkout", () => {
  const root = mkdtempSync(join(tmpdir(), "checker-prompts-"));
  const reviewHeroDir = join(root, ".review-hero");
  const callerBaseDir = join(root, ".caller-base");
  mkdirSync(join(reviewHeroDir, "prompts"), { recursive: true });
  mkdirSync(join(callerBaseDir, ".github", "review-hero", "prompts"), { recursive: true });
  writeFileSync(join(reviewHeroDir, "prompts", "checker-prompt.md"), "Check.");
  writeFileSync(join(reviewHeroDir, "prompts", "bugs.md"), "Bugs.");
  writeFileSync(join(callerBaseDir, ".github", "review-hero", "prompts", "house.md"), "House.");

  const base = consensus();
  const areas = {
    ...base,
    contested: [
      base.contested[0],
      { ...base.contested[0], agent: "house" },
      { ...base.contested[0], agent: "missing" },
    ],
  };
  const warnings = [];
  const prompts = buildCheckerPrompts({
    consensus: areas,
    agents: [
      { key: "bugs", source: "base" },
      { key: "house", source: "custom" },
      { key: "missing", source: "custom" },
    ],
    reviewHeroDir,
    callerBaseDir,
    common: { maxTurns: 10, diff: "+x\n" },
    out: (line) => warnings.push(line),
  });
  assert.match(prompts[0], /^Check\.\n\n## Your specialisation\n\nBugs\./);
  assert.match(prompts[1], /## Your specialisation\n\nHouse\./);
  assert.equal(prompts[2], undefined);
  assert.match(warnings.join("\n"), /No second look for missing/);
});

test("a verdict whose finding is not an integer confirms nothing", () => {
  const answers = [JSON.stringify([
    { finding: null, verdict: "confirm" },
    { finding: "", verdict: "confirm" },
    { finding: false, verdict: "confirm" },
    { finding: "0", verdict: "confirm" },
    { finding: 1.5, verdict: "confirm" },
  ])];
  assert.deepEqual(tallyConfirmations(answers, 2), [0, 0]);
});

test("each area's verdicts are handed over as soon as it settles", async () => {
  const twoAreas = { ...consensus(3), contested: [...consensus(3).contested, { ...consensus(3).contested[0], area: "other" }] };
  let releaseSecond;
  const secondDone = new Promise((resolve) => (releaseSecond = resolve));
  const runClaude = async ({ input }) => {
    if (input === "area 1") await secondDone;
    return { code: 0, timedOut: false, stdout: JSON.stringify({ result: answer([[0, "confirm"]]) }), stderr: "" };
  };
  const progress = [];
  const running = runSecondLook({
    consensus: twoAreas,
    prompts: ["area 0", "area 1"],
    model: "m",
    maxTurns: 10,
    memory: null,
    logsDir: mkdtempSync(join(tmpdir(), "checkers-")),
    env: {},
    runClaude,
    out: () => {},
    onProgress: (partial) => progress.push(partial),
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(progress, [[[1, 0], [0, 0]]]);
  releaseSecond();
  await running;
  assert.deepEqual(progress.at(-1), [[1, 0], [1, 0]]);
});

test("a checker's wrap-up gets the shorter of the wrap-up and checker limits", async () => {
  const calls = [];
  const capped = JSON.stringify({ subtype: "error_max_turns", session_id: "s" });
  const runClaude = async ({ args, timeoutMs }) => {
    const resume = args.includes("--resume");
    calls.push({ resume, timeoutMs });
    return resume
      ? { code: 0, timedOut: false, stdout: JSON.stringify({ result: answer([[0, "confirm"]]) }), stderr: "" }
      : { code: 1, timedOut: false, stdout: capped, stderr: "" };
  };
  await runSecondLook({
    consensus: consensus(3),
    prompts: ["area 0"],
    model: "m",
    maxTurns: 10,
    memory: null,
    logsDir: mkdtempSync(join(tmpdir(), "checkers-")),
    env: {},
    timeoutMs: 60_000,
    runClaude,
    out: () => {},
  });
  assert.deepEqual(calls, [
    { resume: false, timeoutMs: 60_000 },
    { resume: true, timeoutMs: 60_000 },
  ]);
});
