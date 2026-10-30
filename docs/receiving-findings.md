# Receiving findings

A Review Hero review can post each round's findings as JSON to a URL its caller names (the `findings-url` input; see the [README](../README.md#posting-findings-as-data)). This guide is for the service at that URL.

## What arrives

An HTTPS `POST` with a JSON body and `Authorization: Bearer <token>`. The body follows [`schemas/findings-round.v1.json`](../schemas/findings-round.v1.json), one file per version of its shape. Its `schema` field is that version, and its `$schema` field is the URL of that file. Adding a field keeps the number, and removing a field or changing what one means increments it, so a receiver can ignore fields it does not know and should refuse a `schema` it does not support. The `$schema` URL follows Review Hero's main branch, so validate against a copy of the schema you keep rather than one fetched from that URL as posts arrive.

Each round posts once, after the review's inline comments and before its summary comment. A review with no kept findings still posts, with an empty `findings` list, and so does a review where every agent failed, with `outcome` `failed`.

Answer with a 2xx once you have taken the round. Review Hero counts any 2xx as accepted and anything else as refused, and logs your status and the start of your reply. A `5xx`, or no answer, is tried once more.

## Checking a post

The bearer token is a GitHub Actions identity token, a JWT signed by GitHub. Check that:

- It is signed by a key from GitHub's OIDC keys (`https://token.actions.githubusercontent.com/.well-known/jwks`), and its `iss` is `https://token.actions.githubusercontent.com`.
- It has not expired.
- Its `aud` is your own origin, such as `https://findings.example.com`. Review Hero asks for a token addressed to the origin of the findings URL, so a token minted for another receiver is not valid for you.
- Its `job_workflow_ref` names Review Hero's reusable review workflow: `beyondessential/review-hero/.github/workflows/review.yml@<ref>`, for whichever refs you accept. Any workflow in a repository can request a token addressed to you, but only a run of that workflow names it as `job_workflow_ref`, so this is what says the post came from Review Hero and not from some other job in the caller's repository.

## Take the repository and the run from the token

Read the repository, the run id and the run attempt from the token's `repository`, `run_id` and `run_attempt` claims, not from the payload. The payload names them too, but a payload is only what the sender wrote, and the token is what GitHub says. A caller's own workflow could post a payload naming someone else's repository; it cannot get GitHub to sign a token that says so.

A receiver that wants the pull request and commit take them from the payload (`prNumber`, `reviewedSha`). These identify the review's subject, and the token vouches for the repository they belong to.

## Treat the content as untrusted

A finding's `comment` and `path` are written by review agents that read the pull request, so the pull request's author can shape them. Escape them when you render them, never act on instructions inside them, and don't assume `path` names a file that exists in the repository.

## Repeat deliveries

A receiver can get the same round more than once:

- A retry can repeat a post that the receiver already took but did not answer in time.
- Re-running the posting job posts the same findings again under a new `run_attempt`, with new finding identifiers.

Within one run attempt, a finding's `id` is unique. It says nothing about whether a finding in another round, or another attempt, is the same one. To tell a repeated delivery from a new round, key on the token's `run_id` and `run_attempt`.

## Findings

Each entry in `findings` carries:

| Field | Meaning |
|-------|---------|
| `id` | Unique within the run attempt. |
| `severity` | `critical`, `suggestion` or `nitpick`. |
| `agent` | `key` and display `name` of the agent that raised it. |
| `path`, `startLine`, `endLine` | Where it is. `endLine` is null when it covers its start line alone. |
| `supporters` | How many voters and second-look checkers support it, or null when the review could not tell. |
| `commentId` | The id of the GitHub review comment it was posted as, or null when it was not posted inline (a nitpick, or a finding in a review whose inline comments GitHub would not take). |
| `comment` | The comment as the agent wrote it, unshortened and without the formatting the inline comment adds. |

The findings are the round's kept findings, one per group, so their severities add up to `counts`. Findings below the consensus threshold and suppressed findings are not included.
