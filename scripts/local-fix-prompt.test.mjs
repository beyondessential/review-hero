import assert from "node:assert/strict";
import { test } from "node:test";

import { buildLocalFixPrompt } from "./local-fix-prompt.mjs";

/** Extract the fenced code block body from a built prompt. */
function codeBlock(output) {
  const match = output.match(/\n(`{4,})\n([\s\S]*)\n\1\n/);
  assert.ok(match, `no fenced code block found in:\n${output}`);
  return { fence: match[1], body: match[2] };
}

test("returns nothing when there are no comments", () => {
  assert.equal(buildLocalFixPrompt([]), "");
  assert.equal(buildLocalFixPrompt(undefined), "");
});

test("wraps the prompt in a four-backtick fence inside the details block", () => {
  const output = buildLocalFixPrompt([
    { file: "src/app.ts", line: 12, comment: "Handle the null case." },
  ]);

  assert.match(
    output,
    /^\n\n<details>\n<summary>Local fix prompt \(copy to your coding agent\)<\/summary>\n\n````\n/,
  );
  assert.match(output, /\n````\n\n<\/details>$/);

  const { body } = codeBlock(output);
  assert.match(body, /^Fix these issues identified on the pull request\./);
  assert.match(body, /`src\/app\.ts:12`: Handle the null case\./);
});

test("passes inner triple-backtick blocks through verbatim", () => {
  const comment = "Use:\n\n```ts\nconst x = 1;\n```\n\nnot the old form.";
  const { fence, body } = codeBlock(
    buildLocalFixPrompt([{ file: "src/app.ts", line: 3, comment }]),
  );

  assert.equal(fence, "````");
  assert.ok(body.includes("```ts\nconst x = 1;\n```"));
});

test("grows the fence past backtick runs that would close it early", () => {
  const comment = "Nested example:\n\n````md\n```js\n1\n```\n````";
  const { fence, body } = codeBlock(
    buildLocalFixPrompt([{ file: "docs/readme.md", comment }]),
  );

  assert.equal(fence, "`````");
  assert.ok(body.includes(comment));
});

test("grows the fence for CRLF comment text too", () => {
  const comment = "Nested example:\r\n\r\n````md\r\n```js\r\n1\r\n```\r\n````";
  const { fence, body } = codeBlock(
    buildLocalFixPrompt([{ file: "docs/readme.md", line: 1, comment }]),
  );

  assert.equal(fence, "`````");
  const closer = new RegExp(`^ {0,3}\`{${fence.length},}[ \t]*$`);
  assert.ok(
    !body.split(/\r?\n/).some((line) => closer.test(line)),
    "no line inside the block may close the fence early",
  );
});

test("passes HTML tags through verbatim", () => {
  const { body } = codeBlock(
    buildLocalFixPrompt([
      { file: "src/app.tsx", line: 7, comment: "Wrap it in a <details> tag." },
    ]),
  );

  assert.ok(body.includes("Wrap it in a <details> tag."));
  assert.ok(!body.includes("&lt;"));
});

test("strips horizontal rules so they cannot read as item separators", () => {
  const { body } = codeBlock(
    buildLocalFixPrompt([
      { file: "a.ts", line: 1, comment: "First\n---\nSecond" },
      { file: "b.ts", line: 2, comment: "Third" },
    ]),
  );

  assert.ok(body.includes("First\n\nSecond"));
  assert.equal(body.split("\n-------\n").length, 3);
});

test("omits the line number when absent", () => {
  const { body } = codeBlock(
    buildLocalFixPrompt([{ file: "src/app.ts", comment: "Rename this." }]),
  );

  assert.ok(body.includes("`src/app.ts`: Rename this."));
});
