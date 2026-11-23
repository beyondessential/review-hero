---
id: REJ
---

# Earlier rejections

A review with a findings URL reads the pull request's earlier rejections from it: findings its receiver has already decided are wrong, dismissed, or belong to work of their own.
A review drops any finding one of them matches, so a round does not raise again what has already been decided.

## Reading them

- [ ] A review reads its earlier rejections with a `GET` to its findings URL (see `reporting/posting-findings.md`), so a caller sets up nothing beyond the findings URL.
- [ ] A review with no findings URL, or one that is not an `https` URL, reads no rejections and requests no identity token for them.
- [ ] The read names the pull request in a `pr` query parameter, and asks for 200 rejections in a `limit` query parameter.
- [ ] The read is authenticated as a findings post is: by a GitHub Actions identity token addressed to the findings URL's origin, sent as its bearer token.
- [ ] A read that gets no answer, or a server error, is tried once more.
- [ ] The read, with its token request and retry, has a time limit of its own.
- [ ] Redirects are followed as for a findings post: a 307 or 308 to the findings URL's own origin, up to a small number of redirects, and no other.
- [ ] A read counts as answered when the receiver answers 200 with a JSON object whose `schemaVersion` is 1 and whose `rejections` is a list.
- [ ] A read that is not answered, for whatever reason, leaves the review to carry on without earlier rejections, and never fails it.
- [ ] A rejection that does not have the expected shape is left out, and the others are still applied.
- [ ] The job log says how the read went: how many rejections it read, how many exist in all when the list was cut short, or the receiver's status and the start of its reply when it was refused.
- [ ] The job log names the receiver by the findings URL's origin alone, under the same rules as for a findings post.

## Matching a finding

- [ ] A finding matches a rejection when it raises the same concern as the rejected finding, in the same file.
- [ ] A rejection whose finding names no file matches only a finding that names none, so it never matches a review finding, which always names its file.
- [ ] The rejection's reason is context for judging whether a finding raises the same concern, and never matches a finding on its own.
- [ ] A rejection made by an agent never matches a critical finding.
- [ ] A rejection made by a person can match a finding of any severity.
- [ ] The judgement of whether a finding raises the same concern is made by the model that judges suppressions, and a judgement that fails keeps every finding it was judging.
- [ ] The rejected finding's text and the rejection's reason were written by reviewers and people, and reach the model as untrusted data, sanitised as finding text is, never as instructions.
- [ ] The shared library exposes the match, so a consumer that runs the review itself can apply a list of rejections it read on its own.

## Documentation

- [ ] The receiver guide describes the read: the query parameters, the token it carries, the answer shape a review applies, and that a receiver that does not answer it costs the review nothing but repeated findings.
- [ ] The README says that a review with a findings URL reads earlier rejections from it.
