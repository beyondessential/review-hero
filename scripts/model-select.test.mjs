import assert from "node:assert/strict";
import { test } from "node:test";

import { chooseAgentModel } from "./lib.mjs";

const choose = (body) => chooseAgentModel({ body });

const GLM = { model: "z-ai/glm-5.3-flash:nitro", warning: null };

test("reviews on GLM by default", () => {
  for (const body of [undefined, "Just a description", "- [x] **Run Review Hero** <!-- #ai-review -->"]) {
    assert.deepEqual(choose(body), GLM);
  }
});

test("a marker naming an allowed model selects it", () => {
  assert.deepEqual(choose("<!-- review-hero: model=z-ai/glm-5.3-flash:nitro -->"), GLM);
  assert.equal(choose("<!--review-hero:model=z-ai/glm-5.3-flash:nitro-->").model, "z-ai/glm-5.3-flash:nitro");
});

test("a marker naming any other model is ignored with a warning", () => {
  for (const id of ["z-ai/glm-5.3", "glm;rm", "z-ai/glm-5.3-flash:nitro\nx=y"]) {
    const result = choose(`<!-- review-hero: model=${id} -->`);
    assert.equal(result.model, "z-ai/glm-5.3-flash:nitro", id);
  }
  assert.match(choose("<!-- review-hero: model=z-ai/glm-5.3 -->").warning, /ALLOWED_MODELS/);
});
