# Improve prompt caching

Reduce Claude API cost by making the review-agent matrix share a cached prompt prefix.
Cost is the optimisation target; some added latency is acceptable.

## Where the spend is

The review-agent matrix dominates. With `voters=4` and ~5 selected agents, `triage.mjs`
fans out ~20 `claude -p` jobs (flat matrix, no `max-parallel`), each re-sending the full
filtered PR diff. The direct `/v1/messages` callers (`triage`, both dedup passes in
`orchestrate`, `suppress`, `learn-from-reactions`, auto-fix summary) are small, one-shot,
and content-varying, so adding `cache_control` there is near-noise. The matrix is the prize.

## Why the cache almost certainly misses today

Cache prefixes match exactly and in order: `tools` -> `system` -> `messages`.

1. The CLI's default system prompt carries per-machine sections (cwd, env info, memory
   paths, git status). Across 20 runners these vary, poisoning the prefix ahead of the
   piped diff. `--exclude-dynamic-system-prompt-sections` moves them into the first user
   message specifically to improve cross-machine cache reuse.
2. The piped prompt (`review.yml:372-397`) places the per-agent specialisation *before*
   the diff, so the largest payload sits behind a per-agent divergence point.
3. A cache entry is only readable after the first response begins. All 20 jobs launch
   simultaneously, so each writes the cache independently and none reads.

Within a single session, multi-turn caching likely already works. The gap is cross-job.

## Approach

- [ ] Log `cache_read_input_tokens` / `cache_creation_input_tokens` in `logClaudeSession`
      (`lib.mjs:273`). Land this first and alone: it establishes the baseline and makes
      every later change falsifiable.
- [ ] Add `--exclude-dynamic-system-prompt-sections` to the agent invocation
      (`review.yml:398`). Prerequisite for anything else working.
- [ ] Reorder the piped prompt so the shared block (project context, base prompt, AI
      rules, turn budget, diff) comes first and the per-agent specialisation comes last.
      Check review quality side-by-side; instructions-after-context is usually fine or
      better, but it needs confirming.
- [ ] Serialise one call ahead of the fan-out to win a cache write before the reads.

### Priming

Use a throwaway `--max-turns 1` run of the same prompt. `max-turns` is a client-side loop
control and does not alter the request prefix, so the first API request still writes the
full cache while the run exits in seconds. Preferred over promoting a real voter to primer,
which would serialise a full multi-minute review for ~0.1 S of extra saving.

### Expected saving

With `S` = shared prefix tokens, using the documented multiples (writes 1.25x, reads 0.1x):
today ~20 x 1.25 S = ~25 S; after ~1.25 S + 20 x 0.1 S = ~3.25 S. Roughly an 85% cut in
matrix input tokens. Output tokens unchanged. Voter-only sharing (skipping the reorder)
reaches only ~61%, so the reorder carries real weight.

## Open question: TTL vs runner startup

The CLI sets `cache_control` itself, so the 1-hour TTL is likely not requestable, leaving a
5-minute window. Each fan-out job runs app token, checkout, `npm ci`, a global install of
the Claude CLI, and rules detection before calling Claude, so 20 queued jobs can exceed the
window and silently fall back to 20 writes.

- *Separate prime job* (`review-agent` gains `needs: review-agent-prime`): clean, but
  fan-out setup happens after the prime, spending the whole window on setup. Risks paying
  20 writes *and* the added latency.
- *In-job stagger*: all jobs set up in parallel, then one designated job calls Claude
  immediately while the rest wait on a marker artifact. Uglier YAML, keeps the gap to
  seconds.

Leaning to the stagger. Confirm against measured hit rate before committing.
