---
id: MODEL
---

# Review model selection

Triage picks the model the review agents run on. A pull request can pick an allowed model with a checkbox or a hidden marker in its description.

## Default choice

- [ ] The review agents use the workflow's `model` input.
- [ ] A pull request with 500 or more changed diff lines upgrades the review agents to Opus.

## Opt-in checkbox

- [ ] Ticking `**Run Review Hero on GLM (experimental)** <!-- #ai-review-glm -->` runs a review with the agents on `z-ai/glm-5.3-flash:floor`, overriding both the `model` input and the Opus upgrade.
- [ ] A description containing `<!-- review-hero: model=<id> -->` runs the review agents on `<id>` when `<id>` is in `ALLOWED_MODELS`; the checkbox wins over the marker.
- [ ] Any other id logs a workflow warning and the review uses the default choice.
- [ ] Nothing in the description can add or change other triage outputs.
- [ ] Either Review Hero checkbox triggers a review, and both are unticked once it finishes.
- [ ] The description reaches triage through the environment, never interpolated into a script.

## OpenRouter models

- [ ] A model id containing `/` runs the review agents through OpenRouter's Anthropic-compatible endpoint, authenticated with the `REVIEW_HERO_OPENROUTER_API_KEY` secret, with 1.5× the usual turn budget.
- [ ] When that secret is not set, the review logs a workflow warning and uses the default choice.
- [ ] Triage and the orchestrator's filtering always use Anthropic, whatever model the agents run on.
- [ ] The README documents the checkbox and the secret.
