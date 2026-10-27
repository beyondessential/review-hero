# T1: Post each review round's findings as data

A review can post its round's findings as JSON to a caller-named URL, authenticated by GitHub Actions OIDC. Workhorse (card S43 in the Workhorse workspace) is the first receiver, but nothing in Review Hero is Workhorse-specific.

## Decisions

- Generic, not Workhorse-specific: the input is `findings-url`, the completion field is `findingsPost`, and the payload's JSON Schema is published in the repo for any receiver.
- Off by default. A caller that wants it sets `findings-url` and grants `id-token: write`. This avoids sending a third party's findings (which quote their code) to our Workhorse because they granted the permission for something else.
- `findingsPost` is a status (`accepted | refused | unreachable | no-token`), absent with no URL, so a receiver falling back to comments can log why. `runId` and `runAttempt` are top-level run metadata on every completion block.
- Inline comments span the finding's range when start and end lie in one diff hunk, otherwise anchor on the start line. GitHub refuses a multi-line comment across hunks, and one refusal fails the whole review post into the fallback comment.
- A second-look-confirmed finding's voter count includes its confirming checkers.
- Voter count is null where consensus was not applied, 1 in a single-voter review.

## Implementation notes

- **Identity token only in `post`.** A called workflow's jobs inherit the caller's `id-token: write`. Declaring it on `post` would fail the workflow at startup for callers that don't grant it, so `post` stays undeclared and inherits. The `review` job declares its own `permissions:` without `id-token` (it needs `contents: read` for checkouts and `pull-requests: read` for the compare API call in "Get PR diff"; check every step before narrowing).
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

## Build

- [ ] Agent prompt and `validateFindings`: optional end line
- [ ] Consensus: kept groups' members and voter counts; second look adds confirmations; unfiltered findings null
- [ ] Grouping carries representative's range and count
- [ ] Inline review: span within a hunk; collect comment ids
- [ ] Payload builder in `src/`, plus JSON Schema and schema test
- [ ] Orchestrator: token request, post with one retry and a time bound, `findingsPost`, every-agent-failed post
- [ ] Completion block: `runId`, `runAttempt`, `findingsPost`
- [ ] `review.yml`: `findings-url` input, passed to orchestrator; review job permissions without `id-token`
- [ ] README: input, permission, caller example, receiver verification, schema link, block fields
- [ ] `ai-review.yml` dogfood
