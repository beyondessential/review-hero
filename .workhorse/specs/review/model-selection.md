---
id: MODEL
---

# Review model selection

Triage picks the model the review agents run on. Reviews run on GLM by default; a pull request can ask for Claude with a checkbox, or name an allowed model with a hidden marker.

## Default choice

- [ ] The review agents run on `z-ai/glm-5.3-flash:floor` through OpenRouter.
- [ ] When `REVIEW_HERO_OPENROUTER_API_KEY` is not set, the review logs a workflow warning and runs on Claude.

## Claude checkbox

- [ ] Ticking `**Run Review Hero on Claude (before merge)** <!-- #ai-review-claude -->` runs a review with the agents on the workflow's `model` input.
- [ ] A Claude review of a pull request with 500 or more changed diff lines upgrades the agents to Opus.
- [ ] Either Review Hero checkbox triggers a review, and both are unticked once it finishes.

## Marker in the PR description

- [ ] A description containing `<!-- review-hero: model=<id> -->` runs the review agents on `<id>` when `<id>` is in `ALLOWED_MODELS`.
- [ ] Any other id logs a workflow warning and is ignored.
- [ ] The Claude checkbox wins over the marker.
- [ ] Nothing in the description can add or change other triage outputs.
- [ ] The description reaches triage through the environment, never interpolated into a script.

## OpenRouter models

- [ ] A model id containing `/` runs the review agents through OpenRouter's Anthropic-compatible endpoint, authenticated with the `REVIEW_HERO_OPENROUTER_API_KEY` secret, with 1.5× the usual turn budget.
- [ ] Triage and the orchestrator's filtering always use Anthropic, whatever model the agents run on.
- [ ] The README documents the default, the checkbox, the marker and the secret.
