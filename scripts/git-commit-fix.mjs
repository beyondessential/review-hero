#!/usr/bin/env node
/**
 * git-commit-fix.mjs — Stage specific files and commit with a message.
 *
 * Usage: git-commit-fix.mjs -m "commit message" <file1> [file2 ...]
 *
 * This script is the only entry point exposed to Claude during review-only
 * auto-fix, keeping shell access scoped to just git commits. All git calls
 * use execFileSync (array args) to avoid shell injection from commit messages
 * or file paths.
 */

const { execFileSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const path = require("node:path");
const { parseArgs } = require("node:util");

// ── Parse arguments ───────────────────────────────────────────────────────────

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    m: { type: "string" },
  },
  allowPositionals: true,
});

const message = values.m;

if (!message) {
  console.error("Error: commit message is required (-m)");
  console.error("Usage: git-commit-fix.mjs -m <message> <file1> [file2 ...]");
  process.exit(1);
}

if (positionals.length === 0) {
  console.error("Error: at least one file path is required");
  console.error("Usage: git-commit-fix.mjs -m <message> <file1> [file2 ...]");
  process.exit(1);
}

// ── Validate and stage files ──────────────────────────────────────────────────

const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf-8",
}).trim();

// Resolve the protected directory to an absolute path to resist ./, ../, and
// absolute-path bypasses (e.g. `./.review-hero/...` or `/abs/path/.review-hero/...`).
const reviewHeroAbs = path.resolve(repoRoot, ".review-hero");

for (const file of positionals) {
  // Resolve relative to the repo root, not process.cwd(), so that paths are
  // always anchored correctly even if the script is invoked from a subdirectory.
  const absFile = path.resolve(repoRoot, file);

  // Reject paths that resolve outside the repository root
  if (absFile !== repoRoot && !absFile.startsWith(repoRoot + path.sep)) {
    console.error("Error: refusing to stage file outside repository: " + file);
    process.exit(1);
  }

  if (
    absFile === reviewHeroAbs ||
    absFile.startsWith(reviewHeroAbs + path.sep)
  ) {
    console.error(
      "Error: refusing to stage file inside .review-hero/: " + file,
    );
    process.exit(1);
  }

  const existsOnDisk = existsSync(file);
  if (!existsOnDisk) {
    // Check whether git tracks this path — if so it's a deletion, allow staging
    try {
      execFileSync("git", ["ls-files", "--error-unmatch", "--", file], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      // File is tracked but deleted — fall through to stage the removal
    } catch {
      // File is neither on disk nor tracked by git — skip
      console.warn("Warning: skipping non-existent untracked file: " + file);
      continue;
    }
  }

  execFileSync("git", ["add", "--", file]);
}

// ── Commit (only if something was staged) ─────────────────────────────────────

try {
  execFileSync("git", ["diff", "--cached", "--quiet"]);
  // Exit 0 means nothing is staged
  console.log("Nothing staged — skipping commit");
  process.exit(0);
} catch (err) {
  // Exit code 1 means there are staged changes — proceed with commit.
  // Any other non-zero exit (e.g. 128 for git errors) is a real failure.
  if (err.status !== 1) {
    console.error(
      "Error: git diff --cached --quiet failed with exit code " + err.status,
    );
    process.exit(err.status ?? 1);
  }
}

// Message is a separate array element — no shell parsing, no injection risk
execFileSync("git", ["commit", "-m", message], { stdio: "inherit" });
