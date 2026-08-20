import assert from "node:assert/strict";
import { test } from "node:test";

import {
  fetchArtifactNames,
  jitteredDelay,
  waitForMarker,
} from "./wait-for-cache-prime.mjs";

/** Build a fetch stand-in serving fixed pages of artifact names. */
function pagedFetch(pages) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const page = Number(new URL(url).searchParams.get("page"));
    const names = pages[page - 1] ?? [];
    return {
      ok: true,
      json: async () => ({ artifacts: names.map((name) => ({ name })) }),
    };
  };
  return { fetchImpl, calls };
}

const BASE = { repository: "o/r", runId: "1", token: "t" };

test("jitter stays within 20% of the base delay", () => {
  assert.equal(jitteredDelay(1000, () => 0), 800);
  assert.equal(jitteredDelay(1000, () => 1), 1200);
  assert.equal(jitteredDelay(1000, () => 0.5), 1000);
});

test("jitter never returns a negative delay", () => {
  assert.ok(jitteredDelay(0, () => 0) >= 0);
});

test("collects artifact names from a single short page", async () => {
  const { fetchImpl, calls } = pagedFetch([["a", "b"]]);
  const names = await fetchArtifactNames({ ...BASE, fetchImpl });
  assert.deepEqual(names, ["a", "b"]);
  assert.equal(calls.length, 1, "should stop once a page is under-full");
});

test("follows pagination past the first 100 artifacts", async () => {
  const full = Array.from({ length: 100 }, (_, i) => `artifact-${i}`);
  const { fetchImpl, calls } = pagedFetch([full, ["cache-primed-bugs"]]);

  const names = await fetchArtifactNames({ ...BASE, fetchImpl });

  assert.equal(calls.length, 2);
  assert.ok(
    names.includes("cache-primed-bugs"),
    "a marker on page 2 must still be found",
  );
});

test("stops paginating at the page cap", async () => {
  const full = Array.from({ length: 100 }, (_, i) => `a-${i}`);
  const { fetchImpl, calls } = pagedFetch([full, full, full, full]);
  await fetchArtifactNames({ ...BASE, fetchImpl, maxPages: 2 });
  assert.equal(calls.length, 2);
});

test("throws on a non-ok API response", async () => {
  const fetchImpl = async () => ({ ok: false, status: 403 });
  await assert.rejects(() => fetchArtifactNames({ ...BASE, fetchImpl }), /403/);
});

test("returns immediately when the marker is already published", async () => {
  const { fetchImpl } = pagedFetch([["cache-primed-bugs"]]);
  let slept = 0;

  const found = await waitForMarker({
    ...BASE,
    markerName: "cache-primed-bugs",
    fetchImpl,
    sleep: async () => { slept++; },
    log: () => {},
  });

  assert.equal(found, true);
  assert.equal(slept, 0, "should not sleep before the first check");
});

test("keeps polling until the marker appears", async () => {
  let attempt = 0;
  const fetchImpl = async () => {
    attempt++;
    return {
      ok: true,
      json: async () => ({
        artifacts: attempt < 3 ? [] : [{ name: "cache-primed-bugs" }],
      }),
    };
  };

  const found = await waitForMarker({
    ...BASE,
    markerName: "cache-primed-bugs",
    fetchImpl,
    sleep: async () => {},
    log: () => {},
  });

  assert.equal(found, true);
  assert.equal(attempt, 3);
});

test("gives up at the deadline rather than waiting forever", async () => {
  const { fetchImpl } = pagedFetch([[]]);
  let clock = 0;

  const found = await waitForMarker({
    ...BASE,
    markerName: "cache-primed-bugs",
    timeoutMs: 100,
    fetchImpl,
    sleep: async () => { clock += 50; },
    now: () => clock,
    log: () => {},
  });

  assert.equal(found, false, "a missing marker must not block the review");
});

test("survives a transient API failure and finds the marker after it", async () => {
  let attempt = 0;
  const fetchImpl = async () => {
    attempt++;
    if (attempt === 1) throw new Error("connection reset");
    return { ok: true, json: async () => ({ artifacts: [{ name: "m" }] }) };
  };

  const logged = [];
  const found = await waitForMarker({
    ...BASE,
    markerName: "m",
    fetchImpl,
    sleep: async () => {},
    log: (m) => logged.push(m),
  });

  assert.equal(found, true);
  assert.match(logged.join("\n"), /retrying/);
});
