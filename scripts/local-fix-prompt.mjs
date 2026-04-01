import { format as prettify } from "prettier";

async function formatMarkdown(str) {
  return await prettify(str, { parser: "markdown", proseWrap: "always" });
}

/**
 * Review Hero — Local fix prompt builder
 *
 * Shared helper used by both the review orchestrator and the auto-fix script
 * to produce a collapsible <details> block containing outstanding review
 * comments that the developer can copy-paste into their local coding agent.
 *
 * @param {Array<{file: string, line?: number, comment: string}>} comments
 *   Outstanding review comments.
 * @returns {Promise<string>} Markdown string to append to a summary comment, or "" if
 *   there is nothing to report.
 */
export async function buildLocalFixPrompt(comments) {
  if (!comments?.length) return "";

  const items = [];

  for (const c of comments) {
    const loc = sanitise(`${c.file}${c.line ? `:${c.line}` : ""}`);
    items.push(`\`${loc}\`: ${sanitise(c.comment)}`);
  }

  const openingFence = "```md\n";
  const closingFence = "\n```";
  const codeBlocks = await Promise.all(
    items.map(
      async (item) =>
        `${openingFence}${await formatMarkdown(item)}${closingFence}`,
    ),
  );

  return await formatMarkdown(`
<details>
  <summary>Local fix prompt (copy to your coding agent)</summary>

  Fix these issues identified on the pull request. One commit per issue
  fixed.

  ${codeBlocks.join("\n\n")}
</details>
`);
}

/**
 * Sanitise user-supplied text so it cannot corrupt the surrounding prompt
 * structure (this output is consumed by coding agents, not just rendered as
 * markdown):
 *
 * - HTML tags (e.g. `<details>`, `<script>`) — replace `<` with `&lt;`
 * - Triple-backtick fences — replace with single-backtick inline code
 * - Horizontal rules (`---` or more on its own line) — could be mistaken
 *   for our `-------` item separators, so strip them entirely
 */
function sanitise(text) {
  return text
    .replace(/</g, "&lt;")
    .replace(/`{3,}/g, "`")
    .replace(/^-{3,}$/gm, "");
}
