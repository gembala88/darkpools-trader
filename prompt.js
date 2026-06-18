function buildSystemPrompt() {
  return [
    "You are a disciplined Solana token screening assistant.",
    "You CANNOT predict price. Judge ONLY on the provided metrics and timing verdict.",
    "You may ONLY pick from the provided candidate list, by mint. You MAY pick none.",
    "Prefer caution: if nothing is clearly favorable, return pick=null.",
    'Respond with STRICT JSON only. No prose, no markdown, no code fences.',
    'JSON schema:',
    '{',
    '  "pick": <mint string | null>,',
    '  "confidence": <number 0..1>,',
    '  "reason": <short string>,',
    '  "rejected": [ { "mint": <string>, "why": <short> } ]',
    '}',
    'Note: feeConfirm=confirmed means price rose with positive buy pressure (healthy momentum);',
    'neutral/unknown means no confirmation — treat as mild positive only, never decisive.',
  ].join("\n");
}

function buildUserPrompt(candidates) {
  const lines = ["Evaluate these Solana token candidates and pick the best one to buy (or none):"];
  for (const c of candidates) {
    const t = c.timing || {};
    const ind = t.indicators || {};
    const skipped = (c.checks || [])
      .filter((ch) => ch.result === "skip")
      .map((ch) => ch.name)
      .join(",");

    lines.push(
      `- mint=${c.mint}` +
      ` symbol=${c.symbol || "?"}` +
      ` score=${c.score}` +
      ` timing=${t.signal || "?"}` +
      ` emaFast=${ind.emaFast != null ? ind.emaFast : "?"}` +
      ` emaSlow=${ind.emaSlow != null ? ind.emaSlow : "?"}` +
      ` rsi=${ind.rsi != null ? ind.rsi : "?"}` +
       ` liquidityUsd=${c.candidate?.liquidityUsd != null ? c.candidate.liquidityUsd : "?"}` +
       ` volume24hUsd=${c.candidate?.volume24hUsd != null ? c.candidate.volume24hUsd : "?"}` +
       ` ageHours=${c.candidate?.ageHours != null ? c.candidate.ageHours.toFixed(1) : "?"}` +
       ` feeConfirm=${c.feeConfirm?.signal || "unknown"}` +
      (skipped ? ` skipped_checks=${skipped}` : "")
    );
  }
  return lines.join("\n");
}

module.exports = { buildSystemPrompt, buildUserPrompt };
