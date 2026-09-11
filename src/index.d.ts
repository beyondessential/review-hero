/**
 * Type declarations for review-hero's shared review logic.
 *
 * Hand-written to match src/index.mjs. This repo is plain .mjs; these
 * declarations exist so TypeScript consumers get types without a build step.
 */

// ── Core shapes ──────────────────────────────────────────────────────────────

export type Severity = "critical" | "suggestion" | "nitpick";

/** A single review finding after validation. */
export interface Finding {
  file: string;
  line: number;
  severity: Severity;
  comment: string;
  agent: string;
  /** Present only on multi-voter runs: `${agent}-${voter}`. */
  voter?: string;
}

/** A group of findings judged to describe the same underlying issue. */
export interface FindingGroup {
  representative: Finding;
  members: Finding[];
}

/** A discovered review agent. */
export interface Agent {
  key: string;
  name: string;
  description: string;
  source: "base" | "custom";
}

/** A single suppression rule loaded from YAML. */
export interface Suppression {
  pattern: string;
  context?: string;
  reason?: string;
}

// ── Model caller ─────────────────────────────────────────────────────────────

export interface ModelMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ModelRequest {
  model: string;
  maxTokens: number;
  messages: ModelMessage[];
  /** Passed through to the underlying API when supported (e.g. `{ type: "disabled" }`). */
  thinking?: unknown;
}

/**
 * Performs a single model call and resolves to the assistant's text.
 * Implementations should throw on failure so each stage applies its fallback.
 */
export type CallModel = (request: ModelRequest) => Promise<string>;

// ── Finding parsing ──────────────────────────────────────────────────────────

export const VALID_SEVERITIES: ReadonlySet<string>;

export function validateFindings(
  findings: unknown[],
  agentKey: string,
  voter?: number,
): Finding[];

export function extractJsonArray(text: string): unknown[] | null;

/** Returns findings, or null when the agent produced no usable output. */
export function parseAgentResult(
  filePath: string,
  agentKey: string,
  voter?: number,
): Finding[] | null;

// ── Consensus and grouping ───────────────────────────────────────────────────

export interface ConsensusResult {
  kept: Finding[];
  dropped: number;
  droppedFindings: Finding[];
}

export function applyConsensus(
  findings: Finding[],
  voterCount: number,
  callModel?: CallModel | null,
): Promise<ConsensusResult>;

export interface GroupingResult {
  keptGroups: FindingGroup[];
  droppedGroups: FindingGroup[];
}

export function groupAllFindings(
  kept: Finding[],
  dropped: Finding[],
  callModel?: CallModel | null,
): Promise<GroupingResult>;

// ── Suppressions ─────────────────────────────────────────────────────────────

export function loadSuppressions(filePath: string): Suppression[];

export interface SuppressionResult {
  kept: Finding[];
  suppressed: Finding[];
}

export function filterWithSuppressions(
  findings: Finding[],
  suppressions: Suppression[],
  callModel?: CallModel | null,
): Promise<SuppressionResult>;

export function callHaikuForBatch(
  batch: Finding[],
  suppressionList: string,
  callModel: CallModel,
): Promise<SuppressionResult>;

export function sanitizeSuppressionField(str: unknown): string;

// ── Agent discovery ──────────────────────────────────────────────────────────

export interface BaseAgentMeta {
  name: string;
  description: string;
}

export const BASE_AGENTS: Record<string, BaseAgentMeta>;
export const VALID_AGENT_KEY: RegExp;
export function isValidAgentKey(key: string): boolean;
export function loadCallerConfig(callerDir: string): Record<string, unknown>;
export function discoverBaseAgents(reviewHeroDir: string): Agent[];
export function discoverCustomAgents(
  callerDir: string,
  config: Record<string, unknown>,
): Agent[];

// ── Scope filtering ──────────────────────────────────────────────────────────

export const DEFAULT_IGNORE_PATTERNS: string[];
export function globMatch(pattern: string, filePath: string): boolean;
export function simpleWildcard(pattern: string, str: string): boolean;
export function filterDiff(
  rawDiff: string,
  patterns: string[],
): { filtered: string; removedFiles: string[] };

// ── Prompt assembly ──────────────────────────────────────────────────────────

export interface BasePromptOptions {
  projectContext?: string;
  promptPath: string;
  commitHelperPath?: string;
  customRulesPath?: string;
  aiRulesPath?: string;
  aiRulesLabel?: string;
}

export function buildBasePromptSections(options: BasePromptOptions): string[];
export function parseClaudeResult(raw: string): unknown[];

// ── Summary formatting ───────────────────────────────────────────────────────

export const SUMMARY_HEADER: string;
export const SEVERITY_ORDER: Record<Severity, number>;

export function buildSummaryHeader(args: {
  round: number | null;
  agentsCompleted: number;
  agentsFailed: number;
  counts: { critical: number; suggestion: number; nitpick: number };
}): string;

export function buildSummaryTable(
  nitpicks: Finding[],
  agentNames: Record<string, string>,
): string;

// ── Anthropic-backed model caller ────────────────────────────────────────────

export function createAnthropicModelCaller(opts: {
  apiKey: string;
  baseUrl?: string;
}): CallModel;
