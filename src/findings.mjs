/**
 * Review Hero — Finding parsing
 *
 * Parses structured JSON findings out of review-agent output, whether that
 * output is a bare JSON array, a Claude CLI result envelope, or prose with an
 * array embedded in it. Shared between this repo's orchestrator and any other
 * consumer that runs the same review agents and needs the same finding
 * semantics.
 */

import { readFileSync } from "node:fs";

/** The severity vocabulary a finding may declare. */
export const VALID_SEVERITIES = new Set(["critical", "suggestion", "nitpick"]);

/**
 * Keep only entries that are valid findings and normalise them into the shape
 * the rest of the pipeline expects. `voter` is tagged only when supplied, so a
 * single-voter run carries no voter field.
 */
export function validateFindings(findings, agentKey, voter) {
  return findings
    .filter(
      (f) =>
        // Agent output is untrusted: a stray `null` or scalar in the array
        // must drop that one entry, not throw out of the whole review.
        f &&
        typeof f === "object" &&
        typeof f.file === "string" &&
        f.file &&
        VALID_SEVERITIES.has(f.severity) &&
        typeof f.comment === "string" &&
        f.comment &&
        typeof f.line === "number" &&
        f.line > 0,
    )
    .map((f) => ({
      file: f.file,
      line: f.line,
      severity: f.severity,
      comment: f.comment,
      agent: agentKey,
      ...(voter !== undefined && { voter: `${agentKey}-${voter}` }),
    }));
}

/**
 * Extract the first JSON array embedded in `text` by trying [start..end]
 * pairs. Returns the parsed array, or null if none is found.
 */
export function extractJsonArray(text) {
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const start = text.indexOf("[", searchFrom);
    if (start === -1) break;
    let searchEnd = text.length;
    while (searchEnd > start) {
      const end = text.lastIndexOf("]", searchEnd - 1);
      if (end <= start) break;
      try {
        const parsed = JSON.parse(text.slice(start, end + 1));
        if (Array.isArray(parsed)) return parsed;
      } catch {
        // Not valid JSON for this pair — try a shorter span
      }
      searchEnd = end;
    }
    searchFrom = start + 1;
  }
  return null;
}

/**
 * Parse agent output from a file. Returns null on failure (agent produced no
 * usable output), distinct from [] which means "completed OK, no findings".
 */
export function parseAgentResult(filePath, agentKey, voter) {
  let raw;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (err) {
    console.warn(`Failed to read ${filePath}: ${err.message}`);
    return null;
  }

  // The Claude CLI --output-format json wraps the agent's answer in an
  // envelope object whose text output lives in `.result`. Every other field
  // (iterations, modelUsage, …) is CLI metadata and must never be mined for
  // findings — doing so turns an errored run into a bogus empty result.
  let text = raw;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      // Agent emitted a bare JSON array as the whole file.
      return validateFindings(parsed, agentKey, voter);
    }
    if (parsed && typeof parsed === "object") {
      // An errored run (e.g. max-turns budget exhaustion) has no `result`
      // string and produced no answer. Treat it as a failure, not silently
      // as zero findings, and don't scan the envelope's own arrays.
      if (parsed.is_error || typeof parsed.result !== "string") {
        const reason = parsed.subtype ?? parsed.stop_reason ?? "no result field";
        console.warn(`${filePath}: agent produced no usable output (${reason})`);
        return null;
      }
      text = parsed.result;
    }
  } catch {
    // A file that opens with `{` is a CLI envelope that never finished being
    // written (step timeout, killed process, truncated artifact). Its
    // metadata arrays are not findings, so fail rather than scanning them —
    // the same reason we don't mine a complete errored envelope above.
    if (raw.trimStart().startsWith("{")) {
      console.warn(`${filePath}: truncated or malformed CLI envelope`);
      return null;
    }
    // Otherwise it's not an envelope at all — treat the raw file as the
    // agent's own text output.
  }

  const findings = extractJsonArray(text);
  if (findings !== null) {
    return validateFindings(findings, agentKey, voter);
  }

  // The agent is required to emit a JSON array — `[]` when it finds nothing.
  // Prose instead of an array means it ignored the output contract, so we
  // can't tell "no issues" from "never got to the answer". Treat it as a
  // failure so it shows up rather than silently voting zero findings.
  console.warn(`No JSON array found in ${filePath}`);
  return null;
}
