/**
 * Review Hero — Suppression Filter
 *
 * Loads suppression rules from YAML and filters findings against known
 * false-positive patterns. The match judgement is delegated to a model, but
 * the call is injected: `callModel({ model, maxTokens, messages }) =>
 * Promise<string>` returns the model's text. This repo passes an
 * Anthropic-backed implementation; other consumers pass their own.
 *
 * Suppressions file format (.github/review-hero/suppressions.yml):
 *
 *   - pattern: "natural language description of what not to flag"
 *     context: "optional — when this applies"
 *     reason: "optional — why this was added"
 */

import { readFileSync, existsSync } from "node:fs";
import { parse as parseYaml } from "yaml";

/**
 * Load suppressions from a YAML file.
 * Returns an array of { pattern, context?, reason? } objects.
 */
export function loadSuppressions(filePath) {
  if (!filePath || !existsSync(filePath)) return [];
  try {
    const parsed = parseYaml(readFileSync(filePath, "utf-8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s) => s && typeof s.pattern === "string");
  } catch (err) {
    console.warn(`Failed to load suppressions: ${err.message}`);
    return [];
  }
}

const BATCH_SIZE = 50;

/**
 * Strip control characters and cap length to limit blast radius
 * of a compromised suppressions file.
 */
export function sanitizeSuppressionField(str) {
  if (typeof str !== "string") return "";
  return str.replace(/[\x00-\x1F\x7F]/g, " ").slice(0, 500);
}

/**
 * Filter a single batch of findings against the suppression list.
 * Returns { kept: Finding[], suppressed: Finding[] }.
 */
export async function callHaikuForBatch(batch, suppressionList, callModel) {
  const findingsList = batch
    .map(
      (f, i) =>
        `${i}. [${f.severity}] ${f.file}:${f.line} — ${f.comment.slice(0, 300)}`,
    )
    .join("\n");

  try {
    const text = await callModel({
      model: "claude-haiku-4-5-20251001",
      maxTokens: 1000,
      messages: [
        {
          role: "user",
          content: `You are filtering code review findings against suppression rules. A finding should be suppressed if it raises essentially the same concern a suppression rule describes, in a matching context. Be conservative — only suppress clear matches.

## Suppression Rules
${suppressionList}

## Findings
${findingsList}

Output ONLY a JSON array of finding indices (0-based) to SUPPRESS. Output \`[]\` if none match.`,
        },
      ],
    });

    const lastOpen = text.lastIndexOf("[");
    const lastClose = text.lastIndexOf("]");
    if (lastOpen === -1 || lastClose <= lastOpen) {
      // No parseable response — keep all findings in this batch
      return { kept: batch, suppressed: [] };
    }

    const rawIndices = JSON.parse(text.slice(lastOpen, lastClose + 1));
    const suppressedIndices = new Set(
      Array.isArray(rawIndices)
        ? rawIndices.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < batch.length)
        : [],
    );

    const kept = [];
    const suppressed = [];
    for (let i = 0; i < batch.length; i++) {
      if (suppressedIndices.has(i)) {
        suppressed.push(batch[i]);
      } else {
        kept.push(batch[i]);
      }
    }
    return { kept, suppressed };
  } catch (err) {
    console.warn(
      `Suppression filter batch failed, keeping ${batch.length} findings: ${err.message}`,
    );
    return { kept: batch, suppressed: [] };
  }
}

/**
 * Filter findings against suppression rules.
 * Returns { kept: Finding[], suppressed: Finding[] }.
 *
 * Findings are processed in batches of 50 to stay within context limits
 * and make partial failures recoverable (failed batches keep all findings).
 *
 * On failure — or when no `callModel` is supplied — returns all findings as
 * kept (safe fallback).
 */
export async function filterWithSuppressions(findings, suppressions, callModel) {
  if (suppressions.length === 0 || findings.length === 0 || !callModel) {
    return { kept: findings, suppressed: [] };
  }

  const suppressionList = suppressions
    .map((s, i) => {
      let entry = `${i + 1}. ${sanitizeSuppressionField(s.pattern)}`;
      if (s.context) entry += ` — Context: ${sanitizeSuppressionField(s.context)}`;
      return entry;
    })
    .join("\n");

  // Split into chunks and process all batches in parallel
  const chunks = [];
  for (let i = 0; i < findings.length; i += BATCH_SIZE) {
    chunks.push(findings.slice(i, i + BATCH_SIZE));
  }

  const batchResults = await Promise.all(
    chunks.map((batch) => callHaikuForBatch(batch, suppressionList, callModel)),
  );

  const allKept = batchResults.flatMap((r) => r.kept);
  const allSuppressed = batchResults.flatMap((r) => r.suppressed);

  return { kept: allKept, suppressed: allSuppressed };
}
