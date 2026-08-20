/**
 * Print prompt-cache usage for a Claude CLI result file.
 *
 * The review-agent matrix invokes the Claude CLI directly from workflow YAML,
 * so it cannot reuse `logClaudeSession`. Rather than re-derive the numbers in
 * jq at each call site (which lets the hit-rate formula drift away from the
 * JS one), those steps shell out to this script.
 *
 * Usage:
 *   node cache-stats.mjs <result.json> [--label NAME] [--require-write]
 *
 * `--require-write` emits a workflow warning when nothing was written to the
 * cache, which for a priming run means the voters that follow will not share
 * a prefix.
 *
 * Exits 0 even when the file is missing or unparseable: this is reporting, and
 * it must never be the reason a review fails.
 */

import { readFileSync } from "node:fs";

import { formatCacheStats } from "./lib.mjs";

export function readUsage(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return parsed?.usage ?? null;
  } catch {
    return null;
  }
}

export function cacheWriteTokens(usage) {
  return usage?.cache_creation_input_tokens ?? 0;
}

function main(argv) {
  const args = argv.slice(2);
  const path = args.find((a) => !a.startsWith("--"));
  const requireWrite = args.includes("--require-write");
  const labelIndex = args.indexOf("--label");
  const label = labelIndex === -1 ? "" : (args[labelIndex + 1] ?? "");

  if (!path) {
    console.error("cache-stats: no result file given");
    return;
  }

  const usage = readUsage(path);
  const stats = formatCacheStats(usage);
  const prefix = label ? `${label}: ` : "";

  if (stats.length > 0) {
    console.log(`${prefix}${stats.join(" | ")}`);
  } else {
    console.log(`${prefix}no cache usage reported`);
  }

  if (requireWrite && cacheWriteTokens(usage) === 0) {
    console.log(
      `::warning::${prefix}prime run wrote no cache tokens — voters will not share a prefix`,
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv);
}
