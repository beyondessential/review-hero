# Review Hero 🦸

AI-powered pull request review, driven by [Claude](https://www.anthropic.com/claude) and delivered as a reusable GitHub Actions workflow.

Review Hero runs a set of specialised review agents in parallel (bugs, performance, design, security — plus any repo-specific ones you define), deduplicates their findings, and posts a consolidated review on your PR via a GitHub App.

## How it works

```
PR checkbox checked
        │
        ▼
   ┌─────────┐   Haiku selects    ┌────────────────────┐
   │ Triage  │──── agents ───────>│ Review agents (x N) │
   │ (Haiku) │   filters diff     │ (Sonnet, parallel)  │
   └─────────┘                    └─────────┬───────────┘
                                            │ JSON findings
                                            ▼
                                   ┌─────────────────┐
                                   │  Orchestrator   │
                                   │  dedup + post   │
                                   └─────────────────┘
```

1. **Triage** — triggered when a checkbox in the PR body is checked. Calls Claude Haiku to decide which agents are relevant, strips ignored files from the diff, and scales the agent turn budget by diff size.
2. **Review agents** — a parallel matrix of Claude Code CLI invocations, each with a specialised prompt. Agents have read-only access to the repo so they can explore surrounding code for context.
3. **Orchestrator** — collects all agent outputs, deduplicates findings by file and line proximity, resolves stale review threads, then posts inline review comments (critical/suggestion) and a summary comment (with a nitpicks table).

## Setup

### Prerequisites

- The **Review Hero** GitHub App installed on your organisation (or at least on the consumer repo _and_ this repo). The app needs these permissions:
  - **Pull requests**: Read & write
  - **Contents**: Read
  - **Issues**: Read & write
- **Org-level secrets** (set once by an org admin under Settings → Secrets and variables → Actions):

  | Secret                    | Value                                  |
  |---------------------------|----------------------------------------|
  | `REVIEW_HERO_APP_ID`      | The Review Hero GitHub App ID          |
  | `REVIEW_HERO_PRIVATE_KEY` | The Review Hero GitHub App private key |

- A **per-repo secret** for billing separation:

  | Secret              | Value                  |
  |---------------------|------------------------|
  | `ANTHROPIC_API_KEY` | Your Anthropic API key |

### 1. Add the caller workflow

Create `.github/workflows/ai-review.yml` in your repo:

```yaml
name: Review Hero
on:
  pull_request:
    types: [opened, synchronize, reopened, edited]

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    uses: beyondessential/review-hero/.github/workflows/review.yml@main
    secrets: inherit
```

`secrets: inherit` passes through both the org-level app credentials and the repo-level Anthropic key automatically.

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
    types: [opened, synchronize, reopened, edited]

permissions:
  actions: read
  contents: write
  pull-requests: write

jobs:
  auto-fix:
    uses: beyondessential/review-hero/.github/workflows/auto-fix.yml@main
    secrets: inherit
```

Then add the checkboxes to your PR template:

```markdown
- [ ] **Auto-fix review suggestions** <!-- #auto-fix -->
- [ ] **Auto-fix CI failures** <!-- #auto-fix-ci -->
```

Each checkbox triggers independently — you can fix review comments, CI failures, or both. Like the review checkbox, they're automatically unchecked after completion.

**Note:** Auto-Fix needs broader permissions than review (`contents: write` to push commits, `actions: read` to fetch CI logs). The Review Hero GitHub App also needs write access to push on behalf of the bot.

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

Drop a `.md` file into `.github/review-hero/prompts/` and it becomes an agent. The filename (minus `.md`) is the agent key. Define its display name and triage description in `config.yml` under `agents`.

Example — `.github/review-hero/prompts/project-conventions.md`:

```markdown
# Agent: Project Conventions

Check for project-specific conventions and domain rules.

Read `docs/CONVENTIONS.md` for the rules.

Ignore: high-level architecture, performance, generic security, generic bugs.
```

The triage step will automatically discover it and include it in Haiku's agent selection.

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

## Workflow inputs

The caller workflow can pass these optional inputs:

```yaml
jobs:
  review:
    uses: beyondessential/review-hero/.github/workflows/review.yml@main
    with:
      trigger: checkbox        # 'checkbox' (default) or 'always'
      model: claude-sonnet-4-6  # Claude model for agents
      runner: ubuntu-slim      # Runner for all jobs
    secrets: inherit
```

| Input     | Default            | Description |
|-----------|--------------------|-------------|
| `trigger` | `checkbox`         | `checkbox` = only runs when the PR body checkbox is checked. `always` = runs on every PR event. |
| `model`   | `claude-sonnet-4-6`| The Claude model used by review agents. |
| `runner`  | `ubuntu-slim`      | GitHub Actions runner for all jobs. |

### Auto-Fix inputs

```yaml
jobs:
  auto-fix:
    uses: beyondessential/review-hero/.github/workflows/auto-fix.yml@main
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

## PR template snippet

Here's a complete block you can drop into `.github/pull_request_template.md`:

```markdown
### 🦸 Review Hero

- [ ] **Run Review Hero** <!-- #ai-review -->
- [ ] **Auto-fix review suggestions** <!-- #auto-fix -->
- [ ] **Auto-fix CI failures** <!-- #auto-fix-ci -->
```

Omit the auto-fix lines if your repo doesn't use the auto-fix workflow.