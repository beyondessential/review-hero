/**
 * Review Hero — Local fix prompt builder
 *
 * Shared helper used by both the review orchestrator and the auto-fix script
 * to produce a collapsible <details> block containing outstanding review
 * comments that the developer can copy-paste into their local coding agent.
 *
 * @param {Array<{file: string, line?: number, comment: string}>} comments
 *   Outstanding review comments.
 * @returns {string} Markdown string to append to a summary comment, or "" if
 *   there is nothing to report.
 */
export function buildLocalFixPrompt(comments) {
  if (comments.length === 0) return "";

  const items = [];

  for (const c of comments) {
    const loc = `${c.file}${c.line ? `:${c.line}` : ""}`;
    items.push(`\`${loc}\`: ${sanitize(c.comment)}`);
  }

  const prompt =
    "Fix these issues identified on the pull request. One commit per issue fixed.\n\n-------\n\n" +
    items.join("\n\n-------\n\n");

  return (
    "\n\n<details>\n<summary>Local fix prompt (copy to your coding agent)</summary>\n\n" +
    prompt +
    "\n\n</details>"
  );
}

/**
 * Sanitize user-supplied comment text so it cannot corrupt the surrounding
 * markdown structure:
 *
 * - HTML tags (e.g. `<details>`, `<script>`) — replace `<` with `&lt;`
 * - Triple-backtick fences — replace with single-backtick inline code
 * - Horizontal rules (`---` or more on its own line) — could break our
 *   `-------` separators, so we prefix with a zero-width space
 */
function sanitize(text) {
  return text
    .replace(/</g, "&lt;")
    .replace(/`{3,}/g, "`")
    .replace(/^(-{3,})$/gm, "\u200B$1");
}
