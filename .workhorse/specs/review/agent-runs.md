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
- [ ] Every description the exact match accepts also passes the job's skip condition, so a ticked checkbox always starts a review.
- [ ] Checkouts, dependency installs and the Claude CLI install happen once per review.
- [ ] A review keeps its working files where the runner empties them for every job, so a reused runner never reads one review's results, consensus or rules into the next.
- [ ] The orchestrator runs even when agents fail, and posts from whatever results were written.
- [ ] Consensus has a time limit of its own, and when it leaves no outcome the orchestrator posts every agent finding without consensus, with a warning in the job log.
- [ ] The agents have a time limit inside the job's, so the orchestrator still has time to post when agents run long.
- [ ] Every step that reaches the network or a model has a time limit of its own, and the job's limit covers them all, so a hung step cannot take the orchestrator's time to post.
- [ ] A review running on `ubuntu-slim` warns in the job log that the runner stops a job at 15 minutes.
- [ ] The agents and the second look each work to a deadline a little inside their time limit: every process stops by it, so its result is written before the limit is reached.
- [ ] A fresh run for a crashed or empty voter starts only when at least half a voter's time limit is left before the deadline, judged when it would start.
- [ ] An agent process due to start with no time left before its deadline does not start, and is recorded as not started.
- [ ] An agent process stopped at its time limit is stopped along with every process it spawned.
- [ ] The job keeps running while agent processes wait out a provider pause, even with none running.
- [ ] An agent whose prompt cannot be read is left out with a warning, and the other agents still run.

## Voters

- [ ] Triage sets the number of voters each agent runs for the review, the same for every agent.
- [ ] A diff under 100 changed lines runs one voter per agent, so its findings skip consensus.
- [ ] A diff of 100 or more changed lines runs the `voters` input's count of voters per agent.
- [ ] The voter count never exceeds 10.
- [ ] A finding survives consensus when a strict majority of the review's voter count reports it, with voters that contributed nothing still counting toward that number.
- [ ] The completion block's `counts.voters` is the voter count the review ran with (see `reporting/completion-comments.md`).
- [ ] The review summary's filtering line reports consensus only where it filtered findings: it says when consensus was not applied for some agents, and "no consensus" when it was applied for none.

## Concurrency

- [ ] Agent processes start while the runner's memory use stays at or under 80%, counting for the next process, and for each running one still below it, the largest footprint an agent process has reached so far in the review.
- [ ] An agent process's footprint is the memory of its whole process tree, measured while it runs.
- [ ] An agent process is assumed to need at least a fixed allowance, whatever has been measured so far, since the first measurement comes before a process has grown.
- [ ] When an agent process reports that the provider is rate limiting or overloaded, no new process starts for the retry delay the provider asked for, and the number allowed to run drops below the number running at that moment.
- [ ] Each agent process that finishes without having been rate limited raises that number by one.
- [ ] `concurrency` is an optional workflow input capping how many agent processes run at once, with no cap by default.
- [ ] Where the runner's memory cannot be read and `concurrency` is not set, at most eight agent processes run at once, with a warning in the job log.
- [ ] Outside a provider pause, one agent process always runs while work is waiting, whatever the other limits say.
- [ ] Work starts in the order it was queued, so every primer starts ahead of any voter and every agent's cache is written early.

## Prompt cache priming

- [ ] Every voter of an agent sends a byte-identical prompt, so the voters share one cached prompt prefix.
- [ ] The PR title appears in a prompt on a single line, whatever line breaks it holds.
- [ ] With more than one voter on Anthropic, each agent first makes a single-turn primer run that writes the cache, and its voters start once the primer has returned.
- [ ] A primer that fails still releases its voters, which then run without the shared prefix.
- [ ] On OpenRouter, voters start without a primer run.

## Wrap-up, retries and replacements

- [ ] A voter that hits its turn cap, or answers without a findings array, is resumed once and asked for its findings.
- [ ] A primer run has a much shorter time limit than a voter, since it only needs its first request.
- [ ] A wrap-up has a short time limit of its own.
- [ ] A voter whose process exits abnormally is retried once, from scratch.
- [ ] A voter that still has no usable findings after its wrap-up is replaced once by a fresh voter.
- [ ] A voter left without usable findings after its retry or replacement contributes nothing, and the review carries on.
- [ ] A voter that produced no result of its own, whether it timed out, crashed, failed unexpectedly or never started, has its result recorded as failed, so it counts as a failed agent run.
- [ ] A voter or checker stopped at its time limit after it had already answered counts by its answer.
- [ ] Each voter's result is written as soon as it finishes, so results from finished voters survive a later failure in the job.
- [ ] An unexpected error in one voter costs only that voter.

## Second look

Where voters disagree, the review takes a second look before posting: fresh checkers judge the contested findings, and their verdicts count as votes.

- [ ] Consensus runs as its own step after the agents finish, before the GitHub App token is created.
- [ ] While grouping an agent's findings, the consensus model names its contested areas: parts of the code where findings below the majority suggest a real problem worth a second look.
- [ ] An agent has at most three contested areas.
- [ ] A consensus reply that cannot be read whole still filters findings when its list of kept findings is complete, names no contested areas, and says so in the job log.
- [ ] Every finding in a contested area belongs to a group below the majority.
- [ ] A review that runs one voter per agent has no consensus, so no second look.
- [ ] Each contested area gets as many checkers as a finding from a single voter needs to reach the majority.
- [ ] A checker is a fresh run of the area's agent, given the diff and the area's findings, which reads the code with the same read-only tools and confirms or rejects each finding.
- [ ] A checker sees each finding's text and location, not which voters reported it.
- [ ] A finding below the majority is kept when its voters and the checkers confirming it together reach the majority.
- [ ] A review takes at most one second look.
- [ ] Checkers start under the same memory, provider and `concurrency` limits as voters, use the same wrap-up, and have a time limit of their own inside the job's.
- [ ] With more than one checker per area on Anthropic, each area first makes a primer run, and its checkers start once it has returned, as an agent's voters do.
- [ ] Each contested area's verdicts are saved as soon as its checkers finish, so areas settled before a second look fails or runs out of time still count, and the rest stand as consensus left them.
- [ ] A verdict counts only when it names a finding by its number; anything else is a rejection.
- [ ] The review summary's filtering line says how many findings a second look confirmed, when it confirmed any.
- [ ] The completion block's `counts.secondLook` is the number of findings a second look confirmed (see `reporting/completion-comments.md`).

## Credentials

- [ ] Agent processes run with no GitHub token in their environment.
- [ ] Agent processes load no settings, hooks, MCP servers or skills from the pull request's checkout.
- [ ] The GitHub App token is created after the agents and any second look have finished, just before the orchestrator posts.
- [ ] The pull request checkout the agents read holds no stored credentials.

## Logs

- [ ] The job log has a line when each agent process starts.
- [ ] Each agent process's output appears in the job log as its own collapsible group, written when that process finishes.
- [ ] Text from the model or the CLI never runs as a workflow command in the job log: command processing is off inside each process's group, and a model's label written on a single log line stays on that line.
- [ ] The job summary has a table of every agent process, with its agent, voter, attempt, time waiting to start, time running, peak memory, API retries, turns used, prompt cache use and outcome.
- [ ] The job log says why further agent processes are being held back whenever the reason changes.
- [ ] A voter's row covers its wrap-up as well, with turns and cache use summed over both.
- [ ] The job summary gains each row as its process settles, so it survives the agents being stopped at their time limit.

## Documentation

- [ ] The README documents the single review job, the `runner` default, the `concurrency` input, how the voter count follows the diff, and the second look.
- [ ] The README warns that `ubuntu-slim` caps a job at 15 minutes, which the whole review has to fit within.
