/**
 * Review Hero — Consensus and cross-agent grouping
 *
 * Decides which findings are "the same finding" across voters and across
 * agents. Both stages delegate the semantic judgement to a model, but the call
 * itself is injected: `callModel({ model, maxTokens, messages, thinking }) =>
 * Promise<string>` returns the model's text. This repo passes an
 * Anthropic-backed implementation; other consumers pass their own. Passing a
 * falsy `callModel` keeps every finding, matching the "no model available"
 * fallback.
 */

import { sanitizeForPrompt, COMMENT_LIMIT } from "./sanitize.mjs";

/** The most contested areas consensus names for one agent's findings. */
export const MAX_CONTESTED_AREAS = 3;

/**
 * Apply voter consensus to determine whether findings from different voters are
 * about the same issue. The model receives all findings and returns which ones
 * to keep — the deduplicated set that a majority of voters agree on — and the
 * contested areas: groups below the majority that cluster where a second look
 * is worth it.
 *
 * Each contested group carries its member findings (voter tags intact), where
 * they sit in `droppedFindings`, and the number of distinct voters behind it.
 *
 * Falls back to keeping all findings (stripped of voter tags) with no contested
 * areas on error or when no `callModel` is supplied.
 */
// spec: RUN#second-look
export async function applyConsensus(findings, voterCount, callModel) {
  const keepAll = () => ({
    kept: findings.map(({ voter, ...rest }) => rest),
    dropped: 0,
    droppedFindings: [],
    contested: [],
  });

  if (voterCount <= 1) return keepAll();

  if (!callModel) {
    console.warn("No model caller for consensus — keeping all findings");
    return keepAll();
  }

  const threshold = Math.floor(voterCount / 2) + 1;

  const findingsList = findings
    .map((f, i) => {
      const safeComment = sanitizeForPrompt(f.comment, { maxLength: COMMENT_LIMIT });
      const safeVoter = sanitizeForPrompt(f.voter);
      const safeFile = sanitizeForPrompt(f.file);
      const safeLine = sanitizeForPrompt(f.line);
      const safeSeverity = sanitizeForPrompt(f.severity);
      return `${i}. [voter=${safeVoter}] [${safeSeverity}] ${safeFile}:${safeLine} — <comment>${safeComment}</comment>`;
    })
    .join("\n");

  try {
    const text = await callModel({
      model: "claude-sonnet-5",
      maxTokens: 3000,
      // Mechanical grouping — no reasoning needed, and thinking would eat
      // into the token budget the JSON output needs.
      thinking: { type: "disabled" },
      messages: [
        {
          role: "user",
          content: `You are deduplicating code review findings from ${voterCount} independent voters. Each voter reviewed the same code independently.

## Grouping rules

Two findings belong in the SAME group if they describe the same root problem, even if they:
- Use completely different wording or framing
- Reference different but nearby lines in the same file (e.g. line 48 vs 55)
- Have different severity levels
- Approach the issue from different angles (e.g. "missing try/catch" vs "JSON.parse can throw" vs "no error handling")
- One is more specific than the other (e.g. "no validation" vs "no validation on JSON.parse input")

Two findings belong in DIFFERENT groups only if fixing one would NOT fix the other.

## Threshold

For each group, count the number of distinct voters (use the voter= tag). If >= ${threshold} distinct voters flagged it, keep the single best-worded finding as the representative.

## Contested areas

Some groups fall below the threshold. Most of them are noise, but sometimes they cluster: several voters each flagged something different in the same part of the code, or a lone finding looks serious and well-founded. Such a cluster suggests a real problem the voters did not agree on, and is worth a second look by fresh reviewers.

Name at most ${MAX_CONTESTED_AREAS} contested areas. Each is a short label for the part of the code, and the below-threshold groups in it, each group as the list of its member finding indices. Name none when the below-threshold groups look like ordinary noise.

## Findings
${findingsList}

Output a single JSON object and nothing else:
- "keep": the indices (0-based) of the best-worded representative from each group that meets the ${threshold}-voter threshold
- "contested": the contested areas, each {"area": "<label>", "groups": [[<indices>], ...]}

Example: {"keep": [0, 3], "contested": [{"area": "retry loop in src/fetch.ts", "groups": [[5], [7, 9]]}]}`,
        },
      ],
    });

    const validIndex = (n) => Number.isInteger(n) && n >= 0 && n < findings.length;
    const parsed = parseConsensusReply(text);
    if (!parsed) {
      console.warn("Consensus returned no parseable output — keeping all");
      return keepAll();
    }
    const keptIndices = new Set(parsed.keep.filter(validIndex));

    const kept = findings
      .filter((_, i) => keptIndices.has(i))
      .map(({ voter, ...rest }) => rest);
    const droppedFindings = [];
    const droppedAt = new Map(); // input index → index in droppedFindings
    findings.forEach(({ voter, ...rest }, i) => {
      if (keptIndices.has(i)) return;
      droppedAt.set(i, droppedFindings.length);
      droppedFindings.push(rest);
    });

    // A contested group may only hold findings consensus dropped, and each
    // finding belongs to one group at most.
    const claimed = new Set();
    const contested = [];
    for (const area of parsed.contested.slice(0, MAX_CONTESTED_AREAS)) {
      const groups = [];
      for (const indices of area.groups) {
        const members = indices.filter(
          (i) => validIndex(i) && !keptIndices.has(i) && !claimed.has(i),
        );
        if (members.length === 0) continue;
        for (const i of members) claimed.add(i);
        const memberFindings = members.map((i) => findings[i]);
        const { voter, ...representative } = memberFindings[0];
        groups.push({
          representative,
          members: memberFindings,
          dropped: members.map((i) => droppedAt.get(i)),
          supporters: new Set(memberFindings.map((f) => f.voter)).size,
        });
      }
      if (groups.length > 0) contested.push({ area: area.area, groups });
    }

    console.log(
      `Consensus: kept ${kept.length}, dropped ${droppedFindings.length} (${threshold}/${voterCount} voter threshold), ${contested.length} contested area(s)`,
    );
    return { kept, dropped: droppedFindings.length, droppedFindings, contested };
  } catch (err) {
    console.warn(`Consensus filter failed, keeping all: ${err.message}`);
    return keepAll();
  }
}

/**
 * Read the consensus model's reply: a `{ keep, contested }` object, or a bare
 * array of kept indices, which names no contested areas. Null when neither
 * can be found.
 */
export function parseConsensusReply(text) {
  const asIndices = (value) =>
    Array.isArray(value) ? value.map(Number).filter(Number.isInteger) : [];
  const asAreas = (value) =>
    Array.isArray(value)
      ? value
          .filter((a) => a && typeof a === "object" && Array.isArray(a.groups))
          .map((a) => ({
            area: String(a.area ?? "").slice(0, 200),
            groups: a.groups.filter(Array.isArray).map(asIndices),
          }))
      : [];

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1));
      if (parsed && Array.isArray(parsed.keep)) {
        return { keep: asIndices(parsed.keep), contested: asAreas(parsed.contested) };
      }
    } catch {
      // Not an object reply; try a bare array below
    }
  }

  const arrMatch = text.match(/\[\s*(?:\d+\s*(?:,\s*\d+\s*)*)?\]/);
  if (!arrMatch) return null;
  return { keep: asIndices(JSON.parse(arrMatch[0])), contested: [] };
}

/**
 * Group ALL findings (kept + dropped) across all agents. Picks the best-worded
 * comment per group. Returns grouped findings split into kept groups (any
 * member passed consensus) and dropped groups (none did).
 *
 * Falls back to one-finding-per-group on error or when no `callModel` is
 * supplied.
 */
export async function groupAllFindings(kept, dropped, callModel) {
  const all = [
    ...kept.map((f) => ({ ...f, _status: "kept" })),
    ...dropped.map((f) => ({ ...f, _status: "dropped" })),
  ];

  if (all.length <= 1 || !callModel) {
    return {
      keptGroups: kept.map((f) => ({ representative: f, members: [f] })),
      droppedGroups: dropped.map((f) => ({ representative: f, members: [f] })),
    };
  }

  const findingsList = all
    .map((f, i) => {
      const safeComment = sanitizeForPrompt(f.comment, { maxLength: COMMENT_LIMIT });
      const safeFile = sanitizeForPrompt(f.file);
      const safeLine = sanitizeForPrompt(f.line);
      const safeAgent = sanitizeForPrompt(f.agent);
      const safeSeverity = sanitizeForPrompt(f.severity);
      const tag = f._status === "kept" ? "KEPT" : "DROPPED";
      return `${i}. [${tag}] [${safeAgent}] [${safeSeverity}] ${safeFile}:${safeLine} — <comment>${safeComment}</comment>`;
    })
    .join("\n");

  try {
    const text = await callModel({
      model: "claude-sonnet-5",
      maxTokens: 2000,
      // Mechanical grouping — no reasoning needed, and thinking would eat
      // into the token budget the JSON output needs.
      thinking: { type: "disabled" },
      messages: [
        {
          role: "user",
          content: `You are grouping code review findings from multiple independent review agents. Some findings passed voter consensus (KEPT), others did not (DROPPED). Different agents may have flagged the same underlying issue.

## Grouping rules

Two findings belong in the SAME group if they describe the same root problem, even if they:
- Come from different agents (bugs, security, performance, etc.)
- Have different KEPT/DROPPED status
- Use different wording, severity, or framing
- Reference different but nearby lines in the same file
- Approach the issue from different angles (e.g. "missing try/catch" vs "JSON.parse can throw")

Two findings belong in DIFFERENT groups only if fixing one would NOT fix the other.

For each group, pick the single best-worded finding as the representative.

## Findings
${findingsList}

Output a JSON object mapping representative index to array of group member indices.
Example: {"0": [0, 3, 7], "2": [2], "5": [5, 8]}`,
        },
      ],
    });

    // Extract JSON object using bracket-pair scanning (not greedy regex,
    // which would break if the LLM adds explanatory text with braces).
    let parsed = null;
    let searchFrom = 0;
    while (searchFrom < text.length) {
      const start = text.indexOf("{", searchFrom);
      if (start === -1) break;
      let searchEnd = text.length;
      while (searchEnd > start) {
        const end = text.lastIndexOf("}", searchEnd - 1);
        if (end <= start) break;
        try {
          const candidate = JSON.parse(text.slice(start, end + 1));
          if (typeof candidate === "object" && !Array.isArray(candidate)) {
            parsed = candidate;
            break;
          }
        } catch {
          // Not valid JSON for this pair — try a shorter span
        }
        searchEnd = end;
      }
      if (parsed) break;
      searchFrom = start + 1;
    }
    if (!parsed) {
      throw new Error("No parseable JSON object in response");
    }
    const validIndex = (n) => Number.isInteger(n) && n >= 0 && n < all.length;
    const keptGroups = [];
    const droppedGroups = [];
    const assigned = new Set();

    for (const [repStr, members] of Object.entries(parsed)) {
      const rep = Number(repStr);
      if (!validIndex(rep) || !Array.isArray(members)) continue;
      const validMembers = members.map(Number).filter(validIndex);
      if (validMembers.length === 0) continue;

      const allMembers = [rep, ...validMembers.filter((m) => m !== rep)];
      for (const m of allMembers) assigned.add(m);

      const memberFindings = allMembers.map((m) => all[m]);
      const hasKept = memberFindings.some((f) => f._status === "kept");
      // Strip _status before returning
      const clean = (f) => { const { _status, ...rest } = f; return rest; };
      const group = {
        representative: clean(all[rep]),
        members: memberFindings.map(clean),
      };

      if (hasKept) {
        keptGroups.push(group);
      } else {
        droppedGroups.push(group);
      }
    }

    // Add unassigned findings
    for (let i = 0; i < all.length; i++) {
      if (assigned.has(i)) continue;
      const { _status, ...rest } = all[i];
      const group = { representative: rest, members: [rest] };
      if (_status === "kept") {
        keptGroups.push(group);
      } else {
        droppedGroups.push(group);
      }
    }

    console.log(
      `Cross-agent grouping: ${all.length} findings → ${keptGroups.length} kept groups, ${droppedGroups.length} dropped groups`,
    );
    return { keptGroups, droppedGroups };
  } catch (err) {
    console.warn(`Cross-agent grouping failed: ${err.message}`);
    const clean = (f) => { const { _status, ...rest } = f; return rest; };
    return {
      keptGroups: kept.map((f) => ({ representative: clean(f), members: [clean(f)] })),
      droppedGroups: dropped.map((f) => ({ representative: clean(f), members: [clean(f)] })),
    };
  }
}
