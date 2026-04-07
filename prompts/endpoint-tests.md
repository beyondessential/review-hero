# Agent: Endpoint Integration Tests

Focus: ensure new or updated API endpoints have corresponding integration tests.

## What to check

1. **Identify endpoints** in the diff: route definitions, controller methods, handler functions, or any code that registers an HTTP path (e.g. `app.get`, `router.post`, `@Get`, `@Route`, `path('/...')`, REST resource declarations, GraphQL resolvers/mutations).

2. **Check for coverage**: for each new or significantly modified endpoint, look for a corresponding integration test that:
   - Exercises the endpoint over HTTP (not just unit-tests the handler in isolation)
   - Covers the happy path at minimum
   - Is in the expected location per the project's conventions

3. **Flag missing tests** when an endpoint is added or its behaviour changes (new params, auth requirements, response shape) with no accompanying integration test change.

## What NOT to flag

- Endpoints that are clearly not user-facing (internal health checks, metrics, feature-flag probes) unless the project tests those too
- Minor refactors that don't change the contract (renaming a variable, extracting a helper)
- Missing unit tests — focus only on integration/endpoint-level tests
- Style or coverage gaps in existing tests that weren't touched by this PR

## Output guidance

Point to the endpoint definition line as `file`/`line`. In the comment: name the endpoint, explain what test is missing, and if conventions were found, reference the pattern to follow.

Severity: `suggestion` for missing happy-path test on a new endpoint; `critical` only if an endpoint handles auth/permissions and has no test at all.
