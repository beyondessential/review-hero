import assert from "node:assert/strict";
import { test } from "node:test";

import {
  formatCacheStats,
  workflowRunUrl,
  workflowLogsUrl,
  reviewHeroVersion,
  createCompletionReporter,
} from "./lib.mjs";
import { parseCompletionBlock } from "../src/summary.mjs";

test("reports nothing when the cache was not involved", () => {
  assert.deepEqual(formatCacheStats(undefined), []);
  assert.deepEqual(formatCacheStats({}), []);
  assert.deepEqual(
    formatCacheStats({ cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
    [],
  );
});

test("reports a pure cache write as a 0% hit rate", () => {
  const stats = formatCacheStats({
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 20000,
  });
  assert.deepEqual(stats, [
    "Cache read: 0",
    "Cache write: 20,000",
    "Cache hit rate: 0%",
  ]);
});

test("reports a pure cache read as a 100% hit rate", () => {
  const stats = formatCacheStats({
    cache_read_input_tokens: 20000,
    cache_creation_input_tokens: 0,
  });
  assert.deepEqual(stats, [
    "Cache read: 20,000",
    "Cache write: 0",
    "Cache hit rate: 100%",
  ]);
});

test("reports the read share when a session both reads and writes", () => {
  const stats = formatCacheStats({
    cache_read_input_tokens: 15000,
    cache_creation_input_tokens: 5000,
  });
  assert.deepEqual(stats.at(-1), "Cache hit rate: 75%");
});

test("treats a missing counter as zero rather than dropping the report", () => {
  assert.deepEqual(formatCacheStats({ cache_read_input_tokens: 1024 }), [
    "Cache read: 1,024",
    "Cache write: 0",
    "Cache hit rate: 100%",
  ]);
});

// ── Completion reporting ─────────────────────────────────────────────────────

function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("the run URL points at the current Actions run", () => {
  withEnv({ GITHUB_SERVER_URL: "https://github.com", GITHUB_RUN_ID: "42" }, () => {
    assert.equal(workflowRunUrl("o/r"), "https://github.com/o/r/actions/runs/42");
    assert.equal(workflowLogsUrl("o/r"), "https://github.com/o/r/actions/runs/42");
  });
});

test("the run URL is null outside Actions, while the logs URL falls back", () => {
  withEnv({ GITHUB_SERVER_URL: undefined, GITHUB_RUN_ID: undefined }, () => {
    assert.equal(workflowRunUrl("o/r"), null);
    assert.equal(workflowLogsUrl("o/r"), "https://github.com/o/r/actions");
  });
});

test("the completion reporter fills in the run URL and Review Hero version", () => {
  withEnv(
    { GITHUB_SERVER_URL: "https://github.com", GITHUB_RUN_ID: "42", REVIEW_HERO_REF: "v1" },
    () => {
      const reporter = createCompletionReporter({ repo: "o/r", prNumber: "7" });
      const block = parseCompletionBlock(reporter.block({ kind: "auto-fix", outcome: "nothing-to-fix" }));
      assert.equal(block.kind, "auto-fix");
      assert.equal(block.runUrl, "https://github.com/o/r/actions/runs/42");
      assert.equal(block.reviewHero.ref, "v1");
      assert.match(block.reviewHero.sha, /^[0-9a-f]{40}$/);
      assert.equal(block.reviewHero.sha, reviewHeroVersion().sha);
      assert.equal(
        reporter.link(block.reviewHero.sha),
        `[\`${block.reviewHero.sha.slice(0, 7)}\`](https://github.com/o/r/pull/7/commits/${block.reviewHero.sha})`,
      );
    },
  );
});
