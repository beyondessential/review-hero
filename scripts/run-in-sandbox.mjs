#!/usr/bin/env node
/**
 * run-in-sandbox.mjs — Run Claude CLI inside the Docker sandbox container.
 *
 * This script is the single entry point for all sandboxed Claude invocations
 * (review agents, review-fix, and CI-fix). It handles:
 *
 *   - Mounting the repo worktree (read-only for review, read-write for fix)
 *   - Passing the API key via a mounted file (not env var or CLI flag)
 *   - Setting minimal environment variables (no GITHUB_TOKEN, no app secrets)
 *   - Enforcing --cap-drop=ALL, --security-opt=no-new-privileges, non-root user
 *   - For CI-fix: mounting host tool directories so Claude can run build/test
 *
 * Usage:
 *   node run-in-sandbox.mjs /path/to/config.json
 *
 * The config JSON must contain:
 *   {
 *     "mode":          "review-agent" | "review-fix" | "ci-fix",
 *     "prompt":        "/absolute/path/to/prompt.md",
 *     "model":         "claude-sonnet-4-6",
 *     "maxTurns":      10,
 *     "tools":         ["Read", "Glob", "Grep", "Bash(git log:*)", "Bash(git show:*)", "Bash(git diff:*)"],
 *     "image":         "claude-sandbox:latest",       // optional, default shown
 *     "repoRoot":      "/path/to/repo",               // optional, detected via git
 *     "commitHelper":  "/tmp/git-commit-fix-123.mjs"  // required for review-fix
 *   }
 *
 * Modes:
 *   review-agent  — Read-only repo, scoped Bash (git commands only)
 *   review-fix    — Read-write repo, scoped Bash (commit helper only)
 *   ci-fix        — Read-write repo, full Bash (build tools available)
 *
 * The API key is read from the ANTHROPIC_API_KEY environment variable on the
 * host and written to a temp file that is mounted into the container at
 * /run/secrets/api-key (read-only). It is never passed as a CLI argument
 * (which would be visible in /proc/.../cmdline) or as a Docker environment
 * variable (which would be visible in docker inspect). The temp file is
 * deleted in a try/finally block after docker exits.
 *
 * Exit code: passes through the Claude CLI / docker exit code.
 */

import {
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
  statSync,
  mkdtempSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Read and parse config ────────────────────────────────────────────────────

const VALID_MODES = ["review-agent", "review-fix", "ci-fix"];

const configPath = process.argv[2];
if (!configPath) {
  console.error("Usage: node run-in-sandbox.mjs /path/to/config.json");
  process.exit(1);
}

if (!existsSync(configPath)) {
  console.error(`Error: config file not found: ${configPath}`);
  process.exit(1);
}

const config = JSON.parse(readFileSync(configPath, "utf-8"));

const MODE = config.mode ?? "";
const PROMPT_PATH = config.prompt ?? "";
const MODEL = config.model ?? "";
const MAX_TURNS = String(config.maxTurns ?? "");
const TOOLS =
  config.tools?.length > 0
    ? config.tools
    : [
        "Read",
        "Glob",
        "Grep",
        "Bash(git log:*)",
        "Bash(git show:*)",
        "Bash(git diff:*)",
      ];
const COMMIT_HELPER = config.commitHelper ?? "";
const IMAGE = config.image ?? "claude-sandbox:latest";
let REPO_ROOT = config.repoRoot ?? "";

// ── Validate required fields ─────────────────────────────────────────────────

if (!MODE || !PROMPT_PATH || !MODEL || !MAX_TURNS) {
  throw new Error(
    "config must include mode, prompt, model, maxTurns, and tools",
  );
}

if (!VALID_MODES.includes(MODE)) {
  throw new Error(
    `unknown mode '${MODE}' — expected one of: ${VALID_MODES.join(", ")}`,
  );
}

// Validate model — alphanumeric, dots, dashes only.
if (!/^[a-z0-9.-]+$/.test(MODEL)) {
  throw new Error(`invalid model name '${MODEL}' — must match /^[a-z0-9.-]+$/`);
}

// Validate maxTurns — must be a positive integer
if (!/^[1-9]\d*$/.test(MAX_TURNS)) {
  throw new Error(
    `invalid maxTurns '${config.maxTurns}' — must be a positive integer`,
  );
}

// ── Resolve repo root ────────────────────────────────────────────────────────

if (!REPO_ROOT) {
  REPO_ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf-8",
  }).trim();
}

// ── Validate inputs ──────────────────────────────────────────────────────────

if (!existsSync(PROMPT_PATH)) {
  throw new Error(`prompt file not found: ${PROMPT_PATH}`);
}

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  throw new Error("ANTHROPIC_API_KEY is not set");
}

// ── Write API key to a temp file ─────────────────────────────────────────────
// Mounted into the container as /run/secrets/api-key. Using a file avoids
// exposing the key in `docker inspect` (env vars) or /proc/*/cmdline (flags).
// The try/finally block guarantees cleanup.

const tmpDir = mkdtempSync(join(tmpdir(), "claude-sandbox-"));
const apiKeyFile = join(tmpDir, "api-key");

// ── Inner container script ───────────────────────────────────────────────────
// This is a static string with no host-side variable interpolation. All
// dynamic values ($CLAUDE_MODEL, $CLAUDE_MAX_TURNS, $CLAUDE_TOOLS) come from
// the container's environment, set safely via Docker's -e flag.

const claudeSettings = {
  apiKeyHelper: "cat /run/secrets/api-key",
  model: MODEL,
  permissions: {
    allow: TOOLS,
    deny: ["Read(/run/secrets/api-key)"],
  },
  sandbox: {
    enabled: true,
    filesystem: {
      denyRead: ["//run/secrets"],
    },
  },
};
const INNER_SCRIPT = [
  "set -e",
  "# The mounted worktree is owned by the host runner user (UID 1001),",
  "# not the container claude user (UID 65532). Tell git this is safe.",
  "git config --global --add safe.directory /workspace",
  "",
  "cat /tmp/prompt.md | claude -p \\",
  '  --settings "$CLAUDE_SETTINGS" \\',
  "  --output-format json \\",
  '  --max-turns "$CLAUDE_MAX_TURNS"',
].join("\n");

try {
  writeFileSync(apiKeyFile, ANTHROPIC_API_KEY, { mode: 0o600 });

  // ── Build Docker arguments ───────────────────────────────────────────────

  const dockerArgs = [
    "run",
    "--rm",
    "--user",
    "65532:65532",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",

    // Mount the API key file as a read-only secret
    "-v",
    `${apiKeyFile}:/run/secrets/api-key:ro`,

    // Mount the prompt file
    "-v",
    `${PROMPT_PATH}:/tmp/prompt.md:ro`,

    // Minimal environment: only what Claude CLI needs to function.
    "-e",
    "HOME=/home/claude",
    "-e",
    "ANTHROPIC_API_KEY_FILE=/run/secrets/api-key",
    "-e",
    `CLAUDE_MAX_TURNS=${MAX_TURNS}`,
    "-e",
    `CLAUDE_SETTINGS=${JSON.stringify(claudeSettings)}`,
  ];

  // ── Mode-specific mounts ─────────────────────────────────────────────────

  switch (MODE) {
    case "review-agent":
      // Read-only repo — agents explore code but don't modify it
      dockerArgs.push("-v", `${REPO_ROOT}:/workspace:ro`);
      break;

    case "review-fix":
      // Read-write repo — Claude edits files and commits via the helper
      dockerArgs.push("-v", `${REPO_ROOT}:/workspace:rw`);

      if (!COMMIT_HELPER) {
        throw new Error(
          "commitHelper is required in config for review-fix mode",
        );
      }
      if (!existsSync(COMMIT_HELPER)) {
        throw new Error(`commit helper not found: ${COMMIT_HELPER}`);
      }
      // Mount the commit helper read-only so Claude can't modify it via Edit
      dockerArgs.push("-v", `${COMMIT_HELPER}:/tools/git-commit-fix.mjs:ro`);
      break;

    case "ci-fix":
      // Read-write repo — Claude edits files and runs build/test commands
      dockerArgs.push("-v", `${REPO_ROOT}:/workspace:rw`);

      // Mount host tool directories read-only so Claude can run build tools
      // (Node.js, npm, etc.) that were installed by prior workflow steps.
      // These are standard locations on GitHub-hosted runners.
      for (const dir of ["/usr/local", "/opt/hostedtoolcache"]) {
        if (existsSync(dir) && statSync(dir).isDirectory()) {
          dockerArgs.push("-v", `${dir}:${dir}:ro`);
        }
      }

      // Mount the user-local tool directories (pip, cargo, etc.)
      const runnerHome =
        process.env.RUNNER_HOME || process.env.HOME || "/home/runner";
      for (const sub of [".local", ".cargo", ".nvm"]) {
        const full = join(runnerHome, sub);
        if (existsSync(full) && statSync(full).isDirectory()) {
          dockerArgs.push("-v", `${full}:${full}:ro`);
        }
      }

      if (COMMIT_HELPER && existsSync(COMMIT_HELPER)) {
        dockerArgs.push("-v", `${COMMIT_HELPER}:/tools/git-commit-fix.mjs:ro`);
      }
      break;
  }

  // ── Run Claude inside the container ──────────────────────────────────────
  // The inner sh -c reads the API key from the mounted secret file, then
  // pipes the prompt into Claude CLI. MODEL, MAX_TURNS, and TOOLS are read
  // from environment variables set via -e flags — they are never interpolated
  // into the sh -c string at the host level. Output (JSON) goes to stdout.

  dockerArgs.push("-w", "/workspace", IMAGE, "sh", "-c", INNER_SCRIPT);

  const result = execFileSync("docker", dockerArgs, {
    encoding: "utf-8",
    // Inherit stderr so Claude's progress/logging is visible in workflow logs.
    // Stdout is captured and returned (contains the JSON result).
    stdio: ["pipe", "pipe", "inherit"],
  });

  process.stdout.write(result);
} finally {
  // Clean up the API key file — always runs because we're in a finally block.
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup — don't fail the run if removal fails
  }
}
