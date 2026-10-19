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
- **Workspace layout.** The PR checkout sits at the workspace root, since the agents' cwd is where the CLI reads `CLAUDE.md` natively.
  It is checked out first, because `actions/checkout` into the root clears what is already there.
  The trusted ref goes in `.caller-base` and review-hero in `.review-hero`, as in today's agent jobs, so triage moves off `caller/` and `review-hero/`.
  Hidden directories keep them out of the agents' default Grep and Glob.
- **Node version.** Today's agent jobs take `.node-version` from the PR checkout; the merged job takes it from the trusted ref, as triage does.
- **Bootstrap without stored credentials.** The trusted-ref resolution fetches the bootstrap branch with the checkout's stored credentials.
  With `persist-credentials: false` everywhere, the bootstrap case becomes a second `actions/checkout` of `.caller-base` at the bootstrap branch, and the step records its SHA with `git rev-parse`.
- **One extra run per voter slot.** A crash retry and an empty-result replacement share one budget: a slot gets at most one fresh run after its first, whichever the reason.
  That reads the spec's "after its retry or replacement" as either, not both.
- **Process timeout.** Each agent process gets a time limit (today's step limit is 20 minutes).
  A voter killed by it contributes nothing rather than being retried, so one slow voter cannot double the review's length.
  The job has its own `timeout-minutes` above that.
- **Result names.** Results keep the names the orchestrator parses: `{key}-result.json` for a single voter, `{key}-voter-{n}-result.json` otherwise.
  A retry or replacement writes into its slot's name, and every write goes through a temporary file and a rename, so the orchestrator never reads half a file.
- **Prompt builder location.** The review agent prompt joins `buildBasePromptSections` in `src/prompt.mjs`, since prompt assembly is what the shared library exports for consumers.

## Resolved questions

Recorded in the review agent runs spec (RUN):

- Concurrency cap default: 8.
- One retry for a crashed voter, one replacement for an empty one.
- Voter count is review-wide and follows diff size only: one voter under 100 changed lines, the `voters` input up to 499, two more at 500 and above (the Opus threshold), capped at 10.
  Consensus stays a strict majority of that count, with non-contributing voters still counted, so `counts.voters` keeps its meaning.
- `runner` stays one input, defaulting to `ubuntu-latest`; a job-level `if:` skips non-matching events without a runner, and the README warns about slim's 15-minute cap.

## Build steps

### Triage

- [x] `scripts/lib.mjs`: add `voterCountForDiff(diffLines, requested)` (one under 100 changed lines, `requested` from 100 to 499, `requested + 2` from 500, clamped to 1..`MAX_VOTERS`), with cases in `lib.test.mjs` at each boundary (`// spec: RUN#voters`)
- [x] `scripts/lib.mjs`: reword the `MAX_VOTERS` rationale to cost alone
- [x] `scripts/triage.mjs`: replace the `matrix` output with `agents` (JSON array of `{ key, source }`) and `voters` (from `voterCountForDiff`); drop the primer and voter fields; update the header comment and the log lines
- [x] `scripts/triage.mjs`: read the caller repo from `.caller-base` and review-hero from `.review-hero` via the existing `CALLER_REPO_DIR` / `REVIEW_HERO_DIR` env (workflow change only, but check nothing hard-codes `caller/`)

### Prompt

- [x] `src/prompt.mjs`: add `buildReviewAgentPrompt({ projectContext, basePrompt, agentPrompt, aiRules, maxTurns, prTitle, diff })` (contents, not paths, so it is testable) and `softTurnCap`, porting the workflow's bash build: project context, base prompt, agent prompt, AI rules, turn budget with the same soft-cap formula, PR title and fenced diff
- [x] Export it from `src/index.mjs` and type it in `src/index.d.ts`
- [x] Tests in `src/index.test.mjs` (or a new `src/prompt.test.mjs`): identical bytes for identical inputs, sections omitted when empty, soft cap at `maxTurns` 4 and 20

### Agent driver: `scripts/run-agents.mjs`

- [x] Inputs from env: `AGENTS`, `VOTERS`, `MAX_TURNS`, `AGENT_MODEL`, `AGENT_PROVIDER`, `CONCURRENCY` (default 8, rejects non-positive), `RESULTS_DIR`, prompt inputs, and the Anthropic/OpenRouter variables
- [x] Build each selected agent's prompt once with `buildReviewAgentPrompt`, reading custom agent prompts from `.caller-base` (`source` other than `base`), and write it to a file every run of that agent reads
- [x] A FIFO slot pool of size `CONCURRENCY`; primers are queued before any voter, and retries and replacements queue behind whatever is waiting (`// spec: RUN#concurrency`)
- [x] Async `spawnClaude` on `child_process.spawn`: the same flags as the workflow (`--permission-mode dontAsk`, `--output-format json`, `--allowedTools` read-only set, `--exclude-dynamic-system-prompt-sections`), stdin from the prompt file, stdout to the result file, stderr to a per-process log, a kill on timeout
- [x] Spawn with an allowlisted environment (`PATH`, `HOME`, `ANTHROPIC_*`, `API_TIMEOUT_MS`, `CLAUDE_CODE_MAX_CONTEXT_TOKENS`, and what the CLI needs to run) so no GitHub token reaches an agent (`// spec: RUN#credentials`)
- [x] Primer per agent when voters > 1 and the provider is Anthropic: `--max-turns 1`, warn when it wrote nothing to the cache, and release the agent's voters however it ends (`// spec: RUN#prompt-cache-priming`)
- [x] Voter run with the wrap-up resume ported from bash: resume on `error_max_turns` or a result with no `[`, keep the original if the resume fails
- [x] Classify each finished voter as usable, empty, crashed or timed out; give a crashed or empty slot one fresh run, and leave a timed-out one non-contributing (`// spec: RUN#wrap-up-retries-and-replacements`)
- [x] Write each result under the orchestrator's names through a temporary file and rename, as soon as the voter settles
- [x] On each process's finish, print its log, cache stats (via `formatCacheStats`) and outcome as one `::group::` block written in a single call
- [x] Append a job summary table to `GITHUB_STEP_SUMMARY`: agent, voter, attempt, turns, cache read share, outcome (`// spec: RUN#logs`)
- [x] Exit 0 when agents fail, since the orchestrator reports that; exit non-zero only for the driver's own errors

### Driver tests: `scripts/run-agents.test.mjs`

- [x] Make `spawnClaude` injectable, so tests drive the scheduler with a fake that returns scripted results and records start order and overlap
- [x] At most `CONCURRENCY` runs overlap
- [x] An agent's voters start only after its primer settles, including when the primer fails
- [x] No primer with one voter, or on OpenRouter
- [x] Max-turns and no-array results get one resume; a failed resume keeps the original
- [x] A crashed slot and an empty slot each get one fresh run, and no slot gets two
- [x] A timed-out run is not retried
- [x] Spawned env holds no `GITHUB_TOKEN`, `GH_TOKEN` or `ACTIONS_*` variables even when the parent has them
- [x] Result file names match the orchestrator's `RESULT_PATTERN`, single voter and multi-voter

### Remove the cross-job pieces

- [x] Delete `scripts/wait-for-cache-prime.mjs` and `scripts/wait-for-cache-prime.test.mjs`
- [x] Delete `scripts/cache-stats.mjs` and its test: the driver reads the usage block from each envelope itself, and the primer's no-cache-write warning moved into it
- [x] `scripts/orchestrate.mjs`: header says `VOTERS` comes from triage, and the result file pattern moved to `lib.mjs` (`RESULT_FILE_PATTERN`, `resultFileName`) so the driver and orchestrator share it

### Workflow: `.github/workflows/review.yml`

- [x] Inputs: `runner` default `ubuntu-latest`, described as the review job's runner; new `concurrency` number input, default 8; `voters` described as the count for 100 to 499 changed lines
- [x] One `review` job replacing `triage`, `review-agent` and `orchestrate-review`, with `timeout-minutes` set
- [x] Job-level `if:` that skips without a runner: `inputs.trigger == 'always'`, or an opened/reopened/edited action whose body `contains` the ticked checkbox text (`// spec: RUN#the-review-job` in a YAML comment)
- [x] Keep the exact regex check as the first step, and gate every later step on its output
- [x] Checkouts in order, all with `persist-credentials: false`: PR head at the root, trusted ref into `.caller-base`, a second `.caller-base` checkout at the bootstrap branch when the default branch has no config, review-hero into `.review-hero`
- [x] Setup once: `.node-version` from `.caller-base`, `setup-node`, `npm ci --prefix .review-hero`, Claude CLI install
- [x] Keep the caller config, PR diff, triage, suppressions and AI rules steps, pointed at the new paths, with no artifact upload or download between them
- [x] Run `run-agents.mjs` with the triage outputs and `concurrency`, and no GitHub token in the step's env
- [x] Run the orchestrator with `if: always()` and the should-run gate, `ARTIFACTS_DIR` set to the driver's results directory and `VOTERS` from triage
- [x] Upload the results directory and agent logs as one artifact with `if: always()`, for debugging

### Docs

- [x] `README.md`: architecture diagram and "how it works" for the single job; voter consensus section with the diff-size tiers; inputs table for `runner`, `concurrency` and `voters`; the `ubuntu-slim` 15-minute warning
- [x] `DEVELOPING.md`: env table rows that name triage/agents/orchestrate jobs

### Verify

- [x] `npm test`
- [x] `go run github.com/rhysd/actionlint/cmd/actionlint@latest .github/workflows/review.yml`
- [ ] A real review on a PR in this repo (`ai-review.yml` runs the PR's own ref): one job, primers before voters, cache reads on the voters, the summary table, and a completion block whose `counts.voters` matches the tier
