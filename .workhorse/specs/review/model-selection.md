---
id: MODEL
---

# Review model selection

Triage picks the model the review agents run on. A pull request can opt into an experimental model with a checkbox in its description.

## Default choice

- [ ] The review agents use the workflow's `model` input.
- [ ] A pull request with 500 or more changed diff lines upgrades the review agents to Opus.

## Opt-in checkbox

- [ ] Ticking `**Run Review Hero GLM (experimental)** <!-- #ai-review-glm -->` runs a review with the agents on `z-ai/glm-5.3-flash:floor`, overriding both the `model` input and the Opus upgrade.
- [ ] Only models in the opt-in safelist can be chosen; nothing typed into the description names a model.
- [ ] Either Review Hero checkbox triggers a review, and both are unticked once it finishes.
- [ ] The description reaches triage through the environment, never interpolated into a script.

## OpenRouter models

- [ ] A model id containing `/` runs the review agents through OpenRouter's Anthropic-compatible endpoint, authenticated with the `REVIEW_HERO_OPENROUTER_API_KEY` secret, with 1.5× the usual turn budget.
- [ ] When that secret is not set, the review logs a workflow warning and uses the default choice.
- [ ] Triage and the orchestrator's filtering always use Anthropic, whatever model the agents run on.
- [ ] The README documents the checkbox and the secret.
