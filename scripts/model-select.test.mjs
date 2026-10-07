import assert from "node:assert/strict";
import { test } from "node:test";

import { chooseAgentModel } from "./lib.mjs";

const choose = (body, hasOpenRouterKey = true) =>
  chooseAgentModel({ body, fallback: "claude-sonnet-5", hasOpenRouterKey });

const glm = (box) => `- [${box}] **Run Review Hero GLM (experimental)** <!-- #ai-review-glm -->`;

test("uses the fallback without a ticked opt-in checkbox", () => {
  for (const body of [undefined, "Just a description", glm(" "), "- [x] **Run Review Hero** <!-- #ai-review -->"]) {
    assert.deepEqual(choose(body), { model: "claude-sonnet-5", provider: "anthropic", warning: null });
  }
});

test("the GLM checkbox routes to OpenRouter", () => {
  assert.deepEqual(choose(`Summary\n\n${glm("x")}\n`), {
    model: "z-ai/glm-5.3-flash:floor",
    provider: "openrouter",
    warning: null,
  });
});

test("the GLM checkbox without the key falls back with a warning", () => {
  const result = choose(glm("x"), false);
  assert.equal(result.model, "claude-sonnet-5");
  assert.equal(result.provider, "anthropic");
  assert.match(result.warning, /REVIEW_HERO_OPENROUTER_API_KEY/);
});

test("free-text model markers are ignored", () => {
  for (const body of ["<!-- review-hero: model=claude-opus-5 -->", "<!-- review-hero: model=z-ai/glm-5.3 -->"]) {
    assert.equal(choose(body).model, "claude-sonnet-5");
  }
});

test("a tick on another line does not select GLM", () => {
  assert.equal(choose(`- [x] **Other**\n${glm(" ")}`).model, "claude-sonnet-5");
});
