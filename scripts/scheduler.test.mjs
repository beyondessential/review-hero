import assert from "node:assert/strict";
import { test } from "node:test";

import { createScheduler, linuxMemoryProbe, parseCeiling } from "./scheduler.mjs";

const GB = 1024 * 1024 * 1024;
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

/** Work that runs until released, recording how many ran at once. */
function harness(scheduler) {
  let active = 0;
  let peak = 0;
  const releases = [];
  const slots = [];
  const started = [];
  const submit = (name, pid) =>
    scheduler.withSlot(async (slot) => {
      started.push(name);
      slots.push(slot);
      if (pid) slot.onSpawn(pid);
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => releases.push(resolve));
      active--;
      return name;
    });
  return {
    submit,
    started,
    slots,
    peak: () => peak,
    active: () => active,
    releaseOne: () => releases.shift()?.(),
    releaseAll: () => {
      while (releases.length) releases.shift()();
    },
  };
}

/** A memory probe with fixed total and baseline use, and settable tree sizes. */
function fakeMemory({ total = 10 * GB, used = 2 * GB, sizes = {} } = {}) {
  return {
    sizes,
    usage: () => ({ total, used }),
    treeRss: (roots) => new Map(roots.map((pid) => [pid, sizes[pid] ?? 0])),
  };
}

test("work starts in the order it was queued, up to the ceiling", async () => {
  const h = harness(createScheduler({ ceiling: 2, memory: null, pollMs: 1 }));
  const done = ["a", "b", "c", "d"].map((n) => h.submit(n));
  await tick();
  assert.deepEqual(h.started, ["a", "b"]);
  h.releaseOne();
  await tick();
  assert.deepEqual(h.started, ["a", "b", "c"]);
  h.releaseAll();
  await tick();
  h.releaseAll();
  await Promise.all(done);
  assert.deepEqual(h.started, ["a", "b", "c", "d"]);
  assert.equal(h.peak(), 2);
});

test("with no ceiling or memory limit everything starts at once", async () => {
  const h = harness(createScheduler({ memory: null, pollMs: 1 }));
  const done = Array.from({ length: 20 }, (_, i) => h.submit(i));
  await tick();
  assert.equal(h.active(), 20);
  h.releaseAll();
  await Promise.all(done);
});

test("work fills memory up to the target, leaving room for running work to grow", async () => {
  // 2 GB used of 10, an assumed 2 GB per tree, fill to 8 GB: the first starts
  // regardless, then 2+2+2 and 2+2+4 fit, and 2+2+6 does not.
  const h = harness(createScheduler({ memory: fakeMemory(), defaultFootprint: 2 * GB, pollMs: 1 }));
  const done = Array.from({ length: 5 }, (_, i) => h.submit(i));
  await tick();
  assert.equal(h.active(), 3);
  h.releaseAll();
  await tick();
  h.releaseAll();
  await Promise.all(done);
});

test("a measured footprint replaces the assumed one", async () => {
  const memory = fakeMemory({ sizes: { 101: 3 * GB } });
  const scheduler = createScheduler({ memory, defaultFootprint: 1 * GB, pollMs: 1 });
  const h = harness(scheduler);
  const first = h.submit("first", 101);
  await tick();
  assert.equal(scheduler.state().footprint, 3 * GB);
  // 2 used + 3 for a newcomer, and the first is already at its 3 GB peak: 5 fits.
  const second = h.submit("second", 102);
  await tick();
  assert.equal(h.active(), 2);
  // A third would need 2 + 3 + 3 (the second can grow to 3) = 8: it fits; a fourth would not.
  const rest = [h.submit("third", 103), h.submit("fourth", 104)];
  await tick();
  assert.equal(h.active(), 3);
  h.releaseAll();
  await tick();
  h.releaseAll();
  await Promise.all([first, second, ...rest]);
});

test("one piece of work always runs, however full memory is", async () => {
  const h = harness(createScheduler({ memory: fakeMemory({ used: 9.5 * GB }), pollMs: 1 }));
  const done = [h.submit("a"), h.submit("b")];
  await tick();
  assert.deepEqual(h.started, ["a"]);
  h.releaseOne();
  await tick();
  assert.deepEqual(h.started, ["a", "b"]);
  h.releaseAll();
  await Promise.all(done);
});

test("a rate-limit retry pauses new starts and lowers the running limit", async () => {
  let clock = 0;
  const lines = [];
  const scheduler = createScheduler({ memory: null, pollMs: 1, now: () => clock, log: (l) => lines.push(l) });
  const h = harness(scheduler);
  const first = [h.submit("a"), h.submit("b"), h.submit("c")];
  await tick();
  assert.equal(h.active(), 3);

  h.slots[0].onEvent({ type: "system", subtype: "api_retry", error_status: 429, retry_delay_ms: 30_000 });
  assert.equal(scheduler.state().providerLimit, 2);
  assert.ok(lines.some((l) => l.includes("Provider throttled (HTTP 429)")));

  const later = [h.submit("d"), h.submit("e")];
  // One finishes, but the pause still holds.
  h.releaseOne();
  await tick();
  assert.deepEqual(h.started, ["a", "b", "c"]);

  // Once the pause passes, two still run: at the lowered limit, so nothing starts.
  clock = 31_000;
  await tick();
  assert.deepEqual(h.started, ["a", "b", "c"]);

  // An unthrottled finish raises the limit to 3, with one running: both start.
  h.releaseOne();
  await tick();
  assert.equal(scheduler.state().providerLimit, 3);
  assert.deepEqual(h.started, ["a", "b", "c", "d", "e"]);
  h.releaseAll();
  await tick();
  h.releaseAll();
  await Promise.all([...first, ...later]);
});

test("each unthrottled finish raises a lowered limit by one", async () => {
  const scheduler = createScheduler({ memory: null, pollMs: 1 });
  const h = harness(scheduler);
  const done = [h.submit("a"), h.submit("b"), h.submit("c")];
  await tick();
  h.slots[0].onEvent({ type: "system", subtype: "api_retry", error_status: 529, retry_delay_ms: 0 });
  assert.equal(scheduler.state().providerLimit, 2);
  // "a" was throttled: its finish does not raise the limit, "b"'s does.
  h.releaseOne();
  await tick();
  assert.equal(scheduler.state().providerLimit, 2);
  h.releaseOne();
  await tick();
  assert.equal(scheduler.state().providerLimit, 3);
  h.releaseAll();
  await Promise.all(done);
});

test("other API retries are counted but do not throttle", async () => {
  const scheduler = createScheduler({ memory: null, pollMs: 1 });
  const h = harness(scheduler);
  const done = h.submit("a");
  await tick();
  h.slots[0].onEvent({ type: "system", subtype: "api_retry", error_status: 500, retry_delay_ms: 1000 });
  h.slots[0].onEvent({ type: "assistant" });
  assert.equal(scheduler.state().providerLimit, Infinity);
  h.releaseAll();
  const settled = await done;
  assert.equal(settled.retries, 1);
  assert.equal(settled.throttled, false);
  assert.equal(settled.result, "a");
});

test("work that throws still frees its place", async () => {
  const scheduler = createScheduler({ ceiling: 1, memory: null, pollMs: 1 });
  await assert.rejects(scheduler.withSlot(async () => {
    throw new Error("boom");
  }));
  const settled = await scheduler.withSlot(async () => "next");
  assert.equal(settled.result, "next");
});

test("the ceiling is a whole number, with 0 or nothing meaning no ceiling", () => {
  assert.equal(parseCeiling(undefined), Infinity);
  assert.equal(parseCeiling(""), Infinity);
  assert.equal(parseCeiling("0"), Infinity);
  assert.equal(parseCeiling("12"), 12);
  for (const bad of ["-1", "1.5", "lots"]) {
    assert.throws(() => parseCeiling(bad));
  }
});

test("the Linux probe measures this process's own tree", { skip: process.platform !== "linux" }, () => {
  const probe = linuxMemoryProbe();
  assert.ok(probe);
  const { total, used } = probe.usage();
  assert.ok(total > used && used > 0);
  const size = probe.treeRss([process.pid]).get(process.pid);
  assert.ok(size > 1024 * 1024, `expected this process to use over 1 MB, got ${size}`);
});
