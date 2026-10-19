# S1: Run every review agent in a single job

## Direction

Replace the `review-agent` matrix (one job per agent × voter) with a single job that runs every agent and voter as concurrent `claude -p` processes.
Triage and the orchestrator move into the same job, so a review is one job end to end.

The agents are wait-bound on the model, so one runner can carry them all.
Setup (app token, checkouts, `npm ci`, Claude CLI install, rules detection) then happens once, not once per voter.

## Decisions

- One job for the whole review: trigger check, triage, agents, orchestrator.
- The agents run on a full runner, not `ubuntu-slim`, because slim's 15-minute job cap would otherwise have to cover setup, priming, the slowest voter and its resume.
- Cache priming happens in-process: each agent's primer runs first, and its voters start when the primer returns.
  `wait-for-cache-prime.mjs`, its test and the marker artefacts go.
- Results are written to disk as each voter finishes, so a timeout or crash part way through still leaves the orchestrator something to post.
- A fixed cap limits how many `claude` processes run at once, settable through a new workflow input.
- The driver makes three runtime decisions:
  - a voter whose process exits abnormally is retried;
  - a voter that returns nothing usable, even after the wrap-up resume, is replaced by a fresh voter, so consensus keeps its quorum;
  - triage picks each agent's voter count from the diff, not one flat count.

## Design notes

- **Driver.** A `scripts/run-agents.mjs` replaces the bash in the agent step: it builds each agent's prompt, runs primers and voters under a concurrency cap, and handles the wrap-up resume (max-turns, or an answer with no findings array).
  That logic moves out of bash and gains tests alongside the other `scripts/*.test.mjs`.
- **Prompt bytes.** The prompt build moves from bash into the driver, but must stay byte-identical across an agent's voters, or the shared prefix breaks.
- **Trigger gate cost.** In checkbox mode the workflow fires on every PR edit, and today the gate runs on slim.
  Folding it into a full-runner job means booting a VM just to say no.
  A job-level `if:` that approximates the checkbox match (evaluated without a runner) keeps that cheap; the precise regex check stays as the first step.
- **Runner input.** `runner` is documented as "runner for all jobs" with default `ubuntu-slim`.
  The default has to change, and callers that pass `ubuntu-slim` explicitly would hit the 15-minute cap.
  `auto-fix.yml` already splits `runner` / `ci-runner`, which is a precedent if a split is wanted.
- **Credentials in reach of agents.** Agents read the PR checkout with Read/Grep and `git` tools, and in one job they share a runner with the app token the orchestrator uses to post.
  Spawn agent processes with a scrubbed environment (no GitHub tokens) and check out the PR with `persist-credentials: false`, so a prompt-injected agent cannot read a token and echo it into a finding.
- **Logs.** Per-agent output goes to its own file, printed in a `::group::` block as each finishes, with a job summary table (agent, voter, turns, cache hit, outcome).
- **Retries.** "Re-run failed jobs" no longer retries a single agent, so the driver retries a voter that crashes.
- **`MAX_VOTERS`.** Its rationale cites the GitHub Actions matrix limit, which no longer applies; cost is still a reason to cap.

## Open questions

The review agent runs spec (RUN) drafts an answer to each; these await confirmation.

- Concurrency cap default: 8.
- One retry for a crashed voter, one replacement for an empty one.
- Voter count is review-wide and follows diff size only: the `voters` input below 500 changed lines (the Opus threshold), two more at 500 and above, capped at 10.
  Consensus stays a strict majority of that count, with non-contributing voters still counted, so `counts.voters` keeps its meaning.
- `runner` stays one input, defaulting to `ubuntu-latest`; a job-level `if:` skips non-matching events without a runner.
