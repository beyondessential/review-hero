import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  agentEnv,
  cacheReadShare,
  deadlineFrom,
  mergeWrapUp,
  spawnClaude,
  wrapUpReason,
} from "./agent-process.mjs";

function envelope(result, extra = {}) {
  return JSON.stringify({ type: "result", subtype: "success", is_error: false, result, session_id: "session", ...extra });
}

const USABLE = { code: 0, timedOut: false, stdout: envelope("[]"), stderr: "" };
const PROSE = { code: 0, timedOut: false, stdout: envelope("Looks fine to me."), stderr: "" };
const CRASH = { code: 1, timedOut: false, stdout: "", stderr: "boom" };
const CAPPED = {
  code: 1,
  timedOut: false,
  stdout: envelope(undefined, { subtype: "error_max_turns", is_error: true }),
  stderr: "",
};

// ── Classifying and reporting a run ──────────────────────────────────────────

test("the wrap-up only follows a capped run or an answer with no array", () => {
  assert.equal(wrapUpReason(USABLE, JSON.parse(USABLE.stdout), 20), null);
  assert.equal(wrapUpReason(CRASH, null, 20), null);
  assert.match(wrapUpReason(CAPPED, JSON.parse(CAPPED.stdout), 20), /max-turns \(20\)/);
  assert.match(wrapUpReason(PROSE, JSON.parse(PROSE.stdout), 20), /without a findings array/);
});

test("merging a wrap-up keeps its answer and sums the counters", () => {
  const merged = mergeWrapUp(
    { num_turns: 20, duration_ms: 1000, usage: { cache_read_input_tokens: 100, cache_creation_input_tokens: 50 } },
    { result: "[]", num_turns: 1, duration_ms: 200, usage: { cache_read_input_tokens: 300 } },
  );
  assert.equal(merged.result, "[]");
  assert.equal(merged.num_turns, 21);
  assert.equal(merged.duration_ms, 1200);
  assert.deepEqual(merged.usage, { cache_read_input_tokens: 400, cache_creation_input_tokens: 50 });
});

test("a run that reports usage but no cache shows as none, not blank", () => {
  assert.equal(cacheReadShare(undefined), "");
  assert.equal(cacheReadShare({ input_tokens: 10 }), "none");
  assert.equal(cacheReadShare({ cache_read_input_tokens: 3, cache_creation_input_tokens: 1 }), "75%");
});

// ── Deadline and environment ─────────────────────────────────────────────────

test("a step budget becomes a deadline, and no budget means none", () => {
  const now = () => 1000;
  assert.equal(deadlineFrom("60000", now), 61000);
  assert.equal(deadlineFrom(undefined, now), Infinity);
  assert.equal(deadlineFrom("", now), Infinity);
  assert.equal(deadlineFrom("nonsense", now), Infinity);
});

test("agent processes get no GitHub tokens", () => {
  const env = agentEnv({
    PATH: "/usr/bin",
    HOME: "/home/runner",
    ANTHROPIC_API_KEY: "key",
    ANTHROPIC_BASE_URL: "https://openrouter.ai/api",
    ANTHROPIC_AUTH_TOKEN: "router",
    API_TIMEOUT_MS: "180000",
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: "1000000",
    ANTHROPIC_LOG: "debug",
    CLAUDE_CODE_SOMETHING_NEW: "x",
    GITHUB_TOKEN: "ghs_secret",
    GH_TOKEN: "ghs_secret",
    ACTIONS_RUNTIME_TOKEN: "secret",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "secret",
    GITHUB_STEP_SUMMARY: "/tmp/summary",
    REVIEW_HERO_PRIVATE_KEY: "secret",
  });
  assert.deepEqual(Object.keys(env).sort(), [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "API_TIMEOUT_MS",
    "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
    "HOME",
    "PATH",
  ]);
});

// ── Spawning the CLI ─────────────────────────────────────────────────────────

/** A `claude` on a private PATH that runs the given shell body. */
function stubClaude(body) {
  const bin = mkdtempSync(join(tmpdir(), "run-agents-bin-"));
  const path = join(bin, "claude");
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return { PATH: `${bin}:/usr/bin:/bin` };
}

test("spawning the CLI feeds it the prompt and collects its output and exit code", async () => {
  const env = stubClaude('cat; echo "$1" >&2; exit 3');
  const result = await spawnClaude({ args: ["-p"], input: "the prompt", env, timeoutMs: 10_000 });
  assert.deepEqual(result, { code: 3, timedOut: false, stdout: "", rawTail: "the prompt", stderr: "-p\n" });
});

test("spawning the CLI hands over each streamed event and keeps the result event as its output", async () => {
  const lines = [
    '{"type":"system","subtype":"init"}',
    '{"type":"system","subtype":"api_retry","attempt":1,"error_status":429,"retry_delay_ms":1000}',
    '{"type":"result","subtype":"success","result":"[]","num_turns":2}',
  ];
  const env = stubClaude(`cat > /dev/null; printf '%s\\n' ${lines.map((l) => `'${l}'`).join(" ")}`);
  const events = [];
  const pids = [];
  const result = await spawnClaude({
    args: [],
    input: "prompt",
    env,
    timeoutMs: 10_000,
    onEvent: (e) => events.push(e.subtype ?? e.type),
    onSpawn: (pid) => pids.push(pid),
    onExit: (pid) => pids.push(-pid),
  });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, lines[2]);
  assert.deepEqual(events, ["init", "api_retry", "success"]);
  assert.equal(pids.length, 2);
  assert.equal(pids[1], -pids[0]);
});

test("a run that never reaches a result event keeps the tail of its raw output apart from its result", async () => {
  const env = stubClaude("cat > /dev/null; echo 'Error: something broke'; exit 1");
  const result = await spawnClaude({ args: [], input: "", env, timeoutMs: 10_000 });
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.rawTail, "Error: something broke\n");
});

test("a process past its time limit is stopped and reported as timed out", async () => {
  const env = stubClaude("exec sleep 30");
  const result = await spawnClaude({ args: [], input: "", env, timeoutMs: 100 });
  assert.equal(result.timedOut, true);
});

test("a process past its time limit is stopped along with the processes it spawned", async () => {
  const pidFile = join(mkdtempSync(join(tmpdir(), "run-agents-child-")), "pid");
  const env = stubClaude(`cat > /dev/null; sleep 30 & echo $! > ${pidFile}; wait`);
  const result = await spawnClaude({ args: [], input: "", env, timeoutMs: 200 });
  assert.equal(result.timedOut, true);
  const child = Number(readFileSync(pidFile, "utf-8"));
  assert.throws(() => process.kill(child, 0));
});

test("a CLI that cannot be found reports a failed run rather than throwing", async () => {
  const result = await spawnClaude({ args: [], input: "", env: { PATH: "/nonexistent" }, timeoutMs: 1000 });
  assert.equal(result.code, -1);
  assert.equal(result.timedOut, false);
});
