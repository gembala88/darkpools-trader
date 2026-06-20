const fs = require("fs");
const path = require("path");

const dataFile = path.resolve(__dirname, "..", "data", "dry-run-positions.json");
let raw;
try {
  raw = fs.readFileSync(dataFile, "utf-8");
} catch {
  console.log("No data file found at data/dry-run-positions.json");
  process.exit(0);
}

const all = JSON.parse(raw);
const closed = all.filter((p) => p.status === "closed");
const total = closed.length;

function pct(n, d) {
  if (!d) return "—";
  return ((n / d) * 100).toFixed(1) + "%";
}

function avgPnL(arr) {
  if (!arr.length) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function format(n, suffix) {
  if (n == null) return "—";
  return (n >= 0 ? "+" : "") + n.toFixed(6) + (suffix || "");
}

// ---- 1) OVERALL ----
console.log("═══ OVERALL ═══");
console.log(`Total closed:        ${total}`);

if (total === 0) {
  console.log("\nNo closed trades to analyze.");
  process.exit(0);
}

const wins = closed.filter((p) => p.realizedPnlSol > 0);
const losses = closed.filter((p) => p.realizedPnlSol <= 0);
const winCount = wins.length;
const lossCount = losses.length;
const winRate = winCount / total;
const totalPnl = closed.reduce((s, p) => s + (p.realizedPnlSol || 0), 0);
const avgWin = wins.length ? avgPnL(wins.map((p) => p.realizedPnlSol)) : 0;
const avgLoss = losses.length ? avgPnL(losses.map((p) => p.realizedPnlSol)) : 0;
const expectancy = avgWin * winRate + avgLoss * (1 - winRate);
const rr = avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : "—";
const biggestWin = wins.length ? Math.max(...wins.map((p) => p.realizedPnlSol)) : 0;
const biggestLoss = losses.length ? Math.min(...losses.map((p) => p.realizedPnlSol)) : 0;

let maxConsecutiveLosses = 0;
let currentStreak = 0;
for (const p of closed) {
  if (p.realizedPnlSol <= 0) {
    currentStreak++;
    if (currentStreak > maxConsecutiveLosses) maxConsecutiveLosses = currentStreak;
  } else {
    currentStreak = 0;
  }
}

const avgHold = avgPnL(
  closed.map((p) => {
    if (!p.entryTime) return 0;
    const exits = p.exits || [];
    const lastExit = exits.length ? exits[exits.length - 1] : null;
    const end = lastExit?.time || Date.now();
    return (end - p.entryTime) / 3600000;
  })
);

console.log(`Wins:                ${winCount} (${pct(winCount, total)})`);
console.log(`Losses:              ${lossCount} (${pct(lossCount, total)})`);
console.log(`Win rate:            ${pct(winCount, total)}`);
console.log(`Total PnL:           ${format(totalPnl, " SOL")}`);
console.log(`Avg PnL:             ${format(avgPnL(closed.map((p) => p.realizedPnlSol || 0)), " SOL")}`);
console.log(`Expectancy:          ${format(expectancy, " SOL")}`);
console.log(`Avg win:             ${format(avgWin, " SOL")}`);
console.log(`Avg loss:            ${format(avgLoss, " SOL")}`);
console.log(`Risk/Reward:         ${typeof rr === "number" ? rr.toFixed(2) : rr}`);
console.log(`Biggest win:         ${format(biggestWin, " SOL")}`);
console.log(`Biggest loss:        ${format(biggestLoss, " SOL")}`);
console.log(`Max consecutive L:   ${maxConsecutiveLosses}`);
console.log(`Avg hold:            ${avgHold.toFixed(1)}h`);

// ---- 2) BY EXIT REASON ----
console.log("\n═══ BY EXIT REASON ═══");
const reasons = {};
for (const p of closed) {
  const exits = p.exits || [];
  const last = exits.length ? exits[exits.length - 1] : null;
  const reason = last?.reason || "unknown";
  if (!reasons[reason]) reasons[reason] = [];
  reasons[reason].push(p);
}
for (const [reason, group] of Object.entries(reasons)) {
  const gWins = group.filter((p) => p.realizedPnlSol > 0).length;
  const gTotal = group.length;
  const gPnl = group.reduce((s, p) => s + (p.realizedPnlSol || 0), 0);
  console.log(
    `${reason.padEnd(12)} count=${String(gTotal).padEnd(3)} totPnL=${format(gPnl, " SOL").padEnd(14)} avgPnL=${format(gPnl / gTotal, " SOL").padEnd(14)} winRate=${pct(gWins, gTotal)}`
  );
}

// ---- 3) BY ENTRY RUNUP ----
console.log("\n═══ BY ENTRY RUNUP (anti-chase) ═══");
const withRunup = closed.filter((p) => p.entryRunup1hPct != null);
const noRunup = closed.filter((p) => p.entryRunup1hPct == null);
if (noRunup.length) {
  console.log(`${noRunup.length} trades with no runup data (excluded from buckets)`);
}
if (withRunup.length) {
  const buckets = { "<0%": [], "0-10%": [], "10-25%": [], "25-50%": [], ">50%": [] };
  for (const p of withRunup) {
    const v = p.entryRunup1hPct;
    if (v < 0) buckets["<0%"].push(p);
    else if (v <= 10) buckets["0-10%"].push(p);
    else if (v <= 25) buckets["10-25%"].push(p);
    else if (v <= 50) buckets["25-50%"].push(p);
    else buckets[">50%"].push(p);
  }
  for (const [label, group] of Object.entries(buckets)) {
    const gWins = group.filter((p) => p.realizedPnlSol > 0).length;
    const gTotal = group.length;
    const gPnl = group.reduce((s, p) => s + (p.realizedPnlSol || 0), 0);
    const gPeak = gTotal ? avgPnL(group.map((p) => p.peakPrice && p.entryPriceEffective ? ((p.peakPrice - p.entryPriceEffective) / p.entryPriceEffective) * 100 : 0)) : 0;
    console.log(
      `${label.padEnd(10)} count=${String(gTotal).padEnd(3)} winRate=${pct(gWins, gTotal).padEnd(6)} avgPnL=${format(gPnl / gTotal, " SOL").padEnd(14)} avgPeak=${gPeak.toFixed(1)}%`
    );
  }
} else {
  console.log("(no trades with runup data yet)");
}

// ---- 4) BY ENTRY RSI ----
console.log("\n═══ BY ENTRY RSI ═══");
const withRsi = closed.filter((p) => p.entryRsi != null);
const noRsi = closed.filter((p) => p.entryRsi == null);
if (noRsi.length) {
  console.log(`${noRsi.length} trades with no RSI data (excluded)`);
}
if (withRsi.length) {
  const buckets = { "<55": [], "55-60": [], "60-65": [], "65-70": [], ">70": [] };
  for (const p of withRsi) {
    const v = p.entryRsi;
    if (v < 55) buckets["<55"].push(p);
    else if (v < 60) buckets["55-60"].push(p);
    else if (v < 65) buckets["60-65"].push(p);
    else if (v < 70) buckets["65-70"].push(p);
    else buckets[">70"].push(p);
  }
  for (const [label, group] of Object.entries(buckets)) {
    const gWins = group.filter((p) => p.realizedPnlSol > 0).length;
    const gTotal = group.length;
    const gPnl = group.reduce((s, p) => s + (p.realizedPnlSol || 0), 0);
    console.log(
      `${label.padEnd(7)} count=${String(gTotal).padEnd(3)} winRate=${pct(gWins, gTotal).padEnd(6)} avgPnL=${format(gPnl / gTotal, " SOL").padEnd(14)}`
    );
  }
} else {
  console.log("(no trades with RSI data yet)");
}

// ---- 5) PEAK vs OUTCOME ----
console.log("\n═══ PEAK vs OUTCOME (missed TP) ═══");
const tpThreshold = 22;
const reachedTp = closed.filter(
  (p) => p.peakPrice && p.entryPriceEffective && ((p.peakPrice - p.entryPriceEffective) / p.entryPriceEffective) * 100 >= tpThreshold
);
console.log(`Trades that reached ≥${tpThreshold}% peak: ${reachedTp.length}/${total}`);
if (reachedTp.length) {
  const realizedTpExit = reachedTp.filter((p) => {
    const exits = p.exits || [];
    return exits.some((e) => e.reason === "partialTP");
  });
  const exitedOtherwise = reachedTp.filter((p) => {
    const exits = p.exits || [];
    return !exits.some((e) => e.reason === "partialTP");
  });
  console.log(`  Realized TP (partialTP hit): ${realizedTpExit.length}`);
  console.log(`  Exited otherwise:            ${exitedOtherwise.length}`);
  if (exitedOtherwise.length) {
    for (const p of exitedOtherwise) {
      const last = (p.exits || [])[(p.exits || []).length - 1];
      console.log(
        `    ${p.symbol} — peak ${(((p.peakPrice - p.entryPriceEffective) / p.entryPriceEffective) * 100).toFixed(1)}% — exit: ${last?.reason || "?"} — PnL ${format(p.realizedPnlSol, " SOL")}`
      );
    }
  }
}

// ---- 6) DATA QUALITY ----
console.log("\n═══ DATA QUALITY ═══");
const hasRunup = closed.filter((p) => p.entryRunup1hPct != null).length;
const hasRsi = closed.filter((p) => p.entryRsi != null).length;
console.log(`Total closed trades:         ${total}`);
console.log(`With entryRunup1hPct:        ${hasRunup} (${pct(hasRunup, total)})`);
console.log(`With entryRsi:               ${hasRsi} (${pct(hasRsi, total)})`);
console.log(`Missing entry-context:       ${total - Math.max(hasRunup, hasRsi)}`);
console.log("");
console.log("NOTE: Trades before entry-context logging (commit bbd6c00) lack runup/RSI fields.");
console.log("      Conclusions require enough CLEAN trades (post-fix).");
console.log("      Small samples are not proof of edge.");
