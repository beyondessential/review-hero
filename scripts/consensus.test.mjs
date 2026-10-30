import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  collectFindings,
  CONSENSUS_CONCURRENCY,
  outcomeWithoutConsensus,
  runConsensus,
  scanForResults,
} from "./consensus.mjs";

const envelope = (findings) => JSON.stringify({ type: "result", result: JSON.stringify(findings) });
const finding = (line, comment) => ({ file: "a.ts", line, severity: "suggestion", comment });

test("result files are found at any depth and parsed once per agent voter", () => {
  const dir = mkdtempSync(join(tmpdir(), "consensus-"));
  mkdirSync(join(dir, "nested"));
  writeFileSync(join(dir, "bugs-voter-0-result.json"), envelope([finding(1, "x")]));
  writeFileSync(join(dir, "nested", "bugs-voter-1-result.json"), envelope([]));
  writeFileSync(join(dir, "design-voter-0-result.json"), JSON.stringify({ subtype: "error_max_turns" }));
  writeFileSync(join(dir, "bugs-primer.json"), envelope([finding(9, "not a result")]));

  const { findings, agentsCompleted, agentsFailed } = collectFindings(scanForResults(dir));
  assert.equal(agentsCompleted, 2);
  assert.equal(agentsFailed, 1);
  assert.deepEqual(findings.map((f) => [f.agent, f.voter, f.line]), [["bugs", "bugs-0", 1]]);
});

test("a missing results directory yields no results rather than throwing", () => {
  assert.deepEqual(scanForResults(join(tmpdir(), "does-not-exist-review-hero")), []);
});

test("one voter keeps everything with no consensus call and nothing contested", async () => {
  const findings = [{ ...finding(1, "x"), agent: "bugs", voter: "bugs-0" }];
  const result = await runConsensus({
    findings,
    voters: 1,
    callModel: async () => {
      throw new Error("not called");
    },
  });
  assert.deepEqual(result, { kept: [{ ...finding(1, "x"), agent: "bugs", supporters: 1 }], dropped: [], contested: [], unfiltered: [] });
});

test("contested groups point into the combined dropped list across agents", async () => {
  const tag = (agent, voter, line) => ({ ...finding(line, `${agent} ${line}`), agent, voter: `${agent}-${voter}` });
  const findings = [
    tag("bugs", 0, 1),
    tag("bugs", 1, 2),
    tag("design", 0, 10),
    tag("design", 1, 20),
    tag("design", 2, 21),
  ];
  // Each agent keeps its first finding, and design contests its last two,
  // whose two voters fall short of the three of five needed.
  const callModel = async ({ messages }) =>
    messages[0].content.includes("design")
      ? JSON.stringify({ keep: [0], contested: [{ area: "the loop", groups: [[1, 2]] }] })
      : JSON.stringify({ keep: [0], contested: [] });

  const { kept, dropped, contested } = await runConsensus({ findings, voters: 5, callModel });
  assert.deepEqual(kept.map((f) => f.line), [1, 10]);
  assert.deepEqual(dropped.map((f) => f.line), [2, 20, 21]);
  assert.equal(contested.length, 1);
  assert.equal(contested[0].agent, "design");
  assert.equal(contested[0].groups[0].supporters, 2);
  assert.deepEqual(contested[0].groups[0].dropped.map((i) => dropped[i].line), [20, 21]);
});

test("without a consensus outcome, every agent finding is kept as it stands", () => {
  const dir = mkdtempSync(join(tmpdir(), "consensus-fallback-"));
  writeFileSync(join(dir, "bugs-voter-0-result.json"), envelope([finding(1, "x")]));
  writeFileSync(join(dir, "bugs-voter-1-result.json"), envelope([finding(1, "x again")]));
  writeFileSync(join(dir, "bugs-voter-2-result.json"), "{ truncated");
  const outcome = outcomeWithoutConsensus(dir, 3);
  assert.equal(outcome.voters, 3);
  assert.equal(outcome.agentsCompleted, 2);
  assert.equal(outcome.agentsFailed, 1);
  assert.deepEqual(outcome.kept.map((f) => f.comment), ["x", "x again"]);
  assert.ok(outcome.kept.every((f) => !("voter" in f)));
  assert.deepEqual([outcome.dropped, outcome.contested, outcome.secondLook], [[], [], 0]);
  assert.deepEqual(outcome.unfiltered, ["bugs"]);
  // No vote happened, so no finding has a voter count.
  assert.ok(outcome.kept.every((f) => f.supporters === null));
});

// spec: RUN#voters
test("with one voter per agent each finding's voter count is 1", async () => {
  const dir = mkdtempSync(join(tmpdir(), "consensus-single-"));
  writeFileSync(join(dir, "bugs-result.json"), envelope([finding(1, "x")]));
  const outcome = outcomeWithoutConsensus(dir, 1);
  assert.deepEqual(outcome.kept.map((f) => f.supporters), [1]);
});

// spec: RUN#voters
test("consensus across agents leaves each kept finding with its own group's voter count", async () => {
  const tag = (agent, voter, line) => ({ ...finding(line, `${agent} ${line}`), agent, voter: `${agent}-${voter}` });
  const findings = [tag("bugs", 0, 1), tag("bugs", 1, 2), tag("design", 0, 10), tag("design", 1, 11), tag("design", 2, 12)];
  const callModel = async ({ messages }) =>
    messages[0].content.includes("design")
      ? JSON.stringify({ keep: [0], members: { 0: [0, 1, 2] }, contested: [] })
      : JSON.stringify({ keep: [0], members: { 0: [0, 1] }, contested: [] });
  const { kept } = await runConsensus({ findings, voters: 3, callModel });
  assert.deepEqual(kept.map((f) => [f.agent, f.supporters]), [["bugs", 2], ["design", 3]]);
});

test("agents whose consensus failed are named as unfiltered, and calls run a few at a time", async () => {
  const tag = (agent, voter, line) => ({ ...finding(line, `${agent} ${line}`), agent, voter: `${agent}-${voter}` });
  const agents = ["a", "b", "c", "d", "e", "f"];
  const findings = agents.flatMap((agent) => [tag(agent, 0, 1), tag(agent, 1, 1)]);
  let active = 0;
  let peak = 0;
  const callModel = async ({ messages }) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setImmediate(resolve));
    active--;
    if (messages[0].content.includes("[b]") || messages[0].content.includes("b 1")) throw new Error("overloaded");
    return JSON.stringify({ keep: [0], contested: [] });
  };
  const { unfiltered } = await runConsensus({ findings, voters: 3, callModel });
  assert.deepEqual(unfiltered, ["b"]);
  assert.ok(peak <= CONSENSUS_CONCURRENCY);
  assert.ok(peak > 1);
});
