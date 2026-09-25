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
  /** Link to the reviewed commit, from `formatCommitLink`. */
  commitLink?: string | null;
  agentsCompleted: number;
  agentsFailed: number;
  counts: { critical: number; suggestion: number; nitpick: number };
}): string;

export function buildSummaryTable(
  nitpicks: Finding[],
  agentNames: Record<string, string>,
): string;

// ── Completion comments ──────────────────────────────────────────────────────

/** Marker that opens the machine-readable block in a completion comment. */
export const COMPLETION_MARKER: string;

/** Version of the completion block's shape. */
export const COMPLETION_SCHEMA: number;

/** Metadata every completion block carries. */
interface CompletionBase {
  schema: number;
  /** The GitHub Actions run that posted the comment. */
  runUrl: string | null;
  reviewHero: {
    /** The Review Hero ref the caller asked for, e.g. `v1`. */
    ref: string | null;
    /** The Review Hero commit that ref resolved to. */
    sha: string | null;
  };
}

export interface ReviewCompletion extends CompletionBase {
  kind: "review";
  outcome: "completed" | "failed";
  reviewedSha: string;
  counts: {
    agentsCompleted: number;
    agentsFailed: number;
    voters: number;
    critical: number;
    suggestion: number;
    nitpick: number;
    belowThreshold: number;
    suppressed: number;
  };
}

export interface AutoFixCompletion extends CompletionBase {
  kind: "auto-fix";
  outcome: "fixed" | "no-changes" | "partial" | "failed" | "nothing-to-fix";
  /** Absent when the run failed before checking out a commit. */
  baseSha?: string;
  pushedSha: string | null;
  /**
   * `fixed` / `no-changes`: fixed and skipped counts, plus `suppressionsSaved`
   * unless saving suppressions failed. `partial` / `failed`: `outstanding`.
   * Absent when the run failed before it could count its work.
   */
  counts?: {
    reviewCommentsFixed?: number;
    reviewCommentsSkipped?: number;
    ciFailuresFixed?: number;
    ciFailuresSkipped?: number;
    suppressionsSaved?: number;
    outstanding?: number;
  };
}

export interface SaveSuppressionsCompletion extends CompletionBase {
  kind: "save-suppressions";
  outcome: "saved" | "none" | "failed";
  fixRequested: boolean;
  /** Absent when the run failed before checking out a commit. */
  baseSha?: string;
  pushedSha: string | null;
  /** Absent when saving failed. */
  counts?: { saved: number };
}

export type CompletionBlock =
  | ReviewCompletion
  | AutoFixCompletion
  | SaveSuppressionsCompletion;

/** A review round's result as data: the `review` block without its run metadata. */
export type ReviewResult = Omit<ReviewCompletion, "schema" | "runUrl" | "reviewHero">;

/**
 * Build a review round's result from the pipeline's outputs. The hosted review
 * serialises this same object into its completion block.
 */
export function buildReviewResult(args: {
  reviewedSha: string;
  agentsCompleted: number;
  agentsFailed: number;
  voters: number;
  keptGroups?: FindingGroup[];
  droppedGroups?: FindingGroup[];
  suppressedCount?: number;
}): ReviewResult;

/** `Omit` applied to each member of a union rather than to their common keys. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

/**
 * Short-SHA markdown link to a commit within its pull request. Null when any
 * part is malformed, so a bad value can't break out of the markdown link.
 */
export function formatCommitLink(args: {
  serverUrl: string;
  repo: string;
  prNumber: number | string;
  sha: string | null | undefined;
}): string | null;

/** The hidden `<!-- review-hero:completion {…} -->` block; `schema` is filled in. */
export function buildCompletionBlock(
  fields: DistributiveOmit<CompletionBlock, "schema">,
): string;

/**
 * The completion block in a comment body, or null when it has none. Reads the
 * last block, since the genuine one is always appended after any quoted text.
 *
 * SECURITY: this identifies Review Hero's own block within a comment Review
 * Hero wrote. It does not establish that the comment is Review Hero's — anyone
 * who can comment on the PR can post a well-formed block. Check the comment's
 * author before trusting the result.
 */
export function parseCompletionBlock(
  body: string | null | undefined,
): CompletionBlock | null;

/**
 * Neutralise anything block-shaped in untrusted text before embedding it in a
 * comment you post, so it can't be mistaken for your own block.
 */
export function stripCompletionBlocks(text: string | null | undefined): string;

// ── Anthropic-backed model caller ────────────────────────────────────────────

export function createAnthropicModelCaller(opts: {
  apiKey: string;
  baseUrl?: string;
}): CallModel;

// ── Prompt-safe rendering ────────────────────────────────────────────────────

/** Characters of a finding's comment included in a filtering prompt. */
export const COMMENT_LIMIT: number;

/**
 * Render an untrusted value for interpolation into a prompt: collapse newline
 * runs to a space and drop `<comment>` delimiters. Truncates to `maxLength`
 * first when given.
 */
export function sanitizeForPrompt(
  value: unknown,
  options?: { maxLength?: number },
): string;
