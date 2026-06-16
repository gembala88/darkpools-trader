const fs = require("fs");
const path = require("path");
const signals = require("./signals/index");
const safety = require("./filters/safety");

async function scan(config) {
  const candidates = await signals.getCandidates(config);
  const scannedCount = candidates.length;

  const skippedPerCheck = {};
  const passedCandidates = [];

  for (const c of candidates) {
    const result = await safety.applySafetyFilter(c, config);

    // tally skips
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
  const withScores = passedCandidates.map((item) => {
    const c = item.candidate;
    const w = config.scoring;

    const maxLiquidity = Math.max(
      ...passedCandidates.map((p) => p.candidate.liquidityUsd || 0),
      1
    );
    const maxVolume = Math.max(
      ...passedCandidates.map((p) => p.candidate.volume24hUsd || 0),
      1
    );
    const maxAge = Math.max(
      ...passedCandidates.map((p) => p.candidate.ageHours || 0),
      1
    );

    const liqScore = c.liquidityUsd ? c.liquidityUsd / maxLiquidity : 0;
    const volScore = c.volume24hUsd ? c.volume24hUsd / maxVolume : 0;
    const ageScore = c.ageHours ? c.ageHours / maxAge : 0;

    const score =
      (w.wLiquidity || 0) * liqScore +
      (w.wVolume || 0) * volScore +
      (w.wAge || 0) * ageScore;

    return {
      mint: c.mint,
      symbol: c.symbol,
      score: parseFloat(score.toFixed(4)),
      checks: item.checks,
    };
  });

  withScores.sort((a, b) => b.score - a.score);
  const topN = config.scoring.topN || 10;
  const ranked = withScores.slice(0, topN);

  const result = { scannedCount, safeCount, skippedPerCheck, ranked };

  // log summary
  console.log("\n=== SCAN RESULT ===");
  console.log(`Scanned: ${scannedCount} | Safe: ${safeCount}`);
  const skipSummary = Object.entries(skippedPerCheck)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  console.log(`Skipped-per-check: ${skipSummary || "none"}`);
  console.log(`\nTop ${ranked.length} candidates:`);
  for (const r of ranked) {
    const fails = r.checks.filter((c) => c.result === "fail");
    const skips = r.checks.filter((c) => c.result === "skip");
    console.log(
      `  ${r.symbol || "?"} (${r.mint.slice(0, 8)}...) score=${r.score}` +
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
