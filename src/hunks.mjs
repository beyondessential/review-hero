/**
 * Review Hero — Diff hunks
 *
 * Where each hunk of a unified diff sits on the new side of the file, so an
 * inline review comment can span a finding's lines. GitHub refuses a
 * multi-line comment whose lines lie in different hunks, and one refused
 * comment fails the whole review post.
 */

const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** The path a `+++` line names, or null for a deleted file. */
function newPath(line) {
  let path = line.slice(4).split("\t")[0].trim();
  if (path === "/dev/null") return null;
  if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
  return path.replace(/^b\//, "");
}

/**
 * Read a unified diff into `Map<path, Array<{ start, end }>>`: the first and
 * last new-side line of each hunk, inclusive, in the order the hunks appear.
 */
export function parseHunks(diff) {
  const hunks = new Map();
  let path = null;
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of String(diff ?? "").split("\n")) {
    // Inside a hunk the counts say which lines belong to it, so a removed
    // line that reads `-- x` or an added one that reads `++ x` is never taken
    // for a file header.
    if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith("\\")) continue;
      if (line.startsWith("-")) oldLeft--;
      else if (line.startsWith("+")) newLeft--;
      else {
        oldLeft--;
        newLeft--;
      }
      continue;
    }
    if (line.startsWith("+++ ")) {
      path = newPath(line);
      continue;
    }
    const header = path === null ? null : line.match(HUNK_HEADER);
    if (!header) continue;
    const start = Number(header[2]);
    const newCount = header[3] === undefined ? 1 : Number(header[3]);
    oldLeft = header[1] === undefined ? 1 : Number(header[1]);
    newLeft = newCount;
    if (newCount === 0) continue;
    if (!hunks.has(path)) hunks.set(path, []);
    hunks.get(path).push({ start, end: start + newCount - 1 });
  }
  return hunks;
}

/**
 * Where an inline comment for `finding` goes: the finding's lines when it has
 * an end line and both ends lie in one hunk of its file, and its start line
 * alone otherwise. `{ line, startLine }` follows GitHub's names, `line` being
 * the last line of the comment and `startLine` present only for a span.
 */
// spec: RUN#findings
export function commentLines(finding, hunks) {
  const { line, endLine } = finding;
  if (Number.isInteger(endLine) && endLine > line) {
    const same = (hunks?.get(finding.file) ?? []).some((h) => line >= h.start && endLine <= h.end);
    if (same) return { line: endLine, startLine: line };
  }
  return { line };
}
