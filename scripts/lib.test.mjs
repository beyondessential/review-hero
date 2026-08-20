import assert from "node:assert/strict";
import { test } from "node:test";

import { formatCacheStats } from "./lib.mjs";

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
