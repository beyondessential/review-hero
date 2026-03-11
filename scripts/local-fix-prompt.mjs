/**
 * Review Hero — Local fix prompt builder
 *
 * Shared helper used by both the review orchestrator and the auto-fix script
 * to produce a collapsible <details> block containing outstanding issues that
 * the developer can copy-paste into their local coding agent.
 *
 * @param {Array<{file: string, line?: number, comment: string}>} comments
 *   Outstanding review comments.
 * @param {Array<{workflow: string, job: string, log: string}>} [ciFailures=[]]
 *   Outstanding CI failures (auto-fix only; the review path passes nothing).
 * @returns {string} Markdown string to append to a summary comment, or "" if
 *   there is nothing to report.
 */
export function buildLocalFixPrompt(comments, ciFailures = []) {
  if (comments.length === 0 && ciFailures.length === 0) {
    return "";
  }

  const items = [];

  for (const c of comments) {
    const loc = `${c.file}${c.line ? `:${c.line}` : ""}`;
    items.push(`\`${loc}\`: ${c.comment}`);
  }

  for (const f of ciFailures) {
    items.push(
      `CI failure in **${f.workflow} / ${f.job}**:\n\`\`\`\n${f.log}\n\`\`\``,
    );
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
