/**
 * Review Hero — Diff hunks
 *
 * Where each hunk of a unified diff sits on the new side of the file, so an
 * inline review comment can span a finding's lines. GitHub refuses a
 * multi-line comment whose lines lie in different hunks, and one refused
 * comment fails the whole review post.
 */
import { effectiveEndLine } from "./findings.mjs";

const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

const C_ESCAPES = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };

/**
 * A path as git quotes it (any path with a non-ASCII byte, a quote, a backslash
 * or a control character): its C-style escapes decoded, octal escapes being the
 * bytes of the path's UTF-8.
 */
export function unquoteGitPath(quoted) {
  const bytes = [];
  const inner = quoted.slice(1, -1);
  const encoder = new TextEncoder();
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] !== "\\") {
      // A whole code point, so a character outside the BMP is not split
      // into halves that encode as replacement characters.
      const char = String.fromCodePoint(inner.codePointAt(i));
      bytes.push(...encoder.encode(char));
      i += char.length - 1;
      continue;
    }
    const octal = inner.slice(i + 1, i + 4);
    if (/^[0-7]{3}$/.test(octal)) {
      bytes.push(parseInt(octal, 8));
      i += 3;
    } else if (inner[i + 1] in C_ESCAPES) {
      bytes.push(C_ESCAPES[inner[i + 1]]);
      i += 1;
    } else {
      bytes.push(92);
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** The path a `+++` line names, or null for a deleted file. */
function newPath(line) {
  let path = line.slice(4).replace(/\t.*$/, "").trim();
  if (path === "/dev/null") return null;
  if (path.length > 1 && path.startsWith('"') && path.endsWith('"')) path = unquoteGitPath(path);
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
  const { line } = finding;
  const endLine = effectiveEndLine(finding);
  if (endLine !== undefined) {
    const same = (hunks?.get(finding.file) ?? []).some((h) => line >= h.start && endLine <= h.end);
    if (same) return { line: endLine, startLine: line };
  }
  return { line };
}
