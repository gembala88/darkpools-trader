const fs = require("fs");
const path = require("path");

const POSITIONS_FILE = path.resolve(__dirname, "..", "data", "dry-run-positions.json");

function loadAllPositions() {
  try {
    const raw = fs.readFileSync(POSITIONS_FILE, "utf-8");
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function buildReport(positions) {
  const closed = positions.filter((p) => p.status === "closed");
  const open = positions.filter((p) => p.status === "open");
  const totalClosed = closed.length;
  const totalOpen = open.length;

  const empty = {
    totalClosed: 0,
    totalOpen,
    wins: 0,
    losses: 0,
    winRatePct: null,
    totalPnlSol: 0,
    avgPnlSol: null,
    avgWinSol: null,
    avgLossSol: null,
    riskReward: null,
    biggestWinSol: null,
    biggestLossSol: null,
    exitBreakdown: { SL: 0, partialTP: 0, trailing: 0, maxHold: 0 },
    partialTPTotal: 0,
    avgHoldHours: null,
    maxConsecutiveLosses: 0,
    expectancy: null,
    netPnlVsHoldSol: 0,
  };

  if (totalClosed === 0) return empty;

  let wins = 0;
  let losses = 0;
  let totalPnl = 0;
  let sumWinPnl = 0;
  let sumLossPnl = 0;
  let biggestWin = -Infinity;
  let biggestLoss = Infinity;
  const exitBreakdown = { SL: 0, partialTP: 0, trailing: 0, maxHold: 0 };
  let partialTPTotal = 0;
  let totalHoldHours = 0;

  // sorted by entryTime for streak tracking
  const sorted = [...closed].sort((a, b) => a.entryTime - b.entryTime);
  let currentStreak = 0;
  let maxStreak = 0;

  for (const pos of sorted) {
    const pnl = pos.realizedPnlSol;
    totalPnl += pnl;

    if (pnl > 0) {
      wins++;
      sumWinPnl += pnl;
      if (pnl > biggestWin) biggestWin = pnl;
      currentStreak = 0;
    } else {
      losses++;
      sumLossPnl += pnl;
      if (pnl < biggestLoss) biggestLoss = pnl;
      currentStreak++;
      if (currentStreak > maxStreak) maxStreak = currentStreak;
    }

    // final closing reason (last exit with remainingPct sold)
    const lastExit = pos.exits && pos.exits.length > 0
      ? pos.exits[pos.exits.length - 1]
      : null;
    if (lastExit && exitBreakdown[lastExit.reason] !== undefined) {
      exitBreakdown[lastExit.reason]++;
    }

    // count partialTP occurrences across all exits
    if (pos.exits) {
      for (const ex of pos.exits) {
        if (ex.reason === "partialTP") partialTPTotal++;
      }
    }

    // hold hours: entryTime to last exit time
    if (pos.exits && pos.exits.length > 0) {
      const lastTime = pos.exits[pos.exits.length - 1].time;
      totalHoldHours += (lastTime - pos.entryTime) / 3600000;
    }
  }

  const winRatePct = parseFloat(((wins / totalClosed) * 100).toFixed(2));
  const avgPnl = parseFloat((totalPnl / totalClosed).toFixed(8));
  const avgWin = wins > 0 ? parseFloat((sumWinPnl / wins).toFixed(8)) : null;
  const avgLoss = losses > 0 ? parseFloat((sumLossPnl / losses).toFixed(8)) : null;
  const rr = avgWin != null && avgLoss != null && avgLoss !== 0
    ? parseFloat((avgWin / Math.abs(avgLoss)).toFixed(4))
    : null;
  const avgHold = totalClosed > 0 ? parseFloat((totalHoldHours / totalClosed).toFixed(2)) : null;

  return {
    totalClosed,
    totalOpen,
    wins,
    losses,
    winRatePct,
    totalPnlSol: parseFloat(totalPnl.toFixed(8)),
    avgPnlSol: avgPnl,
    avgWinSol: avgWin,
    avgLossSol: avgLoss,
    riskReward: rr,
    biggestWinSol: biggestWin === -Infinity ? null : parseFloat(biggestWin.toFixed(8)),
    biggestLossSol: biggestLoss === Infinity ? null : parseFloat(biggestLoss.toFixed(8)),
    exitBreakdown,
    partialTPTotal,
    avgHoldHours: avgHold,
    maxConsecutiveLosses: maxStreak,
    expectancy: avgPnl,
    netPnlVsHoldSol: parseFloat(totalPnl.toFixed(8)),
  };
}

function formatLines(report) {
  const lines = [];
  const sep = "─".repeat(48);

  lines.push("");
  lines.push(sep);
  lines.push("  EVALUATION REPORT  (dry-run)");
  lines.push(sep);

  if (report.totalClosed === 0) {
    lines.push("  0 closed trades — no data to evaluate yet");
    if (report.totalOpen > 0) {
      lines.push(`  ${report.totalOpen} position(s) still open`);
    }
    lines.push(sep);
    lines.push("");
    return lines;
  }

  lines.push(`  Total closed trades : ${report.totalClosed}`);
  lines.push(`  Still open          : ${report.totalOpen}`);
  lines.push("");
  lines.push(`  Wins                : ${report.wins}`);
  lines.push(`  Losses              : ${report.losses}`);
  lines.push(`  Win rate            : ${report.winRatePct}%`);
  lines.push("");
  lines.push(`  Total PnL (net)     : ${_fmtPnl(report.totalPnlSol)} SOL`);
  lines.push(`  Avg PnL / trade     : ${_fmtPnl(report.avgPnlSol)} SOL`);
  lines.push(`  Avg win             : ${_fmtPnl(report.avgWinSol)} SOL`);
  lines.push(`  Avg loss            : ${_fmtPnl(report.avgLossSol)} SOL`);
  lines.push(`  Risk/reward         : ${report.riskReward != null ? report.riskReward : "N/A"}`);
  lines.push("");
  lines.push(`  Biggest win         : ${_fmtPnl(report.biggestWinSol)} SOL`);
  lines.push(`  Biggest loss        : ${_fmtPnl(report.biggestLossSol)} SOL`);
  lines.push("");
  lines.push(`  Max consecutive losses : ${report.maxConsecutiveLosses}`);
  lines.push(`  Expectancy (avg/trade) : ${_fmtPnl(report.expectancy)} SOL`);
  lines.push("");
  lines.push(`  Avg hold time       : ${report.avgHoldHours != null ? `${report.avgHoldHours} h` : "N/A"}`);
  lines.push("");
  lines.push("  Exit breakdown:");
  for (const [reason, count] of Object.entries(report.exitBreakdown)) {
    if (count > 0) lines.push(`    ${reason.padEnd(12)} : ${count}`);
  }
  if (report.partialTPTotal > 0) {
    lines.push(`    partialTP (total) : ${report.partialTPTotal}`);
  }
  lines.push("");
  lines.push("  vs HOLD SOL baseline:");
  lines.push(`    Net difference     : ${_fmtPnl(report.netPnlVsHoldSol)} SOL`);
  lines.push("    (assumption: holding SOL yields 0% — no SOL price data used)");
  lines.push(sep);
  lines.push("");

  return lines;
}

function _fmtPnl(val) {
  if (val == null) return "N/A";
  const prefix = val >= 0 ? "+" : "";
  return `${prefix}${val.toFixed(6)}`;
}

// ---- self-test ----
if (require.main === module && process.argv.includes("--test")) {
  let failures = 0;
  function assert(label, condition) {
    if (condition) {
      console.log(`PASS  ${label}`);
    } else {
      console.log(`FAIL  ${label}`);
      failures++;
    }
  }

  function makePos(overrides) {
    const base = {
      mint: "Test",
      symbol: "TST",
      sizeSol: 1,
      entryPriceEffective: 1.0,
      entryTime: 1000000,
      status: "closed",
      exits: [{ time: 2000000, reason: "SL", pnlSol: 0 }],
      realizedPnlSol: 0,
    };
    return { ...base, ...overrides };
  }

  // 1. Zero-trade case
  const r0 = buildReport([]);
  assert("zero trades: totalClosed=0", r0.totalClosed === 0);
  assert("zero trades: no NaN", !isNaN(r0.winRatePct ?? 0));
  const fmt0 = formatLines(r0);
  assert("zero trades: format says '0 closed trades'", fmt0.some((l) => l.includes("0 closed trades")));

  // 2. 3 wins (+0.01 each) + 2 losses (-0.008 each)
  const wins = [0.01, 0.01, 0.01];
  const losses = [-0.008, -0.008];
  const synPositions = [
    ...wins.map((p, i) => makePos({ realizedPnlSol: p, entryTime: i * 1000, exits: [{ time: (i + 1) * 1000, reason: "trailing", pnlSol: p }] })),
    ...losses.map((p, i) => makePos({ realizedPnlSol: p, entryTime: (i + 3) * 1000, exits: [{ time: (i + 4) * 1000, reason: "SL", pnlSol: p }] })),
  ];
  const r1 = buildReport(synPositions);
  assert("winRatePct === 60", r1.winRatePct === 60);
  assert("totalPnlSol === 0.014", Math.abs(r1.totalPnlSol - 0.014) < 0.000001);
  assert("riskReward === 1.25", Math.abs(r1.riskReward - 1.25) < 0.0001);
  assert("wins === 3", r1.wins === 3);
  assert("losses === 2", r1.losses === 2);
  assert("biggestWinSol === 0.01", Math.abs(r1.biggestWinSol - 0.01) < 0.000001);
  assert("biggestLossSol === -0.008", Math.abs(r1.biggestLossSol - (-0.008)) < 0.000001);

  // 3. Exit breakdown
  const multiExitPos = makePos({
    realizedPnlSol: 0.02,
    exits: [
      { time: 1500000, reason: "partialTP", pnlSol: 0.01 },
      { time: 2000000, reason: "trailing", pnlSol: 0.01 },
    ],
    entryTime: 1000000,
  });
  const r2 = buildReport([multiExitPos]);
  assert("exitBreakdown trail=1", r2.exitBreakdown.trailing === 1);
  assert("partialTPTotal=1 (from exits[] tally)", r2.partialTPTotal === 1);

  // 4. All losses
  const allLoss = buildReport([
    makePos({ realizedPnlSol: -0.01, exits: [{ time: 2000000, reason: "SL", pnlSol: -0.01 }] }),
    makePos({ realizedPnlSol: -0.02, exits: [{ time: 3000000, reason: "maxHold", pnlSol: -0.02 }] }),
  ]);
  assert("all-losses: winRatePct=0", allLoss.winRatePct === 0);
  assert("all-losses: riskReward=null (no wins)", allLoss.riskReward === null);
  assert("all-losses: totalPnl negative", allLoss.totalPnlSol < 0);

  // 5. Consecutive loss streak
  const streakPositions = [
    makePos({ realizedPnlSol: -0.01, entryTime: 1000, exits: [{ time: 2000, reason: "SL", pnlSol: -0.01 }] }),
    makePos({ realizedPnlSol: -0.01, entryTime: 3000, exits: [{ time: 4000, reason: "SL", pnlSol: -0.01 }] }),
    makePos({ realizedPnlSol: 0.01, entryTime: 5000, exits: [{ time: 6000, reason: "trailing", pnlSol: 0.01 }] }),
    makePos({ realizedPnlSol: -0.01, entryTime: 7000, exits: [{ time: 8000, reason: "SL", pnlSol: -0.01 }] }),
    makePos({ realizedPnlSol: -0.01, entryTime: 9000, exits: [{ time: 10000, reason: "SL", pnlSol: -0.01 }] }),
    makePos({ realizedPnlSol: -0.01, entryTime: 11000, exits: [{ time: 12000, reason: "maxHold", pnlSol: -0.01 }] }),
  ];
  const r3 = buildReport(streakPositions);
  assert("maxConsecutiveLosses=3", r3.maxConsecutiveLosses === 3);

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
  process.exit(failures > 0 ? 1 : 0);
}

module.exports = { buildReport, formatLines, loadAllPositions };
