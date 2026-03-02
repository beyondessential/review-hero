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

## Prerequisites (one-time org admin setup)

> [!WARNING]
> At the moment this app is not configured to be possible to use outside of the beyondessential org.
> You'll need to fork it and create your own app for your own organisation.

### 1. Configure the Review Hero GitHub App

The app needs these permissions:

- **Pull requests**: Read & write
- **Contents**: Read & write (for auto-fix commits)
- **Issues**: Read & write
- **Actions**: Read (for fetching CI failure logs)

### 2. Generate a private key

In the GitHub App's settings page, scroll to the **Private keys** section at the bottom and click **Generate a private key**. This downloads a `.pem` file — the contents of this file are the private key.

> **Note:** This is _not_ the same as the "Client secret" in the app's OAuth settings. The private key is a PEM file used to mint short-lived installation tokens.

### 3. Install the app on repos

Go to the app's **Install App** page and install it on your organisation. Select specific repositories — it must be installed on both the **review-hero** repo (so workflows can check it out) and any consumer repo you want to enable.

### 4. Set org-level secrets

Under the org's **Settings → Secrets and variables → Actions**, add:

| Secret                    | Value                                                    |
|---------------------------|----------------------------------------------------------|
| `REVIEW_HERO_APP_ID`      | The App ID (found on the app's settings page)            |
| `REVIEW_HERO_PRIVATE_KEY` | The full contents of the `.pem` private key file         |

These are automatically inherited by all repos in the org.

Configure the private key to only be available to the set of consumer repos for Review Hero, and the app ID to be available for every repo within the org.

## Setup (per repo)

### 0. Secrets

Each consumer repo needs its own API key:

| Secret              | Value                  |
|---------------------|------------------------|
| `ANTHROPIC_API_KEY` | Your Anthropic API key |

An admin also needs to add the repo to:
- the [Review Hero Install App](https://github.com/organizations/beyondessential/settings/apps/review-hero/installations) page
- the [private key org secret](https://github.com/organizations/beyondessential/settings/secrets/actions/REVIEW_HERO_PRIVATE_KEY) repository access list

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
    uses: beyondessential/review-hero/.github/workflows/review.yml@main
    secrets: inherit
```

`secrets: inherit` passes through both the org-level app credentials and the repo-level Anthropic key automatically.

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
    uses: beyondessential/review-hero/.github/workflows/auto-fix.yml@main
    secrets: inherit
```

> **Note:** Do _not_ add `synchronize` here — auto-fix pushes commits to the PR branch, so triggering on new pushes would cause an infinite loop.

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

> **Security note:** Custom agent prompts, `config.yml`, `auto-fix-rules.md`, and AI rules files (`.cursorrules`, etc.) are always read from the **base branch**, not the PR branch. This prevents a pull request from injecting malicious prompt content by adding or modifying these files. Changes to custom agents or config take effect only after they're merged.

### Sandbox configuration

By default, every Claude invocation uses [Claude's native sandboxing](https://code.claude.com/docs/en/sandboxing) for filesystem and network isolation (see [Security](#security)). On Linux (GitHub Actions runners), this uses [bubblewrap](https://github.com/containers/bubblewrap) and socat, which are installed automatically by the workflow. Repos that need to opt out of sandboxing can configure it in `config.yml`:

```yaml
sandbox:
  # Disable native sandboxing (Claude runs without filesystem/network isolation)
  # dangerousDisableSandbox: true
```

#### Disabling the sandbox

> [!CAUTION]
> Disabling the sandbox means Claude's Bash commands have unrestricted filesystem and network access on the runner. The API key is still secured via `apiKeyHelper` (never passed as an env var), but a prompt injection attack could potentially access other files or network resources. Only enable this if you understand the security implications and accept the risk.

```yaml
sandbox:
  dangerousDisableSandbox: true
```

When the sandbox is disabled, `run-claude.mjs` sets `sandbox.enabled: false` in Claude's settings. Claude CLI is still invoked the same way, and the API key is still secured via `apiKeyHelper` — only the OS-level filesystem and network isolation is removed.

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

### GitHub Actions minutes

Review Hero uses [reusable workflows](https://docs.github.com/en/actions/sharing-automations/reusing-workflows), which means all jobs run against the **calling repo's** Actions minute quota and billing — not this repo's. If your org uses GitHub-hosted runners on private repos, each review run (triage + agents + orchestrator) and each auto-fix run count towards the consumer repo's monthly included minutes or usage charges.

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

## Security

Review Hero uses [Claude's native sandboxing](https://code.claude.com/docs/en/sandboxing) (bubblewrap on Linux) to limit the blast radius of prompt injection attacks. Since Claude processes untrusted input (PR diffs, review comments, CI logs), the sandbox provides OS-level filesystem and network isolation to prevent a manipulated model from extracting secrets or escalating privileges.

Repos can [disable the sandbox](#disabling-the-sandbox) if needed. See [Sandbox configuration](#sandbox-configuration) for details.

### Sandbox properties

| Property | Review agents | Auto-fix (review) | Auto-fix (CI) |
|----------|--------------|-------------------|---------------|
| Filesystem writes | CWD only (default) | CWD + `/tmp` | CWD + `/tmp` |
| Network | Blocked (default) | Blocked (default) | Allowed |
| Bash access | Scoped to `git log`, `git show`, `git diff` | Scoped to commit helper | Unrestricted (needs build tools) |
| Unsandboxed escape hatch | ❌ `allowUnsandboxedCommands: false` | ❌ `allowUnsandboxedCommands: false` | ❌ `allowUnsandboxedCommands: false` |
| ANTHROPIC_API_KEY | Via `apiKeyHelper` (temp file) | Via `apiKeyHelper` (temp file) | Via `apiKeyHelper` (temp file) |

### Protected paths

The following directories are denied at **both** the sandbox filesystem level (blocks Bash subprocesses) and the tool permissions level (blocks Claude's Edit tool), providing two independent layers of protection:

| Path | Reason |
|------|--------|
| `.review-hero/` | Review Hero tooling (scripts, prompts). The [commit helper](#committing) provides a third layer by refusing to stage files here. |
| `.github/workflows/` | Workflow files are arbitrary code execution on push — modifying them is a privilege escalation vector. |
| `.git/hooks/` | Git hooks execute automatically during git operations (e.g. the commit helper runs `git commit`, which triggers `post-commit`). |

### Git credential stripping

`actions/checkout` stores the GitHub token in `.git/config` as an HTTP extraheader. In the auto-fix workflow this is the **GitHub App token** with push access — a high-value target for prompt injection. Before running Claude, `run-claude.mjs` strips all `http.*.extraheader` entries from the local git config and restores them in a `finally` block so the calling script can still push afterwards. This is complementary to the sandbox network isolation, which independently blocks `github.com` from sandboxed Bash commands.

### Network isolation

For **review-agent** and **review-fix**, the sandbox blocks all outbound network from Bash commands by default. In headless mode (`-p`) there is no user to approve new domains, so every outbound request is denied. These modes don't need network access.

For **ci-fix**, build tools need to download dependencies, run linters, and talk to package registries, so we allow everything.

Claude CLI itself runs outside the sandbox and can still reach the Anthropic API (`api.anthropic.com`) for model requests.

### API key handling

The Anthropic API key is written to a temporary file (mode `0o600`) and exposed to Claude CLI via the `apiKeyHelper` setting (`cat /path/to/key`). The `ANTHROPIC_API_KEY` environment variable is **not** forwarded to the Claude process, so sandboxed Bash commands cannot access it via the environment. The temp file is additionally protected by `permissions.deny` (blocking Claude's Read tool) and `sandbox.filesystem.denyRead` (blocking sandboxed Bash). The temp file is deleted in a `finally` block after Claude exits.

### Pre-push secret scanning

After Claude finishes but before any commits are pushed, all new diffs and commit messages are scanned for:

- Known secret format patterns (`sk-ant-*`, `ghp_*`, `ghs_*`, PEM private keys, etc.)
- Exact value matches against secrets available to the workflow

If a match is found, all commits are hard-reset and the push is aborted.

### Base-branch isolation

Custom agent prompts, `config.yml`, `auto-fix-rules.md`, and AI rules files (`.cursorrules`, etc.) are always read from the **base branch**, not the PR branch. This prevents a pull request from injecting malicious prompt content or disabling the sandbox. See the [Custom agents](#custom-agents) and [Sandbox configuration](#sandbox-configuration) sections for details.

## PR template snippet

Here's a complete block you can drop into `.github/pull_request_template.md`:

```markdown
### 🦸 Review Hero

- [ ] **Run Review Hero** <!-- #ai-review -->
- [ ] **Auto-fix review suggestions** <!-- #auto-fix -->
- [ ] **Auto-fix CI failures** <!-- #auto-fix-ci -->
```

Omit the auto-fix lines if your repo doesn't use the auto-fix workflow.
