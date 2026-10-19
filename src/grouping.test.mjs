import assert from "node:assert/strict";
import { test } from "node:test";

import { applyConsensus, parseConsensusReply, MAX_CONTESTED_AREAS } from "./index.mjs";

const finding = (voter, line, comment = `finding at ${line}`) => ({
  file: "a.ts",
  line,
  severity: "suggestion",
  comment,
  agent: "bugs",
  voter: `bugs-${voter}`,
});

const findings = [
  finding(0, 10, "Null deref."),
  finding(1, 11, "Possible null."),
  finding(0, 40, "Retry never backs off."),
  finding(2, 42, "Retry loop spins."),
  finding(1, 90, "Stray log."),
];

test("consensus names contested areas from groups below the majority", async () => {
  const reply = JSON.stringify({
    keep: [0],
    contested: [{ area: "retry loop", groups: [[2, 3]] }],
  });
  const { kept, droppedFindings, contested } = await applyConsensus(findings, 3, async () => reply);
  assert.deepEqual(kept.map((f) => f.line), [10]);
  assert.equal(contested.length, 1);
  const [area] = contested;
  assert.equal(area.area, "retry loop");
  assert.equal(area.groups.length, 1);
  const [group] = area.groups;
  assert.equal(group.supporters, 2);
  assert.equal(group.representative.voter, undefined);
  assert.deepEqual(group.dropped.map((i) => droppedFindings[i].line), [40, 42]);
});

test("a contested group cannot hold a kept finding or one already claimed", async () => {
  const reply = JSON.stringify({
    keep: [0],
    contested: [
      { area: "one", groups: [[0, 2]] },
      { area: "two", groups: [[2], [99], [4]] },
    ],
  });
  const { contested } = await applyConsensus(findings, 3, async () => reply);
  assert.deepEqual(contested.map((a) => a.groups.map((g) => g.members.map((m) => m.line))), [[[40]], [[90]]]);
});

test("consensus names at most the cap of contested areas", async () => {
  const reply = JSON.stringify({
    keep: [],
    contested: findings.map((_, i) => ({ area: `area ${i}`, groups: [[i]] })),
  });
  const { contested } = await applyConsensus(findings, 3, async () => reply);
  assert.equal(contested.length, MAX_CONTESTED_AREAS);
});

test("a bare array reply still keeps findings, with no contested areas", async () => {
  const { kept, contested } = await applyConsensus(findings, 3, async () => "[0, 2]");
  assert.deepEqual(kept.map((f) => f.line), [10, 40]);
  assert.deepEqual(contested, []);
});

test("a single voter has no consensus and no contested areas", async () => {
  const { kept, contested } = await applyConsensus(findings, 1, async () => {
    throw new Error("not called");
  });
  assert.equal(kept.length, findings.length);
  assert.deepEqual(contested, []);
});

test("an unreadable reply keeps everything and names nothing", async () => {
  const { kept, contested } = await applyConsensus(findings, 3, async () => "no idea");
  assert.equal(kept.length, findings.length);
  assert.deepEqual(contested, []);
});

test("the reply parser drops malformed areas and non-integer indices", () => {
  assert.deepEqual(
    parseConsensusReply('Here: {"keep": [1, "x"], "contested": [{"area": "a", "groups": [[2, "y"], "bad"]}, "junk"]}'),
    { keep: [1], contested: [{ area: "a", groups: [[2]] }] },
  );
  assert.equal(parseConsensusReply("nothing here"), null);
});

test("only integer indices count, so junk entries never stand for finding 0", () => {
  assert.deepEqual(
    parseConsensusReply('{"keep": [null, "", false, true, "0", 2], "contested": [{"area": "a", "groups": [[null, 3]]}]}'),
    { keep: [2], contested: [{ area: "a", groups: [[3]] }] },
  );
});
