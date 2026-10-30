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
  /** The last line of the range the finding covers; absent when it covers `line` alone. */
  endLine?: number;
  severity: Severity;
  comment: string;
  agent: string;
  /** Present only on multi-voter runs: `${agent}-${voter}`. */
  voter?: string;
  /**
   * Voters and second-look checkers that support the finding. Set on findings
   * consensus kept: null where the review cannot tell, 1 with one voter per agent.
   */
  supporters?: number | null;
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

/** A group of findings below the majority, put to a second look. */
export interface ContestedGroup {
  /** The group's first finding, without its voter tag. */
  representative: Finding;
  /** Every finding in the group, voter tags intact. */
  members: Finding[];
  /** Where each member sits in the result's `droppedFindings`. */
  dropped: number[];
  /** Distinct voters behind the group. */
  supporters: number;
}

/** A part of the code where findings below the majority are worth a second look. */
export interface ContestedArea {
  area: string;
  groups: ContestedGroup[];
}

export interface ConsensusResult {
  kept: Finding[];
  dropped: number;
  droppedFindings: Finding[];
  /** At most `MAX_CONTESTED_AREAS` areas, empty when consensus named none. */
  contested: ContestedArea[];
  /**
   * Whether the consensus model filtered these findings. False when every
   * finding was kept unfiltered: one voter, no model caller, or a failed or
   * unreadable reply.
   */
  applied: boolean;
}

export const MAX_CONTESTED_AREAS: number;

/** Read the consensus model's reply, or null when it has no usable answer. */
export function parseConsensusReply(
  text: string,
): {
  keep: number[];
  /** Kept index to the indices of its group, for the groups the reply gave. */
  members: Record<number, number[]>;
  contested: Array<{ area: string; groups: number[][] }>;
} | null;

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

export interface ReviewAgentPromptOptions {
  projectContext?: string;
  /** The shared agent prompt (`prompts/agent-prompt.md`). */
  basePrompt: string;
  /** The agent's own specialisation prompt. */
  agentPrompt: string;
  /** The repository's AI rules, left out when empty. */
  aiRules?: string;
  /** The agent's hard turn cap; the prompt names a lower soft cap. */
  maxTurns: number;
  prTitle?: string;
  diff: string;
}

/** The turn a review agent is told to stop exploring by, below its hard cap. */
export function softTurnCap(maxTurns: number): number;
/** Byte-identical for identical options, so an agent's voters share a cached prefix. */
export function buildReviewAgentPrompt(options: ReviewAgentPromptOptions): string;

export interface CheckerPromptOptions {
  projectContext?: string;
  /** The checker instructions (`prompts/checker-prompt.md`). */
  checkerPrompt: string;
  /** The agent's own specialisation prompt. */
  agentPrompt: string;
  aiRules?: string;
  maxTurns: number;
  prTitle?: string;
  diff: string;
  /** The contested area's label, from consensus. */
  area: string;
  /** The findings to judge, numbered in this order. */
  findings: Finding[];
}

/** The prompt for a second-look checker, identical for every checker of an area. */
export function buildCheckerPrompt(options: CheckerPromptOptions): string;
export function parseClaudeResult(raw: string): unknown[];

// ── Summary formatting ───────────────────────────────────────────────────────

export const SUMMARY_HEADER: string;
export const SEVERITY_ORDER: Record<Severity, number>;

export function buildSummaryHeader(args: {
  round: number | null;
  /** Link to the reviewed commit, from `formatCommitLink`. */
  commitLink?: string | null;
  /** Model the review agents ran on. */
  model?: string;
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
  /** The GitHub Actions run id that posted the comment. */
  runId?: number;
  runAttempt?: number;
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
  /** Model the review agents ran on. */
  model?: string;
  /**
   * How posting the round's findings went. Absent when the review has no
   * findings URL.
   */
  findingsPost?: FindingsPostStatus;
  counts: {
    agentsCompleted: number;
    agentsFailed: number;
    voters: number;
    critical: number;
    suggestion: number;
    nitpick: number;
    belowThreshold: number;
    suppressed: number;
    /** Findings below the majority that a second look confirmed. */
    secondLook: number;
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
export type ReviewResult = Omit<
  ReviewCompletion,
  "schema" | "runUrl" | "runId" | "runAttempt" | "reviewHero" | "findingsPost"
>;

/** How posting a round's findings went. */
export type FindingsPostStatus =
  | "accepted"
  | "refused"
  | "unreachable"
  | "no-token"
  | "invalid-url";

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
  /** Findings below the majority that a second look confirmed. */
  secondLook?: number;
  model?: string;
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

// ── Diff hunks ───────────────────────────────────────────────────────────────

/** First and last new-side line of one diff hunk, inclusive. */
export interface Hunk {
  start: number;
  end: number;
}

/** The new-side hunks of each file in a unified diff. */
export function parseHunks(diff: string): Map<string, Hunk[]>;

/**
 * Where an inline comment for a finding goes: its range when both ends lie in
 * one hunk of its file, its start line alone otherwise. `line` is the comment's
 * last line and `startLine` is present only for a multi-line comment.
 */
export function commentLines(
  finding: Pick<Finding, "file" | "line" | "endLine">,
  hunks?: Map<string, Hunk[]>,
): { line: number; startLine?: number };

// ── A review round as data ───────────────────────────────────────────────────

/** Version of the posted findings payload's shape. */
export const FINDINGS_SCHEMA: number;

export interface RoundFinding {
  severity: Severity;
  agent: { key: string; name: string };
  path: string;
  startLine: number;
  /** Null when the finding covers its start line alone. */
  endLine: number | null;
  /** Voters and second-look checkers behind the finding; null when the review cannot tell. */
  supporters: number | null;
  /** The comment as the agent wrote it. */
  comment: string;
}

export interface PostedFinding extends RoundFinding {
  /** Unique within the run attempt. */
  id: string;
  /** The GitHub review comment the finding was posted as, or null. */
  commentId: number | null;
}

export interface FindingsPayload extends Omit<ReviewResult, "kind"> {
  schema: number;
  repository: string;
  prNumber: number;
  runId: number;
  runAttempt: number;
  reviewHero: { ref: string | null; sha: string | null };
  findings: PostedFinding[];
}

/** The round's kept findings, one per group. */
export function buildRoundFindings(
  keptGroups: FindingGroup[],
  agentNames?: Record<string, string>,
): RoundFinding[];

/** The payload for one round: its result and findings, with run metadata and comment ids. */
export function buildFindingsPayload(args: {
  repository: string;
  prNumber: number;
  runId: number;
  runAttempt: number;
  reviewHero: { ref: string | null; sha: string | null };
  result: ReviewResult;
  findings: RoundFinding[];
  commentIds?: Array<number | null>;
}): FindingsPayload;
