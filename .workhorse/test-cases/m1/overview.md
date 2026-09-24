# Completion comments test cases

Scenarios for the commit SHA and machine-readable block in Review Hero's completion comments.
The orchestrator and auto-fix flows have no automated harness.
Cases marked "(smoke)" were checked by running the script against a stubbed GitHub API, in a scratch git repo with a fake `claude`.

## Shared helpers

- [x] A commit link shows the short SHA and links to the commit within the PR (verifies spec: CMPL)
- [x] A commit link is refused for anything that is not a full SHA
- [x] The block is a single-line HTML comment with `schema` first (verifies spec: CMPL)
- [x] A value containing `-->`, `>` or a newline cannot close the HTML comment early, and it round-trips intact (verifies spec: CMPL)
- [x] The block parses back out of a full comment body that also contains other HTML comments
- [x] A body with no block, or a malformed one, parses to null
- [x] The reporter fills in `runUrl`, `reviewHero.ref`, and the resolved `reviewHero.sha`
- [x] The run URL is null outside Actions, and the logs URL still falls back to the Actions page
- [x] The summary header names the reviewed commit after the round (verifies spec: CMPL)
- [x] The review result counts kept groups by severity and reports voters, below-threshold and suppressed figures (verifies spec: CMPL)
- [x] A review with no completed agents is a `failed` result with zero counts (verifies spec: CMPL)
- [x] A review result serialises into the review block and parses back unchanged (verifies spec: CMPL)

## Review

- [x] The triage diff at the reviewed commit matches `gh pr diff` for a PR whose head hasn't moved (checked on two merged PRs in this repo) (verifies spec: CMPL)
- [x] (smoke) Inline review comments are posted against the reviewed SHA (verifies spec: CMPL)
- [x] (smoke) The summary links the reviewed commit and ends with a `review` / `completed` block whose counts match the header (verifies spec: CMPL)
- [x] (smoke) When every agent fails, the comment names the reviewed commit and ends with a `review` / `failed` block (verifies spec: CMPL)
- [ ] A push made while a review is queued doesn't change the diff the agents see, and inline comments land on the older commit as outdated (verifies spec: CMPL)
- [ ] The round still counts summaries posted before the header gained a commit link

## Auto-fix

- [x] (smoke) Nothing to fix: comment names the base commit, and the block is `auto-fix` / `nothing-to-fix` with `pushedSha: null` (verifies spec: CMPL)
- [x] (smoke) Fixes pushed: comment names the base commit and the pushed head, and the block is `fixed` with fixed/skipped counts and `suppressionsSaved` (verifies spec: CMPL)
- [x] (smoke) Claude fails without committing: block is `failed` with `outstanding` equal to the comments in the local fix prompt (verifies spec: CMPL)
- [x] (smoke) Claude fails after committing: partial fixes are pushed, the comment names both commits, and the block is `partial` with `outstanding` (verifies spec: CMPL)
- [x] (smoke) An unexpected error ends in the top-level failure comment with a block that has no `counts` (verifies spec: CMPL)
- [ ] After a successful fix run, a suppressions commit is included in `pushedSha`, and the comment says how many suppressions were saved (verifies spec: CMPL)
- [ ] After a successful fix run, a save-suppressions failure is reported in the comment, and `suppressionsSaved` is left out (verifies spec: CMPL)
- [ ] A push that has to rebase onto the remote reports the rebased head as `pushedSha`

## Save suppressions

- [x] (smoke) Only save suppressions was requested, with nothing new to save: block is `save-suppressions` / `none` with `fixRequested: false` and `counts.saved: 0` (verifies spec: CMPL)
- [x] (smoke) Fix and save suppressions were requested and there was nothing to fix: block has `fixRequested: true` (verifies spec: CMPL)
- [ ] New suppressions committed: block is `saved` with `pushedSha` set and `counts.saved` matching (verifies spec: CMPL)
- [ ] Saving fails: block is `failed` with no `counts` (verifies spec: CMPL)
