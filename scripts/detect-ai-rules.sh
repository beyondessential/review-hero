#!/usr/bin/env sh
# detect-ai-rules.sh — Detect AI coding rules files in the current repository
#
# Claude CLI natively reads CLAUDE.md, so we skip it. This script finds rules
# from other AI tools and concatenates them into a single file that can be
# injected into agent prompts.
#
# Usage:
#   scripts/detect-ai-rules.sh <output-path> [source-dir]
#
# Arguments:
#   output-path  — Where to write the concatenated rules
#   source-dir   — Directory to scan for rules files (default: current directory).
#                  Use this to scan a base-branch checkout instead of the PR
#                  branch, preventing prompt injection via AI rules files added
#                  or modified in a PR.
#
# Writes concatenated rules to <output-path>; the output file may be empty if
# no rules are found.
#
# Detected formats:
#   .cursorrules                    — Cursor (single file)
#   .cursor/rules/*.md, *.mdc      — Cursor rules directory
#   .github/copilot-instructions.md — GitHub Copilot
#   .windsurfrules                  — Windsurf / Codeium
#   .clinerules                     — Cline
#   .rules                          — Zed AI (single file)
#   .rules/*.md                     — Zed AI (rules directory)

set -eu

OUTPUT="${1:?Usage: detect-ai-rules.sh <output-path> [source-dir]}"
SOURCE_DIR="${2:-.}"
: > "$OUTPUT"

found=""

append_file() {
  file="$1"
  label="$2"
  if [ -s "$file" ]; then
    printf '## Rules from %s\n\n' "$label" >> "$OUTPUT"
    cat "$file" >> "$OUTPUT"
    printf '\n\n' >> "$OUTPUT"
    echo "  found: $file ($label)"
    found="yes"
  fi
}

# ── Single-file rules ────────────────────────────────────────────────────────

append_file "$SOURCE_DIR/.cursorrules"                     ".cursorrules (Cursor)"
append_file "$SOURCE_DIR/.windsurfrules"                   ".windsurfrules (Windsurf)"
append_file "$SOURCE_DIR/.clinerules"                      ".clinerules (Cline)"
append_file "$SOURCE_DIR/.github/copilot-instructions.md"  ".github/copilot-instructions.md (GitHub Copilot)"
append_file "$SOURCE_DIR/.rules"                           ".rules (Zed)"

# ── Directory-based rules ────────────────────────────────────────────────────

# Cursor rules directory
if [ -d "$SOURCE_DIR/.cursor/rules" ]; then
  for f in "$SOURCE_DIR"/.cursor/rules/*.md "$SOURCE_DIR"/.cursor/rules/*.mdc; do
    if [ -f "$f" ]; then append_file "$f" "$(echo "$f" | sed "s|^$SOURCE_DIR/||") (Cursor)"; fi
  done
fi

# Zed rules directory
if [ -d "$SOURCE_DIR/.rules" ]; then
  for f in "$SOURCE_DIR"/.rules/*.md; do
    if [ -f "$f" ]; then append_file "$f" "$(echo "$f" | sed "s|^$SOURCE_DIR/||") (Zed)"; fi
  done
fi

# ── Summary ──────────────────────────────────────────────────────────────────

if [ -n "$found" ]; then
  echo "AI rules detected and written to $OUTPUT"
else
  echo "No non-CLAUDE.md AI rules files found"
fi
