---
name: run-review-and-fix
description: "Run a parallel multi-agent code review and fix cycle. Launches specialist review-scan agents concurrently, collects findings, then launches review-fix. Supports multiple cycles (e.g. /run-review-and-fix 3)."
user-invocable: true
---

# Parallel Review — Orchestration Instructions

You are orchestrating a parallel code review cycle. Follow these steps exactly.

## Parse arguments

Check if the user specified a cycle count (e.g. "/run-review-and-fix 3" or "for 3 cycles"). Default to 1 cycle if not specified. Maximum 5 cycles.

## Step 1: Discover what to review

1. Run `git diff main --name-only` (or appropriate base branch) to get changed files.
2. Use Glob to check for `.github/review-hero/prompts/*.md`. Read each file found — these are custom review agents.
3. Read `.github/review-hero/config.yml` if it exists for project context.

## Step 2: Build the list of focus areas

Always include these 4 base focus areas:
- `security`
- `bugs`
- `performance`
- `design`

Plus one entry per custom prompt file found. For example, if `.github/review-hero/prompts/bes-requirements.md` exists, add `bes-requirements` with its prompt contents.

## Step 3: Launch review-scan agents IN PARALLEL

Launch ALL review-scan agents in a SINGLE message (multiple Agent tool calls). This is critical — they must run concurrently.

For each base focus area, launch:
```
Agent(subagent_type: "review-scan", prompt: "Focus area: {area}\nChanged files: {file list}\nReview these files for {area} issues. Run `git diff main -- <file>` for each to see the changes.")
```

For each custom agent, include the full prompt contents:
```
Agent(subagent_type: "review-scan", prompt: "Focus area: {name}\nChanged files: {file list}\nCustom review prompt:\n{contents of the .md file}\n\nReview these files following the custom prompt above. Read any files it references.")
```

## Step 4: Collect results

Wait for ALL review-scan agents to complete. Each returns a JSON array of findings.

## Step 5: Launch review-fix

Launch a single review-fix agent with all collected findings:
```
Agent(subagent_type: "review-fix", prompt: "Here are findings from parallel review scans:\n\n## Security\n{findings}\n\n## Bugs\n{findings}\n\n## Performance\n{findings}\n\n## Design\n{findings}\n\n## {custom}\n{findings}\n\nApply consensus filtering and fix confirmed issues.")
```

## Step 6: Report cycle results

After review-fix completes, report what was found and fixed.

## Step 7: Repeat if more cycles requested

If cycles > 1 and review-fix reported fixes were applied, repeat steps 3-6 for the next cycle. Each cycle re-scans the updated code.

If review-fix reports nothing to fix, stop early: "No issues found in cycle N — stopping early."

Log between cycles: "Cycle N/M complete. Starting next cycle..."

## Important

- ALL review-scan agents MUST be launched in a single message for parallelism
- Do NOT skip custom agent prompts
- If a review-scan agent fails, continue with results from the others
- Do NOT launch review-fix until all scans complete
