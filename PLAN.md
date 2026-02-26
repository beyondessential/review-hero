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
│ .github/    │  (read at runtime)      │ .github/workflows/auto-fix.yml   │
│  review-hero│ <───────────────────────│  ├─ check-trigger job            │
│  /config.yml│                         │  └─ auto-fix job                 │
│  /prompts/  │                         │                                  │
│   *.md      │                         │ scripts/                         │
│             │                         │  ├─ triage.mjs                   │
└─────────────┘                         │  ├─ orchestrate.mjs              │
                                        │  └─ auto-fix.mjs                 │
                                        │                                  │
                                        │ prompts/                         │
                                        │  ├─ agent-prompt.md              │
                                        │  ├─ auto-fix.md                  │
                                        │  ├─ bugs.md                      │
                                        │  ├─ performance.md               │
                                        │  ├─ design.md                    │
                                        │  └─ security.md                  │
                                        └──────────────────────────────────┘
```

## Review pipeline

Three jobs run in sequence:

1. **Triage** — Checks the PR checkbox trigger, discovers base + custom agents,
   calls Claude Haiku to select relevant agents, strips ignored files from the
   diff, and calculates max-turns from filtered diff size.

2. **Review Agents** — Parallel matrix of Claude Code CLI invocations, one per
   selected agent. Each gets the base prompt + its specialisation prompt + the
   PR diff. Has read-only tool access to the checked-out repo for exploring
   surrounding code.

3. **Orchestrate** — Downloads all agent artifacts, deduplicates findings by
   file and line proximity, resolves stale review-hero threads, posts inline
   review comments (critical/suggestion) and a summary comment (with nitpicks
   table) via the GitHub App identity. Unchecks the PR checkbox so subsequent
   edits don't re-trigger.

## Auto-fix pipeline

Opt-in per repo — consumers add a separate caller workflow to enable it. Two
jobs:

1. **Check Trigger** — Looks for two independent checkboxes in the PR body:
   one for fixing review suggestions, one for fixing CI failures.

2. **Auto-Fix** — Fetches unresolved review threads and/or CI failure logs,
   builds a prompt, runs Claude Code CLI with edit tools to apply fixes,
   commits and pushes the result. Resolves fixed threads, replies on skipped
   ones, and posts a summary comment. The runner is automatically upgraded
   from `ubuntu-slim` to `ubuntu-latest` when fixing CI failures, since Claude
   may need to run build tools or test suites to verify fixes.

## Cross-repo checkout strategy

A reusable workflow's `GITHUB_TOKEN` is scoped to the caller repo. To access
scripts and prompts from this repo, we generate a GitHub App token scoped to
the org via `actions/create-github-app-token` with `owner` set. This gives a
token with read access to both the caller repo and review-hero (assuming the
app is installed on both). Each job checks out both repos as needed.

| Job               | Needs caller repo? | Needs review-hero? |
|-------------------|--------------------|--------------------|
| triage            | Yes (config, diff) | Yes (triage.mjs)   |
| review-agent      | Yes (code at HEAD) | Yes (prompts)       |
| orchestrate       | No                 | Yes (orchestrate.mjs) |
| check-trigger     | No                 | No                  |
| auto-fix          | Yes (push access)  | Yes (auto-fix.mjs)  |

## Consumer repo convention

Repos that want AI review add a caller workflow and a PR template checkbox.
Repos that also want auto-fix add a second caller workflow and two more
checkboxes. Both use `secrets: inherit` so org-level app credentials and
per-repo Anthropic keys flow through automatically.

Optional per-repo customisation lives in `.github/review-hero/`:

- **`config.yml`** — project name and description (injected into prompts as
  context), custom agent definitions (key, display name, triage description),
  and extra ignore patterns for diff filtering.
- **`prompts/*.md`** — each file becomes a custom review agent, discovered
  automatically by the triage script alongside the base agents.
- **`auto-fix-rules.md`** — project-specific rules appended to the auto-fix
  prompt (e.g. spelling conventions, links to coding standards docs).

If no config exists, only the 4 base agents run and prompts are generic.

## Agent discovery

The triage script discovers agents from two sources:

- **Base agents** — `bugs`, `performance`, `design`, `security` — defined in
  this repo's `prompts/` directory with metadata hardcoded in the script.
- **Custom agents** — any `.md` file in the caller repo's
  `.github/review-hero/prompts/`. Metadata (display name, triage description)
  comes from `config.yml`; falls back to title-casing the filename.

Each agent in the matrix carries a `key` and `source` (`base` or `custom`).
The workflow constructs the correct prompt path at runtime since the filesystem
layout differs between the triage and agent jobs.

## Diff filtering and cost guardrails

The triage script strips ignored file hunks from the diff before counting
lines and before the diff reaches agents. This saves tokens and prevents
agents from commenting on noise.

Built-in defaults cover common lockfiles and generated files
(`package-lock.json`, `yarn.lock`, `Cargo.lock`, `go.sum`, `*.generated.*`,
etc.). Consumer repos can extend the list via `ignore_patterns` in their
config.

Max-turns scale with filtered diff size and are capped at 10: <100 lines → 3,
100–499 → 5, 500+ → 10. Triage uses Haiku to skip irrelevant agents, so small
PRs don't run all 4+. We never skip a review entirely.

## Secrets and credentials

- **`ANTHROPIC_API_KEY`** — set per-repo for billing separation. Used by both
  Haiku (triage) and Sonnet (agents, auto-fix).
- **`REVIEW_HERO_APP_ID`** and **`REVIEW_HERO_PRIVATE_KEY`** — set as org-level
  secrets. The Review Hero GitHub App needs to be installed on both this repo
  (so it can be checked out) and any consumer repo (so it can post reviews and
  push auto-fix commits).

Required GitHub App permissions:

- **Pull requests**: Read & write (post reviews, read PR body, uncheck checkboxes)
- **Contents**: Read & write (checkout code, push auto-fix commits)
- **Issues**: Read & write (post summary comments)
- **Actions**: Read (fetch CI failure logs for auto-fix)

## Decisions

- **Pinning**: consumers reference `@main` for now. Tagged releases can be
  introduced later once the system is proven.
- **PR template snippet**: the README includes a ready-to-paste checkbox block
  for consumer PR templates.
- **Cost guardrails**: cap max-turns at 10, never skip. Ignore lockfiles and
  generated files from diff size calculation and agent input.
- **Runner defaults**: `ubuntu-slim` for everything except auto-fix when fixing
  CI failures, which uses `ubuntu-latest` (build tools may be needed).
- **Auto-fix is opt-in**: repos must explicitly add the auto-fix caller
  workflow. The review workflow is independent.
- **Org secrets for app creds**: `REVIEW_HERO_APP_ID` and
  `REVIEW_HERO_PRIVATE_KEY` are org-level secrets. Only `ANTHROPIC_API_KEY` is
  per-repo, for billing separation. Consumer workflows use `secrets: inherit`.

## Future work

- Tagged releases for stability once the system is battle-tested.
- GitHub Actions usage metrics / cost tracking.
- Optional "auto" trigger mode that runs on every PR without the checkbox.