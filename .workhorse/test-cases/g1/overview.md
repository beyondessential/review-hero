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
