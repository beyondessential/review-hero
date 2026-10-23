/**
 * Review Hero — Scope filtering
 *
 * Decides which files are in scope for review by stripping ignored patterns
 * (lockfiles, generated files, caller-configured globs) out of a unified diff.
 * Shared so a consumer reviews the same set of files this repo does.
 */

import { basename } from "node:path";

/** Files never worth reviewing — dependency lockfiles and generated output. */
export const DEFAULT_IGNORE_PATTERNS = [
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "Cargo.lock",
  "go.sum",
  "composer.lock",
  "Gemfile.lock",
  "poetry.lock",
  "bun.lockb",
  "flake.lock",
  "*.generated.*",
];

/**
 * Rudimentary glob match — supports `*` (any within segment) and `**` (any
 * path depth). Good enough for lockfile patterns; we don't need full minimatch.
 */
export function globMatch(pattern, filePath) {
  // Direct basename match (e.g. "package-lock.json" matches "foo/package-lock.json")
  if (!pattern.includes("/") && !pattern.includes("**")) {
    const name = basename(filePath);
    return simpleWildcard(pattern, name);
  }
  // Path-based patterns with **
  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "__GLOBSTAR__")
    .replace(/\*/g, "[^/]*")
    .replace(/__GLOBSTAR__/g, ".*");
  return new RegExp(`^${regex}$`).test(filePath);
}

export function simpleWildcard(pattern, str) {
  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${regex}$`).test(str);
}

/**
 * Split a unified diff into per-file sections and filter out ignored files.
 * Returns { filtered: string, removedFiles: string[] }.
 */
export function filterDiff(rawDiff, patterns) {
  const sections = [];
  let current = null;

  for (const line of rawDiff.split("\n")) {
    const fileMatch = line.match(/^diff --git a\/.+ b\/(.+)$/);
    if (fileMatch) {
      if (current) sections.push(current);
      current = { file: fileMatch[1], lines: [line] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) sections.push(current);

  const removedFiles = [];
  const kept = [];

  for (const section of sections) {
    const dominated = patterns.some((p) => globMatch(p, section.file));
    if (dominated) {
      removedFiles.push(section.file);
    } else {
      kept.push(section.lines.join("\n"));
    }
  }

  return { filtered: kept.join("\n"), removedFiles };
}

/**
 * One line per file in a diff with its added and removed line counts, for a
 * reader shown only part of it, up to `maxFiles` lines.
 */
export function summariseDiffFiles(diff, maxFiles = 400) {
  const files = [];
  let current = null;
  for (const line of diff.split("\n")) {
    const header = /^diff --git a\/.+ b\/(.+)$/.exec(line);
    if (header) {
      current = { path: header[1], added: 0, removed: 0 };
      files.push(current);
    } else if (current && line.startsWith("+") && !line.startsWith("+++")) {
      current.added += 1;
    } else if (current && line.startsWith("-") && !line.startsWith("---")) {
      current.removed += 1;
    }
  }
  const lines = files.slice(0, maxFiles).map((f) => `${f.path} (+${f.added}/-${f.removed})`);
  if (files.length > maxFiles) lines.push(`and ${files.length - maxFiles} more files`);
  return lines.join("\n");
}
