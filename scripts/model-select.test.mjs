import assert from "node:assert/strict";
import { test } from "node:test";

import { chooseAgentModel } from "./lib.mjs";

const choose = (body, hasOpenRouterKey = true) =>
  chooseAgentModel({ body, claudeModel: "claude-sonnet-5", hasOpenRouterKey });

const GLM = { model: "z-ai/glm-5.3-flash:floor", provider: "openrouter", warning: null };
const CLAUDE = { model: "claude-sonnet-5", provider: "anthropic", warning: null };
const claudeBox = (box) =>
  `- [${box}] **Run Review Hero on Claude (before merge)** <!-- #ai-review-claude -->`;

test("reviews on GLM by default", () => {
  for (const body of [undefined, "Just a description", claudeBox(" "), "- [x] **Run Review Hero** <!-- #ai-review -->"]) {
    assert.deepEqual(choose(body), GLM);
  }
});

test("the Claude checkbox reviews on the Claude model", () => {
  assert.deepEqual(choose(`Summary\n\n${claudeBox("x")}\n`), CLAUDE);
});

test("the Claude checkbox wins over a marker", () => {
  assert.deepEqual(choose(`${claudeBox("x")}\n<!-- review-hero: model=z-ai/glm-5.3-flash:floor -->`), CLAUDE);
});

test("without the OpenRouter key, reviews on Claude with a warning", () => {
  const result = choose("Just a description", false);
  assert.equal(result.model, "claude-sonnet-5");
  assert.equal(result.provider, "anthropic");
  assert.match(result.warning, /REVIEW_HERO_OPENROUTER_API_KEY/);
});

test("a rejected marker is still reported when the key is missing", () => {
  const { warning } = choose("<!-- review-hero: model=claude-opus-5 -->", false);
  assert.match(warning, /ALLOWED_MODELS/);
  assert.match(warning, /REVIEW_HERO_OPENROUTER_API_KEY/);
});

test("a marker naming an allowed model selects it", () => {
  assert.deepEqual(choose("<!-- review-hero: model=z-ai/glm-5.3-flash:floor -->"), GLM);
  assert.equal(choose("<!--review-hero:model=z-ai/glm-5.3-flash:floor-->").model, "z-ai/glm-5.3-flash:floor");
});

test("a marker naming any other model is ignored with a warning", () => {
  for (const id of ["claude-opus-5", "z-ai/glm-5.3", "claude;rm", "z-ai/glm-5.3-flash:floor\nx=y"]) {
    const result = choose(`<!-- review-hero: model=${id} -->`);
    assert.equal(result.model, "z-ai/glm-5.3-flash:floor", id);
    assert.equal(result.provider, "openrouter", id);
  }
  assert.match(choose("<!-- review-hero: model=claude-opus-5 -->").warning, /ALLOWED_MODELS/);
});

test("a tick on another line does not select Claude", () => {
  assert.equal(choose(`- [x] **Other**\n${claudeBox(" ")}`).model, "z-ai/glm-5.3-flash:floor");
});
