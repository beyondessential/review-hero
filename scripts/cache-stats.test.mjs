import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cacheWriteTokens, readUsage } from "./cache-stats.mjs";

const dir = mkdtempSync(join(tmpdir(), "cache-stats-"));

function fixture(name, contents) {
  const path = join(dir, name);
  writeFileSync(path, contents);
  return path;
}

test("reads the usage block from a result file", () => {
  const path = fixture(
    "ok.json",
    JSON.stringify({ usage: { cache_read_input_tokens: 42 } }),
  );
  assert.deepEqual(readUsage(path), { cache_read_input_tokens: 42 });
});

test("returns null rather than throwing for a missing file", () => {
  assert.equal(readUsage(join(dir, "absent.json")), null);
});

test("returns null rather than throwing for unparseable output", () => {
  assert.equal(readUsage(fixture("bad.json", "not json at all")), null);
});

test("returns null when the result carries no usage block", () => {
  assert.equal(readUsage(fixture("nousage.json", "{}")), null);
});

test("treats absent cache-write counters as zero", () => {
  assert.equal(cacheWriteTokens(null), 0);
  assert.equal(cacheWriteTokens({}), 0);
  assert.equal(cacheWriteTokens({ cache_creation_input_tokens: 512 }), 512);
});
