# K1 — Make review-hero consumable as a library

Scenarios verifying that the shared review logic is importable, dependency-light, and behaves identically whether the model call is API-backed (this repo) or caller-supplied (Workhorse).

## Packaging & entry point

- [x] The package entry (`src/index.mjs`) imports cleanly and exposes every shared function
- [x] Nothing reachable from the entry point imports `@actions/core` or shells out to `yq`
- [x] The package installs as a dependency and imports into a TypeScript project (type declarations resolve)

## Injectable model call

- [x] `filterWithSuppressions` routes every model call through the caller-supplied function and suppresses the indices it returns
- [x] `filterWithSuppressions` with no caller (`null`) keeps all findings
- [x] `applyConsensus` routes through the caller-supplied function and keeps only the representatives it returns
- [x] `applyConsensus` with no caller keeps all findings (stripped of voter tags)
- [x] `groupAllFindings` with no caller falls back to one group per finding
- [x] `createAnthropicModelCaller` returns the assistant text and throws on a non-2xx response

## Suppressions without yq

- [x] `loadSuppressions` parses a YAML suppressions file via the JS parser
- [x] `loadSuppressions` returns `[]` for a missing file and for non-list YAML

## Agent discovery & scope (no yq)

- [x] `loadCallerConfig` parses `.github/review-hero/config.yml` via the JS parser
- [x] `discoverBaseAgents` finds the base agents whose prompt files exist
- [x] `filterDiff` strips ignored files (lockfiles) and keeps in-scope files

## Regression — one implementation

- [x] Existing `orchestrate`/`lib` tests still pass through the extracted modules
- [x] `triage.mjs` runs end-to-end: parses config, filters the diff, builds the matrix
