# Improve prompt caching

Coverage for making the review-agent matrix share a cached prompt prefix between the voters
of each agent. The behaviour under test is mostly observable through cache token counts in
the CI logs, so most cases are manual checks against a real review run.

## Cache usage reporting

- [x] `formatCacheStats` returns nothing when neither counter is present, so sessions
      predating cache reporting do not print an empty stat.
- [x] A pure cache write reports a 0% hit rate.
- [x] A pure cache read reports a 100% hit rate.
- [x] A session that both reads and writes reports the read share.
- [x] A missing counter is treated as zero rather than suppressing the whole report.
- [ ] The agent matrix prints cache read/write figures for each voter, including when the
      agent hit its max-turns cap.
- [ ] A full workflow re-run publishes its marker without colliding with the previous
      attempt's artifact name.
- [ ] Cache figures appear for the auto-fix run via `runClaude`.

## Prompt determinism

- [x] Two builds of the same agent's prompt are byte-identical, so voters can share a
      prefix. Verified by building twice and comparing checksums.
- [ ] Prompts for two *different* agents differ, confirming each agent primes its own
      prefix rather than colliding.
- [ ] A custom agent (read from the trusted ref) builds a prompt as successfully as a base
      agent.
- [ ] A missing agent prompt file fails the build step with a clear error rather than
      sending a truncated prompt to Claude.

## Primer nomination

- [x] With `voters > 1`, exactly one primer is nominated per agent and the remaining voters
      are waiters.
- [x] With `voters = 1`, no primer is nominated and no job waits, so a single-voter run
      does not stall on a marker that never arrives.

## Wait coordination

- [x] An already-published marker returns immediately without sleeping first, since setup
      times vary and the primer may already be done.
- [x] Polling continues until the marker appears.
- [x] A missing marker gives up at the deadline rather than blocking the review forever.
- [x] A transient API failure is retried rather than abandoning the wait.
- [x] Artifact listing paginates, so a marker beyond the first 100 artifacts is still found.
- [x] Pagination stops at the page cap.
- [x] A non-ok API response raises rather than being read as "no artifacts".
- [x] Poll delay jitter stays within 20% of the base interval and is never negative.
- [x] A misconfigured wait (missing env) warns and exits 0 rather than failing the job.
- [x] An unreachable API warns and exits 0 rather than failing the job.

## Cache reporting

- [x] Usage is read from a well-formed result file.
- [x] A missing file, unparseable output, or absent usage block returns null rather than
      throwing.
- [x] Absent cache-write counters are treated as zero.
- [x] `--require-write` warns when a prime run wrote no cache tokens.
- [x] Reporting exits 0 for a missing or unparseable file, so it can never fail a review.

## Stagger behaviour

- [ ] On a real multi-voter review, the primer reports a cache write and its sibling voters
      report cache reads.
- [ ] Sibling voters start their Claude call only after the marker artifact appears.
- [ ] A failed prime run still publishes the marker, so siblings are released rather than
      waiting out the full timeout.
- [ ] When the marker never appears, waiters proceed after the timeout with a warning and
      the review still completes.
- [ ] Total input token spend for a multi-voter review drops relative to a pre-change run
      on the same PR.

## Regressions

- [ ] A review with `voters = 1` behaves as before, with no prime step and no wait step.
- [ ] Hitting the max-turns cap is still treated as a skipped agent rather than a CI
      failure, now that `PIPESTATUS` handling has been removed.
- [ ] A genuine Claude failure (bad model, missing API key) still fails the job.
- [ ] Review quality is unchanged: findings on a known PR are comparable to a pre-change
      run.
