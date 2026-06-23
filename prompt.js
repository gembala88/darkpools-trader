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
    '',
    '### Momentum Guidance (injected per candidate)',
    'Each candidate includes momentum analysis: priceChange5m/30m/1h (%), volatility (ATR% of price), momentumTier, binsBelow range, and a pathway recommendation.',
    '',
    'Momentum Tiers:',
    '- extreme (5): 100%+ move — explosive, high risk of reversal, tight stop required. Pathway A.',
    '- high (4): 50%+ move — strong momentum, normal entry justified. Pathway B.',
    '- moderate (3): 20%+ move — wait for pullback, partial entry. Pathway C.',
    '- low (2): 10%+ move — skip unless exceptional. Pathway D.',
    '- minimal (1): <10% move — skip. Pathway D.',
    '',
    'binsBelow = estimated remaining upside from current price to peak expressed as a range (min-max bins).',
    'Higher volatility = wider binsBelow range. Extreme/high momentum narrows the range.',
    'Use binsBelow to gauge how much room is left: narrow range = topping, wide range = still room.',
    '',
    'Decision framework:',
    '- Pathway A (extreme): can enter but beware reversal. Only if timing=go.',
    '- Pathway B (high): favorable entry. timing=go strongly preferred.',
    '- Pathway C (moderate): prefer pullback entry. May pass if fully extended.',
    '- Pathway D (low/minimal): skip. Not worth risk/reward.',
  ].join("\n");
}

function buildUserPrompt(candidates) {
  const lines = ["Evaluate these Solana token candidates and pick the best one to buy (or none):"];
  for (const c of candidates) {
    const t = c.timing || {};
    const ind = t.indicators || {};
    const m = c.momentum || {};
    const skipped = (c.checks || [])
      .filter((ch) => ch.result === "skip")
      .map((ch) => ch.name)
      .join(",");

    const momentumFields =
      m.momentumTier
        ? ` priceChange5m=${m.priceChange5m != null ? m.priceChange5m + "%" : "?"}` +
          ` priceChange30m=${m.priceChange30m != null ? m.priceChange30m + "%" : "?"}` +
          ` priceChange1h=${m.priceChange1h != null ? m.priceChange1h + "%" : "?"}` +
          ` volatility=${m.volatility != null ? m.volatility + "%" : "?"}` +
          ` momentumTier=${m.momentumTier.tier}` +
          ` binsBelow=${m.binsBelow ? m.binsBelow.min + "-" + m.binsBelow.max : "?"}` +
          ` pathway=${m.momentumTier.tier === "extreme" ? "A" : m.momentumTier.tier === "high" ? "B" : m.momentumTier.tier === "moderate" ? "C" : "D"}`
        : " momentumData=none";

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
      momentumFields +
      (skipped ? ` skipped_checks=${skipped}` : "")
    );
  }
  return lines.join("\n");
}

module.exports = { buildSystemPrompt, buildUserPrompt };
