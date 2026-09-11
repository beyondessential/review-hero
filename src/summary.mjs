/**
 * Review Hero — Summary formatting
 *
 * Formats the consolidated review summary a reviewer sees: the header line and
 * the nitpick table. Shared so a consumer presents the same summary this repo
 * does.
 */

/** Leading marker for a Review Hero summary comment, used to detect prior rounds. */
export const SUMMARY_HEADER = "🦸 **Review Hero Summary**";

/** Severity sort order, most to least severe. */
export const SEVERITY_ORDER = { critical: 0, suggestion: 1, nitpick: 2 };

export function buildSummaryHeader({ round, agentsCompleted, agentsFailed, counts }) {
  return (
    `${SUMMARY_HEADER}${round ? ` (round ${round})` : ""}\n` +
    `**${agentsCompleted} agent${agentsCompleted === 1 ? "" : "s"}** reviewed this PR` +
    (agentsFailed > 0 ? ` | ${agentsFailed} failed` : "") +
    ` | ${counts.critical} critical` +
    ` | ${counts.suggestion} suggestion${counts.suggestion === 1 ? "" : "s"}` +
    ` | ${counts.nitpick} nitpick${counts.nitpick === 1 ? "" : "s"}`
  );
}

export function buildSummaryTable(nitpicks, agentNames) {
  if (nitpicks.length === 0) return "";

  const rows = nitpicks
    .map((f) => {
      const agentName = agentNames[f.agent] ?? f.agent;
      const shortComment =
        f.comment.length > 300 ? `${f.comment.slice(0, 297)}...` : f.comment;
      const escaped = shortComment
        .replace(/\\/g, "\\\\")
        .replace(/\|/g, "\\|")
        .replace(/\n/g, " ");
      return `| \`${f.file}\` | ${f.line} | ${agentName} | ${escaped} |`;
    })
    .join("\n");

  return `### Nitpicks\n\n| File | Line | Agent | Comment |\n|------|------|-------|---------|\n${rows}`;
}
