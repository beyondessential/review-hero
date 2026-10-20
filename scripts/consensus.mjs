/**
 * Review Hero — Consensus
 *
 * Reads every agent's result files, applies voter consensus per agent, and
 * writes the outcome for the second look and the orchestrator: the findings
 * consensus kept and dropped, and the contested areas the consensus model
 * thinks are worth a second look. Runs as its own step, before the GitHub App
 * token exists.
 *
 * Environment variables:
 *   ARTIFACTS_DIR       — Directory containing agent result files (scanned recursively)
 *   VOTERS              — Voters each agent ran, as triage set them (default: 1)
 *   CONSENSUS_PATH      — Where to write the consensus outcome
 *   ANTHROPIC_API_KEY   — API key for the consensus model (optional)
 *   ANTHROPIC_BASE_URL  — Custom base URL for the Anthropic API (optional)
 *   GITHUB_OUTPUT       — Receives `second_look=true` when there are contested areas
 */

import { appendFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { oneLine } from "./agent-process.mjs";
import { RESULT_FILE_PATTERN, votersFromEnv } from "./lib.mjs";
import {
  applyConsensus,
  createAnthropicModelCaller,
  parseAgentResult,
  isValidAgentKey,
} from "../src/index.mjs";

/** Every agent result file under `dir`, as `{ agentKey, voter, filePath }`. */
export function scanForResults(dir) {
  const results = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...scanForResults(fullPath));
    } else if (entry.isFile()) {
      const match = entry.name.match(RESULT_FILE_PATTERN);
      if (match && isValidAgentKey(match[1])) {
        results.push({
          agentKey: match[1],
          voter: match[2] !== undefined ? parseInt(match[2]) : undefined,
          filePath: fullPath,
        });
      }
    }
  }
  return results;
}

/**
 * Parse every result file once per agent voter. A file with no usable output
 * counts as a failed agent run.
 */
export function collectFindings(results) {
  const findings = [];
  let agentsCompleted = 0;
  let agentsFailed = 0;
  const seen = new Set();

  for (const { agentKey, voter, filePath } of results) {
    const key = voter !== undefined ? `${agentKey}-${voter}` : agentKey;
    if (seen.has(key)) continue;
    seen.add(key);

    const label = voter !== undefined ? `${agentKey} (voter ${voter})` : agentKey;
    const parsed = parseAgentResult(filePath, agentKey, voter);
    if (parsed === null) {
      console.warn(`${label}: failed to parse output`);
      agentsFailed++;
      continue;
    }
    console.log(`${label}: ${parsed.length} findings`);
    findings.push(...parsed);
    agentsCompleted++;
  }
  return { findings, agentsCompleted, agentsFailed };
}

/**
 * Apply consensus per agent, so that two agents flagging the same line stay
 * distinct findings. Contested groups point into the combined `dropped` list,
 * so a second look can move a confirmed group back to `kept`.
 */
export async function runConsensus({ findings, voters, callModel }) {
  if (voters <= 1) {
    return {
      kept: findings.map(({ voter, ...rest }) => rest),
      dropped: [],
      contested: [],
    };
  }

  const byAgent = new Map();
  for (const f of findings) {
    if (!byAgent.has(f.agent)) byAgent.set(f.agent, []);
    byAgent.get(f.agent).push(f);
  }

  const entries = [...byAgent.entries()];
  const results = await Promise.all(
    entries.map(([, agentFindings]) => applyConsensus(agentFindings, voters, callModel)),
  );

  const kept = [];
  const dropped = [];
  const contested = [];
  results.forEach((result, i) => {
    const offset = dropped.length;
    kept.push(...result.kept);
    dropped.push(...result.droppedFindings);
    for (const area of result.contested) {
      contested.push({
        agent: entries[i][0],
        area: area.area,
        groups: area.groups.map((group) => ({
          representative: group.representative,
          supporters: group.supporters,
          dropped: group.dropped.map((d) => offset + d),
        })),
      });
    }
  });
  return { kept, dropped, contested };
}

/**
 * The outcome to post from when the consensus step left none: every agent
 * result kept as it stands, since a review that skips consensus beats one that
 * throws away results already paid for.
 */
export function outcomeWithoutConsensus(artifactsDir, voters) {
  const { findings, agentsCompleted, agentsFailed } = collectFindings(scanForResults(artifactsDir));
  return {
    voters,
    agentsCompleted,
    agentsFailed,
    kept: findings.map(({ voter, ...rest }) => rest),
    dropped: [],
    contested: [],
    secondLook: 0,
  };
}

/** Write through a temporary file, so a reader never sees half of it. */
export function writeConsensus(path, consensus) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(consensus));
  renameSync(tmp, path);
}

async function main() {
  const artifactsDir = process.env.ARTIFACTS_DIR;
  const consensusPath = process.env.CONSENSUS_PATH;
  if (!artifactsDir || !consensusPath) {
    throw new Error("Missing ARTIFACTS_DIR or CONSENSUS_PATH");
  }
  const voters = votersFromEnv();
  const apiKey = process.env.ANTHROPIC_API_KEY || "";
  const callModel = apiKey
    ? createAnthropicModelCaller({
        apiKey,
        baseUrl: process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com",
      })
    : null;

  const { findings, agentsCompleted, agentsFailed } = collectFindings(scanForResults(artifactsDir));
  if (voters > 1) console.log(`Voter consensus enabled: ${voters} voters per agent`);
  const { kept, dropped, contested } = await runConsensus({ findings, voters, callModel });

  for (const area of contested) {
    // The label is the consensus model's, so it is kept to one line.
    console.log(`Contested: ${area.agent}, ${oneLine(area.area)} (${area.groups.length} finding(s))`);
  }

  writeConsensus(consensusPath, {
    voters,
    agentsCompleted,
    agentsFailed,
    kept,
    dropped,
    contested,
    secondLook: 0,
  });

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `second_look=${contested.length > 0}\n`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`::error::consensus: ${err.message}`);
    process.exit(1);
  });
}
