/**
 * Block until the cache-prime marker for this agent appears on the current
 * workflow run.
 *
 * Every voter of an agent sends a byte-identical prompt, so they can share a
 * cached prompt prefix — but a cache entry only becomes readable once the
 * first response has begun. Voter 0 primes the cache and publishes a marker
 * artifact; the remaining voters wait here so their requests read the prefix
 * instead of each writing their own copy.
 *
 * Waiting is an optimisation, never a gate: if the marker never arrives we
 * proceed anyway. A missed prefix costs money, a failed review costs the run.
 *
 * Env:
 *   GH_TOKEN            — token with actions:read on this repository
 *   GITHUB_REPOSITORY   — owner/repo
 *   GITHUB_RUN_ID       — run whose artifacts are searched
 *   MARKER_NAME         — artifact name to wait for
 *   POLL_TIMEOUT_MS     — give up after this long (default 300000)
 *   POLL_INTERVAL_MS    — base delay between polls (default 15000)
 */

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_INTERVAL_MS = 15_000;
const REQUEST_TIMEOUT_MS = 10_000;
const PER_PAGE = 100;
const MAX_PAGES = 20;

/**
 * Spread the poll delay by +/-20%.
 *
 * Waiters are released by the same event and set up in parallel, so a fixed
 * interval marches them into the artifacts API in lockstep. With agents x
 * voters waiters on a large matrix that bunching is what risks a secondary
 * rate limit, so the delay is jittered to smear the requests out.
 */
export function jitteredDelay(baseMs, random = Math.random) {
  const spread = baseMs * 0.2;
  return Math.max(0, Math.round(baseMs - spread + random() * spread * 2));
}

/**
 * Fetch every artifact name on a run, following pagination.
 *
 * A run accumulates one artifact per voter result plus one marker per agent,
 * so a large matrix can exceed a single page. Stopping at the first page would
 * silently never find a marker that does exist.
 */
export async function fetchArtifactNames({
  repository,
  runId,
  token,
  fetchImpl = fetch,
  maxPages = MAX_PAGES,
}) {
  const names = [];

  for (let page = 1; page <= maxPages; page++) {
    const url =
      `https://api.github.com/repos/${repository}/actions/runs/${runId}` +
      `/artifacts?per_page=${PER_PAGE}&page=${page}`;

    const response = await fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      // Without this a stalled connection could outlast the overall deadline,
      // since a hung request never returns to the polling loop.
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`GitHub API ${response.status}`);
    }

    const body = await response.json();
    const artifacts = body?.artifacts ?? [];
    names.push(...artifacts.map((a) => a?.name).filter(Boolean));

    if (artifacts.length < PER_PAGE) break;
  }

  return names;
}

export async function waitForMarker({
  markerName,
  repository,
  runId,
  token,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  intervalMs = DEFAULT_INTERVAL_MS,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
  random = Math.random,
  log = console.log,
}) {
  const deadline = now() + timeoutMs;

  // Checked before the first sleep: setup times vary between runners, so the
  // marker may already be published by the time a waiter gets here.
  for (;;) {
    let names;
    try {
      names = await fetchArtifactNames({
        repository,
        runId,
        token,
        fetchImpl,
      });
    } catch (err) {
      // A transient API failure is not worth abandoning the wait over.
      log(`Artifact lookup failed, retrying: ${err.message}`);
      names = [];
    }

    if (names.includes(markerName)) return true;
    if (now() >= deadline) return false;

    await sleep(jitteredDelay(intervalMs, random));
  }
}

async function main() {
  const markerName = process.env.MARKER_NAME;
  const repository = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  const token = process.env.GH_TOKEN;

  if (!markerName || !repository || !runId || !token) {
    console.log(
      "::warning::Cache-prime wait is misconfigured — proceeding without a shared prefix",
    );
    return;
  }

  const found = await waitForMarker({
    markerName,
    repository,
    runId,
    token,
    timeoutMs: Number(process.env.POLL_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
    intervalMs: Number(process.env.POLL_INTERVAL_MS) || DEFAULT_INTERVAL_MS,
  });

  if (found) {
    console.log(`Cache primed (${markerName}) — proceeding`);
  } else {
    console.log(
      `::warning::Timed out waiting for cache prime (${markerName}) — proceeding without a shared prefix`,
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // Waiting is an optimisation, so an unexpected failure here must not fail
  // the review. Worst case the agent runs without a shared prefix.
  try {
    await main();
  } catch (err) {
    console.log(
      `::warning::Cache-prime wait failed (${err.message}) — proceeding without a shared prefix`,
    );
  }
}
