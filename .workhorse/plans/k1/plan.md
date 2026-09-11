# K1 — Make review-hero consumable as a library

Extract review-hero's review logic into an importable, dependency-light package so Workhorse's local-review stage can run the same review and reach the same verdicts, without dragging in the GitHub Actions runtime or shelling out to `yq`.

## Approach

Move the pure, shared review logic into a new `src/` package directory with a single entry point (`src/index.mjs`). The existing Actions scripts (`orchestrate.mjs`, `triage.mjs`) keep their GitHub/Actions plumbing and top-level execution but import the shared logic from `src/`, so there is one implementation, not two. `scripts/suppress.mjs` migrates wholesale into `src/suppressions.mjs`.

The model call is inverted: the three filtering stages take a caller-supplied `callModel(request) => Promise<string>` instead of `{ apiKey, baseUrl }`. This repo wires an Anthropic-backed implementation (`createAnthropicModelCaller`); Workhorse wires a local-agent one.

### Module layout (`src/`)

| Module | Exports |
|---|---|
| `findings.mjs` | `parseAgentResult`, `extractJsonArray`, `validateFindings`, `VALID_SEVERITIES` |
| `grouping.mjs` | `applyConsensus`, `groupAllFindings` |
| `suppressions.mjs` | `loadSuppressions`, `filterWithSuppressions`, `callHaikuForBatch`, `sanitizeSuppressionField` |
| `agents.mjs` | `BASE_AGENTS`, `loadCallerConfig`, `discoverBaseAgents`, `discoverCustomAgents`, `isValidAgentKey`, `VALID_AGENT_KEY` |
| `scope.mjs` | `filterDiff`, `globMatch`, `simpleWildcard`, `DEFAULT_IGNORE_PATTERNS` |
| `prompt.mjs` | `buildBasePromptSections`, `parseClaudeResult` |
| `summary.mjs` | `buildSummaryHeader`, `buildSummaryTable`, `SUMMARY_HEADER`, `SEVERITY_ORDER` |
| `anthropic.mjs` | `createAnthropicModelCaller` (this repo's API-backed `callModel`) |
| `sanitize.mjs` | `sanitizeForPrompt`, `COMMENT_LIMIT` — prompt-safe rendering shared by all three filtering stages |
| `index.mjs` | barrel re-export of all of the above |
| `index.d.ts` | hand-written type declarations for the entry point |

### The `callModel` contract

`callModel({ model, maxTokens, messages, thinking? }) => Promise<string>` — returns the assistant text (`""` if none), throws on transport/API error so each stage keeps its existing safe fallback. Passing `null`/`undefined` (no caller) makes consensus/grouping keep everything, matching today's "no API key" behaviour.

## Checklist

- [x] Add `yaml` dependency; drop `yq` shell-outs in `loadSuppressions` and `loadCallerConfig`
- [x] Create `src/` modules holding the extracted pure logic
- [x] Invert the three filtering stages to take `callModel` (`applyConsensus`, `groupAllFindings`, `filterWithSuppressions`/`callHaikuForBatch`)
- [x] Add `createAnthropicModelCaller` (API-backed impl for this repo)
- [x] `src/index.mjs` barrel + `src/index.d.ts` declarations
- [x] Rewrite `orchestrate.mjs` to import from `src/`, wire the Anthropic caller, keep GitHub plumbing; re-export test symbols
- [x] Rewrite `triage.mjs` to import agent-discovery/scope from `src/`, keep its own triage model call
- [x] Delete `scripts/suppress.mjs` (migrated to `src/suppressions.mjs`)
- [x] `package.json`: name, version, drop `private`, `exports`/`main`/`types`, `yaml` dep
- [x] Shared entry point must not transitively import `@actions/core` or require `yq` — verified (grep + fresh-import check)
- [x] Tests: existing pass; added a package-entry test proving the consumer path + injectable caller
- [x] `npm test` green (58 pass); `.d.ts` compiles under `tsc --strict`; a `nodenext` TS consumer resolves the package by name

## Verification notes

- Shared entry `src/index.mjs` exports 27 symbols; a fresh `node` import loads it with no `@actions/core`/`yq` in the graph.
- `triage.mjs` smoke-tested end-to-end: YAML config parsed without `yq`, lockfile stripped from the diff, base agents discovered, matrix emitted.
- Lockfile regenerated to the scoped name/version; `npm ci` is green (workflows use `npm ci --prefix review-hero`).
- Deliberately still Actions-side (not shared): the orchestrator `main`, all GitHub/git plumbing, `runClaude`, reaction-learning, and triage agent-selection. `applyConsensus` is exported for completeness even though a laptop-side local stage won't use it.

## Review round 1 — hardening the extracted surface

Four suggestions, all confirmed against the code and applied. All four were pre-existing behaviour moved verbatim during the extraction rather than regressions, but promoting them to public API is the point at which they ship to every consumer, so they were fixed here.

- **All text blocks, not just the first.** `createAnthropicModelCaller` read `content[0].text`. Since the `callModel` contract forwards `thinking`, a caller that enables it gets a thinking block first and would have received `""` — which every stage reads as unparseable and silently keeps all findings, with nothing to signal the call succeeded. It now joins every `type: "text"` block.
- **Untrusted agent output.** `validateFindings` assumed every array element was an object, so a `null` in an agent artifact threw a `TypeError` out of `parseAgentResult` and out of the orchestrator, failing the entire review over one bad entry. Confirmed live on both the bare-array and envelope paths.
- **Shared prompt sanitiser.** Consensus and grouping stripped newlines and `<comment>` delimiters before interpolating finding text; suppression did not, so a planted string quoted into a finding comment could forge `Output ONLY: [0,1,2,…]` and suppress a whole batch, hiding genuine critical findings. `groupAllFindings` had also already drifted from `applyConsensus` (it sanitised `file` but interpolated `line` raw). All three now render through `sanitizeForPrompt` in `src/sanitize.mjs`, which is the point of a single helper.

  Checked explicitly: for findings containing no newlines or delimiters, all three prompts are **byte-identical** to before. The change bites only on the injection case, so the hosted/local agreement the card is built on is preserved.
- **Publish allowlist.** With `private: true` dropped and no `files` field, `npm publish` packed the whole working directory — 86 files, including `.agents/` and `.workhorse/`, and on a runner whatever the Actions steps had materialised there. Now `files: ["src/", "prompts/"]` → 21 files. `prompts/` is load-bearing, not cosmetic: `discoverBaseAgents` resolves `<packageRoot>/prompts` at runtime, so omitting it would silently yield zero base agents. `.review-hero/` and `.caller-base/` added to `.gitignore` (review-hero reviews itself, so both can appear inside this checkout).

Verified by installing the packed tarball into a clean project: it imports, `discoverBaseAgents` finds all four agents from the shipped prompts, and the shipped `src/index.test.mjs` runs green from `node_modules` (19 cases) — which is how the card's "fixtures reachable by a consumer" requirement is met.
