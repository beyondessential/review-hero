# Review Hero — Implementation Plan

## Goal

Turn the Tamanu-specific AI review system into a **reusable, org-wide GitHub Actions workflow** that any repo can adopt with a ~12-line caller workflow and optional per-repo customisation.

## Architecture

```
┌─────────────┐     workflow_call      ┌──────────────────────────────────┐
│ Caller repo │ ──────────────────────>│ review-hero (this repo)          │
│             │  secrets + inputs       │                                  │
│ .github/    │                         │ .github/workflows/review.yml     │
│  workflows/ │                         │  ├─ triage job                   │
│   ai-review │                         │  ├─ review-agent job (matrix)    │
│   .yml      │                         │  └─ orchestrate-review job       │
│             │                         │                                  │
│ .github/    │  (read at runtime)      │ scripts/                         │
│  review-hero│ <───────────────────────│  ├─ triage.mjs                   │
│  /config.yml│                         │  └─ orchestrate.mjs              │
│  /prompts/  │                         │                                  │
│   *.md      │                         │ prompts/                         │
│             │                         │  ├─ agent-prompt.md              │
└─────────────┘                         │  ├─ bugs.md                      │
                                        │  ├─ performance.md               │
                                        │  ├─ design.md                    │
                                        │  └─ security.md                  │
                                        └──────────────────────────────────┘
```

### Three-job pipeline (same as Tamanu, but generic)

1. **Triage** — Checks the PR checkbox trigger, discovers base + custom agents,
   calls Claude Haiku to select relevant agents, calculates max-turns from diff
   size.

2. **Review Agents** — Parallel matrix of Claude Code CLI invocations, one per
   selected agent. Each gets the base prompt + its specialisation prompt + the
   PR diff. Has read-only tool access to the checked-out repo.

3. **Orchestrate** — Downloads all agent artifacts, deduplicates findings,
   resolves stale review-hero threads, posts inline review comments
   (critical/suggestion) and a summary comment (with nitpicks table) via the
   GitHub App identity.

## Repo structure

```
review-hero/
├── PLAN.md                          # This file
├── README.md                        # Setup guide for consumers
├── .github/
│   └── workflows/
│       ├── review.yml               # Reusable review workflow
│       └── auto-fix.yml             # Reusable auto-fix workflow (opt-in)
├── scripts/
│   ├── triage.mjs                   # Haiku-based agent selection
│   ├── orchestrate.mjs              # Dedup + GitHub API review posting
│   └── auto-fix.mjs                 # Fix review comments + CI failures
└── prompts/
    ├── agent-prompt.md              # Base system prompt (generic)
    ├── auto-fix.md                  # Auto-fix agent prompt
    ├── bugs.md                      # Bugs & correctness agent
    ├── performance.md               # Performance agent
    ├── design.md                    # Design & architecture agent
    └── security.md                  # Security agent
```

### Consumer repo convention

Repos that want AI review add a caller workflow (and optionally an auto-fix
workflow):

**1. Review workflow** (`.github/workflows/ai-review.yml`):

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

**2. (Optional) Auto-fix workflow** (`.github/workflows/ai-auto-fix.yml`):

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

**3. (Optional) Repo-specific config** (`.github/review-hero/`):

```
.github/review-hero/
├── config.yml
├── auto-fix-rules.md             # Extra rules appended to auto-fix prompt
└── prompts/
    └── project-conventions.md    # Or any name — each .md becomes a review agent
```

`config.yml` schema:

```yaml
# Project metadata — used in the base prompt so the model has context
project: Tamanu
description: A healthcare management system

# Custom agents (one entry per .md file in prompts/)
agents:
  project-conventions:
    name: "Project Conventions"           # Display name in review comments
    description: "Tamanu conventions, migrations, FHIR, sync, permissions"  # For triage

# Extra file patterns to exclude from the diff (added to built-in defaults)
ignore_patterns:
  - "some-generated-dir/**"
```

If no `config.yml` exists, only the 4 base agents run and the base prompt
is generic ("You are reviewing a pull request").

## Cross-repo checkout strategy

A reusable workflow's `GITHUB_TOKEN` is scoped to the **caller** repo. To
access scripts and prompts from this repo, we generate a GitHub App token
scoped to the org:

```yaml
- uses: actions/create-github-app-token@v1
  with:
    app-id: ${{ secrets.REVIEW_HERO_APP_ID }}
    private-key: ${{ secrets.REVIEW_HERO_PRIVATE_KEY }}
    owner: ${{ github.repository_owner }}
```

This gives a token with read access to both the caller repo and review-hero
(assuming the app is installed on both). Each job that needs review-hero files
does:

```yaml
- uses: actions/checkout@v4
  with:
    repository: beyondessential/review-hero
    path: .review-hero
    token: ${{ steps.app-token.outputs.token }}
```

The caller repo is checked out at the workspace root as usual.

| Job               | Needs caller repo? | Needs review-hero? |
|-------------------|--------------------|--------------------|
| triage            | Yes (config, diff) | Yes (triage.mjs)   |
| review-agent      | Yes (code at HEAD) | Yes (prompts)       |
| orchestrate       | No                 | Yes (orchestrate.mjs) |

## Reusable workflow interface

```yaml
on:
  workflow_call:
    inputs:
      trigger:
        description: "'checkbox' = only on PR body edit with checkbox checked, 'always' = every PR event"
        type: string
        default: checkbox
      model:
        description: "Claude model for review agents"
        type: string
        default: claude-sonnet-4-6
      runner:
        description: "Runner for agent jobs (needs more compute)"
        type: string
        default: ubuntu-latest
      light-runner:
        description: "Runner for triage/orchestrate (lightweight)"
        type: string
        default: ubuntu-latest
    secrets:
      ANTHROPIC_API_KEY:
        required: true
      REVIEW_HERO_APP_ID:
        required: true
      REVIEW_HERO_PRIVATE_KEY:
        required: true
```

## Script changes from Tamanu originals

### `triage.mjs`

- Remove hardcoded `ALL_AGENTS` — base agents are discovered by reading
  `prompts/*.md` from the review-hero checkout (excluding `agent-prompt.md`)
- Read `.github/review-hero/config.yml` from the caller repo to discover
  custom agents and their descriptions
- Merge base + custom agents into the full list
- Output `agent_names` (JSON map of key → display name) alongside `matrix`
  and `max_turns` so orchestrate can use it without hardcoding

### `orchestrate.mjs`

- Remove hardcoded `AGENT_NAMES` — read from `AGENT_NAMES` env var (JSON),
  set by the workflow from triage outputs
- Everything else is already generic

### `agent-prompt.md`

- Remove "Tamanu, a healthcare management system" reference
- If caller provides project name/description in config.yml, the workflow
  prepends a `## Project Context` section to the prompt at runtime
- If no config, the prompt is simply "You are reviewing a pull request"

### Base prompts (`bugs.md`, `performance.md`, `design.md`, `security.md`)

- Remove Tamanu-specific references (Sequelize, React hooks, etc.)
- Keep them language/framework agnostic — the model can infer the tech stack
  from the diff and surrounding code

### Diff filtering / ignore patterns

The triage script strips ignored file hunks from the diff **before** counting
lines and **before** the diff is passed to agents. This saves tokens and
prevents agents from commenting on noise.

Built-in defaults (always excluded):

```
package-lock.json
yarn.lock
pnpm-lock.yaml
Cargo.lock
go.sum
composer.lock
Gemfile.lock
poetry.lock
*.generated.*
```

Consumer repos can extend this list via `ignore_patterns` in their
`config.yml`. Patterns use minimatch/glob syntax.

### Cost guardrails

- Max-turns scales with (filtered) diff size: <100 lines → 3, <500 → 5,
  else → 10. The cap is 10 regardless of diff size.
- Triage uses Haiku to skip irrelevant agents, so small PRs don't run all 4+.
- Diff filtering removes lockfiles and generated files before line counting,
  so a lockfile churn commit doesn't inflate the turn budget.
- We never skip a review entirely — even a huge PR gets capped at 10 turns.

## Build order

1. `prompts/` — Base prompt and 4 specialisation prompts (generic)
2. `scripts/triage.mjs` — Generic triage with agent discovery
3. `scripts/orchestrate.mjs` — Generic orchestrator
4. `.github/workflows/review.yml` — The reusable workflow
5. `README.md` — Consumer setup guide

## Secrets required (per-consumer repo)

| Secret                   | Purpose                                      |
|--------------------------|----------------------------------------------|
| `ANTHROPIC_API_KEY`      | Claude API (Haiku for triage, Sonnet for agents) |
| `REVIEW_HERO_APP_ID`     | GitHub App ID for posting reviews as bot     |
| `REVIEW_HERO_PRIVATE_KEY`| GitHub App private key                       |

The Review Hero GitHub App needs to be installed on both this repo (so it can
be checked out) and any consumer repo (so it can post reviews). Permissions
needed:

- **Pull requests**: Read & write (post reviews, read PR body)
- **Contents**: Read (checkout code)
- **Issues**: Write (post summary comments)

## Decisions

- **Pinning**: consumers reference `@main` for now. We can introduce tagged
  releases later once the system is proven.
- **PR template snippet**: yes — the README includes a ready-to-paste checkbox
  block for consumer PR templates.
- **Cost guardrails**: cap max-turns at 10, never skip. Ignore lockfiles and
  generated files from diff size calculation and agent input.

## Future work

- Tagged releases for stability once the system is battle-tested.
- GitHub Actions usage metrics / cost tracking.
- Optional "auto" trigger mode that runs on every PR without the checkbox.
```

Now let me build the files, starting with the prompts:

<file_path>
review-hero/prompts/agent-prompt.md
</file_path>

<edit_description>
Create the generic base agent prompt, parameterized (the workflow will prepend project context if available)
</edit_description>