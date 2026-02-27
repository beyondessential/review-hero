#!/usr/bin/env sh
# detect-ai-rules.sh — Detect AI coding rules files in the current repository
#
# Claude CLI natively reads CLAUDE.md, so we skip it. This script finds rules
# from other AI tools and concatenates them into a single file that can be
# injected into agent prompts.
#
# Usage:
#   scripts/detect-ai-rules.sh <output-path>
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

OUTPUT="${1:?Usage: detect-ai-rules.sh <output-path>}"
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

append_file ".cursorrules"                     ".cursorrules (Cursor)"
append_file ".windsurfrules"                   ".windsurfrules (Windsurf)"
append_file ".clinerules"                      ".clinerules (Cline)"
append_file ".github/copilot-instructions.md"  ".github/copilot-instructions.md (GitHub Copilot)"
append_file ".rules"                           ".rules (Zed)"

# ── Directory-based rules ────────────────────────────────────────────────────

# Cursor rules directory
if [ -d ".cursor/rules" ]; then
  for f in .cursor/rules/*.md .cursor/rules/*.mdc; do
    if [ -f "$f" ]; then append_file "$f" "$f (Cursor)"; fi
  done
fi

# Zed rules directory
if [ -d ".rules" ]; then
  for f in .rules/*.md; do
    if [ -f "$f" ]; then append_file "$f" "$f (Zed)"; fi
  done
fi

# ── Summary ──────────────────────────────────────────────────────────────────

if [ -n "$found" ]; then
  echo "AI rules detected and written to $OUTPUT"
else
  echo "No non-CLAUDE.md AI rules files found"
fi
