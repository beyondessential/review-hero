---
id: CMPL
---

# Completion comments

When a review or auto-fix run ends, Review Hero posts a completion comment on the pull request.
Each completion comment names the commit the run worked on and carries a hidden, machine-readable block describing the run, so tools such as Workhorse can track Review Hero's state on a pull request without scraping the visible text.

Completion comments are:

- the review summary at the end of a review round
- the comment posted when a review could not complete because every agent failed
- the auto-fix comments for each way an auto-fix run ends: fixes applied, no file changes needed, partially completed, failed, and nothing to fix
- the save-suppressions comments: suppressions saved, no new suppressions, and save failed

## Reviewed commit

- [ ] The reviewed commit is the pull request's head commit as of the event that triggered the review.
- [ ] Triage takes the diff at the reviewed commit, so a push made while the review is queued or running does not change what the agents see.
- [ ] The review agents check out the reviewed commit.
- [ ] Inline review comments are anchored to the reviewed commit, including when the pull request has moved on by the time they are posted.

## Commits shown in the visible text

- [ ] Each commit is shown as its short SHA, linked to that commit within the pull request.
- [ ] The review summary names the reviewed commit on its header line, after the round.
- [ ] The comment for a review where every agent failed names the reviewed commit.
- [ ] An auto-fix or save-suppressions comment names the commit the run started from.
- [ ] When the run pushed commits, the comment also names the new head it pushed, including when a failed run pushed partial fixes before stopping.

## Machine-readable block

- [ ] Every completion comment ends with exactly one HTML comment of the form `<!-- review-hero:completion {…} -->`, where `{…}` is a single-line JSON object.
- [ ] The block does not show when the comment is rendered on GitHub.
- [ ] No value in the JSON can end the HTML comment early: any `>` in a value is written as the JSON escape `\u003e`.
- [ ] The JSON carries only run metadata and counts, never finding or comment text.
- [ ] The README documents every field and outcome in the block, for consumers.

### Fields

- [ ] `schema` is the integer version of the block's shape, starting at 1.
- [ ] Adding a field keeps the same `schema` number, and removing a field or changing what it means increments it.
- [ ] `kind` is `review`, `auto-fix`, or `save-suppressions`.
- [ ] `outcome` says how the run ended, from the set of outcomes for its `kind` (see below).
- [ ] `runUrl` links to the GitHub Actions run that posted the comment.
- [ ] `reviewHero.ref` is the Review Hero ref the caller asked for (for example `v1`), and `reviewHero.sha` is the Review Hero commit that ref resolved to for the run.
- [ ] All SHAs in the block are full 40-character SHAs.

### Review

- [ ] `outcome` is `completed` when at least one agent returned results, and `failed` when every agent failed.
- [ ] `reviewedSha` is the reviewed commit.
- [ ] `counts` holds `agentsCompleted`, `agentsFailed`, `voters`, `critical`, `suggestion`, `nitpick`, `belowThreshold`, and `suppressed`, matching the figures in the visible summary.

### Auto-fix

- [ ] `outcome` is `fixed` when fixes were pushed, `no-changes` when the run finished without needing file changes, `partial` when some fixes were pushed before the run failed, `failed` when the run failed without pushing, and `nothing-to-fix` when there were no unresolved review comments or CI failures to work on.
- [ ] `baseSha` is the commit the run started from, and `pushedSha` is the new head the run pushed, or `null` when it pushed nothing.
- [ ] A run that finishes its fixes saves suppressions from developer feedback before posting its comment, so `pushedSha` is the final head, including any suppressions commit.
- [ ] The comment for such a run says how many suppressions were saved when it saved any, or that saving them failed.
- [ ] For `fixed` and `no-changes`, `counts` holds `reviewCommentsFixed`, `reviewCommentsSkipped`, `ciFailuresFixed`, `ciFailuresSkipped`, and `suppressionsSaved`, leaving out `suppressionsSaved` when saving suppressions failed.
- [ ] For `partial` and `failed`, `counts` holds `outstanding`, the number of review comments listed in the comment's local fix prompt.
- [ ] A run that failed before it could count its work leaves `counts` out, and leaves `baseSha` out if it failed before checking out a commit.

### Save suppressions

- [ ] A save-suppressions comment is posted when an auto-fix run had nothing to fix and saving suppressions was requested.
- [ ] `outcome` is `saved` when new suppressions were committed, `none` when there were no new suppressions to save, and `failed` when saving failed.
- [ ] `fixRequested` is `true` when an auto-fix had also been requested and found nothing to fix, and `false` when only saving suppressions was requested.
- [ ] `baseSha` is the commit the run started from, and `pushedSha` is the new head carrying the suppressions commit, or `null` when nothing was pushed.
- [ ] `counts.saved` is the number of suppressions committed, and `counts` is left out when saving failed.
