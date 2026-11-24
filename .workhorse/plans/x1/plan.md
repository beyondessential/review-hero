# Read a card's earlier rejections before posting a round

Spec: Earlier rejections (`.workhorse/specs/review/earlier-rejections.md`), plus `counts.rejected` and `rejectionsRead` in Completion comments.

## Design notes

- The read lives beside the findings post in `scripts/findings-post.mjs`, sharing the identity token request, the same-origin redirect rule and the log redaction. The single-attempt function is generalised over method and how a 2xx is read, so the post and the read follow redirects and retry the same way.
- The read has its own, shorter bound than the post (30 s), so it fits the orchestrator step's existing time limit beside the post.
- Matching lives in the shared library (`src/rejections.mjs`): parsing the answer, and `filterWithRejections`. Candidates are narrowed in code before any model call: same file only, and an agent's rejection never a candidate for a critical. Each file's findings are judged against that file's candidates in one call (two when criticals see fewer rejections), batched like suppressions.
- The suppression filter's reply parsing (the last JSON array of indices) is shared rather than copied.
- `counts.rejected` is an added field, so the completion block and the findings payload stay at schema 1.

## Checklist

- [x] Shared library: `src/rejections.mjs` (parse, filter), exports and types
- [ ] Read: `readRejections` in `scripts/findings-post.mjs`, with the attempt and retry generalised
- [ ] Orchestrator: read, filter kept and below-consensus findings, log, summary stat, result counts and `rejectionsRead`
- [ ] Completion result and payload schema: `counts.rejected`
- [ ] Tests for parse, filter, read and the result
- [ ] Docs: README (overview, findings section, completion table) and the receiver guide
