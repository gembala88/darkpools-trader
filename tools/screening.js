const fs = require("fs");
const path = require("path");
const signals = require("./signals/index");
const candles = require("./signals/candles");
const strategy = require("../strategies/index");
const safety = require("./filters/safety");
const agent = require("../agent");

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

  // timing: fetch candles + run strategy for each safe candidate
  const tfConfig = config.strategy.trendFollowing;
  const strat = strategy.getActiveStrategy(config);
  const withTiming = [];

  for (const item of passedCandidates) {
    const c = item.candidate;
    let candleData = [];
    if (config.sources.geckoterminalOhlc?.enabled && c.pairAddress) {
      try {
        candleData = await candles.getCandles(c, tfConfig);
      } catch (err) {
        console.log(`candles error for ${c.mint}: ${err.message}`);
      }
    }
    const timing = strat.evaluate(c, candleData, tfConfig);
    withTiming.push({ ...item, timing });
  }

  // deterministic scoring within batch
  function median(arr) {
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  const liqValues = withTiming.map((p) => p.candidate.liquidityUsd || 0);
  const volValues = withTiming.map((p) => p.candidate.volume24hUsd || 0);
  const medianLiq = median(liqValues) || 1;
  const medianVol = median(volValues) || 1;
  const minAge = config.filters?.minTokenAgeHours || 1;

  const withScores = withTiming.map((item) => {
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

    const score =
      (w.wLiquidity || 0) * liqScore +
      (w.wVolume || 0) * volScore +
      (w.wAge || 0) * ageScore;

    return {
      mint: c.mint,
      symbol: c.symbol,
      score: parseFloat(score.toFixed(4)),
      checks: item.checks,
      timing: item.timing,
    };
  });

  withScores.sort((a, b) => b.score - a.score);
  const topN = config.scoring.topN || 10;
  const ranked = withScores.slice(0, topN);

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
