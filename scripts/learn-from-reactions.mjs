/**
 * Review Hero — Learn from Reactions
 *
 * Detects thumbs-down reactions on Review Hero comments and generates
 * suppression entries from the developer feedback.
 */

/**
 * Find Review Hero threads that received thumbs-down reactions.
 *
 * @param {Function} graphqlFn - GraphQL query function
 * @param {string} repo - "owner/repo"
 * @param {string|number} prNumber
 * @param {string} botLogin - e.g. "review-hero[bot]"
 * @returns {Array<{ file, line, reviewComment, devReplies }>}
 */
export async function findRejectedFindings(
  graphqlFn,
  repo,
  prNumber,
  botLogin,
) {
  const [owner, name] = repo.split("/");

  const data = await graphqlFn(
    `query($owner: String!, $repo: String!, $pr: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $pr) {
          reviewThreads(first: 100) {
            nodes {
              id
              isResolved
              comments(first: 50) {
                nodes {
                  body
                  path
                  line
                  author { login }
                  reactions(first: 20) {
                    nodes {
                      content
                      user { login }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }`,
    { owner, repo: name, pr: parseInt(prNumber) },
  );

  const threads = data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
  const rejected = [];

  for (const thread of threads) {
    if (thread.isResolved) continue;

    const comments = thread.comments?.nodes ?? [];
    const first = comments[0];
    if (!first || first.author?.login !== botLogin) continue;

    // Check for thumbs-down from non-bot users
    const hasThumbsDown = comments.some((c) =>
      (c.reactions?.nodes ?? []).some(
        (r) =>
          r.content === "THUMBS_DOWN" && r.user?.login !== botLogin,
      ),
    );
    if (!hasThumbsDown) continue;

    // Collect developer replies for context
    const devReplies = comments
      .filter((c) => c.author?.login !== botLogin && c.body)
      .map((c) => c.body);

    rejected.push({
      file: first.path,
      line: first.line,
      reviewComment: first.body,
      devReplies,
    });
  }

  return rejected;
}

/**
 * Generate suppression entries from rejected findings using Haiku.
 *
 * @param {Array} rejectedThreads - Output from findRejectedFindings
 * @param {{ apiKey: string, baseUrl: string }} options
 * @returns {Array<{ pattern, context, reason }>}
 */
export async function generateSuppressions(
  rejectedThreads,
  { apiKey, baseUrl },
) {
  if (rejectedThreads.length === 0) return [];

  const descriptions = rejectedThreads
    .map((t, i) => {
      const parts = [`### Rejected #${i + 1}: \`${t.file}:${t.line}\``];
      parts.push(`Review comment: ${t.reviewComment}`);
      if (t.devReplies.length > 0) {
        parts.push(
          `Developer feedback:\n${t.devReplies.map((r) => `> ${r}`).join("\n")}`,
        );
      }
      return parts.join("\n");
    })
    .join("\n\n");

  try {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 2000,
        messages: [
          {
            role: "user",
            content: `Developers rejected these AI code review comments (thumbs-down reaction). Create suppression rules to prevent similar false positives in future reviews.

${descriptions}

Output a JSON array of suppression rules. Each rule should be general (not file-specific):
\`\`\`json
[{ "pattern": "what not to flag", "context": "when it applies", "reason": "why devs disagreed" }]
\`\`\`
Only output the JSON array.`,
          },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`API ${response.status}: ${await response.text()}`);
    }

    const result = await response.json();
    const text = result.content?.[0]?.text ?? "";

    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return [];

    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((s) => s && typeof s.pattern === "string")
      .map((s) => ({
        pattern: s.pattern,
        context: s.context || "",
        reason: s.reason || "Rejected by developer (thumbs-down)",
      }));
  } catch (err) {
    console.warn(
      `Failed to generate suppressions from reactions: ${err.message}`,
    );
    return [];
  }
}

/**
 * Format suppressions as YAML for appending to suppressions.yml.
 */
function escapeYamlString(str) {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

export function formatSuppressionsYaml(suppressions) {
  if (suppressions.length === 0) return "";
  return suppressions
    .map((s) => {
      const lines = [`- pattern: "${escapeYamlString(s.pattern)}"`];
      if (s.context)
        lines.push(`  context: "${escapeYamlString(s.context)}"`);
      if (s.reason)
        lines.push(`  reason: "${escapeYamlString(s.reason)}"`);
      return lines.join("\n");
    })
    .join("\n");
}
