# Post each review round's findings as data

Scenarios for posting a round's findings to a findings URL. The post, payload, schema, hunk and voter-count cases are covered by tests beside the code (`scripts/findings-post.test.mjs`, `src/round.test.mjs`, `src/grouping.test.mjs`, `scripts/consensus.test.mjs`, `scripts/run-checkers.test.mjs`, `scripts/review-workflow.test.mjs`). The cases that need a real workflow run on a pull request are listed last.

## Turning it on

- [x] No findings URL posts nothing, requests no token, and leaves `findingsPost` out of the block (verifies spec: FPOST)
- [x] A URL that is not https posts nothing, requests no token, logs it, and reports `invalid-url` (verifies spec: FPOST)
- [x] A job that cannot request an identity token reports `no-token` and posts nothing (verifies spec: FPOST)

## Authentication

- [x] The token's audience is the findings URL's origin and it is sent as the bearer (verifies spec: FPOST)
- [x] The token is masked in the job log (verifies spec: FPOST)
- [x] A transient token-request failure is tried once more, and a refusal is not (verifies spec: FPOST)
- [x] Only the posting job can request an identity token: the review job names its permissions without `id-token`, and the posting job declares none (verifies spec: RUN)
- [x] This repo's own caller grants `id-token: write` to the calling job alone (verifies spec: FPOST)
- [x] A payload that fails to build requests no identity token (verifies spec: FPOST)

## When a review posts

- [x] A 2xx is `accepted`, any other answer `refused`, and no answer `unreachable` (verifies spec: FPOST)
- [x] No answer or a 5xx is tried once more, the retry's result stands, and only one retry is made (verifies spec: FPOST)
- [x] A retry starts only with enough of the total time left (verifies spec: FPOST)
- [x] The log announces a retry only when one runs, and says when one was skipped for time (verifies spec: FPOST)
- [x] A retry that cannot fit costs no pause (verifies spec: FPOST)
- [x] The token request and the post share one time budget (verifies spec: FPOST)
- [x] A payload builder that returns nothing reports `error` and mints no token (verifies spec: FPOST)
- [x] Log lines strip control characters and any URL's path however it is written (verifies spec: FPOST)
- [x] A URL's userinfo never reaches the log (verifies spec: FPOST)
- [x] Every secret-bearing part of the findings URL is removed from every log line, raw or decoded, query values included (verifies spec: FPOST)
- [x] A reply is redacted before it is cut, so a URL running over the excerpt's end is caught (verifies spec: FPOST)
- [x] A refused reply that echoes the request's path has it removed (verifies spec: FPOST)
- [x] A 307 or 308 within the origin is followed, up to a few times, carrying the token and body (verifies spec: FPOST)
- [x] A redirect to another origin or scheme, or any other redirect status, is refused and the token goes nowhere else (verifies spec: FPOST)
- [x] The log gives the receiver's status and the start of its reply when refused, on one line (verifies spec: FPOST)
- [x] The log names the receiver's origin and never the URL's path (verifies spec: FPOST)
- [x] Error messages in the log stay on one line and name the findings URL by its origin (verifies spec: FPOST)
- [x] A single huge reply chunk is decoded only as far as the excerpt (verifies spec: FPOST)
- [x] A refused reply of any size is read only as far as the excerpt, and its stream cancelled (verifies spec: FPOST)
- [x] A payload that fails to build sends nothing and reports `error`, not `unreachable` (verifies spec: CMPL)
- [x] A review with no findings URL makes no call to list its review's comments (end to end against a faked GitHub) (verifies spec: FPOST)
- [x] A post that fails never fails the review, and the GitHub comments go out (end to end against a faked GitHub and receiver) (verifies spec: FPOST)
- [x] The post happens after the inline review and before the summary, so the completion block reports it (end to end against a faked GitHub and receiver) (verifies spec: FPOST)
- [x] A review where every agent failed posts a `failed` round with no findings before its completion comment (end to end against a faked GitHub and receiver) (verifies spec: FPOST)
- [x] A review with no kept findings posts an empty list (verifies spec: FPOST)

## Payload

- [x] A built payload validates against the published JSON Schema, including empty and failed rounds (verifies spec: FPOST)
- [x] The schema refuses a payload missing a required field (verifies spec: FPOST)
- [x] The schema requires `$schema`, and its test fails on a keyword it does not check (verifies spec: FPOST)
- [x] The payload's result is the completion block's, less `kind`, and its findings' severities add up to its counts (verifies spec: FPOST)
- [x] Finding ids are unique within the run attempt (verifies spec: FPOST)
- [x] Each finding carries its agent's key and name, its range with a null end line for a single line, and its voter count or null (verifies spec: FPOST)
- [x] The comment is unshortened and without the inline formatting (verifies spec: FPOST)
- [x] Each inline finding carries its GitHub comment id and others null, matched by place and text so two findings on one line keep their own (verifies spec: FPOST)
- [x] Findings sharing a line whose text GitHub rewrote get no id rather than each other's (verifies spec: FPOST)
- [x] A multi-line and a single-line comment ending on one line are kept apart, outdated comments included (verifies spec: FPOST)
- [x] A group takes its representative's location, range and voter count (verifies spec: RUN)
- [x] A kept group whose representative consensus dropped takes its members' highest voter count, and an unknown kept count stays unknown (verifies spec: FPOST)

## Finding ranges

- [x] An agent's end line is kept only when an integer past the start line (verifies spec: RUN)
- [x] An inline comment spans its range when both ends are in one hunk, and sits on the start line otherwise (verifies spec: RUN)
- [x] The inline comment and the posted data use the same test for a finding's range (verifies spec: RUN)
- [x] The hunks of a diff are read per file on the new side, ignoring deleted files and header-like content lines (verifies spec: RUN)
- [x] Paths git quotes and escapes are decoded to the real path, characters outside the BMP included (verifies spec: RUN)
- [x] Scope filtering, triage and hunk parsing agree on a git-quoted header's path, so filtering one file never takes the next with it (verifies spec: RUN)
- [x] A review GitHub refuses for a multi-line comment is posted again with each comment on its start line (end to end against a faked GitHub) (verifies spec: RUN)
- [x] A finding whose line is not a whole number is dropped (verifies spec: RUN)

## Voter counts

- [x] A kept finding's voter count is the distinct voters among its group's members, from the voter tags (verifies spec: RUN)
- [x] A kept finding whose group the reply does not give, a bare-array reply, and a recovered keep list have no voter count (verifies spec: RUN)
- [x] Findings kept because consensus was not applied have no voter count with several voters, and 1 with one (verifies spec: RUN)
- [x] A finding a second look confirms counts its voters plus its confirming checkers (verifies spec: RUN)
- [x] A kept finding whose group has fewer voters than the majority has no voter count (verifies spec: RUN)
- [x] An untagged finding listed as a member counts as no voter, in kept and contested groups alike (verifies spec: RUN)
- [x] Another kept finding listed among a kept group's members does not count towards it (verifies spec: RUN)

## Completion block

- [x] Every block carries `runId` and `runAttempt` as integers, and leaves them out when the environment holds no plain number (verifies spec: CMPL)
- [x] A review block carries `findingsPost` when there is a findings URL and omits it otherwise (verifies spec: CMPL)

## Needs a real run on a pull request

- [ ] The fallback comment shows a multi-line finding's whole range (verifies spec: RUN)
- [ ] A review on a pull request in the same repository with `findings-url` and `id-token: write` reports `findingsPost: accepted` against a live receiver (verifies spec: FPOST)
- [ ] A review on a pull request from a fork reports `no-token` (verifies spec: FPOST)
- [ ] A caller without `id-token: write` runs the review to completion and reports `no-token`, rather than failing at startup (verifies spec: FPOST)
- [ ] A multi-line inline comment within one hunk is accepted by GitHub, and one across hunks sits on the start line (verifies spec: RUN)
- [ ] The comment ids in the payload match the comments on the pull request (verifies spec: FPOST)
- [ ] A receiver that checks `job_workflow_ref` accepts the token from a run of `review.yml` (verifies spec: FPOST)
