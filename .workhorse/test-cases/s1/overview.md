# Run every review agent in a single job

Scenarios for the single review job. Driver behaviour is covered by `scripts/run-agents.test.mjs` against a fake CLI. The workflow cases need a real review on a pull request.

## Voter count

- [x] A diff under 100 changed lines runs one voter per agent (verifies spec: RUN)
- [x] A diff of 100 to 499 changed lines runs the `voters` input (verifies spec: RUN)
- [x] A diff of 500 or more changed lines runs two more voters than the input (verifies spec: RUN)
- [x] The voter count never exceeds 10, and a nonsense input falls back to one (verifies spec: RUN)

## Concurrency and priming

- [x] No more than `concurrency` agent processes overlap (verifies spec: RUN)
- [x] `concurrency` defaults to 8 and rejects anything but a positive integer (verifies spec: RUN)
- [x] Every primer starts before any voter, and an agent's voters start after its primer ends (verifies spec: RUN)
- [x] A failed primer still releases its voters, with a warning that it wrote no cache (verifies spec: RUN)
- [x] One voter, or OpenRouter, runs without a primer (verifies spec: RUN)
- [x] Every voter of an agent gets byte-identical prompt bytes (verifies spec: RUN)
- [ ] On a real multi-voter Anthropic review, voters report cache reads in the summary table (verifies spec: RUN)

## Wrap-up, retries and replacements

- [x] A capped voter, and one that answers in prose, is resumed once for its findings (verifies spec: RUN)
- [x] A failed wrap-up keeps the original result (verifies spec: RUN)
- [x] A crashed voter is retried once from scratch (verifies spec: RUN)
- [x] An empty voter is replaced once by a fresh voter (verifies spec: RUN)
- [x] A slot never gets more than one fresh run (verifies spec: RUN)
- [x] A timed-out voter is not retried and gets no wrap-up
- [x] Each slot's result is written under the name the orchestrator scans for (verifies spec: RUN)

## Credentials

- [x] Agent processes get no `GITHUB_TOKEN`, `GH_TOKEN` or `ACTIONS_*` variables (verifies spec: RUN)
- [ ] On a real run, no checkout leaves credentials in `.git/config` or under the runner temp directory (verifies spec: RUN)

## The review job

- [ ] A PR edit with no ticked checkbox shows the job as skipped, with no runner started (verifies spec: RUN)
- [ ] A ticked checkbox runs the whole review as one job and posts a summary (verifies spec: RUN)
- [ ] An agent failure part way through still leaves the orchestrator posting from the finished voters (verifies spec: RUN)
- [ ] A caller with no config on the default branch and a bootstrap branch set reads config from the bootstrap branch
- [ ] The completion block's `counts.voters` matches the voter tier for the diff (verifies spec: RUN)

## Logs

- [x] Each process's log is one collapsible group (verifies spec: RUN)
- [x] The job summary has a row per process with agent, run, attempt, turns, cache read and outcome (verifies spec: RUN)
