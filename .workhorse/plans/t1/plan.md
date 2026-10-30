# T1: Post each review round's findings as data

A review can post its round's findings as JSON to a caller-named URL, authenticated by GitHub Actions OIDC. Workhorse (card S43 in the Workhorse workspace) is the first receiver, but nothing in Review Hero is Workhorse-specific.

## Decisions

- Generic, not Workhorse-specific: the input is `findings-url`, the completion field is `findingsPost`, and the payload's JSON Schema is published in the repo for any receiver.
- Off by default. A caller that wants it sets `findings-url` and grants `id-token: write`. This avoids sending a third party's findings (which quote their code) to our Workhorse because they granted the permission for something else.
- `findingsPost` is a status (`accepted | refused | unreachable | no-token | invalid-url`), absent with no URL, so a receiver falling back to comments can log why. `runId` and `runAttempt` are top-level run metadata on every completion block.
- Inline comments span the finding's range when start and end lie in one diff hunk, otherwise anchor on the start line. GitHub refuses a multi-line comment across hunks, and one refusal fails the whole review post into the fallback comment.
- A second-look-confirmed finding's voter count includes its confirming checkers.
- Voter count is null where consensus was not applied, 1 in a single-voter review.

## Implementation notes

- **Identity token only in `post`.** A called workflow's jobs inherit the caller's `id-token: write`. Declaring it on `post` would fail the workflow at startup for callers that don't grant it, so `post` stays undeclared and inherits. The `review` job declares its own `permissions:` without `id-token` (it needs `contents: read` for checkouts and `pull-requests: read` for the compare API call in "Get PR diff"; check every step before narrowing).
- **Redirects.** Post with `redirect: "manual"`, since `fetch` would otherwise follow a cross-origin redirect (minus the token). Re-send only on a 307/308 whose `Location` resolves to the findings URL's origin.
- **Requesting the token.** In the orchestrator, from `ACTIONS_ID_TOKEN_REQUEST_URL` + `&audience=<origin>` with `ACTIONS_ID_TOKEN_REQUEST_TOKEN` as bearer. Missing env means `no-token`.
- **Comment ids.** The review POST returns the review, not its comments. List the review's comments (`GET /pulls/{n}/reviews/{id}/comments`) and match by path and line to the findings posted inline. The fallback issue comment carries no per-finding id.
- **Range from agents.** `prompts/agent-prompt.md` output schema gains an optional `endLine`. `validateFindings` keeps it when it is an integer at or after `line`. The checker prompt shows the range.
- **Spanning hunks.** The posting job has the diff the agents saw (in the review artifact). Parse hunk ranges on the new side to decide whether `start_line` can be sent.
- **Voter count from consensus.** The consensus reply names only the kept representatives today. It must also give each kept group's members, and the code counts distinct `voter` tags among them. A reply that cannot be read whole and recovers only the kept list leaves counts null.
- **Payload builder** sits in `src/` beside `buildReviewResult`, exported from `src/index.mjs` and typed in `src/index.d.ts`.
- **JSON Schema** under `schemas/` (e.g. `schemas/findings-round.v1.json`), with a test validating a built payload against it.
- **Finding id** `<runId>-<runAttempt>-<n>`, unique within the run attempt.
- **Dogfood.** This repo's own `ai-review.yml` sets `findings-url: https://workhorse.bes.au` and grants `id-token: write`.
- **S43 needs to know** the input name (its canonical setup must set `findings-url` too), the `findingsPost` statuses, and the top-level `runId`/`runAttempt`.

## As built

- The consensus reply gains `members`, mapping each kept index to its group's indices. Kept findings carry `supporters` (the payload field has the same name). Consensus token budget rose to cover the extra list.
- `src/hunks.mjs` (`parseHunks`, `commentLines`) and `src/round.mjs` (`buildRoundFindings`, `buildFindingsPayload`, `FINDINGS_SCHEMA`) are exported from `src/index.mjs`. The orchestrator gets the diff through `DIFF_PATH`.
- `scripts/findings-post.mjs` holds the token request, redirects, retry and time bound. The orchestrator's `matchCommentIds` pairs posted comments with the review's listed ones by place, then text.
- The review job's `permissions` is `contents: read` alone: the only workflow-token use there is checkout and the compare call.
- The dogfood URL is `https://workhorse.bes.au/api/review-hero/rounds`: the host is the live Workhorse deployment, and the path is S43's endpoint. Until S43 ships, dogfood posts are refused with a 404 and logged.
- `findingsPost` gained `error` for a failure on the run's own side (such as the payload failing to build), so `unreachable` only means the receiver gave no answer.

## Build

- [x] Agent prompt and `validateFindings`: optional end line
- [x] Consensus: kept groups' members and voter counts; second look adds confirmations; unfiltered findings null
- [x] Grouping carries representative's range and count
- [x] Inline review: span within a hunk; collect comment ids
- [x] Payload builder in `src/`, plus JSON Schema and schema test
- [x] Orchestrator: token request, post with one retry and a time bound, `findingsPost`, every-agent-failed post
- [x] Completion block: `runId`, `runAttempt`, `findingsPost`
- [x] `review.yml`: `findings-url` input, passed to orchestrator; review job permissions without `id-token`
- [x] README: input, permission, caller example, fork PRs report `no-token`, block fields, link to receiver guide
- [x] Receiver guide (e.g. `docs/receiving-findings.md`): token checks, take repo and run from the token, schema link, repeat deliveries
- [x] `ai-review.yml` dogfood
