import assert from "node:assert/strict";
import { test } from "node:test";

import { applyConsensus, groupAllFindings, parseConsensusReply, MAX_CONTESTED_AREAS } from "./index.mjs";
import { indexReplyMaxTokens } from "./grouping.mjs";

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
  // Five voters, so the two behind the retry findings fall short of the three needed.
  const { kept, droppedFindings, contested } = await applyConsensus(findings, 5, async () => reply);
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

test("a group already at the majority is not contested", async () => {
  // Two of three voters is the majority: such a group duplicates a finding
  // consensus kept, and a second look must not promote it unchecked.
  const reply = JSON.stringify({
    keep: [0],
    contested: [{ area: "retry loop", groups: [[2, 3], [4]] }],
  });
  const { contested } = await applyConsensus(findings, 3, async () => reply);
  assert.deepEqual(contested.map((a) => a.groups.map((g) => g.members.map((m) => m.line))), [[[90]]]);
});

test("the consensus reply may grow with the number of findings", async () => {
  const many = Array.from({ length: 400 }, (_, i) => finding(i % 5, i + 1));
  let asked;
  await applyConsensus(many, 5, async ({ maxTokens }) => {
    asked = maxTokens;
    return JSON.stringify({ keep: [], contested: [] });
  });
  assert.equal(asked, indexReplyMaxTokens(400, 3000));
  assert.ok(indexReplyMaxTokens(400, 3000) > indexReplyMaxTokens(10, 3000));
});

test("the cross-agent grouping reply may grow with the number of findings", async () => {
  const many = Array.from({ length: 300 }, (_, i) => ({ ...finding(0, i + 1), voter: undefined }));
  let asked;
  await groupAllFindings(many.slice(0, 200), many.slice(200), async ({ maxTokens }) => {
    asked = maxTokens;
    return "{}";
  });
  assert.equal(asked, indexReplyMaxTokens(300, 2000));
});

test("consensus names at most the cap of contested areas", async () => {
  const reply = JSON.stringify({
    keep: [],
    contested: findings.map((_, i) => ({ area: `area ${i}`, groups: [[i]] })),
  });
  const { contested } = await applyConsensus(findings, 3, async () => reply);
  assert.equal(contested.length, MAX_CONTESTED_AREAS);
});

test("consensus says whether it filtered the findings", async () => {
  assert.equal((await applyConsensus(findings, 3, async () => JSON.stringify({ keep: [0], contested: [] }))).applied, true);
  assert.equal((await applyConsensus(findings, 3, null)).applied, false);
  assert.equal((await applyConsensus(findings, 3, async () => "no idea")).applied, false);
  assert.equal(
    (await applyConsensus(findings, 3, async () => {
      throw new Error("down");
    })).applied,
    false,
  );
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
    { keep: [1], members: {}, contested: [{ area: "a", groups: [[2]] }] },
  );
  assert.equal(parseConsensusReply("nothing here"), null);
});

test("only integer indices count, so junk entries never stand for finding 0", () => {
  assert.deepEqual(
    parseConsensusReply('{"keep": [null, "", false, true, "0", 2], "contested": [{"area": "a", "groups": [[null, 3]]}]}'),
    { keep: [2], members: {}, contested: [{ area: "a", groups: [[3]] }] },
  );
});

test("a reply cut off mid-object keeps only its explicit keep list, and says the areas were lost", () => {
  const warn = console.warn;
  const warnings = [];
  console.warn = (line) => warnings.push(line);
  try {
    assert.deepEqual(parseConsensusReply('{"keep": [0, 3], "contested": [{"area": "x", "groups": [[5]'), { keep: [0, 3], members: {}, contested: [] });
    assert.match(warnings.join("\n"), /contested areas and voter counts lost/);
    // Cut off inside the keep list: the first complete array is a contested
    // group's or nothing, never the kept findings.
    assert.equal(parseConsensusReply('{"keep": [0, 3'), null);
    assert.equal(parseConsensusReply('{"contested": [{"groups": [[5]]}], "keep": [0'), null);
    // Cut off before the keep key: the contested group's list is not the kept findings.
    assert.equal(parseConsensusReply('{"contested": [{"area": "loop", "groups": [[4]]}], "ke'), null);
    assert.equal(parseConsensusReply('Sure: {"contested": [{"groups": [[4]]}]'), null);
    // A bare array, with or without prose, is still the older reply shape.
    assert.deepEqual(parseConsensusReply("Kept: [1, 2]"), { keep: [1, 2], members: {}, contested: [] });
  } finally {
    console.warn = warn;
  }
});

test("an object reply without a keep array is unreadable, not mined for indices", () => {
  assert.equal(parseConsensusReply('{"keep": "0, 1", "contested": [{"area": "a", "groups": [[4, 5]]}]}'), null);
  assert.equal(parseConsensusReply('{"kept": [0]}'), null);
});

// spec: RUN#voters
test("a kept finding's voter count is the distinct voters among its group's members", async () => {
  // Findings 0 and 1 are one issue from two voters, and finding 0 is listed
  // twice over by the model to show repeats do not count. Findings 2 and 3
  // are another, from two others.
  const reply = JSON.stringify({ keep: [0, 2], members: { 0: [0, 1, 0], 2: [2, 3] }, contested: [] });
  const { kept } = await applyConsensus(findings, 3, async () => reply);
  assert.deepEqual(kept.map((f) => [f.line, f.supporters]), [[10, 2], [40, 2]]);
  assert.ok(kept.every((f) => f.voter === undefined));
});

// spec: RUN#voters
test("a kept finding whose group falls short of the majority has no voter count", async () => {
  // Three voters need two, so a group of one voter contradicts its own keep.
  for (const members of [{ 0: [0] }, { 0: [] }, { 0: [0, 2] }]) {
    const { kept } = await applyConsensus(findings, 3, async () => JSON.stringify({ keep: [0], members }));
    assert.equal(kept[0].supporters, null, JSON.stringify(members));
  }
});

test("an untagged finding listed as a member does not count as a voter", async () => {
  const untagged = [...findings, { ...finding(9, 11), voter: undefined }];
  const reply = JSON.stringify({ keep: [0], members: { 0: [0, 1, 5] } });
  const { kept } = await applyConsensus(untagged, 3, async () => reply);
  assert.equal(kept[0].supporters, 2);
});

test("a contested group counts its voters the same way, an untagged finding counting for none", async () => {
  const untagged = [...findings, { ...finding(9, 41), voter: undefined }];
  const reply = JSON.stringify({ keep: [0], contested: [{ area: "retry", groups: [[2, 5]] }] });
  const { contested } = await applyConsensus(untagged, 5, async () => reply);
  assert.equal(contested[0].groups[0].supporters, 1);
});

test("members the model invents or leaves out do not count towards a voter count", async () => {
  const reply = JSON.stringify({ keep: [0], members: { 0: [0, 99, "x", 3] }, contested: [] });
  const { kept } = await applyConsensus(findings, 3, async () => reply);
  assert.equal(kept[0].supporters, 2);
});

test("a kept finding whose group the reply does not give has no voter count", async () => {
  const noMembers = await applyConsensus(findings, 3, async () => JSON.stringify({ keep: [0, 2], contested: [] }));
  assert.deepEqual(noMembers.kept.map((f) => f.supporters), [null, null]);
  const partial = await applyConsensus(findings, 3, async () => JSON.stringify({ keep: [0, 2], members: { 0: [0, 1] } }));
  assert.deepEqual(partial.kept.map((f) => f.supporters), [2, null]);
  const bare = await applyConsensus(findings, 3, async () => "[0, 2]");
  assert.deepEqual(bare.kept.map((f) => f.supporters), [null, null]);
});

test("findings kept because consensus was not applied have no voter count, and a single voter counts 1", async () => {
  for (const callModel of [null, async () => "no idea"]) {
    const { kept } = await applyConsensus(findings, 3, callModel);
    assert.ok(kept.every((f) => f.supporters === null));
  }
  const single = await applyConsensus(findings, 1, null);
  assert.ok(single.kept.every((f) => f.supporters === 1));
});

test("the reply parser reads the members of each kept group", () => {
  assert.deepEqual(parseConsensusReply('{"keep": [0, 3], "members": {"0": [0, 1], "3": [3, "x"], "z": [9], "5": "bad"}}'), {
    keep: [0, 3],
    members: { 0: [0, 1], 3: [3] },
    contested: [],
  });
});
