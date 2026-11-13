---
id: MODEL
---

# Review model selection

Every model call a review makes goes to a GLM model through OpenRouter. Triage picks the model the review agents run on; a pull request can name an allowed model with a hidden marker.

## Default choice

- [ ] The review agents run on `z-ai/glm-5.3-flash:nitro`, with a flat 20-turn budget.
- [ ] Triage and suppression matching run on `z-ai/glm-5.3-flash:nitro`.
- [ ] Consensus and grouping run on `z-ai/glm-5.3:nitro`.
- [ ] Auto-fix runs on the workflow's `model` input, `z-ai/glm-5.3:nitro` by default.

## Marker in the PR description

- [ ] A description containing `<!-- review-hero: model=<id> -->` runs the review agents on `<id>` when `<id>` is in `ALLOWED_MODELS`.
- [ ] Any other id logs a workflow warning and is ignored.
- [ ] Nothing in the description can add or change other triage outputs.
- [ ] The description reaches triage through the environment, never interpolated into a script.

## OpenRouter

- [ ] Every model call authenticates with the `REVIEW_HERO_OPENROUTER_API_KEY` secret, which both workflows require.
- [ ] The review agents and auto-fix reach OpenRouter's Anthropic-compatible endpoint through the CLI; triage and the filtering stages call the same endpoint directly.
- [ ] The README documents the default, the marker and the secret.
