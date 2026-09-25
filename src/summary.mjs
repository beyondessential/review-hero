/**
 * Review Hero — Summary formatting
 *
 * Formats the consolidated review summary a reviewer sees: the header line, the
 * nitpick table, and the commit links the summary and the completion comments
 * share. Shared so a consumer presents the same summary this repo does.
 *
 * The completion block's wire format lives in `completion.mjs`.
 */

import { stripCompletionBlocks } from "./completion.mjs";

/** Leading marker for a Review Hero summary comment, used to detect prior rounds. */
export const SUMMARY_HEADER = "🦸 **Review Hero Summary**";

/** Severity sort order, most to least severe. */
export const SEVERITY_ORDER = { critical: 0, suggestion: 1, nitpick: 2 };

const FULL_SHA = /^[0-9a-f]{40}$/;
const REPO_NAME = /^[\w.-]+\/[\w.-]+$/;
const PR_NUMBER = /^\d+$/;

/**
 * Link a commit within its pull request, shown as its short SHA.
 *
 * Every part of the URL is validated rather than interpolated as given: a value
 * carrying `)` or whitespace would otherwise break out of the markdown link and
 * let the surrounding comment be rewritten.
 *
 * @returns {string | null} Markdown link, or null when any part is malformed.
 */
export function formatCommitLink({ serverUrl, repo, prNumber, sha }) {
  if (!FULL_SHA.test(sha ?? "")) return null;
  if (!REPO_NAME.test(repo ?? "")) return null;
  if (!PR_NUMBER.test(String(prNumber ?? ""))) return null;

  let origin;
  try {
    const parsed = new URL(serverUrl);
    if (parsed.protocol !== "https:") return null;
    origin = parsed.origin;
  } catch {
    return null;
  }

  return `[\`${sha.slice(0, 7)}\`](${origin}/${repo}/pull/${prNumber}/commits/${sha})`;
}

export function buildSummaryHeader({ round, commitLink, agentsCompleted, agentsFailed, counts }) {
  return (
    `${SUMMARY_HEADER}${round ? ` (round ${round})` : ""}` +
    `${commitLink ? ` · reviewed ${commitLink}` : ""}\n` +
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
      // Findings quote the diff, so this text is as untrusted as the branch.
      const escaped = stripCompletionBlocks(shortComment)
        .replace(/\\/g, "\\\\")
        .replace(/\|/g, "\\|")
        .replace(/\n/g, " ");
      return `| \`${stripCompletionBlocks(f.file)}\` | ${f.line} | ${agentName} | ${escaped} |`;
    })
    .join("\n");

  return `### Nitpicks\n\n| File | Line | Agent | Comment |\n|------|------|-------|---------|\n${rows}`;
}
