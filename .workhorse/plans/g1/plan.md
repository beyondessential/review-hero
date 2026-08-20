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
2. A cache entry is only readable after the first response begins. All 20 jobs launch
   simultaneously, so each writes the cache independently and none reads.

Within a single session, multi-turn caching likely already works. The gap is cross-job.

## Correction: reordering the prompt does not buy cross-agent sharing

An earlier version of this plan proposed moving the per-agent specialisation to the end of
the prompt so that all ~20 jobs would share one prefix, and estimated an ~85% saving. That
is wrong.

Cache prefixes are matched at *content block* granularity. Piping the prompt via stdin
makes the whole thing a single text block, so the block either matches in full or not at
all. Appending the specialisation still changes those bytes, so agents cannot share a
prefix no matter where within the block the specialisation sits. Reordering was dropped:
it changes nothing for a single block, and for voters (identical prompts) order is
irrelevant.

What remains shareable is the set of voters *within* one agent, whose prompts are
byte-identical. That is the win this card delivers.

## Approach

- [x] Log `cache_read_input_tokens` / `cache_creation_input_tokens` plus a hit rate, so a
      missed prefix is visible in CI rather than only on the bill. `formatCacheStats` in
      `lib.mjs` covers the `runClaude` path (auto-fix); the agent matrix prints the same
      figures with `jq` because it invokes the CLI directly from YAML.
- [x] Add `--exclude-dynamic-system-prompt-sections` to every agent invocation and to
      `runClaude`. Prerequisite for anything else working: it moves cwd, env info, memory
      paths and git status out of the system prompt, which otherwise varies per runner and
      poisons the prefix ahead of the diff.
- [x] Build the prompt to `/tmp/agent-prompt.md` in its own step rather than piping it
      inline, so the prime run and the real run send identical bytes. Also removes the
      `PIPESTATUS` handling, since there is no longer a pipe to interrogate.
- [x] Stagger via an in-job prime: `triage.mjs` marks voter 0 of each agent as `primer`.
      The primer runs `--max-turns 1` (client-side loop control, so the request body and
      therefore the cache write are unaffected) and publishes a marker artifact; siblings
      poll the run's artifacts API for that marker before starting.

### Rejected: reordering for cross-agent sharing

See the correction above. Blocked by content-block granularity, not by ordering.

### Expected saving

Per agent, with `S` = prompt tokens and 4 voters: today 4 x 1.25 S = 5 S; after, one prime
write plus four voter reads = 1.25 S + 4 x 0.1 S = 1.65 S. About a **67% cut** in matrix
input tokens. Output tokens are unchanged.

The throwaway prime costs ~0.1 S more than promoting voter 0 to primer would, because
voter 0 then reads rather than writes. That is worth paying: the alternative requires
detecting when voter 0's first response began, which we cannot observe.

Baseline assumes the CLI currently writes cache (1.25x). If it is not caching the piped
prompt at all the baseline is 4 S and the saving is ~59%. The new logging will settle this
on the first run.

### Next lever, if this is not enough

Cross-agent sharing is reachable by putting the shared block (project context, base prompt,
AI rules, turn budget, diff) into the system prompt via `--append-system-prompt-file` and
piping only the per-agent specialisation as the user message. Since the prefix is
`tools -> system -> messages`, an identical system prompt is shareable across all agents
even though the user messages differ, taking ~8.25 S down to ~3.25 S.

Not done here: it moves the diff into the system prompt, which is a behavioural change to
every agent, and it should be judged against measured hit-rate data plus a review-quality
comparison rather than adopted blind.

## Decision: TTL vs runner startup

The CLI sets `cache_control` itself, so the 1-hour TTL is not requestable, leaving a
5-minute window.

Resolved in favour of the **in-job stagger**: every voter completes its setup (app token,
checkout, `npm ci`, global CLI install, rules detection) in parallel, and only the Claude
call is staggered. This keeps the gap between the cache write and the reads to seconds. A
separate prime job would have been cleaner YAML but would spend the whole 5-minute window
on fan-out setup, risking paying for 20 writes *and* the added latency.

Residual risk: the marker poll waits up to 5 minutes and then proceeds with a warning
rather than failing. A missed prefix costs money; a failed review costs the whole run.
