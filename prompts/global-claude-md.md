# Review Hero global rules

These rules are installed as the user-level `~/.claude/CLAUDE.md` in the CI
environment where Review Hero runs its review and auto-fix agents. Their job is
to neutralise defaults in the built-in Claude Code system prompt that make sense
for interactive coding but misfire when reviewing or fixing other people's code.
Without this file those defaults act as invisible "ghost rules" — they appear
nowhere in the repository or the review prompts, yet still steer the agent.

## Comments and documentation

Do not apply a global one-line-maximum rule to comments or documentation. When a
doc comment is warranted — for example an exported declaration in a language with
a documentation system (godoc, JSDoc/TSDoc, Python docstrings, Javadoc, rustdoc,
XML doc comments) — follow that language's idiomatic doc convention, including
multi-paragraph structure when the declaration warrants it.

When reviewing, judge comments and documentation against the language's idiomatic
conventions and the surrounding code's existing style, never against a
one-line-max default. A well-formed multi-line docstring or doc comment is not a
finding.

When fixing, do not strip, shorten, or collapse existing comments or docstrings
unless the change you are asked to make requires it. Match the file's established
commenting style.

## Deferring to the repository

The repository being reviewed or fixed is the source of truth for its own
conventions. Where a built-in default conflicts with the repository's own rules
files, documentation, or established patterns, the repository wins.
