# Developing Review Hero

This document is for maintainers of Review Hero. For setup and usage, see [README.md](README.md). For architecture and design decisions, see [PLAN.md](PLAN.md).

## Project structure

```
.github/
  workflows/
    review.yml          # Reusable workflow — the review pipeline (triage → agents → orchestrate)
    auto-fix.yml        # Reusable workflow — the auto-fix pipeline
    ai-review.yml       # Caller workflow — dogfooding Review Hero on this repo
    ai-auto-fix.yml     # Caller workflow — dogfooding auto-fix on this repo
    release.yml         # Moves floating major version tags on release
prompts/
    agent-prompt.md     # Base prompt shared by all review agents
    bugs.md             # Bugs & Correctness agent specialisation
    performance.md      # Performance agent specialisation
    design.md           # Design & Architecture agent specialisation
    security.md         # Security agent specialisation
    auto-fix.md         # Auto-fix prompt
scripts/
    triage.mjs          # Triage: diff filtering, agent discovery, Haiku agent selection
    orchestrate.mjs     # Orchestrator: dedup findings, post review comments
    auto-fix.mjs        # Auto-fix: fetch comments/CI failures, run Claude, commit/push
    git-commit-fix.mjs  # Helper for Claude to commit individual fixes during auto-fix
    detect-ai-rules.sh  # Detects AI rules files (.cursorrules, copilot-instructions, etc.)
```

## Branch protection

This repo requires PRs to merge to `main`. Direct pushes to `main` are not allowed.

## Versioning

We follow [semantic versioning](https://semver.org/) with the standard GitHub Actions convention of **floating major version tags**.

Consumers pin to `@v1`, which always points at the latest compatible release:

```yaml
uses: beyondessential/review-hero/.github/workflows/review.yml@v1
```

The version contract:

- **Patch** (`v1.0.0` → `v1.0.1`) — bug fixes, prompt tweaks, minor improvements. No consumer action needed.
- **Minor** (`v1.0.0` → `v1.1.0`) — new features, new inputs/secrets with backwards-compatible defaults, new agents. No consumer action needed.
- **Major** (`v1.x.x` → `v2.0.0`) — breaking changes: removed/renamed inputs or secrets, changed default behaviour, anything that requires consumers to update their caller workflows.

## Releasing

### 1. Merge your PR

Get your changes into `main` via a pull request as usual.

### 2. Create a GitHub Release

Go to [Releases → Draft a new release](../../releases/new):

1. Click **Choose a tag** and type the new semver tag (e.g. `v1.2.3`). Select **Create new tag on publish**.
2. Set the target to `main`.
3. Set the release title to the tag name (e.g. `v1.2.3`).
4. Write release notes — click **Generate release notes** for a good starting point, then edit as needed.
5. Click **Publish release**.

### 3. The floating tag moves automatically

The [`release.yml`](.github/workflows/release.yml) workflow triggers on `release: published`. It parses the semver tag, extracts the major version (e.g. `v1` from `v1.2.3`), and force-moves the `v1` tag to point at the new release. Consumers on `@v1` pick up the update immediately.

You can verify it worked by checking that the `v1` tag now points at the same commit as your release tag:

```sh
git fetch --tags --force
git rev-parse v1
git rev-parse v1.2.3
# Should print the same SHA
```

### Choosing a version number

Look at what's changed since the last release and pick the appropriate bump:

| Change | Bump |
|--------|------|
| Fixed a bug in a script or prompt | Patch |
| Improved prompt quality or output formatting | Patch |
| Added a new optional workflow input with a default | Minor |
| Added a new optional secret | Minor |
| Added a new base agent | Minor |
| Renamed or removed a workflow input | **Major** |
| Changed a default that could break existing consumers | **Major** |
| Renamed required secrets | **Major** |

### First release

If no `v1.0.0` release exists yet, the first release creates both the `v1.0.0` tag and the `v1` floating tag. Consumers referencing `@v1` won't resolve until this is done.

### Rolling back

If a release breaks things, you have two options:

1. **Publish a new patch release** with the fix. This is preferred.
2. **Move the major tag back manually** to the previous good release as a stopgap:

   ```sh
   git tag -f v1 v1.2.2
   git push origin v1 --force
   ```

## Testing changes

There's no test suite — Review Hero is tested by dogfooding. This repo has its own caller workflows (`ai-review.yml` and `ai-auto-fix.yml`) that exercise the full pipeline.

To test changes before merging:

1. Push your branch.
2. In a test repo (or this repo), temporarily point the caller workflow at your branch:

   ```yaml
   uses: beyondessential/review-hero/.github/workflows/review.yml@my-branch
   ```

3. Open a PR and trigger a review. Check the Actions logs for the results.
4. Remember to revert the ref back to `@v1` after testing.

## Secrets and environment variables

### Workflow secrets

| Secret | Required | Description |
|--------|----------|-------------|
| `REVIEW_HERO_APP_ID` | Yes | GitHub App ID |
| `REVIEW_HERO_PRIVATE_KEY` | Yes | GitHub App private key (`.pem` contents) |
| `ANTHROPIC_API_KEY` | Yes* | Anthropic API key |
| `REVIEW_HERO_ANTHROPIC_API_KEY` | Yes* | Anthropic API key (takes priority over `ANTHROPIC_API_KEY`) |
| `ANTHROPIC_BASE_URL` | No | Custom Anthropic API base URL |
| `REVIEW_HERO_ANTHROPIC_BASE_URL` | No | Custom Anthropic API base URL (takes priority over `ANTHROPIC_BASE_URL`) |

\* At least one of `ANTHROPIC_API_KEY` or `REVIEW_HERO_ANTHROPIC_API_KEY` must be set.

### Key environment variables passed to scripts

| Variable | Used by | Description |
|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | triage, agents, auto-fix | Resolved from the `REVIEW_HERO_` variant or the plain variant |
| `ANTHROPIC_BASE_URL` | triage, agents, auto-fix | Custom API base URL (optional) |
| `APP_SLUG` | orchestrate, auto-fix | GitHub App slug, used to derive `{slug}[bot]` for identity matching and git commits |
| `GITHUB_TOKEN` | orchestrate, auto-fix | App installation token for GitHub API calls |
| `GITHUB_ACTIONS_TOKEN` | orchestrate | Built-in `GITHUB_TOKEN` used to uncheck the checkbox without re-triggering the workflow |

## Cross-org support

This repo is public, so external users can reference our reusable workflows directly. Key design points:

- **Review-hero checkout** uses `repository: beyondessential/review-hero` with no token (public repo, read-only).
- **App token generation** uses `owner: ${{ github.repository_owner }}` — this scopes to the *caller's* org, where their own GitHub App is installed.
- **`APP_SLUG`** is detected at runtime via `gh api /app`, so it works regardless of what the user named their app.
- Users bring their own GitHub App and their own Anthropic key. We host nothing but this repo.