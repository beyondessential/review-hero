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
   │ (Haiku) │   filters diff     │ (Sonnet, parallel)           │
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

1. **Triage** — triggered when a checkbox in the PR body is checked. Calls Claude Haiku to decide which agents are relevant, strips ignored files from the diff, and scales the agent turn budget by diff size.
2. **Review agents** — a parallel matrix of Claude Code CLI invocations, each with a specialised prompt. When `voters > 1`, each agent runs multiple times independently for consensus. Agents have read-only access to the repo so they can explore surrounding code for context.
3. **Orchestrator** — collects all agent outputs, applies voter consensus (when enabled), filters against suppression rules and learned feedback, deduplicates findings by file and line proximity, resolves stale review threads, then posts inline review comments (critical/suggestion) and a summary comment (with a nitpicks table).

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

Drop a `.md` file into `.github/review-hero/prompts/` and it becomes an agent. The filename (minus `.md`) is the agent key, which must consist of **lowercase alphanumeric characters and hyphens only** (e.g. `project-conventions`, `my-rules`). Keys that don't match this pattern are ignored. Define the agent's display name and triage description in `config.yml` under `agents`.

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

When `voters` is set to 2 or more, each review agent runs N independent times and only findings that a majority of voters agree on are kept. This significantly reduces false positives — noise tends to vary between runs while real issues are consistently found.

```yaml
jobs:
  review:
    uses: beyondessential/review-hero/.github/workflows/review.yml@v1
    with:
      voters: 3  # Run each agent 3 times, keep findings with ≥2/3 agreement
    secrets: inherit
```

The consensus threshold is `floor(voters / 2) + 1` (strict majority) — for 3 voters, a finding needs at least 2 to agree (same file, within 5 lines). Each voter runs the same prompt — natural LLM stochasticity provides diversity, while real issues are found consistently.

**Cost impact:** Voters multiply agent costs linearly. The default of 3 voters strikes a good balance between noise reduction and cost.

### Automatic Opus upgrade for large PRs

For PRs with 500+ changed lines, triage automatically upgrades the review model from Sonnet to Opus. Opus reasons more deeply and catches subtle issues in large diffs that Sonnet may miss. Max turns are reduced (6 instead of 10) to stay within timeout budgets — Opus uses fewer but deeper reasoning turns. The step timeout is set to 20 minutes to accommodate Opus's longer response times.

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


## Workflow inputs

The caller workflow can pass these optional inputs:

```yaml
jobs:
  review:
    uses: beyondessential/review-hero/.github/workflows/review.yml@v1
    with:
      trigger: checkbox        # 'checkbox' (default) or 'always'
      model: claude-sonnet-4-6  # Default model (auto-upgrades to Opus for large PRs)
      runner: ubuntu-slim      # Runner for all jobs
      voters: 3                # Voters per agent (1 to disable consensus)
    secrets: inherit
```

| Input     | Default            | Description |
|-----------|--------------------|-------------|
| `trigger` | `checkbox`         | `checkbox` = only runs when the PR body checkbox is checked. `always` = runs on every PR event. |
| `model`   | `claude-sonnet-4-6`| Default Claude model for review agents. Triage may upgrade to Opus for large PRs (500+ lines). |
| `runner`  | `ubuntu-slim`      | GitHub Actions runner for all jobs. |
| `voters`  | `3`                | Independent voters per agent. `>=2` enables consensus filtering. Set to `1` to disable. |

### Auto-Fix inputs

```yaml
jobs:
  auto-fix:
    uses: beyondessential/review-hero/.github/workflows/auto-fix.yml@v1
    with:
      model: claude-sonnet-4-6
      runner: ubuntu-slim       # Runner for trigger check + review fixes
      ci-runner: ubuntu-latest  # Runner when fixing CI failures (may need build tools)
    secrets: inherit
```

| Input       | Default            | Description |
|-------------|--------------------|-------------|
| `model`     | `claude-sonnet-4-6`| The Claude model used for auto-fix. |
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

Review Hero uses [reusable workflows](https://docs.github.com/en/actions/sharing-automations/reusing-workflows), which means all jobs run against the **calling repo's** Actions minute quota and billing — not this repo's. Each review run (triage + agents + orchestrator) and each auto-fix run count towards your repo's monthly included minutes or usage charges.

### Review

- **Triage**: one Haiku call per run (~100 tokens out). Very cheap.
- **Agents**: one Sonnet session per selected agent, with up to 3–10 tool-use turns depending on diff size. This is where most cost comes from.
- **Diff filtering**: lockfiles and generated files are stripped before agents see them, which avoids wasting tokens on noise.

Max turns scale with the filtered diff size and are capped at 10:

| Filtered diff lines | Max turns |
|---------------------|-----------|
| < 100               | 3         |
| 100–499             | 5         |
| 500+                | 10        |

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
- [ ] **Auto-fix review suggestions** <!-- #auto-fix -->
- [ ] **Auto-fix CI failures** <!-- #auto-fix-ci -->
- [ ] **Save suppressions** <!-- #save-suppressions -->
```

Omit the auto-fix lines if your repo doesn't use that workflow.
