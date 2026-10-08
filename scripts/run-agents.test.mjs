import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildPrompt, limit } from "./run-agents.mjs";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "run-agents-"));
  mkdirSync(join(dir, "rh/prompts"), { recursive: true });
  mkdirSync(join(dir, "caller/.github/review-hero/prompts"), { recursive: true });
  writeFileSync(join(dir, "rh/prompts/agent-prompt.md"), "BASE");
  writeFileSync(join(dir, "rh/prompts/bugs.md"), "BUGS");
  writeFileSync(join(dir, "caller/.github/review-hero/prompts/house.md"), "HOUSE");
  return { reviewHeroDir: join(dir, "rh"), callerBaseDir: join(dir, "caller") };
}

const args = (dirs, overrides) => ({
  ...dirs,
  agent: { key: "bugs", source: "base" },
  projectContext: "",
  aiRules: "",
  maxTurns: 20,
  prTitle: "Fix it",
  diff: "+line\n",
  ...overrides,
});

test("the prompt keeps the section order and bytes of the old bash builder", () => {
  const dirs = fixture();
  assert.equal(
    buildPrompt(args(dirs, { projectContext: "CTX", aiRules: "RULES" })),
    "## Project Context\n\nCTX\n\nBASE\n\nBUGS" +
      "\n\n## Repository AI Rules\n\nThis repository defines the following AI coding rules. Follow them when reviewing.\n\nRULES" +
      "\n\n## Turn budget\n\nYou have at most 20 agent turns for this review, and every tool call spends one. Stop exploring by turn 17 and spend the remainder writing up findings. Prioritise the highest-risk changes, sample files selectively rather than reading them end-to-end, and make your final message the JSON array (exactly `[]` if you found nothing). Returning fewer high-confidence findings on time beats being cut off mid-exploration with no output at all.\n" +
      "\n\n## PR Title\n\nFix it\n\n## PR Diff\n\n```diff\n+line\n```\n",
  );
});

test("custom agents read their prompt from the trusted caller checkout", () => {
  const dirs = fixture();
  const prompt = buildPrompt(args(dirs, { agent: { key: "house", source: "custom" } }));
  assert.match(prompt, /BASE\n\nHOUSE/);
  assert.doesNotMatch(prompt, /Project Context|Repository AI Rules/);
});

test("limit never runs more than its concurrency at once", async () => {
  const run = limit(2);
  let active = 0;
  let peak = 0;
  const task = () =>
    run(async () => {
      peak = Math.max(peak, ++active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    });
  await Promise.all(Array.from({ length: 6 }, task));
  assert.equal(peak, 2);
});
