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

/**
 * Apply voter consensus to determine whether findings from different voters are
 * about the same issue. The model receives all findings and returns which ones
 * to keep — the deduplicated set that a majority of voters agree on.
 *
 * Falls back to keeping all findings (stripped of voter tags) on error or when
 * no `callModel` is supplied.
 */
export async function applyConsensus(findings, voterCount, callModel) {
  if (voterCount <= 1) {
    return { kept: findings.map(({ voter, ...rest }) => rest), dropped: 0, droppedFindings: [] };
  }

  if (!callModel) {
    console.warn("No model caller for consensus — keeping all findings");
    return { kept: findings.map(({ voter, ...rest }) => rest), dropped: 0, droppedFindings: [] };
  }

  const threshold = Math.floor(voterCount / 2) + 1;

  const findingsList = findings
    .map((f, i) => {
      const safeComment = f.comment
        .slice(0, 300)
        .replace(/[\r\n]+/g, " ")
        .replace(/<\/?comment>/gi, "");
      const safeVoter = String(f.voter).replace(/[\r\n]+/g, " ");
      const safeFile = String(f.file)
        .replace(/[\r\n]+/g, " ")
        .replace(/<\/?comment>/gi, "");
      const safeLine = String(f.line).replace(/[\r\n]+/g, " ");
      return `${i}. [voter=${safeVoter}] [${f.severity}] ${safeFile}:${safeLine} — <comment>${safeComment}</comment>`;
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

## Findings
${findingsList}

Output a JSON array of finding indices (0-based) — only the best-worded representative from each group that meets the ${threshold}-voter threshold.

Example: [0, 3]`,
        },
      ],
    });

    const validIndex = (n) => Number.isInteger(n) && n >= 0 && n < findings.length;

    const arrMatch = text.match(/\[\s*(?:\d+\s*(?:,\s*\d+\s*)*)?\]/);
    if (!arrMatch) {
      console.warn("Consensus returned no parseable output — keeping all");
      return { kept: findings.map(({ voter, ...rest }) => rest), dropped: 0, droppedFindings: [] };
    }
    const keptIndices = new Set(JSON.parse(arrMatch[0]).map(Number).filter(validIndex));

    const kept = findings
      .filter((_, i) => keptIndices.has(i))
      .map(({ voter, ...rest }) => rest);
    const droppedFindings = findings
      .filter((_, i) => !keptIndices.has(i))
      .map(({ voter, ...rest }) => rest);

    console.log(
      `Consensus: kept ${kept.length}, dropped ${droppedFindings.length} (${threshold}/${voterCount} voter threshold)`,
    );
    return { kept, dropped: droppedFindings.length, droppedFindings };
  } catch (err) {
    console.warn(`Consensus filter failed, keeping all: ${err.message}`);
    return { kept: findings.map(({ voter, ...rest }) => rest), dropped: 0, droppedFindings: [] };
  }
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
      const safeComment = f.comment
        .slice(0, 300)
        .replace(/[\r\n]+/g, " ")
        .replace(/<\/?comment>/gi, "");
      const safeFile = String(f.file)
        .replace(/[\r\n]+/g, " ")
        .replace(/<\/?comment>/gi, "");
      const tag = f._status === "kept" ? "KEPT" : "DROPPED";
      return `${i}. [${tag}] [${f.agent}] [${f.severity}] ${safeFile}:${f.line} — <comment>${safeComment}</comment>`;
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
