/**
 * Review Hero — Shared review logic
 *
 * The importable entry point for review-hero's review logic: finding parsing,
 * consensus and cross-agent grouping, suppression filtering, agent discovery,
 * scope filtering, prompt assembly, and summary formatting.
 *
 * This entry point is deliberately dependency-light and free of any GitHub
 * Actions runtime — a consumer wires in its own model caller (see
 * `createAnthropicModelCaller` for this repo's API-backed one) and its own
 * GitHub/git plumbing.
 */

export {
  VALID_SEVERITIES,
  validateFindings,
  extractJsonArray,
  parseAgentResult,
} from "./findings.mjs";

export { applyConsensus, groupAllFindings } from "./grouping.mjs";

export {
  loadSuppressions,
  filterWithSuppressions,
  callHaikuForBatch,
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

export { buildBasePromptSections, parseClaudeResult } from "./prompt.mjs";

export {
  SUMMARY_HEADER,
  SEVERITY_ORDER,
  buildSummaryHeader,
  buildSummaryTable,
} from "./summary.mjs";

export { createAnthropicModelCaller } from "./anthropic.mjs";
