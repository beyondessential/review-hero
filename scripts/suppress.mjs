/**
 * Review Hero — Suppression Filter
 *
 * Loads suppression rules from YAML and filters findings using Claude Haiku
 * to identify matches against known false-positive patterns.
 *
 * Suppressions file format (.github/review-hero/suppressions.yml):
 *
 *   - pattern: "natural language description of what not to flag"
 *     context: "optional — when this applies"
 *     reason: "optional — why this was added"
 */

import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

/**
 * Load suppressions from a YAML file.
 * Returns an array of { pattern, context?, reason? } objects.
 */
export function loadSuppressions(filePath) {
  if (!filePath || !existsSync(filePath)) return [];
  try {
    const json = execFileSync("yq", ["-o=json", ".", filePath], {
      encoding: "utf-8",
    });
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s) => s && typeof s.pattern === "string");
  } catch (err) {
    console.warn(`Failed to load suppressions: ${err.message}`);
    return [];
  }
}

const BATCH_SIZE = 50;

/**
 * Use Claude Haiku to filter findings against suppression rules.
 * Returns { kept: Finding[], suppressed: Finding[] }.
 *
 * Findings are processed in batches of 50 to stay within context limits
 * and make partial failures recoverable (failed batches keep all findings).
 *
 * On failure, returns all findings as kept (safe fallback).
 */
export async function filterWithSuppressions(
  findings,
  suppressions,
  { apiKey, baseUrl },
) {
  if (suppressions.length === 0 || findings.length === 0) {
    return { kept: findings, suppressed: [] };
  }

  const suppressionList = suppressions
    .map((s, i) => {
      let entry = `${i + 1}. ${s.pattern}`;
      if (s.context) entry += ` — Context: ${s.context}`;
      return entry;
    })
    .join("\n");

  const allKept = [];
  const allSuppressed = [];

  // Process in batches to keep each API call within context limits
  for (let batchStart = 0; batchStart < findings.length; batchStart += BATCH_SIZE) {
    const batch = findings.slice(batchStart, batchStart + BATCH_SIZE);

    const findingsList = batch
      .map(
        (f, i) =>
          `${i}. [${f.severity}] ${f.file}:${f.line} — ${f.comment.slice(0, 300)}`,
      )
      .join("\n");

    try {
      const response = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 1000,
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
        }),
      });

      if (!response.ok) {
        throw new Error(`API ${response.status}: ${await response.text()}`);
      }

      const result = await response.json();
      const text = result.content?.[0]?.text ?? "";

      const match = text.match(/\[[\s\S]*?\]/);
      if (!match) {
        // No parseable response — keep all findings in this batch
        allKept.push(...batch);
        continue;
      }

      const rawIndices = JSON.parse(match[0]);
      const suppressedIndices = new Set(
        Array.isArray(rawIndices)
          ? rawIndices.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < batch.length)
          : [],
      );

      for (let i = 0; i < batch.length; i++) {
        if (suppressedIndices.has(i)) {
          allSuppressed.push(batch[i]);
        } else {
          allKept.push(batch[i]);
        }
      }
    } catch (err) {
      console.warn(
        `Suppression filter batch failed, keeping ${batch.length} findings: ${err.message}`,
      );
      allKept.push(...batch);
    }
  }

  return { kept: allKept, suppressed: allSuppressed };
}
