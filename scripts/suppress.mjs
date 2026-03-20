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
import { execSync } from "node:child_process";

/**
 * Load suppressions from a YAML file.
 * Returns an array of { pattern, context?, reason? } objects.
 */
export function loadSuppressions(filePath) {
  if (!filePath || !existsSync(filePath)) return [];
  try {
    const json = execSync(`yq -o=json '.' "${filePath}"`, {
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

/**
 * Use Claude Haiku to filter findings against suppression rules.
 * Returns { kept: Finding[], suppressed: Finding[] }.
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

  const findingsList = findings
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
    if (!match) return { kept: findings, suppressed: [] };

    const suppressedIndices = new Set(JSON.parse(match[0]));
    const kept = [];
    const suppressed = [];

    for (let i = 0; i < findings.length; i++) {
      if (suppressedIndices.has(i)) {
        suppressed.push(findings[i]);
      } else {
        kept.push(findings[i]);
      }
    }

    return { kept, suppressed };
  } catch (err) {
    console.warn(
      `Suppression filter failed, keeping all findings: ${err.message}`,
    );
    return { kept: findings, suppressed: [] };
  }
}
