# M1: Report commit SHA in completion comments

## Tech notes

- Reviewed SHA: pass `github.event.pull_request.head.sha` to the orchestrator as an env var and drop `getLatestCommit` (`scripts/orchestrate.mjs`), so inline comments anchor to the reviewed commit.
- Triage diff: `gh pr diff` returns the live head, so triage uses the compare API at `base.sha...head.sha` from the event. On two merged PRs in this repo, it produced output byte-identical to `gh pr diff`.
- Review Hero ref: pass `inputs.ref` as an env var. The SHA is resolved from the checkout the scripts run from (`reviewHeroVersion` in `scripts/lib.mjs`), so neither workflow needs to pass a path.
- Run URL: build it from `GITHUB_SERVER_URL`, `GITHUB_REPOSITORY`, and `GITHUB_RUN_ID`. `workflowLogsUrl` in `scripts/lib.mjs` already does this.
- Put the block builder (JSON serialisation with `>` escaped, plus the marker) and the short-SHA link formatter in `src/summary.mjs` and export them from `src/index.mjs`, so a library consumer produces the same block.
- Auto-fix: take `baseSha` at the start of `main()` so the top-level `catch` can report it. Track the pushed head wherever `pushChanges()` runs.
- Auto-fix success path: move the trailing `runSaveSuppressions()` call ahead of the summary post, so the summary reports the final head and the saved count. Catch its failure and report that failure in the summary rather than just logging a warning.
- Keep `SUMMARY_HEADER` as the prefix of the review summary, so `countPreviousRounds` still matches older and newer summaries.

## Steps

- [x] Workflow env wiring (reviewed SHA, ref, resolved SHA) for review and auto-fix
- [x] Triage diff at the reviewed commit
- [x] Block builder and SHA link helper in `src/summary.mjs`, with tests
- [x] Review summary and all-agents-failed comments
- [x] Auto-fix and save-suppressions comments
- [x] README section documenting the block
