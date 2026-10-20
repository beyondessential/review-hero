# Review Hero 🦸

AI-powered pull request review, driven by [Claude](https://www.anthropic.com/claude) and delivered as a reusable GitHub Actions workflow.

Review Hero runs a set of specialised review agents in parallel (bugs, performance, design, security — plus any repo-specific ones you define), deduplicates their findings, and posts a consolidated review on your PR via a GitHub App.

## How it works

```
PR checkbox checked
        │
        ▼
   ┌─────────┐   Haiku selects    ┌──────────────────────────────┐
   │ Triage  │──── agents ───────>│ Review agents (x N x voters) │
   │ (Haiku) │   filters diff     │ (GLM or Claude, concurrent)  │
   └─────────┘                    └──────────────┬────────────────┘
                                                 │ JSON findings
                                                 ▼
                                        ┌─────────────────┐
                                        │  Orchestrator   │
                                        │  consensus      │
                                        │  suppress       │
                                        │  dedup + post   │
                                        └─────────────────┘
```

Triage, the agents, consensus and the second look run in one job. The orchestrator posts from a second, short job on `ubuntu-slim`.

1. **Triage** — triggered when a checkbox in the PR body is checked. Calls Claude Haiku to decide which agents are relevant, strips ignored files from the diff, sets the agent turn budget (flat for GLM, scaled by diff size for Claude), and sets the number of voters each agent runs (see [Voter consensus](#voter-consensus)).
2. **Review agents** — concurrent Claude Code CLI processes, each with a specialised prompt. The CLI installed is the newest release at least a week old, so a broken or compromised release has time to be caught first. They start while the runner stays under 80% memory use (measured from the processes themselves) and the provider is not rate limiting, up to `concurrency` when set. When there is more than one voter, each agent runs that many times independently for consensus; on Anthropic, a short primer run first writes the shared prompt to the cache so the voters read it. A voter that crashes is retried once, and one that returns no usable findings is replaced once. Agents have read-only access to the repo so they can explore surrounding code for context, and run with no GitHub token in their environment.
3. **Consensus and second look** — applies voter consensus per agent (when enabled). Where findings below the majority cluster in a part of the code, fresh checkers take a second look at them (see [Second look](#second-look)).
4. **Orchestrator** — filters against suppression rules and learned feedback, deduplicates findings by file and line proximity, resolves stale review threads, then posts inline review comments (critical/suggestion) and a summary comment (with a nitpicks table). It runs in its own job, with fresh checkouts of review-hero and your config, and reads the review job's results only as data. Its GitHub token is created there.

## Prerequisites (once per owner — user or org)

### 1. Create a GitHub App

Create a [new GitHub App](https://github.com/settings/apps/new) (org-level or personal — either works). The app needs these permissions:

- **Pull requests**: Read & write
- **Contents**: Read & write (for auto-fix commits)
- **Issues**: Read & write
- **Actions**: Read (for fetching CI failure logs)

You can name the app whatever you like — Review Hero detects the app's identity at runtime.

### 2. Generate a private key

In the GitHub App's settings page, scroll to the **Private keys** section at the bottom and click **Generate a private key**. This downloads a `.pem` file — the contents of this file are the private key.

> **Note:** This is _not_ the same as the "Client secret" in the app's OAuth settings. The private key is a PEM file used to mint short-lived installation tokens.

### 3. Install the app on your repos

Go to the app's **Install App** page and install it on your account or organisation. Select the specific repositories you want to enable Review Hero on.

### 4. Set secrets

You need three secrets. These can be set at the **org level** (recommended — all repos inherit them automatically) or **per-repo**:

| Secret                    | Value                                                    |
|---------------------------|----------------------------------------------------------|
| `REVIEW_HERO_APP_ID`      | The App ID (found on the app's settings page)            |
| `REVIEW_HERO_PRIVATE_KEY` | The full contents of the `.pem` private key file         |
| `ANTHROPIC_API_KEY`       | Your [Anthropic API key](https://console.anthropic.com/) |

> **Tip:** If you set secrets at the org level, you can scope `REVIEW_HERO_PRIVATE_KEY` to only the repos that use Review Hero. `ANTHROPIC_API_KEY` can also be set per-repo if you want separate billing.

#### Namespaced secret variants

If you already use `ANTHROPIC_API_KEY` for other purposes and want a dedicated key for Review Hero, you can set `REVIEW_HERO_ANTHROPIC_API_KEY` instead — it takes priority when both are present.

The same applies to `ANTHROPIC_BASE_URL` / `REVIEW_HERO_ANTHROPIC_BASE_URL`, which let you point Review Hero at a custom API endpoint (e.g. an API proxy or compatible provider). The `REVIEW_HERO_`-prefixed variant takes priority.

| Secret                              | Description                                              |
|--------------------------------------|----------------------------------------------------------|
| `REVIEW_HERO_ANTHROPIC_API_KEY`      | Anthropic API key (preferred over `ANTHROPIC_API_KEY`)   |
| `REVIEW_HERO_ANTHROPIC_BASE_URL`     | Custom API base URL (preferred over `ANTHROPIC_BASE_URL`)|
| `REVIEW_HERO_OPENROUTER_API_KEY`     | OpenRouter key, only needed for [OpenRouter models](#choosing-the-model-per-pr) |

## Setup (per repo)

### 1. Add the caller workflow

Create `.github/workflows/ai-review.yml` in your repo:

```yaml
name: Review Hero
on:
  pull_request:
    types: [opened, reopened, edited]

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    uses: beyondessential/review-hero/.github/workflows/review.yml@v1
    secrets: inherit
```

`secrets: inherit` passes through the app credentials and Anthropic key automatically.

> **Tip:** If you use `trigger: always` and want reviews to re-run on every push, add `synchronize` to the `types` list. This is not included by default to avoid unnecessary workflow invocations — in `checkbox` mode (the default) `synchronize` events are ignored anyway.

### 2. Add the checkbox to your PR template

Add this to your `.github/pull_request_template.md`:

```markdown
- [ ] **Run Review Hero** <!-- #ai-review -->
```

The `<!-- #ai-review -->` comment is required — it's how the workflow identifies the checkbox.

When a PR author (or reviewer) checks this box, Review Hero runs. The box is automatically unchecked after the review completes so it can be re-triggered later.

That's it — no other per-repo configuration needed.

### 3. (Optional) Enable Auto-Fix

Auto-Fix lets Claude automatically fix unresolved review comments and/or CI failures by committing directly to the PR branch. It's opt-in per repo — add a second caller workflow to enable it.

Create `.github/workflows/ai-auto-fix.yml`:

```yaml
name: Review Hero Auto-Fix
on:
  pull_request:
    types: [opened, reopened, edited]

permissions:
  actions: read
  contents: write
  pull-requests: write

jobs:
  auto-fix:
    uses: beyondessential/review-hero/.github/workflows/auto-fix.yml@v1
    secrets: inherit
```

> **Note:** Do _not_ add `synchronize` here — auto-fix pushes commits to the PR branch, so triggering on new pushes would cause an infinite loop.

Then add the checkboxes to your PR template:

```markdown
- [ ] **Auto-fix review suggestions** <!-- #auto-fix -->
- [ ] **Auto-fix CI failures** <!-- #auto-fix-ci -->
- [ ] **Save suppressions** <!-- #save-suppressions -->
```

Each checkbox triggers independently — you can fix review comments, fix CI failures, run the suppressions-from-feedback step on its own, or any combination. Like the review checkbox, they're automatically unchecked after completion. The suppressions step also runs automatically at the end of any auto-fix run; the `Save suppressions` checkbox is only needed when you want to trigger it without auto-fix. See [Learning from feedback](#learning-from-feedback).

**Note:** Auto-Fix needs broader permissions than review (`contents: write` to push commits, `actions: read` to fetch CI logs). Your GitHub App also needs write access to push on behalf of the bot.

#### Custom auto-fix rules

If your project has conventions the auto-fix agent should follow (spelling rules, file conventions, etc.), create `.github/review-hero/auto-fix-rules.md`:

```markdown
## Project Rules

- Use Australian/NZ English spelling
- Read `docs/CONVENTIONS.md` for project conventions
```

This file is appended to the auto-fix prompt automatically.

## Configuration (optional)

For repo-specific customisation, create `.github/review-hero/config.yml`:

```yaml
# Project metadata — included in the agent system prompt for context
project: Tamanu
description: a healthcare management system

# Extra file patterns to exclude from the diff (added to built-in defaults).
# Patterns support * (any within segment) and ** (any path depth).
ignore_patterns:
  - "some-generated-dir/**"
  - "*.auto.ts"

# Custom agents — one entry per .md file in .github/review-hero/prompts/
agents:
  project-conventions:
    name: "Project Conventions"
    description: "Tamanu conventions, migrations, FHIR, sync, permissions"
```

### Custom agents

Drop a `.md` file into `.github/review-hero/prompts/` and it becomes an agent. The filename (minus `.md`) is the agent key, which must consist of **lowercase alphanumeric characters and hyphens only** (e.g. `project-conventions`, `my-rules`) and must not end in `-voter-` followed by a number, which names a voter's results. Keys that don't match are ignored. Define the agent's display name and triage description in `config.yml` under `agents`.

Example — `.github/review-hero/prompts/project-conventions.md`:

```markdown
# Agent: Project Conventions

Check for project-specific conventions and domain rules.

Read `docs/CONVENTIONS.md` for the rules.

Ignore: high-level architecture, performance, generic security, generic bugs.
```

The triage step will automatically discover it and include it in Haiku's agent selection.

> **Security note:** Custom agent prompts, `config.yml`, `auto-fix-rules.md`, `auto-merge-rules.md`, and AI rules files (`.cursorrules`, etc.) are always read from the repository's **default branch** (e.g. `main`), not the PR branch. This prevents a pull request from injecting malicious prompt content by adding or modifying these files. Changes to custom agents or config take effect only after they're merged to the default branch.

### Bootstrap branch (initial setup)

When you first install Review Hero on a repo, the default branch won't have a `.github/review-hero/config.yml` yet — the PR that adds it is what you're trying to review! To work around this, you can set an optional repo-level secret:

| Secret                          | Value                                                        |
|---------------------------------|--------------------------------------------------------------|
| `REVIEW_HERO_BOOTSTRAP_BRANCH` | Branch name to read config from while the default branch has none |

When this secret is set and the default branch has no `config.yml`, Review Hero will read all trusted content (config, custom agent prompts, AI rules, auto-fix rules) from the bootstrap branch instead. Once your setup PR is merged and the default branch has the config, the bootstrap branch is ignored — you can delete the secret at that point.

> **Tip:** Set this to the name of your setup PR's branch (e.g. `add-review-hero`), then delete the secret after merging.

### Built-in ignore patterns

These files are always stripped from the diff before triage and agent input:

- `package-lock.json`
- `yarn.lock`
- `pnpm-lock.yaml`
- `Cargo.lock`
- `go.sum`
- `composer.lock`
- `Gemfile.lock`
- `poetry.lock`
- `bun.lockb`
- `flake.lock`
- `*.generated.*`

Extend this list with `ignore_patterns` in your config.

## Noise reduction

Review Hero includes two complementary mechanisms to improve signal-to-noise ratio.

### Voter consensus

When a review runs 2 or more voters, each review agent runs that many independent times and only findings that a majority of voters agree on are kept. This significantly reduces false positives — noise tends to vary between runs while real issues are consistently found.

The number of voters follows the size of the filtered diff:

| Changed diff lines | Voters per agent |
|--------------------|------------------|
| Under 100          | 1 (no consensus) |
| 100 or more        | `voters`         |

Every agent in a review runs the same number of voters, never more than 10.

```yaml
jobs:
  review:
    uses: beyondessential/review-hero/.github/workflows/review.yml@v1
    with:
      voters: 3  # Run each agent 3 times on a typical diff, keep findings with ≥2/3 agreement
    secrets: inherit
```

The consensus threshold is a strict majority of the review's voter count — for 3 voters, a finding needs at least 2 to agree (same file, within 5 lines). A voter that contributed nothing still counts toward that number. Each voter runs the same prompt — natural LLM stochasticity provides diversity, while real issues are found consistently.

**Cost impact:** Voters multiply agent costs linearly. The default of 3 voters strikes a good balance between noise reduction and cost.

### Second look

Findings below the majority are usually noise, but sometimes several voters each flag something different in the same part of the code, or a lone finding looks serious. While grouping findings, the consensus model names up to three such contested areas per agent.

Each contested area gets fresh checkers: runs of the same agent, given the diff and the area's findings, which read the code and confirm or reject each one. Every confirmation counts as a vote, and an area gets as many checkers as a finding from a single voter needs to reach the majority (one for 3 voters, two for 5). A finding whose voters and confirming checkers reach the majority is posted with the rest; the summary's filtering line says how many a second look confirmed.

A review takes at most one second look, and none when it runs a single voter. If the second look fails or runs out of time, the review posts from consensus as it stood.

### Choosing the model

Review agents run on GLM 5.3 Flash by default, through [OpenRouter](https://openrouter.ai/) with a flat 20-turn budget. This needs the `REVIEW_HERO_OPENROUTER_API_KEY` secret; without it, reviews run on Claude and log a warning. Triage and filtering always use Anthropic.

A second checkbox runs the review on Claude, meant as a final pass just before merging a substantive PR:

```markdown
- [ ] **Run Review Hero on Claude (before merge)** <!-- #ai-review-claude -->
```

The Claude review uses the `model` input, upgraded to Opus for PRs with 500+ changed lines. The step timeout is set to 20 minutes to accommodate Opus's longer response times.

A hidden marker in the PR description can pick another model from `ALLOWED_MODELS` in `scripts/lib.mjs`; any other id logs a warning and is ignored. The Claude checkbox wins over the marker.

```markdown
<!-- review-hero: model=z-ai/glm-5.3-flash:nitro -->
```

### Suppression rules

Create `.github/review-hero/suppressions.yml` to define patterns of findings to filter out:

```yaml
- pattern: "missing error handling on optional field"
  context: "when the value has a default or is in test code"
  reason: "our codebase uses defaults extensively, this is expected"

- pattern: "consider using a constant for this value"
  context: "single-use values in test files"
  reason: "magic numbers in tests are fine"
```

Each suppression rule is a natural language description. At review time, Claude Haiku checks each finding against suppressions and filters out matches. The Anthropic API key (already required) covers this — Haiku calls are very cheap.

### Learning from feedback

Review Hero automatically learns from developer feedback:

1. **During review** — If previous Review Hero comments on the same PR have 👎 reactions, those rejected findings are used as ephemeral suppressions for the current review cycle (so the same false positive doesn't reappear when re-reviewing).

2. **During auto-fix** — When auto-fix runs and detects 👎 reactions on Review Hero comments, it reads any developer replies in the thread to understand why, generates suppression rules, and commits them to `.github/review-hero/suppressions.yml` on the PR branch. After the PR merges, those suppressions become permanent.

3. **By ticking `Save suppressions`** — Runs the same step as #2 on demand without invoking auto-fix. Useful when there's nothing to auto-fix but you've added 👎 reactions you want captured, or when you want to re-run the step after replying with more context.

To reject a Review Hero finding: add a 👎 reaction to the comment. Optionally reply in the thread explaining why — this helps generate better suppression rules.


## Completion comments

When a review or auto-fix run ends, Review Hero posts a completion comment on the PR. Each one names the commit the run worked on, as a short SHA linked to the commit within the PR, and ends with a hidden, machine-readable block so other tools can track Review Hero without parsing the visible text:

```
<!-- review-hero:completion {"schema":1,"kind":"review","outcome":"completed","reviewedSha":"…","counts":{…},"runUrl":"…","reviewHero":{"ref":"v1","sha":"…"}} -->
```

The block is a single-line JSON object inside an HTML comment, so GitHub doesn't render it. Any `>` in a value is written as `\u003e`, so nothing inside the JSON can close the comment early. It carries only run metadata and counts, never finding text. A review is always made against one commit: the PR head as of the event that triggered it. The diff, the agents' checkout, and the inline comments all use that commit, even if the PR moves on while the review is running.

`schema` is the version of the block's shape. Adding a field keeps the same number. Removing a field or changing what one means increments it. The library exports `parseCompletionBlock(body)` to read the block and `buildCompletionBlock(fields)` to write one.

> **Check the author before trusting a block.** Anyone who can comment on a PR can post a well-formed completion block, so the block alone proves nothing — only a comment authored by your Review Hero app (`{app-slug}[bot]`) does. Within such a comment, `parseCompletionBlock` reads the *last* block, because Review Hero appends its own after any quoted PR text. It also exports `buildReviewResult(…)`, which turns the review pipeline's outputs into a review's `kind`, `outcome`, `reviewedSha` and `counts`. A consumer that runs the review itself gets the same figures as data, and the hosted review writes that same object into its block.

### Fields on every block

| Field | Description |
|-------|-------------|
| `schema` | Version of the block's shape (currently `1`) |
| `kind` | `review`, `auto-fix`, or `save-suppressions` |
| `outcome` | How the run ended; see below for the values each `kind` can have |
| `runUrl` | The GitHub Actions run that posted the comment |
| `reviewHero.ref` | The Review Hero ref the caller asked for, e.g. `v1` |
| `reviewHero.sha` | The Review Hero commit that ref resolved to |

All SHAs are full 40-character SHAs.

### `review`

Posted at the end of a review round, or when a review could not complete.

| Field | Description |
|-------|-------------|
| `outcome` | `completed` when at least one agent returned results, `failed` when every agent failed |
| `reviewedSha` | The commit that was reviewed |
| `model` | The model the review agents ran on |
| `counts` | `agentsCompleted`, `agentsFailed`, `voters`, `critical`, `suggestion`, `nitpick`, `belowThreshold`, `suppressed`, `secondLook` (findings below the majority a second look confirmed) |

### `auto-fix`

| Field | Description |
|-------|-------------|
| `outcome` | `fixed` (fixes pushed), `no-changes` (finished without file changes), `partial` (some fixes pushed before the run failed), `failed` (failed without pushing), `nothing-to-fix` (no unresolved review comments or CI failures) |
| `baseSha` | The commit the run started from. Absent if the run failed before checking out a commit |
| `pushedSha` | The new head the run pushed, or `null` if it pushed nothing. Includes any suppressions commit made at the end of the run |
| `counts` | For `fixed` and `no-changes`: `reviewCommentsFixed`, `reviewCommentsSkipped`, `ciFailuresFixed`, `ciFailuresSkipped`, and `suppressionsSaved` (absent if saving suppressions failed). For `partial` and `failed`: `outstanding`, the number of review comments in the local fix prompt. Absent if the run failed before it could count its work |

### `save-suppressions`

Posted when an auto-fix run had nothing to fix and `Save suppressions` was ticked.

| Field | Description |
|-------|-------------|
| `outcome` | `saved` (new suppressions committed), `none` (nothing new to save), `failed` |
| `fixRequested` | `true` if auto-fix was also requested and found nothing to fix |
| `baseSha` | The commit the run started from |
| `pushedSha` | The new head carrying the suppressions commit, or `null` if nothing was pushed |
| `counts` | `saved`, the number of suppressions committed. Absent when `outcome` is `failed` |

## Workflow inputs

The caller workflow can pass these optional inputs:

```yaml
jobs:
  review:
    uses: beyondessential/review-hero/.github/workflows/review.yml@v1
    with:
      trigger: checkbox        # 'checkbox' (default) or 'always'
      model: claude-sonnet-5   # Claude model for the Claude checkbox (auto-upgrades to Opus for large PRs)
      runner: ubuntu-latest    # Runner for the review job
      voters: 3                # Voters per agent on a typical diff (1 to disable consensus)
      concurrency: 0           # Most agent processes at once (0 = limited by memory and the provider only)
    secrets: inherit
```

| Input     | Default            | Description |
|-----------|--------------------|-------------|
| `trigger` | `checkbox`         | `checkbox` = only runs when the PR body checkbox is checked. `always` = runs on every PR event. |
| `model`   | `claude-sonnet-5`  | Claude model for review agents when the Claude checkbox is ticked or the OpenRouter key is unset. Triage may upgrade to Opus for large PRs (500+ lines). |
| `runner`  | `ubuntu-latest`    | GitHub Actions runner for the review job, which runs the agents. Posting always runs on `ubuntu-slim`. |
| `voters`  | `3`                | Independent voters per agent for a diff of 100 or more changed lines; smaller diffs run one. `>=2` enables consensus filtering. Set to `1` to disable. |
| `concurrency` | `0`            | Most review agent processes running at once. `0` leaves the runner's memory (filled to 80%) and the provider's rate limiting as the only limits; on a runner whose memory cannot be read, it runs at most 8. |

> [!NOTE]
> `ubuntu-slim` caps a job at 15 minutes, and setup and every agent run in the review job, so they have to fit within that. A review job on `ubuntu-slim` warns about this in the job log.

### Auto-Fix inputs

```yaml
jobs:
  auto-fix:
    uses: beyondessential/review-hero/.github/workflows/auto-fix.yml@v1
    with:
      model: claude-sonnet-5
      runner: ubuntu-slim       # Runner for trigger check + review fixes
      ci-runner: ubuntu-latest  # Runner when fixing CI failures (may need build tools)
    secrets: inherit
```

| Input       | Default            | Description |
|-------------|--------------------|-------------|
| `model`     | `claude-sonnet-5`  | The Claude model used for auto-fix. |
| `runner`    | `ubuntu-slim`      | GitHub Actions runner for the trigger check and review-only fixes. |
| `ci-runner` | `ubuntu-latest`    | GitHub Actions runner used when fixing CI failures (needs build tools, test runners, etc.). Automatically selected when the CI failures checkbox is checked. |

## Base agents

| Agent        | Focus |
|--------------|-------|
| **Bugs & Correctness** | Logic errors, edge cases, null access, race conditions, type mismatches, error handling gaps |
| **Performance** | Expensive loops, unbounded growth, N+1 queries, resource exhaustion, missing pagination |
| **Design & Architecture** | Wrong abstractions, DRY violations, over-engineering, separation of concerns |
| **Security** | Injection, XSS, auth bypass, data exposure, input validation, path traversal |

The triage step uses Haiku to skip agents that aren't relevant to the changed files. **Bugs** is always included.

## Cost

### GitHub Actions minutes

Review Hero uses [reusable workflows](https://docs.github.com/en/actions/sharing-automations/reusing-workflows), which means all jobs run against the **calling repo's** Actions minute quota and billing — not this repo's. Each review run (two jobs: one for triage and the agents, and a short one that posts) and each auto-fix run count towards your repo's monthly included minutes or usage charges.

### Review

- **Triage**: one Haiku call per run (~100 tokens out). Very cheap.
- **Agents**: one GLM (or Claude) session per selected agent, with a capped number of tool-use turns (below). This is where most cost comes from.
- **Diff filtering**: lockfiles and generated files are stripped before agents see them, which avoids wasting tokens on noise.

GLM gets 20 turns. Claude's scale with the filtered diff size:

| Filtered diff lines | Max turns |
|---------------------|-----------|
| < 100               | 8         |
| 100–499             | 15        |
| 500+                | 20        |

### Auto-Fix

- One Sonnet session with up to 30 tool-use turns.
- Has `Read`, `Edit`, `Glob`, and `Grep` tools. If fixing CI failures, `Bash` is also enabled so it can run commands to verify fixes.
- Cost depends on how many review comments / CI failures need fixing, but is typically comparable to a single review agent run.

## Versioning

Review Hero follows [semantic versioning](https://semver.org/). Consumer workflows should pin to a **major version tag** (e.g. `@v1`), which automatically receives backwards-compatible updates:

```yaml
uses: beyondessential/review-hero/.github/workflows/review.yml@v1
```

- **Patch releases** (e.g. `v1.0.1`) — bug fixes, prompt tweaks, minor improvements.
- **Minor releases** (e.g. `v1.1.0`) — new features, new agents, new inputs with backwards-compatible defaults.
- **Major releases** (e.g. `v2.0.0`) — breaking changes to workflow inputs, secrets, or behaviour that requires consumer updates.

If you need to pin to an exact version for stability, use the full semver tag:

```yaml
uses: beyondessential/review-hero/.github/workflows/review.yml@v1.2.3
```

## PR template snippet

Here's a complete block you can drop into `.github/pull_request_template.md`:

```markdown
### 🦸 Review Hero

- [ ] **Run Review Hero** <!-- #ai-review -->
- [ ] **Run Review Hero on Claude (before merge)** <!-- #ai-review-claude -->
- [ ] **Auto-fix review suggestions** <!-- #auto-fix -->
- [ ] **Auto-fix CI failures** <!-- #auto-fix-ci -->
- [ ] **Save suppressions** <!-- #save-suppressions -->
```

Omit the auto-fix lines if your repo doesn't use that workflow.
