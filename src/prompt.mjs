/**
 * Review Hero — Prompt assembly
 *
 * Builds the base prompt sections handed to a review or fix agent, and parses
 * the array of findings back out of a Claude CLI result. Shared so a consumer
 * assembles the same prompt and reads the same output contract this repo does.
 */

import { readFileSync, existsSync } from "node:fs";

export function buildBasePromptSections({
  projectContext,
  promptPath,
  commitHelperPath,
  customRulesPath,
  aiRulesPath,
  aiRulesLabel = "Follow them when applying changes.",
}) {
  const sections = [];

  if (projectContext) {
    sections.push(`## Project Context\n\n${projectContext}`);
  }

  let basePrompt = readFileSync(promptPath, "utf-8");
  if (commitHelperPath) {
    basePrompt = basePrompt.replaceAll(
      ".review-hero/scripts/git-commit-fix.mjs",
      commitHelperPath,
    );
  }
  sections.push(basePrompt);

  if (customRulesPath && existsSync(customRulesPath)) {
    sections.push(readFileSync(customRulesPath, "utf-8"));
  }

  if (aiRulesPath) {
    try {
      const aiRules = readFileSync(aiRulesPath, "utf-8").trim();
      if (aiRules) {
        sections.push(
          `## Repository AI Rules\n\nThis repository defines the following AI coding rules. ${aiRulesLabel}\n\n${aiRules}`,
        );
      }
    } catch {
      // No AI rules file or unreadable — skip
    }
  }

  return sections;
}

export function parseClaudeResult(raw) {
  let text = raw;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.result)) return parsed.result;
    if (parsed.result) text = parsed.result;
    else if (Array.isArray(parsed)) return parsed;
  } catch {
    // Not valid JSON at top level — search for embedded array below
  }

  let searchFrom = 0;
  while (searchFrom < text.length) {
    const start = text.indexOf("[", searchFrom);
    if (start === -1) break;
    let searchEnd = text.length;
    while (searchEnd > start) {
      const end = text.lastIndexOf("]", searchEnd - 1);
      if (end <= start) break;
      try {
        const arr = JSON.parse(text.slice(start, end + 1));
        if (Array.isArray(arr)) return arr;
      } catch {
        // try shorter span
      }
      searchEnd = end;
    }
    searchFrom = start + 1;
  }

  return [];
}
