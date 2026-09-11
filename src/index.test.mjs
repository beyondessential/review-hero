import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadSuppressions,
  filterWithSuppressions,
  applyConsensus,
  groupAllFindings,
  loadCallerConfig,
  discoverBaseAgents,
  filterDiff,
  createAnthropicModelCaller,
} from "./index.mjs";

const dir = mkdtempSync(join(tmpdir(), "review-hero-lib-"));

function writeTmp(name, contents) {
  const path = join(dir, name);
  writeFileSync(path, contents);
  return path;
}

// ── Injectable model call ────────────────────────────────────────────────────

test("filterWithSuppressions routes calls through the caller-supplied model function", async () => {
  const findings = [
    { file: "a.ts", line: 1, severity: "nitpick", comment: "Add a comment.", agent: "design" },
    { file: "b.ts", line: 2, severity: "critical", comment: "Null deref.", agent: "bugs" },
  ];
  const calls = [];
  const callModel = async (request) => {
    calls.push(request);
    // Suppress the first finding (index 0) in the batch.
    return "[0]";
  };

  const { kept, suppressed } = await filterWithSuppressions(
    findings,
    [{ pattern: "clarifying comments" }],
    callModel,
  );

  assert.equal(calls.length, 1, "the injected caller performed the model call");
  assert.equal(calls[0].model, "claude-haiku-4-5-20251001");
  assert.equal(suppressed.length, 1);
  assert.equal(suppressed[0].file, "a.ts");
  assert.equal(kept.length, 1);
  assert.equal(kept[0].file, "b.ts");
});

test("filterWithSuppressions with no caller keeps everything", async () => {
  const findings = [{ file: "a.ts", line: 1, severity: "critical", comment: "x", agent: "bugs" }];
  const { kept, suppressed } = await filterWithSuppressions(
    findings,
    [{ pattern: "anything" }],
    null,
  );
  assert.deepEqual(kept, findings);
  assert.equal(suppressed.length, 0);
});

test("applyConsensus routes through the caller and keeps the representatives it returns", async () => {
  const findings = [
    { file: "a.ts", line: 1, severity: "critical", comment: "Null deref.", agent: "bugs", voter: "bugs-0" },
    { file: "a.ts", line: 1, severity: "critical", comment: "Possible null.", agent: "bugs", voter: "bugs-1" },
  ];
  const callModel = async () => "keep [0]";
  const { kept, dropped } = await applyConsensus(findings, 2, callModel);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].comment, "Null deref.");
  assert.equal(kept[0].voter, undefined, "voter tag is stripped from kept findings");
  assert.equal(dropped, 1);
});

test("applyConsensus with no caller keeps all findings, stripped of voter tags", async () => {
  const findings = [
    { file: "a.ts", line: 1, severity: "critical", comment: "x", agent: "bugs", voter: "bugs-0" },
    { file: "a.ts", line: 1, severity: "critical", comment: "y", agent: "bugs", voter: "bugs-1" },
  ];
  const { kept, dropped } = await applyConsensus(findings, 2, null);
  assert.equal(kept.length, 2);
  assert.equal(dropped, 0);
  assert.ok(kept.every((f) => f.voter === undefined));
});

test("groupAllFindings with no caller falls back to one group per finding", async () => {
  const kept = [{ file: "a.ts", line: 1, severity: "critical", comment: "x", agent: "bugs" }];
  const dropped = [{ file: "b.ts", line: 2, severity: "nitpick", comment: "y", agent: "design" }];
  const { keptGroups, droppedGroups } = await groupAllFindings(kept, dropped, null);
  assert.equal(keptGroups.length, 1);
  assert.equal(droppedGroups.length, 1);
  assert.equal(keptGroups[0].representative.file, "a.ts");
});

// ── Anthropic-backed caller ──────────────────────────────────────────────────

test("createAnthropicModelCaller returns the assistant text", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ content: [{ type: "text", text: "hello" }] }),
  });
  try {
    const callModel = createAnthropicModelCaller({ apiKey: "k" });
    const text = await callModel({ model: "m", maxTokens: 10, messages: [] });
    assert.equal(text, "hello");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createAnthropicModelCaller throws on a non-2xx response", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => "boom" });
  try {
    const callModel = createAnthropicModelCaller({ apiKey: "k" });
    await assert.rejects(() => callModel({ model: "m", maxTokens: 10, messages: [] }), /API 500/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── Suppressions loading without yq ──────────────────────────────────────────

test("loadSuppressions parses a YAML file with the JS parser", () => {
  const path = writeTmp(
    "suppressions.yml",
    '- pattern: "no comments in prompts"\n  context: "prompt files"\n- pattern: "second rule"\n',
  );
  const rules = loadSuppressions(path);
  assert.equal(rules.length, 2);
  assert.equal(rules[0].pattern, "no comments in prompts");
  assert.equal(rules[0].context, "prompt files");
});

test("loadSuppressions returns [] for a missing file and for non-list YAML", () => {
  assert.deepEqual(loadSuppressions(join(dir, "nope.yml")), []);
  const scalar = writeTmp("scalar.yml", "just: a mapping\n");
  assert.deepEqual(loadSuppressions(scalar), []);
});

// ── Agent discovery and scope filtering ──────────────────────────────────────

test("loadCallerConfig parses config.yml via the JS parser", () => {
  const callerDir = mkdtempSync(join(tmpdir(), "review-hero-caller-"));
  const cfgDir = join(callerDir, ".github", "review-hero");
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(join(cfgDir, "config.yml"), 'project: Demo\nignore_patterns:\n  - "*.pem"\n');
  const config = loadCallerConfig(callerDir);
  assert.equal(config.project, "Demo");
  assert.deepEqual(config.ignore_patterns, ["*.pem"]);
});

test("filterDiff strips ignored files and keeps in-scope files", () => {
  const rawDiff = [
    "diff --git a/src/app.ts b/src/app.ts",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "diff --git a/package-lock.json b/package-lock.json",
    "@@ -1 +1 @@",
    "-x",
    "+y",
  ].join("\n");
  const { filtered, removedFiles } = filterDiff(rawDiff, ["package-lock.json"]);
  assert.deepEqual(removedFiles, ["package-lock.json"]);
  assert.ok(filtered.includes("src/app.ts"));
  assert.ok(!filtered.includes("package-lock.json"));
});

test("discoverBaseAgents finds the base agents whose prompts exist in this repo", () => {
  // This repo's own prompts/ directory backs the base agents.
  const agents = discoverBaseAgents(join(import.meta.dirname, ".."));
  const keys = agents.map((a) => a.key).sort();
  assert.deepEqual(keys, ["bugs", "design", "performance", "security"]);
  assert.ok(agents.every((a) => a.source === "base"));
});
