/**
 * Review Hero — Agent process scheduler
 *
 * Decides when the next agent process may start. Agents spend their time
 * waiting on the model, so the limits that matter are the runner's memory and
 * the provider's rate limits, not a fixed count:
 *
 * - Memory: a process starts while the runner's memory use, plus the largest
 *   footprint any agent process tree has reached so far (never less than an
 *   assumed allowance) for the newcomer, plus room for running processes
 *   still to grow to that footprint, stays at or under the fill target
 * - Provider: when a running process reports a rate-limit or overload retry,
 *   no process starts for the delay the provider asked for, and the running
 *   limit drops below the count at that moment. Each process that finishes
 *   without having been throttled raises the limit by one
 * - Ceiling: an optional fixed maximum, from the `concurrency` input
 *
 * At least one process always runs while work is waiting, outside a provider
 * pause, so the scheduler never stalls on an estimate. Work starts in the
 * order it was queued. Where memory cannot be read and there is no ceiling,
 * the drivers fall back to a fixed one (see `ceilingFor`).
 */

import { readFileSync, readdirSync } from "node:fs";

/** Fill the runner up to this share of its memory. */
export const MEMORY_FILL_TARGET = 0.8;

/** The least footprint assumed for an agent process tree, measured or not. */
export const DEFAULT_FOOTPRINT_BYTES = 250 * 1024 * 1024;

/** How often running process trees are measured and waiting work re-checked. */
export const POLL_MS = 2_000;

/**
 * The most agent processes running at once where the runner's memory cannot
 * be read and no `concurrency` is set, so nothing else bounds the pool.
 */
export const UNMEASURED_CEILING = 8;

/** The least time new starts pause for after a throttled request. */
const MIN_THROTTLE_PAUSE_MS = 5_000;

/** HTTP statuses that mean the provider is asking for less traffic. */
const THROTTLE_STATUSES = new Set([429, 529]);

// ── Memory on Linux ──────────────────────────────────────────────────────────

function meminfo() {
  const fields = {};
  for (const line of readFileSync("/proc/meminfo", "utf-8").split("\n")) {
    const m = line.match(/^(\w+):\s+(\d+) kB/);
    if (m) fields[m[1]] = Number(m[2]) * 1024;
  }
  return fields;
}

function rssBytes(pid) {
  try {
    const m = readFileSync(`/proc/${pid}/status`, "utf-8").match(/^VmRSS:\s+(\d+) kB/m);
    return m ? Number(m[1]) * 1024 : 0;
  } catch {
    return 0;
  }
}

function parentPids() {
  const parents = new Map();
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      // The command name sits in parentheses and may hold spaces, so read the
      // fields after its closing parenthesis: state, then parent pid.
      const stat = readFileSync(`/proc/${name}/stat`, "utf-8");
      const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      parents.set(Number(name), Number(after[1]));
    } catch {
      // The process exited while we looked.
    }
  }
  return parents;
}

function childPids() {
  const children = new Map();
  for (const [pid, ppid] of parentPids()) {
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  return children;
}

function treeOf(children, root) {
  const tree = [];
  const stack = [root];
  const seen = new Set();
  while (stack.length > 0) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    tree.push(pid);
    stack.push(...(children.get(pid) ?? []));
  }
  return tree;
}

/**
 * A process and everything it has spawned, root first. Just the root where
 * there is no `/proc` to read.
 */
export function processTree(root) {
  try {
    return treeOf(childPids(), root);
  } catch {
    return [root];
  }
}

/**
 * Memory readings from `/proc`, or null where there is no `/proc` to read.
 * `treeRss` sums the resident memory of each root process and everything it
 * has spawned (the CLI runs ripgrep and git as children).
 */
export function linuxMemoryProbe() {
  try {
    const { MemTotal, MemAvailable } = meminfo();
    if (!MemTotal || MemAvailable === undefined) return null;
  } catch {
    return null;
  }
  return {
    usage() {
      const { MemTotal, MemAvailable } = meminfo();
      return { total: MemTotal, used: MemTotal - MemAvailable };
    },
    treeRss(roots) {
      const children = childPids();
      const sizes = new Map();
      for (const root of roots) {
        let total = 0;
        for (const pid of treeOf(children, root)) total += rssBytes(pid);
        sizes.set(root, total);
      }
      return sizes;
    },
  };
}

// ── Scheduler ────────────────────────────────────────────────────────────────

/**
 * A scheduler for agent processes. `withSlot(fn)` resolves with `fn(slot)`'s
 * result once the work is admitted, where `slot` carries the hooks the CLI
 * runner reports through: `onSpawn(pid)` for each process the work starts,
 * and `onEvent(event)` for each stream-json event they emit. Once `fn` settles,
 * the resolved value is `{ result, peakBytes, retries, throttled }` alongside
 * the admission timing.
 *
 * `memory` is a probe like `linuxMemoryProbe()`'s, or null to leave memory
 * unchecked. `log` receives a line whenever starts are held back for a new
 * reason, so the job log shows what is limiting the pool.
 */
// spec: RUN#concurrency
export function createScheduler({
  ceiling = Infinity,
  memory = linuxMemoryProbe(),
  fillTarget = MEMORY_FILL_TARGET,
  defaultFootprint = DEFAULT_FOOTPRINT_BYTES,
  pollMs = POLL_MS,
  now = Date.now,
  log = () => {},
} = {}) {
  const waiting = [];
  const running = new Set(); // per-work records: { pids, peak, throttledAt }
  let providerLimit = Infinity;
  let pausedUntil = 0;
  let footprint = 0; // largest process-tree footprint measured so far
  let timer = null;
  let lastHold = null;

  function measure() {
    if (!memory) return;
    const roots = [...running].flatMap((work) => [...work.pids]);
    if (roots.length === 0) return;
    const sizes = memory.treeRss(roots);
    for (const work of running) {
      let size = 0;
      for (const pid of work.pids) size += sizes.get(pid) ?? 0;
      work.current = size;
      work.peak = Math.max(work.peak, size);
      footprint = Math.max(footprint, work.peak);
    }
  }

  /** Why the next piece of work cannot start yet, or null when it can. */
  function holdReason() {
    if (running.size >= ceiling) return "ceiling";
    // A provider pause holds even with nothing running: it ends on its own,
    // so it cannot stall the review the way an estimate could.
    if (now() < pausedUntil) return "provider pause";
    if (running.size === 0) return null;
    if (running.size >= providerLimit) return "provider limit";
    if (memory) {
      // Never below the assumed footprint: the first measurement comes moments
      // after a process starts, long before it has grown to its working size.
      const estimate = Math.max(footprint, defaultFootprint);
      const { total, used } = memory.usage();
      let growth = 0;
      for (const work of running) growth += Math.max(0, estimate - (work.current ?? 0));
      if (used + estimate + growth > total * fillTarget) return "memory";
    }
    return null;
  }

  // Admission only reads overall memory use. Process trees are measured on
  // the poll alone: work queued in one burst would otherwise rescan /proc once
  // per item, for processes spawned moments ago that cannot have grown yet.
  function pump() {
    while (waiting.length > 0) {
      const reason = holdReason();
      if (reason) {
        if (reason !== lastHold) {
          log(`Holding further agent processes (${reason}; ${running.size} running, ${waiting.length} waiting)`);
          lastHold = reason;
        }
        break;
      }
      lastHold = null;
      start(waiting.shift());
    }
    schedulePoll();
  }

  function schedulePoll() {
    const busy = waiting.length > 0 || running.size > 0;
    if (busy && !timer) {
      // Left ref'd on purpose: while work waits out a provider pause with
      // nothing running, this timer is the only thing keeping the process
      // alive. It is cleared as soon as nothing is running or waiting.
      timer = setInterval(() => {
        measure();
        pump();
      }, pollMs);
    } else if (!busy && timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function start({ fn, resolve, reject, queuedAt }) {
    const work = { pids: new Set(), peak: 0, current: 0, retries: 0, throttled: false };
    running.add(work);
    const startedAt = now();
    const slot = {
      onSpawn(pid) {
        if (pid) work.pids.add(pid);
      },
      onExit(pid) {
        work.pids.delete(pid);
      },
      onEvent(event) {
        if (event?.type !== "system" || event.subtype !== "api_retry") return;
        work.retries++;
        if (!THROTTLE_STATUSES.has(event.error_status)) return;
        work.throttled = true;
        const wasPaused = now() < pausedUntil;
        const pause = Math.max(MIN_THROTTLE_PAUSE_MS, Number(event.retry_delay_ms) || 0);
        pausedUntil = Math.max(pausedUntil, now() + pause);
        // Running processes keep retrying while the provider throttles, so the
        // same signal arrives many times. Only a lower limit or a fresh pause
        // is news worth logging.
        const lowered = Math.max(1, running.size - 1);
        if (lowered < providerLimit) {
          providerLimit = lowered;
          log(
            `Provider throttling (HTTP ${event.error_status}): no new agent processes for now, and none while ${providerLimit} or more are running`,
          );
        } else if (!wasPaused) {
          log(`Provider throttling (HTTP ${event.error_status}): no new agent processes for now`);
        }
      },
    };
    Promise.resolve()
      .then(() => fn(slot))
      .then(
        (result) => finish(work, () => resolve({
          result,
          waitedMs: startedAt - queuedAt,
          ranMs: now() - startedAt,
          peakBytes: work.peak || undefined,
          retries: work.retries,
          throttled: work.throttled,
        })),
        (err) => finish(work, () => reject(err)),
      );
  }

  function finish(work, settle) {
    running.delete(work);
    if (!work.throttled && providerLimit !== Infinity) providerLimit++;
    settle();
    pump();
  }

  return {
    withSlot(fn) {
      return new Promise((resolve, reject) => {
        waiting.push({ fn, resolve, reject, queuedAt: now() });
        pump();
      });
    },
    /** For tests and reporting: the scheduler's current view. */
    state() {
      return { running: running.size, waiting: waiting.length, providerLimit, pausedUntil, footprint };
    },
  };
}

/**
 * The ceiling to schedule with: `ceiling` as given, or `UNMEASURED_CEILING`
 * when there is no ceiling and no memory probe to stand in for one.
 */
export function ceilingFor(ceiling, memory, log = () => {}) {
  if (memory || ceiling !== Infinity) return ceiling;
  log(`Runner memory cannot be read; running at most ${UNMEASURED_CEILING} agent processes at once`);
  return UNMEASURED_CEILING;
}

/**
 * The `concurrency` input: a positive integer caps how many agent processes
 * run at once, and 0 or nothing leaves memory and the provider as the only
 * limits.
 */
export function parseCeiling(raw) {
  if (raw === undefined || raw === "" || raw === "0") return Infinity;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`CONCURRENCY must be a whole number, 0 for no limit, got "${raw}"`);
  }
  return value === 0 ? Infinity : value;
}
