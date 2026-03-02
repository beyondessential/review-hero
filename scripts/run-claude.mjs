#!/usr/bin/env node
/**
 * run-claude.mjs — Run Claude CLI with native sandboxing.
 *
 * This script is the single entry point for all Claude invocations
 * (review agents, review-fix, and CI-fix). It handles:
 *
 *   - Configuring Claude's native sandbox (bubblewrap on Linux, Seatbelt
 *     on macOS) for filesystem and network isolation
 *   - Managing the API key via apiKeyHelper — the key is written to a temp
 *     file and never forwarded as an env var to the Claude process
 *   - Setting tool permissions and filesystem restrictions per mode
 *   - Stripping git credentials from .git/config so sandboxed commands
 *     cannot extract the GitHub token embedded by actions/checkout
 *   - Disabling the sandbox when the caller opts out via sandboxDisabled
 *
 * Usage:
 *   node run-claude.mjs /path/to/config.json
 *
 * The config JSON must contain:
 *   {
 *     "mode":            "review-agent" | "review-fix" | "ci-fix",
 *     "prompt":          "/absolute/path/to/prompt.md",
 *     "model":           "claude-sonnet-4-6",
 *     "maxTurns":        10,
 *     "tools":           ["Read", "Glob", "Grep", ...],
 *     "sandboxDisabled": false,                        // optional, default false
 *     "repoRoot":        "/path/to/repo",              // optional, detected via git
 *     "commitHelper":    "/tmp/git-commit-fix-123.mjs" // required for review-fix
 *   }
 *
 * Modes:
 *   review-agent  — Read-only review; scoped Bash (git read commands only).
 *                   No extra write permissions are granted. The tool
 *                   permissions (Read, Glob, Grep, scoped git commands) are
 *                   the primary access control; the sandbox provides
 *                   defence-in-depth.
 *
 *   review-fix    — Read-write repo; scoped Bash (commit helper only).
 *                   Claude edits files and commits via the git-commit-fix
 *                   helper. The CWD (repo root) is writable by default in
 *                   the sandbox. /tmp is granted write access for scratch
 *                   files.
 *
 *   ci-fix        — Read-write repo; full Bash (build tools available).
 *                   Same as review-fix but with unrestricted Bash so Claude
 *                   can run build commands, linters, and test suites.
 *
 * API key handling:
 *   The API key is read from the ANTHROPIC_API_KEY environment variable on
 *   the host, written to a temp file (mode 0o600), and exposed to Claude CLI
 *   via the apiKeyHelper setting ("cat /path/to/key"). The ANTHROPIC_API_KEY
 *   env var is deliberately NOT forwarded to the Claude process so that
 *   sandboxed Bash commands cannot access it via the environment. The temp
 *   file is protected from Claude's own tools:
 *     - permissions.deny blocks the Read tool from accessing it
 *     - sandbox.filesystem.denyRead blocks sandboxed Bash from reading it
 *   The temp file is deleted in a try/finally block after Claude exits.
 *
 * Git credential handling:
 *   actions/checkout stores the GitHub token in .git/config as an HTTP
 *   extraheader. In the auto-fix workflow this is the GitHub App token with
 *   push access — a high-value target for prompt injection. Before running
 *   Claude, this script strips all extraheader credentials from .git/config
 *   and restores them in the finally block so that the calling script (e.g.
 *   auto-fix.mjs) can still push afterwards. This is complementary to the
 *   sandbox network isolation which blocks github.com from sandboxed Bash.
 *
 * Exit code: passes through the Claude CLI exit code.
 */

import {
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
  mkdtempSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Read and parse config ────────────────────────────────────────────────────

const VALID_MODES = ["review-agent", "review-fix", "ci-fix"];

const configPath = process.argv[2];
if (!configPath) {
  console.error("Usage: node run-claude.mjs /path/to/config.json");
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
const SANDBOX_DISABLED = config.sandboxDisabled === true;
let REPO_ROOT = config.repoRoot ?? "";

// ── Validate required fields ─────────────────────────────────────────────────

if (!MODE || !PROMPT_PATH || !MODEL || !MAX_TURNS) {
  throw new Error("config must include mode, prompt, model, and maxTurns");
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

if (MODE === "review-fix" && !COMMIT_HELPER) {
  throw new Error("commitHelper is required in config for review-fix mode");
}

if (COMMIT_HELPER && !existsSync(COMMIT_HELPER)) {
  throw new Error(`commit helper not found: ${COMMIT_HELPER}`);
}

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  throw new Error("ANTHROPIC_API_KEY is not set");
}

// ── Git credential helpers ───────────────────────────────────────────────────
// actions/checkout stores the GitHub token in .git/config as:
//   [http "https://github.com/"]
//       extraheader = AUTHORIZATION: basic <base64(x-access-token:TOKEN)>
//
// In the auto-fix workflow this is the GitHub App token with push access.
// We strip it before running Claude and restore it in the finally block so
// that (a) Claude cannot extract it from .git/config and (b) the calling
// script can still push afterwards.

/**
 * Read and remove all http.*.extraheader entries from the repo's local git
 * config. Returns an array of {key, value} pairs for later restoration.
 */
function stripGitCredentials() {
  // Enumerate every http.<url>.extraheader entry in local config. Each line
  // from --get-regexp is formatted as "http.<url>.extraheader <value>".
  let raw;
  try {
    raw = execFileSync(
      "git",
      ["config", "--local", "--get-regexp", "^http\\..*\\.extraheader$"],
      { encoding: "utf-8", cwd: REPO_ROOT, stdio: ["pipe", "pipe", "pipe"] },
    );
  } catch {
    // Exit code 1 means no matches — nothing to strip.
    return [];
  }

  const entries = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    // Format: "key value" — split on the first space.
    const spaceIdx = line.indexOf(" ");
    if (spaceIdx === -1) continue;
    entries.push({
      key: line.slice(0, spaceIdx),
      value: line.slice(spaceIdx + 1),
    });
  }

  // Remove all matched entries.
  for (const { key } of entries) {
    try {
      execFileSync("git", ["config", "--local", "--unset-all", key], {
        cwd: REPO_ROOT,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      // Best-effort — may already be gone if two entries share a key.
    }
  }

  if (entries.length > 0) {
    console.error(
      `Stripped ${entries.length} git credential(s) from .git/config`,
    );
  }

  return entries;
}

/**
 * Restore previously stripped git credentials.
 */
function restoreGitCredentials(entries) {
  for (const { key, value } of entries) {
    try {
      execFileSync("git", ["config", "--local", "--add", key, value], {
        cwd: REPO_ROOT,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      // Best-effort — don't fail the run if restoration fails.
    }
  }
}

// ── Write API key to a temp file ─────────────────────────────────────────────
// Exposed to Claude CLI via apiKeyHelper ("cat <path>"). The env var is NOT
// forwarded to the Claude process, so sandboxed Bash commands cannot access
// the key via the environment. The temp directory is denied from both
// Claude's Read tool and the sandbox filesystem, so even a prompt-injected
// agent cannot exfiltrate the key. The try/finally block guarantees cleanup.

const tmpDir = mkdtempSync(join(tmpdir(), "claude-run-"));
const apiKeyFile = join(tmpDir, "api-key");
const settingsFile = join(tmpDir, "settings.json");

// Strip git credentials before entering the try block so they are always
// restored in the finally block, even if writing the API key file fails.
const strippedGitCreds = stripGitCredentials();

try {
  writeFileSync(apiKeyFile, ANTHROPIC_API_KEY, { mode: 0o600 });

  // ── Build sandbox filesystem restrictions ──────────────────────────────
  // By default the sandbox allows reads everywhere and writes only to CWD
  // (the repo root). We add mode-specific write paths, deny reads to the
  // temp directory that contains the API key, and deny writes to sensitive
  // directories so sandboxed Bash cannot tamper with them.
  //
  // Protected directories:
  //   .review-hero/        — Review Hero tooling (scripts, prompts)
  //   .github/workflows/   — Workflow files are arbitrary code execution on
  //                          push; modifying them is a privilege escalation
  //   .git/hooks/          — Git hooks execute automatically during git
  //                          operations (e.g. the commit helper calls
  //                          git commit, which would trigger post-commit)

  const reviewHeroDir = join(REPO_ROOT, ".review-hero");
  const workflowsDir = join(REPO_ROOT, ".github", "workflows");
  const gitHooksDir = join(REPO_ROOT, ".git", "hooks");

  const allowWrite = [];
  const denyRead = [`//${tmpDir}`];
  const denyWrite = [
    `//${reviewHeroDir}`,
    `//${workflowsDir}`,
    `//${gitHooksDir}`,
  ];

  switch (MODE) {
    case "review-agent":
      // Read-only review — the default CWD write permission is harmless
      // because the tool permissions (Read, Glob, Grep, scoped git) don't
      // include Edit or unrestricted Bash, so no writes can actually occur.
      break;

    case "review-fix":
      // The commit helper and Claude's temp files may write to /tmp.
      allowWrite.push("//tmp");
      break;

    case "ci-fix":
      // Full build environment — /tmp for scratch files and build artefacts.
      allowWrite.push("//tmp");
      break;
  }

  // ── Build Claude settings ──────────────────────────────────────────────
  // These are passed to `claude -p --settings <json>`. The apiKeyHelper runs
  // as the Claude CLI process itself (outside the sandbox), so it can read
  // the key file even though sandboxed Bash commands cannot.

  const claudeSettings = {
    apiKeyHelper: `cat ${apiKeyFile}`,
    model: MODEL,
    permissions: {
      allow: TOOLS,
      // Deny Claude's own tools (Read, Edit) access to the API key file and
      // to directories that should never be modified during a review or fix.
      // The sandbox filesystem restrictions below are the OS-level equivalent
      // for Bash subprocesses; together they form two independent layers of
      // protection.
      deny: [
        `Read(${apiKeyFile})`,
        `Edit(${reviewHeroDir})`,
        `Edit(${workflowsDir})`,
        `Edit(${gitHooksDir})`,
      ],
    },
    sandbox: {
      enabled: !SANDBOX_DISABLED,
      // Prevent Claude from using the dangerouslyDisableSandbox escape hatch.
      // All commands must either run inside the sandbox or be explicitly
      // listed in excludedCommands (which we don't set).
      allowUnsandboxedCommands: false,
      // Filesystem restrictions are only meaningful when the sandbox is
      // enabled. When disabled, Claude has unrestricted access (the user
      // has accepted this risk via dangerousDisableSandbox in config.yml).
      ...(!SANDBOX_DISABLED
        ? {
            filesystem: {
              ...(allowWrite.length > 0 ? { allowWrite } : {}),
              denyRead,
              denyWrite,
            },
            network: {
              allowedDomains:
                MODE === "ci-fix" && !SANDBOX_DISABLED ? ["*"] : [],
            },
          }
        : {}),
    },
  };

  writeFileSync(settingsFile, JSON.stringify(claudeSettings));

  // ── Run Claude ─────────────────────────────────────────────────────────
  // The prompt is piped via stdin. Settings are passed as a JSON string to
  // --settings (using array args in execFileSync, so no shell escaping).
  // Stderr is inherited so Claude's progress/logging is visible in workflow
  // logs. Stdout is captured and returned (contains the JSON result).

  const result = execFileSync(
    "claude",
    [
      "-p",
      "--output-format",
      "json",
      "--max-turns",
      MAX_TURNS,
      "--settings",
      JSON.stringify(claudeSettings),
    ],
    {
      input: readFileSync(PROMPT_PATH, "utf-8"),
      encoding: "utf-8",
      cwd: REPO_ROOT,
      // Inherit stderr so Claude's progress/logging is visible in workflow
      // logs. Stdout is captured and returned (contains the JSON result).
      stdio: ["pipe", "pipe", "inherit"],
      env: {
        // Minimal environment — only what Claude CLI needs to function.
        // ANTHROPIC_API_KEY is deliberately excluded; Claude reads it via
        // apiKeyHelper instead. This prevents sandboxed Bash commands from
        // accessing the key through the environment.
        PATH: process.env.PATH,
        HOME: process.env.HOME,
      },
    },
  );

  process.stdout.write(result);
} finally {
  // ── Restore git credentials ──────────────────────────────────────────
  // Must happen before cleanup so the calling script (auto-fix.mjs) can
  // still push using the token that actions/checkout configured.
  restoreGitCredentials(strippedGitCreds);

  // Clean up the API key and settings files — always runs because we're in
  // a finally block. Best-effort: don't fail the run if removal fails.
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup — don't fail the run if removal fails
  }
}
