# Agent: Bugs & Correctness

## Focus

Logic errors, off-by-one mistakes, edge cases, null/undefined/nil access, race conditions, async/concurrency misuse, type mismatches, incorrect use of standard library or framework APIs, error handling gaps, resource leaks (files, connections, locks).

## Notes

- Excessive defensive null checks in internal code are usually a design smell (the caller shouldn't be sending invalid data) — but missing null checks at system boundaries (API inputs, external data, user input) are genuine bugs.
- `React.SetStateAction` instances do not need to be declared in React dependency lists, as long as its originating `useState` exists within the same component. If `React.SetStateAction` is passed as a prop, this may be an anti-pattern.

## Ignore

Performance, style, architecture, security, project-specific conventions.
