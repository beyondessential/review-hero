/**
 * Review Hero — Local fix prompt builder
 *
 * Shared helper used by both the review orchestrator and the auto-fix script
 * to produce a collapsible <details> block containing outstanding review
 * comments that the developer can copy-paste into their local coding agent.
 *
 * The prompt goes inside a single fenced code block so GitHub renders a copy
 * button for the whole thing, and so comment text passes through verbatim.
 *
 * @param {Array<{file: string, line?: number, comment: string}>} comments
 *   Outstanding review comments.
 * @returns {string} Markdown string to append to a summary comment, or "" if
 *   there is nothing to report.
 */
export function buildLocalFixPrompt(comments) {
  if (!comments?.length) return "";

  const items = [];

  for (const c of comments) {
    const loc = sanitise(`${c.file}${c.line ? `:${c.line}` : ""}`);
    items.push(`\`${loc}\`: ${sanitise(c.comment)}`);
  }

  const prompt =
    "Fix these issues identified on the pull request. One commit per issue fixed.\n\n-------\n\n" +
    items.join("\n\n-------\n\n");

  const fence = "`".repeat(fenceLength(prompt));

  return (
    "\n\n<details>\n<summary>Local fix prompt (copy to your coding agent)</summary>\n\n" +
    `${fence}\n${prompt}\n${fence}` +
    "\n\n</details>"
  );
}

/**
 * Pick a fence long enough that nothing in the content can close it early.
 *
 * CommonMark closes a fenced code block only on a line that is nothing but
 * backticks (indented up to three spaces, trailing whitespace allowed), so
 * only those lines constrain the fence. Four backticks is the floor: review
 * comments routinely contain ``` code blocks.
 */
function fenceLength(content) {
  let longest = 3;
  for (const [, run] of content.matchAll(/^ {0,3}(`{3,})[ \t]*$/gm)) {
    longest = Math.max(longest, run.length);
  }
  return longest + 1;
}

/**
 * Strip horizontal rules (`---` or more on its own line) from user-supplied
 * text. The prompt uses `-------` lines to separate items, so a comment
 * containing one would read as an item boundary to the coding agent.
 *
 * Nothing else needs escaping: the prompt sits inside a fenced code block, so
 * backticks and HTML tags reach the agent as written.
 */
function sanitise(text) {
  return text.replace(/^-{3,}$/gm, "");
}
