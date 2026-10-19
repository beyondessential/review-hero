---
id: RUN
---

# Review agent runs

A review runs as a single GitHub Actions job: triage, every review agent and each of its voters, and the orchestrator that posts the result.
The agents spend their time waiting on the model, so one runner carries them all as concurrent processes, and the shared setup happens once per review.

## The review job

- [ ] A review is one job, running triage, the review agents and the orchestrator in turn.
- [ ] The job runs on the workflow's `runner` input, which defaults to `ubuntu-latest`.
- [ ] An event that cannot start a review skips the job without starting a runner: a pull request action other than opened, reopened or edited in checkbox mode, or a description with no ticked Review Hero checkbox.
- [ ] The exact checkbox match runs as the job's first step, and a mismatch ends the job before any setup.
- [ ] Checkouts, dependency installs and the Claude CLI install happen once per review.
- [ ] The orchestrator runs even when agents fail, and posts from whatever results were written.

## Voters

- [ ] Triage sets the number of voters each agent runs for the review, the same for every agent.
- [ ] A diff under 100 changed lines runs one voter per agent, so its findings skip consensus.
- [ ] The `voters` input is the voter count for a diff of 100 to 499 changed lines.
- [ ] A diff of 500 or more changed lines runs two more voters than the `voters` input.
- [ ] The voter count never exceeds 10.
- [ ] A finding survives consensus when a strict majority of the review's voter count reports it, with voters that contributed nothing still counting toward that number.
- [ ] The completion block's `counts.voters` is the voter count the review ran with (see `reporting/completion-comments.md`).

## Concurrency

- [ ] At most `concurrency` agent processes run at once, where `concurrency` is a workflow input defaulting to 8.
- [ ] A primer run takes a free slot ahead of any voter, so every agent's cache is written early.

## Prompt cache priming

- [ ] Every voter of an agent sends a byte-identical prompt, so the voters share one cached prompt prefix.
- [ ] With more than one voter on Anthropic, each agent first makes a single-turn primer run that writes the cache, and its voters start once the primer has returned.
- [ ] A primer that fails still releases its voters, which then run without the shared prefix.
- [ ] On OpenRouter, voters start without a primer run.

## Wrap-up, retries and replacements

- [ ] A voter that hits its turn cap, or answers without a findings array, is resumed once and asked for its findings.
- [ ] A voter whose process exits abnormally is retried once, from scratch.
- [ ] A voter that still has no usable findings after its wrap-up is replaced once by a fresh voter.
- [ ] A voter left without usable findings after its retry or replacement contributes nothing, and the review carries on.
- [ ] Each voter's result is written as soon as it finishes, so results from finished voters survive a later failure in the job.

## Credentials

- [ ] Agent processes run with no GitHub token in their environment.
- [ ] The pull request checkout the agents read holds no stored credentials.

## Logs

- [ ] Each agent process's output appears in the job log as its own collapsible group, written when that process finishes.
- [ ] The job summary has a table of every agent process, with its agent, voter, turns used, prompt cache use and outcome.

## Documentation

- [ ] The README documents the single review job, the `runner` default, the `concurrency` input, and how the voter count follows the diff.
- [ ] The README warns that `ubuntu-slim` caps a job at 15 minutes, which the whole review has to fit within.
