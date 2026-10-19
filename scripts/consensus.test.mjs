import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collectFindings, outcomeWithoutConsensus, runConsensus, scanForResults } from "./consensus.mjs";

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
  assert.deepEqual(result, { kept: [{ ...finding(1, "x"), agent: "bugs" }], dropped: [], contested: [] });
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
  // Each agent keeps its first finding, and design contests its last two.
  const callModel = async ({ messages }) =>
    messages[0].content.includes("design")
      ? JSON.stringify({ keep: [0], contested: [{ area: "the loop", groups: [[1, 2]] }] })
      : JSON.stringify({ keep: [0], contested: [] });

  const { kept, dropped, contested } = await runConsensus({ findings, voters: 3, callModel });
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
});
