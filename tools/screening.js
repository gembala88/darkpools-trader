const fs = require("fs");
const path = require("path");
const signals = require("./signals/index");
const candles = require("./signals/candles");
const strategy = require("../strategies/index");
const safety = require("./filters/safety");
const agent = require("../agent");
const gmgn = require("./signals/gmgn");

async function scan(config) {
  const candidates = await signals.getCandidates(config);
  const scannedCount = candidates.length;

  const skippedPerCheck = {};
  const passedCandidates = [];

  for (const c of candidates) {
    const result = await safety.applySafetyFilter(c, config);

    for (const check of result.checks) {
      if (check.result === "skip") {
        skippedPerCheck[check.name] = (skippedPerCheck[check.name] || 0) + 1;
      }
    }

    if (result.passed) {
      passedCandidates.push({ candidate: c, checks: result.checks });
    }
  }

  const safeCount = passedCandidates.length;

  // deterministic scoring within batch
  function median(arr) {
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  const liqValues = passedCandidates.map((p) => p.candidate.liquidityUsd || 0);
  const volValues = passedCandidates.map((p) => p.candidate.volume24hUsd || 0);
  const medianLiq = median(liqValues) || 1;
  const medianVol = median(volValues) || 1;
  const minAge = config.filters?.minTokenAgeHours || 1;

  const withScores = await Promise.all(passedCandidates.map(async (item) => {
    const c = item.candidate;
    const w = config.scoring;

    const liqScore = c.liquidityUsd
      ? Math.min(c.liquidityUsd / (medianLiq * 3), 1)
      : 0;
    const volScore = c.volume24hUsd
      ? Math.min(c.volume24hUsd / (medianVol * 3), 1)
      : 0;
    const ageScore = c.ageHours
      ? Math.min(c.ageHours / (minAge * 4), 1)
      : 0;

    let score =
      (w.wLiquidity || 0) * liqScore +
      (w.wVolume || 0) * volScore +
      (w.wAge || 0) * ageScore;

    // fee/activity confirmation (reuses gmgn cache, no extra cli call)
    let feeConfirm = { signal: "unknown", priceUp: null, buyPressure: null };
    try {
      const stats = await gmgn.getTokenStats(c.mint, config);
      if (stats.available && stats.feeConfirm) {
        feeConfirm = stats.feeConfirm;
        const nudge = config.confirmation?.feeConfirmNudge || 1.05;
        if (feeConfirm.signal === "confirmed") {
          score = score * nudge;
        }
      }
    } catch {
      // feeConfirm stays unknown, score unchanged
    }

    return {
      mint: c.mint,
      symbol: c.symbol,
      candidate: c,
      score: parseFloat(score.toFixed(4)),
      checks: item.checks,
      timing: null,
      feeConfirm,
    };
  }));

  withScores.sort((a, b) => b.score - a.score);
  const topN = config.scoring.topN || 10;
  const ranked = withScores.slice(0, topN);

  // timing: fetch candles + run strategy only for top N (not all safe candidates)
  const tfConfig = config.strategy.trendFollowing;
  const strat = strategy.getActiveStrategy(config);
  for (const r of ranked) {
    const c = r.candidate;
    let candleData = [];
    if (config.sources.geckoterminalOhlc?.enabled && c.pairAddress) {
      try {
        candleData = await candles.getCandles(c, tfConfig);
      } catch (err) {
        console.log(`candles error for ${c.mint}: ${err.message}`);
      }
    }
    r.timing = strat.evaluate(c, candleData, tfConfig);
  }

  // LLM decision
  const decision = await agent.decide(ranked, config);

  const result = { scannedCount, safeCount, skippedPerCheck, ranked, decision };

  // log summary
  console.log("\n=== SCAN RESULT ===");
  console.log(`Scanned: ${scannedCount} | Safe: ${safeCount}`);
  const skipSummary = Object.entries(skippedPerCheck)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  console.log(`Skipped-per-check: ${skipSummary || "none"}`);
  console.log(`\nTop ${ranked.length} candidates (safe + timing):`);
  for (const r of ranked) {
    const fails = r.checks.filter((c) => c.result === "fail");
    const skips = r.checks.filter((c) => c.result === "skip");
    const t = r.timing || {};
    const ind = t.indicators || {};
    const timingStr = `${t.signal || "?"}`;
    const indStr =
      ind.emaFast != null
        ? ` EMA${ind.emaFast} EMA${ind.emaSlow} RSI${ind.rsi}`
        : "";
    console.log(
      `  ${r.symbol || "?"} (${r.mint.slice(0, 8)}...) score=${r.score} timing=${timingStr}${indStr}` +
        (fails.length ? ` FAILS: ${fails.map((f) => f.name).join(",")}` : "") +
        (skips.length ? ` SKIPS: ${skips.map((s) => `${s.name}`).join(",")}` : "")
    );
  }
  console.log("");

  // append to scan-log
  const logPath = path.resolve(__dirname, "..", "data", "scan-log.json");
  let existing = [];
  try {
    const raw = fs.readFileSync(logPath, "utf-8");
    existing = JSON.parse(raw);
    if (!Array.isArray(existing)) existing = [];
  } catch {}
  existing.push({ timestamp: new Date().toISOString(), ...result });
  fs.writeFileSync(logPath, JSON.stringify(existing, null, 2));

  return result;
}

module.exports = { scan };
