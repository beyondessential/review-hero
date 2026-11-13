/**
 * Review Hero — Shared review logic
 *
 * The importable entry point for review-hero's review logic: finding parsing,
 * consensus and cross-agent grouping, suppression filtering, agent discovery,
 * scope filtering, prompt assembly, and summary and completion-comment
 * formatting.
 *
 * This entry point is deliberately dependency-light and free of any GitHub
 * Actions runtime — a consumer wires in its own model caller (see
 * `createOpenRouterModelCaller` for this repo's API-backed one) and its own
 * GitHub/git plumbing.
 */

export {
  VALID_SEVERITIES,
  effectiveEndLine,
  validateFindings,
  extractJsonArray,
  parseAgentResult,
} from "./findings.mjs";

export {
  applyConsensus,
  keepWithoutConsensus,
  parseConsensusReply,
  groupAllFindings,
  MAX_CONTESTED_AREAS,
} from "./grouping.mjs";

export {
  loadSuppressions,
  filterWithSuppressions,
  callModelForBatch,
  sanitizeSuppressionField,
} from "./suppressions.mjs";

export {
  BASE_AGENTS,
  VALID_AGENT_KEY,
  isValidAgentKey,
  loadCallerConfig,
  discoverBaseAgents,
  discoverCustomAgents,
} from "./agents.mjs";

export {
  DEFAULT_IGNORE_PATTERNS,
  globMatch,
  simpleWildcard,
  filterDiff,
} from "./scope.mjs";

export {
  buildBasePromptSections,
  buildReviewAgentPrompt,
  buildCheckerPrompt,
  softTurnCap,
  parseClaudeResult,
} from "./prompt.mjs";

export {
  SUMMARY_HEADER,
  SEVERITY_ORDER,
  buildSummaryHeader,
  buildSummaryTable,
  formatCommitLink,
} from "./summary.mjs";

export {
  COMPLETION_MARKER,
  COMPLETION_SCHEMA,
  buildCompletionBlock,
  parseCompletionBlock,
  stripCompletionBlocks,
  buildReviewResult,
} from "./completion.mjs";

export { parseHunks, commentLines, nearestDiffLine, diffGitPath, unquoteGitPath } from "./hunks.mjs";

export { FINDINGS_SCHEMA, FINDINGS_SCHEMA_URL, buildRoundFindings, matchCommentIds, buildFindingsPayload } from "./round.mjs";

export { createOpenRouterModelCaller, FILTER_MODEL, GROUPING_MODEL } from "./openrouter.mjs";

export { sanitizeForPrompt, COMMENT_LIMIT } from "./sanitize.mjs";
