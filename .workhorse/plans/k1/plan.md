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
- [x] `npm test` green (51 pass); `.d.ts` compiles under `tsc --strict`; a `nodenext` TS consumer resolves the package by name

## Verification notes

- Shared entry `src/index.mjs` exports 27 symbols; a fresh `node` import loads it with no `@actions/core`/`yq` in the graph.
- `triage.mjs` smoke-tested end-to-end: YAML config parsed without `yq`, lockfile stripped from the diff, base agents discovered, matrix emitted.
- Lockfile regenerated to the scoped name/version; `npm ci` is green (workflows use `npm ci --prefix review-hero`).
- Deliberately still Actions-side (not shared): the orchestrator `main`, all GitHub/git plumbing, `runClaude`, reaction-learning, and triage agent-selection. `applyConsensus` is exported for completeness even though a laptop-side local stage won't use it.
