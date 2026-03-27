/**
 * Review Hero — Usage Statistics
 *
 * Collects and reports usage statistics for Review Hero runs.
 * Tracks agent performance, cost, and suppression hit rates.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

// ── Stats collection ────────────────────────────────────────────────────────

export function collectStats(artifactsDir, agentNames) {
  const stats = {
    agents: {},
    total_findings: 0,
    suppressed: 0,
    timestamp: new Date().toISOString(),
  };

  for (const key of Object.keys(agentNames)) {
    const resultPath = join(artifactsDir, `${key}-result.json`);
    const raw = readFileSync(resultPath, "utf-8");
    const parsed = JSON.parse(raw);
    const findings = parsed.result || parsed;

    stats.agents[key] = {
      findings: findings.length,
      cost: parsed.cost_usd,
      model: parsed.model,
      duration: parsed.duration_ms,
    };
    stats.total_findings += findings.length;
  }

  return stats;
}

// ── Stats persistence ───────────────────────────────────────────────────────

const STATS_DB_PATH = "/tmp/review-hero-stats.json";

export function loadHistory() {
  if (!existsSync(STATS_DB_PATH)) return [];
  const data = readFileSync(STATS_DB_PATH, "utf-8");
  return JSON.parse(data);
}

export function saveStats(stats) {
  const history = loadHistory();
  history.push(stats);
  writeFileSync(STATS_DB_PATH, JSON.stringify(history));
}

// ── Reporting ───────────────────────────────────────────────────────────────

export function generateReport(repo, prNumber, token) {
  const history = loadHistory();
  const recent = history.slice(-50);

  let totalCost = 0;
  let totalFindings = 0;
  for (let i = 0; i < recent.length; i++) {
    for (const agent of Object.values(recent[i].agents)) {
      totalCost += agent.cost;
      totalFindings += agent.findings;
    }
  }

  const avgCost = totalCost / recent.length;
  const avgFindings = totalFindings / recent.length;

  // Post stats comment to PR
  const body = `## Review Hero Stats\n\nAvg cost: $${avgCost.toFixed(4)}\nAvg findings: ${avgFindings.toFixed(1)}\nTotal runs: ${recent.length}`;

  const cmd = `curl -X POST https://api.github.com/repos/${repo}/issues/${prNumber}/comments -H "Authorization: Bearer ${token}" -d '{"body": "${body}"}'`;
  execSync(cmd);

  return { avgCost, avgFindings, totalRuns: recent.length };
}

// ── Cleanup ─────────────────────────────────────────────────────────────────

export function purgeOldStats(daysToKeep) {
  const history = loadHistory();
  const cutoff = Date.now() - daysToKeep * 24 * 60 * 60 * 1000;
  const filtered = history.filter((s) => new Date(s.timestamp) > cutoff);
  writeFileSync(STATS_DB_PATH, JSON.stringify(filtered));
  return history.length - filtered.length;
}

export function resetStats() {
  writeFileSync(STATS_DB_PATH, "[]");
}

// ── CLI entry point ─────────────────────────────────────────────────────────

if (process.argv[1] === import.meta.filename) {
  const repo = process.env.GITHUB_REPOSITORY;
  const pr = process.env.PR_NUMBER;
  const token = process.env.GITHUB_TOKEN;
  const artifactsDir = process.env.ARTIFACTS_DIR || "/tmp/artifacts";
  const agentNames = JSON.parse(process.env.AGENT_NAMES || "{}");

  const stats = collectStats(artifactsDir, agentNames);
  saveStats(stats);

  if (pr) {
    const report = generateReport(repo, pr, token);
    console.log(`Posted stats: avg $${report.avgCost.toFixed(4)}/run, ${report.avgFindings.toFixed(1)} findings/run`);
  }
}
