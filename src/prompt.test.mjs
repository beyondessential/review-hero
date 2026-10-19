import assert from "node:assert/strict";
import { test } from "node:test";

import { buildReviewAgentPrompt, softTurnCap } from "./index.mjs";

const options = {
  projectContext: "You are reviewing a PR for **Acme**.",
  basePrompt: "Base prompt.",
  agentPrompt: "Look for bugs.",
  aiRules: "Use tabs.",
  maxTurns: 20,
  prTitle: "Fix the thing",
  diff: "diff --git a/x b/x\n+added\n",
};

test("identical options build identical bytes, so voters share a prefix", () => {
  assert.equal(buildReviewAgentPrompt(options), buildReviewAgentPrompt({ ...options }));
});

test("the prompt carries its sections in order", () => {
  const prompt = buildReviewAgentPrompt(options);
  const order = [
    "## Project Context\n\nYou are reviewing a PR for **Acme**.",
    "Base prompt.\n\nLook for bugs.",
    "## Repository AI Rules",
    "Use tabs.",
    "## Turn budget",
    "## PR Title\n\nFix the thing",
    "## PR Diff\n\n```diff\ndiff --git a/x b/x\n+added\n```\n",
  ];
  let at = -1;
  for (const part of order) {
    const found = prompt.indexOf(part, at + 1);
    assert.ok(found > at, `expected ${JSON.stringify(part)} after offset ${at}`);
    at = found;
  }
});

test("empty project context and AI rules are left out", () => {
  const prompt = buildReviewAgentPrompt({ ...options, projectContext: "", aiRules: "" });
  assert.ok(prompt.startsWith("Base prompt."));
  assert.ok(!prompt.includes("## Project Context"));
  assert.ok(!prompt.includes("## Repository AI Rules"));
});

test("the diff fence closes on its own line when the diff has no trailing newline", () => {
  const prompt = buildReviewAgentPrompt({ ...options, diff: "+added" });
  assert.ok(prompt.endsWith("```diff\n+added\n```\n"));
});

test("the turn budget names the hard cap and a soft cap below it", () => {
  const prompt = buildReviewAgentPrompt(options);
  assert.ok(prompt.includes("at most 20 agent turns"));
  assert.ok(prompt.includes("Stop exploring by turn 17"));
});

test("the soft cap leaves three turns on a large budget and one on a small one", () => {
  assert.equal(softTurnCap(20), 17);
  assert.equal(softTurnCap(5), 2);
  assert.equal(softTurnCap(4), 3);
  assert.equal(softTurnCap(2), 1);
});
