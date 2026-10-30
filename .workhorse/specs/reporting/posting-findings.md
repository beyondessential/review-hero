---
id: FPOST
---

# Posting findings

A review can post each round's findings as data to a URL the caller names, alongside the comments it posts to GitHub for people.
A receiver then gets every finding whole, with its severity, location and origin as fields, rather than parsing them back out of comment text.
Any service can be a receiver: the post is authenticated by GitHub, so a receiver needs no secret shared with the caller.

## Turning it on

- [ ] The workflow's `findings-url` input names the URL a review posts its findings to.
- [ ] `findings-url` is empty by default, and a review with no findings URL posts nothing and requests no identity token.
- [ ] A findings URL must be an `https` URL, and a review whose findings URL is not one posts nothing, requests no identity token, and says so in the job log.
- [ ] A review whose caller has not granted permission to request a GitHub Actions identity token reports `no-token`, since a called workflow cannot grant itself more than its caller allows.
- [ ] The README documents `findings-url`, the permission it needs, and a caller example with both that grants the permission to the calling job alone, notes that a pull request from a fork always reports `no-token`, and links to the receiver guide.

## Authentication

- [ ] Each post is authenticated by a GitHub Actions identity token, sent as its bearer token.
- [ ] The token's audience is the origin of the findings URL, so a token minted for one receiver is refused by any other.
- [ ] The token is requested in the posting job, just before the post and after the payload is built, so a run that cannot build its payload requests none.
- [ ] A token request that gets no answer, a server error or a rate limit is tried once more, so a passing failure at GitHub does not read as a missing permission.
- [ ] The repository has a guide for receivers, apart from the README.
- [ ] The receiver guide tells receivers how to check a post: the token is issued by GitHub Actions, is addressed to the receiver's own origin, has not expired, and names Review Hero's reusable review workflow as the workflow that requested it.
- [ ] The receiver guide tells receivers to take the repository and the run from the token rather than from the payload, since any workflow in a repository can request a token but only Review Hero's names that workflow.
- [ ] The receiver guide tells receivers to treat a finding's comment and path as untrusted, since the pull request's author can shape them.

## When a review posts

- [ ] A review posts its findings after its inline review and before its summary comment, so each finding posted inline carries its GitHub comment and the summary's completion block can say how the post went.
- [ ] A review with no kept findings still posts its round, with an empty list of findings.
- [ ] A review where every agent failed posts a round with a `failed` outcome and no findings, before its completion comment.
- [ ] A post that gets no answer, or a server error, is tried once more.
- [ ] The token request and the post, with their retries, share one bound in time, and a retry that cannot fit in what is left is skipped without waiting for it.
- [ ] When a post is retried, the retry's result is how the post went.
- [ ] The receiver guide says a receiver can get the same round more than once: a retry can repeat a post the receiver already took, and re-running the posting job posts the same findings again under a new run attempt, with new identifiers.
- [ ] A 307 or 308 redirect to the findings URL's own origin is followed, up to a small number of redirects.
- [ ] Any other redirect is not followed, so the identity token only ever goes to the origin it is addressed to, and the post counts as refused.
- [ ] A post counts as accepted when the receiver answers with a 2xx status.
- [ ] A post that is not accepted never fails the review: it is logged, the completion block says how it went (see `reporting/completion-comments.md`), and the review's GitHub comments are posted as usual.
- [ ] The job log says how the post went, with the receiver's status and the start of its reply when it was refused.
- [ ] The job log names the receiver by the findings URL's origin alone, since a caller may put a secret in its path, and each of its lines about the post stays on one line, with no control characters and no URL's path or userinfo, including in the start of a reply that echoes the request.
- [ ] A refused reply is read only as far as the start the job log shows.
- [ ] The review looks up its inline comments' GitHub ids only when it has an `https` findings URL.

## Payload

- [ ] The payload is a JSON object carrying a `schema` integer, the version of its shape, starting at 1.
- [ ] Adding a field keeps the same `schema` number, and removing a field or changing what it means increments it.
- [ ] The payload's JSON Schema is published in the repository, one file per schema version, and the receiver guide links to it.
- [ ] The payload carries a `$schema` field holding the URL of the published JSON Schema for its version.
- [ ] The payload names the repository and the pull request number.
- [ ] The payload names the GitHub Actions run id and run attempt, and the Review Hero ref and commit, as the completion block does.
- [ ] The payload carries the review's result (`outcome`, `reviewedSha`, `model` and `counts`) exactly as the completion block reports it.
- [ ] The payload's findings are the review's kept findings, one per group, so their severities add up to the result's counts: nitpicks are included, and findings below the consensus threshold or suppressed are left out.
- [ ] The shared library builds the payload's result and findings from the review pipeline's outputs, so a consumer that runs the review itself can produce the same shape.
- [ ] The hosted review's payload is that same result and findings with the run metadata and each inline finding's GitHub comment id added.

### Findings

- [ ] Each finding has an identifier, unique within its run attempt, which says nothing about whether a finding in another round is the same one.
- [ ] Each finding carries its severity, the key and display name of the agent that raised it, its file path, and its start and end line, with the end line null when the finding covers its start line alone.
- [ ] Each finding carries its voter count, how many voters and second-look checkers support it, or null when the review cannot tell (see `review/agent-runs.md`).
- [ ] A finding whose group's representative is one consensus dropped carries the highest voter count among the group's members, since one of them is what kept the group.
- [ ] A finding posted inline carries the id of its GitHub review comment, and a finding not posted inline carries null.
- [ ] Each finding carries its comment as the agent wrote it, unshortened and without the formatting the inline comment adds around it.
