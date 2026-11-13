/**
 * Review Hero — OpenRouter-backed model caller
 *
 * The `callModel` implementation this repo passes to the filtering stages. It
 * reaches OpenRouter's Anthropic-compatible Messages endpoint, the same one the
 * review agents' CLI uses. Other consumers (e.g. a local review that routes
 * through the developer's own agent) supply their own `callModel` with the same
 * contract and never touch this module.
 *
 * Contract:
 *   callModel({ model, maxTokens, messages, thinking? }) => Promise<string>
 *   - resolves to the assistant's text ("" when the response carries none)
 *   - throws on a transport or non-2xx API error, so each stage's own
 *     try/catch applies its safe fallback
 */

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api";

/** Triage and suppression matching: short, mechanical calls. */
export const FILTER_MODEL = "z-ai/glm-5.3-flash:nitro";

/** Consensus and grouping, which weigh findings against each other. */
export const GROUPING_MODEL = "z-ai/glm-5.3:nitro";

/** Headers for a Messages request to OpenRouter. */
export function openRouterHeaders(apiKey) {
  return {
    authorization: `Bearer ${apiKey}`,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  };
}

/**
 * The assistant's text from a Messages response. Every text block is joined:
 * a reasoning model puts a thinking block ahead of them, and reading only the
 * first block would return "", which each stage reads as unparseable output.
 */
export function responseText(result) {
  return (result?.content ?? [])
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

/**
 * Build a `callModel` bound to an API key and base URL.
 */
export function createOpenRouterModelCaller({ apiKey, baseUrl = OPENROUTER_BASE_URL }) {
  return async function callModel({ model, maxTokens, messages, thinking }) {
    const body = { model, max_tokens: maxTokens, messages };
    if (thinking) body.thinking = thinking;

    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: openRouterHeaders(apiKey),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`API ${response.status}: ${await response.text()}`);
    }

    return responseText(await response.json());
  };
}
