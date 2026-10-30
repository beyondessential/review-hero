/**
 * Review Hero — Prompt assembly
 *
 * Builds the base prompt sections handed to a review or fix agent, and parses
 * the array of findings back out of a Claude CLI result. Shared so a consumer
 * assembles the same prompt and reads the same output contract this repo does.
 */

import { readFileSync, existsSync } from "node:fs";

import { sanitizeForPrompt, COMMENT_LIMIT } from "./sanitize.mjs";

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

/**
 * The turn the agent is told to stop exploring by. It sits below the hard cap
 * so the agent has turns left to write up its findings rather than being cut
 * off before it answers.
 */
export function softTurnCap(maxTurns) {
  return maxTurns > 4 ? maxTurns - 3 : maxTurns - 1;
}

/**
 * The layout every agent prompt shares: project context, the instructions,
 * the repository's AI rules (to follow when doing `task`), the turn budget,
 * then the PR title and fenced diff. The title is the PR author's and can be
 * set with newlines through the API, so it is rendered on one line like any
 * other untrusted value, never as prompt sections of its own.
 */
function assemblePrompt({ projectContext, instructions, aiRules, task, turnBudget, prTitle, diff }) {
  let prompt = "";
  if (projectContext) {
    prompt += `## Project Context\n\n${projectContext}\n\n`;
  }
  prompt += instructions;
  if (aiRules) {
    prompt += `\n\n## Repository AI Rules\n\nThis repository defines the following AI coding rules. Follow them when ${task}.\n\n`;
    prompt += aiRules;
  }
  prompt += `\n\n## Turn budget\n\n${turnBudget}\n`;
  prompt += `\n\n## PR Title\n\n${sanitizeForPrompt(prTitle)}\n\n## PR Diff\n\n\`\`\`diff\n`;
  prompt += diff;
  if (diff && !diff.endsWith("\n")) prompt += "\n";
  prompt += "\`\`\`\n";
  return prompt;
}

/**
 * Assemble the prompt for one review agent: project context, the shared agent
 * prompt, the agent's own specialisation, the repository's AI rules, the turn
 * budget, then the PR title and diff.
 *
 * Every voter of an agent sends these exact bytes, which is what lets them
 * share one cached prompt prefix. Nothing here may vary between voters (no
 * timestamps, no per-run detail), or each voter pays for its own cache write.
 */
// spec: RUN#prompt-cache-priming
export function buildReviewAgentPrompt({
  projectContext = "",
  basePrompt,
  agentPrompt,
  aiRules = "",
  maxTurns,
  prTitle = "",
  diff,
}) {
  return assemblePrompt({
    projectContext,
    instructions: `${basePrompt}\n\n${agentPrompt}`,
    aiRules,
    task: "reviewing",
    turnBudget: `You have at most ${maxTurns} agent turns for this review, and every tool call spends one. Stop exploring by turn ${softTurnCap(maxTurns)} and spend the remainder writing up findings. Prioritise the highest-risk changes, sample files selectively rather than reading them end-to-end, and make your final message the JSON array (exactly \`[]\` if you found nothing). Returning fewer high-confidence findings on time beats being cut off mid-exploration with no output at all.`,
    prTitle,
    diff,
  });
}

/**
 * Assemble the prompt for a second-look checker: the checker instructions, the
 * agent's own specialisation, the repository's AI rules, the turn budget, the
 * PR title and diff, then the contested area and its findings, numbered.
 *
 * Every checker of an area sends these exact bytes. The findings quote the
 * pull request, so their text is sanitised and fenced like any other quoted
 * content.
 */
// spec: RUN#second-look
export function buildCheckerPrompt({
  projectContext = "",
  checkerPrompt,
  agentPrompt,
  aiRules = "",
  maxTurns,
  prTitle = "",
  diff,
  area,
  findings,
}) {
  let prompt = assemblePrompt({
    projectContext,
    instructions: `${checkerPrompt}\n\n## Your specialisation\n\n${agentPrompt}`,
    aiRules,
    task: "judging findings",
    turnBudget: `You have at most ${maxTurns} agent turns for this check, and every tool call spends one. Stop exploring by turn ${softTurnCap(maxTurns)} and make your final message the JSON array of verdicts.`,
    prTitle,
    diff,
  });
  prompt += `\n## Findings to check\n\nArea: ${sanitizeForPrompt(area)}\n\n`;
  findings.forEach((f, i) => {
    const comment = sanitizeForPrompt(f.comment, { maxLength: COMMENT_LIMIT });
    prompt += `${i}. [${sanitizeForPrompt(f.severity)}] ${sanitizeForPrompt(f.file)}:${sanitizeForPrompt(f.line)}${f.endLine ? `-${sanitizeForPrompt(f.endLine)}` : ""} — <comment>${comment}</comment>\n`;
  });
  return prompt;
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
