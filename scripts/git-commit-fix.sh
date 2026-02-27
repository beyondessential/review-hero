#!/bin/sh
# git-commit-fix.sh — Stage specific files and commit with a message.
#
# Usage: git-commit-fix.sh -m "commit message" <file1> [file2 ...]
#
# This script is the only Bash entrypoint exposed to Claude during
# review-only auto-fix, keeping shell access scoped to just git commits.

set -e

# ── Parse arguments ───────────────────────────────────────────────────────────

usage() {
  echo "Usage: git-commit-fix.sh -m <message> <file1> [file2 ...]" >&2
  exit 1
}

MESSAGE=""
while getopts "m:" opt; do
  case "$opt" in
    m) MESSAGE="$OPTARG" ;;
    *) usage ;;
  esac
done
shift $((OPTIND - 1))

if [ -z "$MESSAGE" ]; then
  echo "Error: commit message is required (-m)" >&2
  usage
fi

if [ $# -eq 0 ]; then
  echo "Error: at least one file path is required" >&2
  usage
fi

# ── Validate and stage files ─────────────────────────────────────────────────

for file in "$@"; do
  # Block any path that points into .review-hero
  case "$file" in
    .review-hero|.review-hero/*)
      echo "Error: refusing to stage file inside .review-hero/: $file" >&2
      exit 1
      ;;
  esac

  if [ ! -e "$file" ]; then
    echo "Warning: skipping non-existent file: $file" >&2
    continue
  fi

  git add -- "$file"
done

# ── Commit (only if something was staged) ────────────────────────────────────

if git diff --cached --quiet; then
  echo "Nothing staged — skipping commit"
  exit 0
fi

git commit -m "$MESSAGE"
