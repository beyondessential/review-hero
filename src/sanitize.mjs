/**
 * Review Hero — Prompt-safe rendering of finding fields
 *
 * Finding text is untrusted. A review agent quotes the code it read, so a PR
 * author can plant a string in a source file and have it carried into a
 * finding's comment. Interpolated raw into a filtering prompt, a newline in
 * that text breaks out of the line it was meant to occupy and can forge new
 * instructions, and a literal <comment> tag closes the delimiter the prompt
 * wraps it in.
 *
 * Every stage that interpolates a finding into a prompt renders it through
 * here, so consensus, cross-agent grouping, and suppression cannot drift apart
 * on what counts as safe.
 */

/** Characters of a finding's comment included in a filtering prompt. */
export const COMMENT_LIMIT = 300;

/**
 * Render an untrusted value for interpolation into a prompt: collapse newline
 * runs to a space and drop <comment> delimiters. Truncates to `maxLength`
 * first when given, so the limit applies to the author's text rather than to
 * whatever the escaping expanded it to.
 */
export function sanitizeForPrompt(value, { maxLength } = {}) {
  let text = String(value ?? "");
  if (maxLength !== undefined) text = text.slice(0, maxLength);
  return text.replace(/[\r\n]+/g, " ").replace(/<\/?comment>/gi, "");
}
