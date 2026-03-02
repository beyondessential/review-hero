#!/usr/bin/env sh
# run-in-sandbox.sh — Run Claude CLI inside the Docker sandbox container.
#
# This script is the single entry point for all sandboxed Claude invocations
# (review agents, review-fix, and CI-fix). It handles:
#
#   - Mounting the repo worktree (read-only for review, read-write for fix)
#   - Passing the API key via a mounted file (not env var or CLI flag)
#   - Setting minimal environment variables (no GITHUB_TOKEN, no app secrets)
#   - Enforcing --cap-drop=ALL, --security-opt=no-new-privileges, non-root user
#   - For CI-fix: mounting host tool directories so Claude can run build/test
#
# Usage:
#   run-in-sandbox.sh --mode <mode> --prompt <path> --model <model> \
#     --max-turns <n> --tools <tool-spec> [--commit-helper <path>] \
#     [--image <image>] [--repo-root <path>]
#
# Modes:
#   review-agent  — Read-only repo, scoped Bash (git commands only)
#   review-fix    — Read-write repo, scoped Bash (commit helper only)
#   ci-fix        — Read-write repo, full Bash (build tools available)
#
# The API key is read from the ANTHROPIC_API_KEY environment variable on the
# host and mounted into the container as a file at /run/secrets/api-key.
# It is never passed as a CLI argument (visible in /proc/*/cmdline) or as
# a Docker environment variable (visible in docker inspect).
#
# Exit code: passes through the Claude CLI exit code.

set -eu

# ── Parse arguments ──────────────────────────────────────────────────────────

MODE=""
PROMPT_PATH=""
MODEL=""
MAX_TURNS=""
TOOLS=""
COMMIT_HELPER=""
IMAGE="claude-sandbox:latest"
REPO_ROOT=""

usage() {
  echo "Usage: run-in-sandbox.sh --mode <mode> --prompt <path> --model <model> --max-turns <n> --tools <tool-spec> [options]" >&2
  echo "Modes: review-agent, review-fix, ci-fix" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --mode)          MODE="$2";          shift 2 ;;
    --prompt)        PROMPT_PATH="$2";   shift 2 ;;
    --model)         MODEL="$2";         shift 2 ;;
    --max-turns)     MAX_TURNS="$2";     shift 2 ;;
    --tools)         TOOLS="$2";         shift 2 ;;
    --commit-helper) COMMIT_HELPER="$2"; shift 2 ;;
    --image)         IMAGE="$2";         shift 2 ;;
    --repo-root)     REPO_ROOT="$2";     shift 2 ;;
    *)               echo "Unknown argument: $1" >&2; usage ;;
  esac
done

# Validate required arguments
if [ -z "$MODE" ] || [ -z "$PROMPT_PATH" ] || [ -z "$MODEL" ] || [ -z "$MAX_TURNS" ] || [ -z "$TOOLS" ]; then
  echo "Error: missing required arguments" >&2
  usage
fi

case "$MODE" in
  review-agent|review-fix|ci-fix) ;;
  *) echo "Error: unknown mode '$MODE'" >&2; usage ;;
esac

if [ -z "$REPO_ROOT" ]; then
  REPO_ROOT="$(git rev-parse --show-toplevel)"
fi

# ── Validate inputs ─────────────────────────────────────────────────────────

if [ ! -f "$PROMPT_PATH" ]; then
  echo "Error: prompt file not found: $PROMPT_PATH" >&2
  exit 1
fi

if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "Error: ANTHROPIC_API_KEY is not set" >&2
  exit 1
fi

# ── Write API key to a temp file ────────────────────────────────────────────
# Mounted into the container as /run/secrets/api-key. Using a file avoids
# exposing the key in `docker inspect` (env vars) or /proc/*/cmdline (flags).

API_KEY_FILE="$(mktemp)"
# Ensure cleanup on exit, even on error or signal
trap 'rm -f "$API_KEY_FILE"' EXIT INT TERM
printf '%s' "$ANTHROPIC_API_KEY" > "$API_KEY_FILE"
chmod 600 "$API_KEY_FILE"

# ── Build Docker arguments ──────────────────────────────────────────────────

DOCKER_ARGS="--rm"
DOCKER_ARGS="$DOCKER_ARGS --user 65532:65532"
DOCKER_ARGS="$DOCKER_ARGS --cap-drop=ALL"
DOCKER_ARGS="$DOCKER_ARGS --security-opt=no-new-privileges"

# Mount the API key file as a read-only secret
DOCKER_ARGS="$DOCKER_ARGS -v $API_KEY_FILE:/run/secrets/api-key:ro"

# Mount the prompt file
DOCKER_ARGS="$DOCKER_ARGS -v $PROMPT_PATH:/tmp/prompt.md:ro"

# Minimal environment: only what Claude CLI needs to function.
# Notably absent: GITHUB_TOKEN, REVIEW_HERO_APP_ID, REVIEW_HERO_PRIVATE_KEY,
# and any other workflow secrets.
DOCKER_ARGS="$DOCKER_ARGS -e HOME=/home/claude"
DOCKER_ARGS="$DOCKER_ARGS -e ANTHROPIC_API_KEY_FILE=/run/secrets/api-key"

# ── Mode-specific mounts ───────────────────────────────────────────────────

case "$MODE" in
  review-agent)
    # Read-only repo — agents explore code but don't modify it
    DOCKER_ARGS="$DOCKER_ARGS -v $REPO_ROOT:/workspace:ro"
    ;;

  review-fix)
    # Read-write repo — Claude edits files and commits via the helper
    DOCKER_ARGS="$DOCKER_ARGS -v $REPO_ROOT:/workspace:rw"

    if [ -z "$COMMIT_HELPER" ]; then
      echo "Error: --commit-helper is required for review-fix mode" >&2
      exit 1
    fi
    if [ ! -f "$COMMIT_HELPER" ]; then
      echo "Error: commit helper not found: $COMMIT_HELPER" >&2
      exit 1
    fi
    # Mount the commit helper read-only so Claude can't modify it via Edit
    DOCKER_ARGS="$DOCKER_ARGS -v $COMMIT_HELPER:/tools/git-commit-fix.mjs:ro"
    ;;

  ci-fix)
    # Read-write repo — Claude edits files and runs build/test commands
    DOCKER_ARGS="$DOCKER_ARGS -v $REPO_ROOT:/workspace:rw"

    # Mount host tool directories read-only so Claude can run build tools
    # (Node.js, npm, etc.) that were installed by prior workflow steps.
    # These are standard locations on GitHub-hosted runners.
    for dir in /usr/local /opt/hostedtoolcache; do
      if [ -d "$dir" ]; then
        DOCKER_ARGS="$DOCKER_ARGS -v $dir:$dir:ro"
      fi
    done

    # Mount the user-local tool directories (pip, cargo, etc.)
    RUNNER_HOME="${RUNNER_HOME:-${HOME:-/home/runner}}"
    if [ -d "$RUNNER_HOME/.local" ]; then
      DOCKER_ARGS="$DOCKER_ARGS -v $RUNNER_HOME/.local:$RUNNER_HOME/.local:ro"
    fi
    if [ -d "$RUNNER_HOME/.cargo" ]; then
      DOCKER_ARGS="$DOCKER_ARGS -v $RUNNER_HOME/.cargo:$RUNNER_HOME/.cargo:ro"
    fi
    if [ -d "$RUNNER_HOME/.nvm" ]; then
      DOCKER_ARGS="$DOCKER_ARGS -v $RUNNER_HOME/.nvm:$RUNNER_HOME/.nvm:ro"
    fi

    if [ -n "$COMMIT_HELPER" ] && [ -f "$COMMIT_HELPER" ]; then
      DOCKER_ARGS="$DOCKER_ARGS -v $COMMIT_HELPER:/tools/git-commit-fix.mjs:ro"
    fi
    ;;
esac

# ── Run Claude inside the container ─────────────────────────────────────────
# The entrypoint reads the API key from the mounted file, then pipes the
# prompt into Claude CLI. Output (JSON) goes to stdout.

# shellcheck disable=SC2086
exec docker run $DOCKER_ARGS \
  -w /workspace \
  "$IMAGE" \
  sh -c '
    # The mounted worktree is owned by the host runner user (UID 1001),
    # not the container claude user (UID 65532). Tell git this is safe.
    git config --global --add safe.directory /workspace

    # Read the API key from the mounted secret file
    export ANTHROPIC_API_KEY="$(cat /run/secrets/api-key)"

    cat /tmp/prompt.md | claude -p \
      --output-format json \
      --model "'"$MODEL"'" \
      --max-turns '"$MAX_TURNS"' \
      --allowedTools "'"$TOOLS"'"
  '
