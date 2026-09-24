# M1: Report commit SHA in completion comments

## Tech notes

- Reviewed SHA: pass `github.event.pull_request.head.sha` to the orchestrator as an env var and drop `getLatestCommit` (`scripts/orchestrate.mjs`), so inline comments anchor to the reviewed commit.
- Triage diff: `gh pr diff` returns the live head. Replace it with a diff taken at the reviewed commit (e.g. the compare API `base...{reviewed sha}`, or `git diff` over a checkout of it).
- Review Hero ref: pass `inputs.ref` as an env var, and resolve the SHA with `git -C review-hero rev-parse HEAD` (`.review-hero` in the auto-fix workflow).
- Run URL: build it from `GITHUB_SERVER_URL`, `GITHUB_REPOSITORY`, and `GITHUB_RUN_ID`. `workflowLogsUrl` in `scripts/lib.mjs` already does this.
- Put the block builder (JSON serialisation with `>` escaped, plus the marker) and the short-SHA link formatter in `src/summary.mjs` and export them from `src/index.mjs`, so a library consumer produces the same block.
- Auto-fix: take `baseSha` at the start of `main()` so the top-level `catch` can report it. Track the pushed head wherever `pushChanges()` runs.
- Auto-fix success path: move the trailing `runSaveSuppressions()` call ahead of the summary post, so the summary reports the final head and the saved count. Catch its failure and report that failure in the summary rather than just logging a warning.
- Keep `SUMMARY_HEADER` as the prefix of the review summary, so `countPreviousRounds` still matches older and newer summaries.

## Steps

- [ ] Workflow env wiring (reviewed SHA, ref, resolved SHA) for review and auto-fix
- [ ] Triage diff at the reviewed commit
- [ ] Block builder and SHA link helper in `src/summary.mjs`, with tests
- [ ] Review summary and all-agents-failed comments
- [ ] Auto-fix and save-suppressions comments
- [ ] README section documenting the block
