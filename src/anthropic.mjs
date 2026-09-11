/**
 * Review Hero — Anthropic-backed model caller
 *
 * The `callModel` implementation this repo passes to the filtering stages. It
 * reaches the Anthropic Messages API directly. Other consumers (e.g. a local
 * review that routes through the developer's own agent) supply their own
 * `callModel` with the same contract and never touch this module.
 *
 * Contract:
 *   callModel({ model, maxTokens, messages, thinking? }) => Promise<string>
 *   - resolves to the assistant's text ("" when the response carries none)
 *   - throws on a transport or non-2xx API error, so each stage's own
 *     try/catch applies its safe fallback
 */

/**
 * Build a `callModel` bound to an API key and base URL.
 */
export function createAnthropicModelCaller({ apiKey, baseUrl = "https://api.anthropic.com" }) {
  return async function callModel({ model, maxTokens, messages, thinking }) {
    const body = { model, max_tokens: maxTokens, messages };
    if (thinking) body.thinking = thinking;

    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`API ${response.status}: ${await response.text()}`);
    }

    const result = await response.json();
    // Collect every text block rather than just the first. A response may
    // carry several, and a caller that enables thinking gets a thinking block
    // ahead of them — reading only block 0 would return "", which each stage
    // reads as unparseable output and quietly keeps every finding, with
    // nothing to signal that the call in fact succeeded.
    return (result.content ?? [])
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("");
  };
}
