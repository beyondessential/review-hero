---
id: MODEL
---

# Review model selection

Triage picks the model the review agents run on. A pull request can pick a different model for itself with a hidden marker in its description.

## Default choice

- [ ] The review agents use the workflow's `model` input.
- [ ] A pull request with 500 or more changed diff lines upgrades the review agents to Opus.

## Marker in the PR description

- [ ] A description containing `<!-- review-hero: model=<id> -->` runs the review agents on `<id>`, overriding both the `model` input and the Opus upgrade.
- [ ] The marker does not show when the description is rendered on GitHub.
- [ ] An id is valid only when it is at most 100 characters of lowercase letters, digits, `.`, `_`, `:`, `/` and `-`, starting with a letter or digit.
- [ ] An invalid id logs a workflow warning and the review uses the default choice.
- [ ] Nothing in the description can add or change other triage outputs.
- [ ] The description reaches triage through the environment, never interpolated into a script.

## OpenRouter models

- [ ] An id containing `/` runs the review agents through OpenRouter's Anthropic-compatible endpoint, authenticated with the `REVIEW_HERO_OPENROUTER_API_KEY` secret.
- [ ] When that secret is not set, an OpenRouter id logs a workflow warning and the review uses the default choice.
- [ ] Triage and the orchestrator's filtering always use Anthropic, whatever model the agents run on.
- [ ] The README documents the marker and the secret.
