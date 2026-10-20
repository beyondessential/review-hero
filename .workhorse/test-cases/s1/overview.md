# Run every review agent in a single job

Scenarios for the single review job. Driver behaviour is covered by `scripts/run-agents.test.mjs` against a fake CLI. The workflow cases need a real review on a pull request.

## Voter count

- [x] A diff under 100 changed lines runs one voter per agent (verifies spec: RUN)
- [x] A diff of 100 or more changed lines runs the `voters` input, however large (verifies spec: RUN)
- [x] `voters: 1` runs one voter whatever the diff size (verifies spec: RUN)
- [x] The voter count never exceeds 10, and a nonsense input falls back to one (verifies spec: RUN)

## Concurrency and priming

- [x] No more than `concurrency` agent processes overlap when it is set (verifies spec: RUN)
- [x] `concurrency` 0 or unset means no ceiling; anything but a whole number is rejected (verifies spec: RUN)
- [x] With no ceiling and memory to spare, everything starts at once (verifies spec: RUN)
- [x] Processes fill memory up to 80%, leaving room for running ones to grow to the largest footprint (verifies spec: RUN)
- [x] A measured process-tree footprint larger than the assumed one replaces it (verifies spec: RUN)
- [x] A small early measurement does not shrink the estimate below the assumed footprint (verifies spec: RUN)
- [x] With no memory probe and no `concurrency`, at most eight processes run, with a warning (verifies spec: RUN)
- [x] Process trees are measured on the poll, not once per queued piece of work
- [x] One process always runs, however full memory is (verifies spec: RUN)
- [x] A 429 or 529 retry pauses new starts for its delay and lowers the running limit (verifies spec: RUN)
- [x] Each unthrottled finish raises a lowered limit by one (verifies spec: RUN)
- [x] Other API retries are counted but do not throttle
- [x] The CLI streams events; the runner keeps the result event as the envelope, and the raw tail apart from it when there is none
- [x] Rate-limit retries from a run reach the scheduler and the summary row (verifies spec: RUN)
- [x] The Linux probe measures a real process tree
- [ ] On a real review, the summary shows peak memory per process and the pool fills past the old cap of 8 (verifies spec: RUN)
- [x] Every primer starts before any voter, and an agent's voters start after its primer ends (verifies spec: RUN)
- [x] A failed primer still releases its voters, with a warning that it wrote no cache (verifies spec: RUN)
- [x] One voter, or OpenRouter, runs without a primer (verifies spec: RUN)
- [x] Every voter of an agent gets byte-identical prompt bytes (verifies spec: RUN)
- [x] A PR title with newlines stays on one line in review and checker prompts (verifies spec: RUN)
- [ ] On a real multi-voter Anthropic review, voters report cache reads in the summary table (verifies spec: RUN)

## Wrap-up, retries and replacements

- [x] A capped voter, and one that answers in prose, is resumed once for its findings (verifies spec: RUN)
- [x] A failed wrap-up keeps the original result (verifies spec: RUN)
- [x] A crashed voter is retried once from scratch (verifies spec: RUN)
- [x] An empty voter is replaced once by a fresh voter (verifies spec: RUN)
- [x] A slot never gets more than one fresh run (verifies spec: RUN)
- [x] A timed-out voter is not retried and gets no wrap-up
- [x] A voter or checker stopped at its time limit after answering counts by its answer (verifies spec: RUN)
- [x] A run with no result event writes a result marked failed, never its raw output, so it counts as a failed run (verifies spec: RUN)
- [x] A process past its time limit is stopped along with the processes it spawned (verifies spec: RUN)
- [x] Each slot's result is written under the name the orchestrator scans for (verifies spec: RUN)
- [x] A prose answer with a stray bracket but no findings array still gets its wrap-up (verifies spec: RUN)
- [x] A wrap-up sends the same system prompt flag as the voter it resumes
- [x] A primer gets the short primer time limit (verifies spec: RUN)
- [x] A wrap-up gets the short wrap-up limit, for voters and checkers alike (verifies spec: RUN)
- [x] Every process's time limit is cut to what is left before the deadline (verifies spec: RUN)
- [x] A crashed voter gets no fresh run with too little time left, and does with time to spare (verifies spec: RUN)
- [x] A fresh run queued with time to spare but admitted with too little left starts no process (verifies spec: RUN)
- [x] Work admitted after the deadline starts no process and is recorded as not started (verifies spec: RUN)
- [x] A step budget becomes a deadline; no budget means none
- [x] Work waiting out a provider pause keeps the process alive with nothing running (verifies spec: RUN)
- [x] An unexpected error in one voter costs only that voter, and writes a result marked failed (verifies spec: RUN)
- [x] An agent whose prompt cannot be read, or whose key is invalid, is skipped and the rest run (verifies spec: RUN)

## Second look

- [x] Consensus names contested areas only from findings it dropped, each finding in one group at most (verifies spec: RUN)
- [x] A group the model names as contested but already at the majority is left out (verifies spec: RUN)
- [x] Consensus names at most three contested areas per agent (verifies spec: RUN)
- [x] A bare array reply from the consensus model still works, with nothing contested
- [x] A single voter has no consensus and nothing contested (verifies spec: RUN)
- [x] An area gets `floor(voters / 2)` checkers (verifies spec: RUN)
- [x] A confirmation counts once per checker; anything unclear is a rejection (verifies spec: RUN)
- [x] A finding whose voters and confirming checkers reach the majority moves to kept, taking its group's other members out of dropped (verifies spec: RUN)
- [x] With five voters a lone finding needs both checkers (verifies spec: RUN)
- [x] No verdicts, or a checker that throws, leave consensus as it stood (verifies spec: RUN)
- [x] Each area's verdicts are handed over as soon as it settles, so they are saved before a step time limit (verifies spec: RUN)
- [x] A verdict whose finding is null, empty, false, a string or a fraction confirms nothing (verifies spec: RUN)
- [x] Consensus replies only count integer indices, so junk entries never stand for finding 0
- [x] Without a consensus outcome, every agent result is kept as it stands (verifies spec: RUN)
- [x] An agent key ending in `-voter-<n>` is rejected
- [x] Checkers start under the same limits as voters (verifies spec: RUN)
- [x] With several checkers on Anthropic, each area's primer starts before any checker, and a failed primer still releases them (verifies spec: RUN)
- [x] One checker per area, or OpenRouter, runs without a primer (verifies spec: RUN)
- [x] The consensus reply's token limit grows with the number of findings
- [x] Checker prompts come from the area agent's own prompt in the trusted checkout, and fence the quoted findings (verifies spec: RUN)
- [x] The review result carries `counts.secondLook` (verifies spec: CMPL)
- [x] On a real review with contested areas, the summary's filtering line reports findings a second look confirmed (verifies spec: RUN)
- [ ] A second look stopped at its time limit leaves the orchestrator posting from consensus as it stood (verifies spec: RUN)

## Credentials

- [x] Agent processes get no `GITHUB_TOKEN`, `GH_TOKEN` or `ACTIONS_*` variables (verifies spec: RUN)
- [ ] On a real run, no checkout leaves credentials in `.git/config` or under the runner temp directory (verifies spec: RUN)

## The review job

- [ ] A PR edit with no ticked checkbox shows the job as skipped, with no runner started (verifies spec: RUN)
- [ ] A ticked checkbox with two spaces after `[x]` still runs a review (verifies spec: RUN)
- [ ] A ticked checkbox with a tab or three spaces after `[x]` is skipped by both the gate and the exact check (verifies spec: RUN)
- [ ] A PR edit with only the template's unticked checkboxes shows the job as skipped (verifies spec: RUN)
- [ ] A consensus step that fails still leaves the orchestrator posting every agent finding, with a warning (verifies spec: RUN)
- [ ] Agents stopped at the step's time limit still leave the orchestrator posting from finished voters (verifies spec: RUN)
- [ ] A ticked checkbox runs the whole review as one job and posts a summary (verifies spec: RUN)
- [ ] An agent failure part way through still leaves the orchestrator posting from the finished voters (verifies spec: RUN)
- [ ] A caller with no config on the default branch and a bootstrap branch set reads config from the bootstrap branch
- [ ] On a self-hosted runner, a second review reads none of the first review's results or consensus outcome (verifies spec: RUN)
- [ ] The completion block's `counts.voters` matches the voter tier for the diff (verifies spec: RUN)
- [ ] A review on `ubuntu-slim` shows the 15-minute warning in the job log (verifies spec: RUN)
- [ ] The second look step runs with the same environment as the agents step, through the shared anchor

## Logs

- [x] Each process logs a line when it starts (verifies spec: RUN)
- [x] Each row records how long the process waited for a slot and how long it ran (verifies spec: RUN)
- [x] A voter's row covers its wrap-up, with turns summed (verifies spec: RUN)
- [x] Rows reach the job summary as each process settles (verifies spec: RUN)
- [x] A run that reports usage but touched no cache shows "none" in the cache column

- [x] Each process's log is one collapsible group (verifies spec: RUN)
- [x] The job summary has a row per process with agent, run, attempt, turns, cache read and outcome (verifies spec: RUN)
