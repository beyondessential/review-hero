import assert from "node:assert/strict";
import { test } from "node:test";

import { chooseAgentModel } from "./lib.mjs";

const choose = (body, hasOpenRouterKey = false) =>
  chooseAgentModel({ body, fallback: "claude-sonnet-5", hasOpenRouterKey });

test("uses the fallback when there is no marker", () => {
  assert.deepEqual(choose("Just a description"), {
    model: "claude-sonnet-5",
    provider: "anthropic",
    warning: null,
  });
  assert.equal(choose(undefined).model, "claude-sonnet-5");
});

test("a marker overrides the fallback", () => {
  const body = "Summary\n\n<!-- review-hero: model=claude-opus-5 -->\n";
  assert.deepEqual(choose(body), {
    model: "claude-opus-5",
    provider: "anthropic",
    warning: null,
  });
});

test("tolerates spacing inside the marker", () => {
  assert.equal(choose("<!--review-hero:model=claude-haiku-4-5-->").model, "claude-haiku-4-5");
  assert.equal(choose("<!--  review-hero:  model=claude-haiku-4-5   -->").model, "claude-haiku-4-5");
});

test("an OpenRouter id routes to OpenRouter when the key is set", () => {
  assert.deepEqual(choose("<!-- review-hero: model=z-ai/glm-5.3 -->", true), {
    model: "z-ai/glm-5.3",
    provider: "openrouter",
    warning: null,
  });
});

test("an OpenRouter id without the key falls back with a warning", () => {
  const result = choose("<!-- review-hero: model=z-ai/glm-5.3 -->", false);
  assert.equal(result.model, "claude-sonnet-5");
  assert.equal(result.provider, "anthropic");
  assert.match(result.warning, /REVIEW_HERO_OPENROUTER_API_KEY/);
});

test("invalid ids fall back with a warning", () => {
  for (const id of [
    "",
    "Claude-Opus",
    "-flag",
    "claude opus",
    "claude;rm",
    "a".repeat(101),
  ]) {
    const result = choose(`<!-- review-hero: model=${id} -->`, true);
    assert.equal(result.model, "claude-sonnet-5", id);
    assert.ok(result.warning, id);
  }
});

test("a newline can never reach the chosen model", () => {
  for (const body of [
    "<!-- review-hero: model=claude-opus-5\nagent_provider=openrouter -->",
    "<!-- review-hero: model=claude-opus-5\r\nx=y -->",
    "<!-- review-hero: model=claude-opus-5%0Ax=y -->",
  ]) {
    const result = choose(body, true);
    assert.doesNotMatch(result.model, /[\r\n]/);
    assert.equal(result.model, "claude-sonnet-5");
  }
});

test("the longest allowed id is accepted", () => {
  const id = "a".repeat(100);
  assert.equal(choose(`<!-- review-hero: model=${id} -->`).model, id);
});
