# Four-backtick local fix prompt

Scenarios verifying that the copyable local fix prompt is emitted as a single fenced code block that comment content cannot break out of.

## Prompt structure

- [x] With no comments, nothing is emitted
- [x] With comments, the prompt is wrapped in a four-backtick fence inside the `<details>` block
- [x] The item separators and per-item `file:line` prefixes appear inside the fence
- [x] A comment with no line number renders the file path alone

## Content passthrough

- [x] A comment containing a three-backtick code block reaches the agent verbatim, and the fence stays at four backticks
- [x] A comment containing a four-backtick block grows the outer fence to five backticks
- [x] Backtick runs are detected in CRLF comment text as well as LF
- [x] HTML tags in comment text pass through unescaped
- [x] Horizontal rules in comment text are stripped so they cannot read as item separators

## Rendering

Manual only: this exercises GitHub's own markdown rendering, which the unit tests cannot reach.

- [ ] On a real PR comment, GitHub renders the block collapsed with a working copy button, and copying yields the prompt without the fence
