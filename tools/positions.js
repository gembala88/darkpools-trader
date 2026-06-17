const fs = require("fs");
const path = require("path");

const DRY_RUN_FILE = path.resolve(__dirname, "..", "data", "dry-run-positions.json");

function _loadAll() {
  try {
    const raw = fs.readFileSync(DRY_RUN_FILE, "utf-8");
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function _saveAll(positions) {
  const dir = path.dirname(DRY_RUN_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(DRY_RUN_FILE, JSON.stringify(positions, null, 2));
}

function loadOpenPositions() {
  const all = _loadAll();
  const open = all.filter((p) => p.status === "open");
  if (open.length > 0) {
    console.log(`resumed ${open.length} open position(s)`);
  }
  return open;
}

function _applySlippage(price, side, slippagePct) {
  if (side === "buy") return price * (1 + slippagePct / 100);
  return price * (1 - slippagePct / 100);
}

function openPosition(candidate, currentPrice, config) {
  if (config.mode !== "dry_run") {
    console.log("openPosition: refusing — mode is not dry_run");
    return null;
  }

  const existing = loadOpenPositions();
  if (existing.length >= config.maxConcurrentPositions) {
    console.log("openPosition: at max concurrent positions");
    return null;
  }

  const slipPct = config.execution.slippagePctPerSide;
  const effectivePrice = _applySlippage(currentPrice, "buy", slipPct);
  const qty = config.positionSizeSol / effectivePrice;

  const pos = {
    mint: candidate.mint,
    symbol: candidate.symbol || candidate.mint.slice(0, 8),
    sizeSol: config.positionSizeSol,
    qtyTokens: qty,
    entryPriceQuoted: currentPrice,
    entryPriceEffective: effectivePrice,
    entryTime: Date.now(),
    peakPrice: currentPrice,
    remainingPct: 100,
    partialTpDone: false,
    status: "open",
    exits: [],
    realizedPnlSol: 0,
  };

  console.log(
    `SIMULATED BUY ${pos.symbol} @ ${effectivePrice.toFixed(8)} (quoted ${currentPrice.toFixed(8)}, slip ${slipPct}%)`
  );

  const all = _loadAll();
  all.push(pos);
  _saveAll(all);
  return pos;
}

function evaluateExit(position, currentPrice, candleAtr, config) {
  const entryEff = position.entryPriceEffective;
  const peak = position.peakPrice;
  const newPeak = Math.max(peak, currentPrice);
  position.peakPrice = newPeak;

  const slipPct = config.execution.slippagePctPerSide;
  const exec = config.execution;

  // stop loss
  const slThreshold = entryEff * (1 + config.stopLossPct / 100);
  if (currentPrice <= slThreshold) {
    return _exitReason("SL", `price ${currentPrice.toFixed(8)} <= SL ${slThreshold.toFixed(8)}`);
  }

  // partial take-profit
  if (exec.partialTpEnabled && !position.partialTpDone) {
    const tpThreshold = entryEff * (1 + config.takeProfitPct / 100);
    if (currentPrice >= tpThreshold) {
      position.partialTpDone = true;
      return _exitReason(
        "partialTP",
        `price ${currentPrice.toFixed(8)} >= TP ${tpThreshold.toFixed(8)}, selling ${exec.partialTpSellPct}%`
      );
    }
  }

  // trailing stop
  let trailStop;
  if (exec.trailing.mode === "fixed") {
    trailStop = newPeak * (1 - exec.trailing.fixedPct / 100);
  } else if (exec.trailing.mode === "atr" && candleAtr != null) {
    trailStop = newPeak - exec.trailing.atrMultiplier * candleAtr;
  } else {
    trailStop = newPeak * (1 - exec.trailing.fixedPct / 100);
  }

  if (currentPrice <= trailStop) {
    return _exitReason(
      "trailing",
      `price ${currentPrice.toFixed(8)} <= trail ${trailStop.toFixed(8)} (peak ${newPeak.toFixed(8)})`
    );
  }

  // max hold
  const elapsedHours = (Date.now() - position.entryTime) / 3600000;
  if (elapsedHours >= config.maxHoldHours) {
    return _exitReason("maxHold", `hold ${elapsedHours.toFixed(1)}h >= ${config.maxHoldHours}h`);
  }

  return null;
}

function _exitReason(type, detail) {
  return { type, detail };
}

function partialClose(position, sellPct, reason, currentPrice, config) {
  const slipPct = config.execution.slippagePctPerSide;
  const effPrice = _applySlippage(currentPrice, "sell", slipPct);
  const soldPct = sellPct;
  const pnlSol = position.sizeSol * (soldPct / 100) * ((effPrice - position.entryPriceEffective) / position.entryPriceEffective);

  const exit = {
    time: Date.now(),
    reason: reason.type,
    detail: reason.detail,
    priceQuoted: currentPrice,
    priceEffective: effPrice,
    pctOfPosition: soldPct,
    pnlSol: parseFloat(pnlSol.toFixed(8)),
  };

  position.exits.push(exit);
  position.remainingPct -= soldPct;
  position.realizedPnlSol = parseFloat(
    (position.realizedPnlSol + pnlSol).toFixed(8)
  );

  if (position.remainingPct <= 0) {
    position.status = "closed";
    position.remainingPct = 0;
  }

  _saveAll(_loadAll().map((p) => (p.mint === position.mint && p.entryTime === position.entryTime ? position : p)));

  console.log(
    `  EXIT ${reason.type}: sold ${soldPct}% @ ${effPrice.toFixed(8)} (quoted ${currentPrice.toFixed(8)}, slip ${slipPct}%), pnl ${pnlSol.toFixed(6)} SOL`
  );

  return exit;
}

function closeRemaining(position, reason, currentPrice, config) {
  if (position.remainingPct > 0) {
    partialClose(position, position.remainingPct, reason, currentPrice, config);
  }
}

// ---- self-test ----
if (require.main === module && process.argv.includes("--test")) {
  const config = {
    mode: "dry_run",
    positionSizeSol: 1,
    maxConcurrentPositions: 1,
    stopLossPct: -8,
    takeProfitPct: 20,
    maxHoldHours: 6,
    execution: {
      slippagePctPerSide: 3,
      partialTpEnabled: true,
      partialTpSellPct: 50,
      trailing: { mode: "fixed", fixedPct: 10, atrMultiplier: 2.0 },
    },
  };
  const dummyCandidate = { mint: "TestToken111111111111111111111111111111111111", symbol: "TEST" };

  let failures = 0;
  function assert(label, condition) {
    if (condition) {
      console.log(`PASS  ${label}`);
    } else {
      console.log(`FAIL  ${label}`);
      failures++;
    }
  }

  // 1. Entry slippage
  const entryPrice = 1.0;
  const slip = config.execution.slippagePctPerSide;
  const expectedEff = entryPrice * (1 + slip / 100);
  const pos = openPosition(dummyCandidate, entryPrice, config);
  assert("entry price effective > quoted by slippage", pos.entryPriceEffective === expectedEff);

  // 2. SL path: price drops to 0.90 (-10% from entry = triggers SL at -8% from entryEff)
  const slTrigger = 0.90;
  const reason = evaluateExit(pos, slTrigger, null, config);
  assert("SL triggered at price below SL threshold", reason !== null && reason.type === "SL");
  partialClose(pos, 100, reason, slTrigger, config);
  assert("SL exit: status closed", pos.status === "closed");
  assert("SL exit: realizedPnlSol negative", pos.realizedPnlSol < 0);

  // Reset for next test
  fs.writeFileSync(DRY_RUN_FILE, "[]");

  // 3. Partial-TP + trailing path
  const pos2 = openPosition(dummyCandidate, 1.0, config);
  // Rise to 1.21 (+21% from entryEff=1.03, TP fires at +20% = 1.236)
  const tpTrigger = 1.25;
  const tpReason = evaluateExit(pos2, tpTrigger, null, config);
  assert("partialTP triggered at price above TP threshold", tpReason !== null && tpReason.type === "partialTP");
  partialClose(pos2, config.execution.partialTpSellPct, tpReason, tpTrigger, config);
  assert("partialTP: remainingPct=50% after TP sell", pos2.remainingPct === 50);
  assert("partialTP: partialTpDone=true", pos2.partialTpDone === true);

  // price rises further to 1.40, peak=1.40
  const peak = 1.40;
  evaluateExit(pos2, peak, null, config);
  assert("trailing: peak updated to 1.40", pos2.peakPrice === 1.40);

  // drops to 1.25 (trail=1.40*0.9=1.26, 1.25 <= 1.26 triggers)
  const trailTrigger = 1.25;
  const trailReason = evaluateExit(pos2, trailTrigger, null, config);
  assert("trailing triggered after drop from peak", trailReason !== null && trailReason.type === "trailing");
  closeRemaining(pos2, trailReason, trailTrigger, config);
  assert("trailing exit: status closed", pos2.status === "closed");
  assert("trailing exit: total PnL positive (moon captured)", pos2.realizedPnlSol > 0);

  fs.writeFileSync(DRY_RUN_FILE, "[]");

  // 4. Pure trailing (moonshot) path
  const pos3 = openPosition(dummyCandidate, 1.0, config);
  evaluateExit(pos3, 1.50, null, config);
  assert("moonshot: peak=1.50", pos3.peakPrice === 1.50);
  const trailT = 1.34; // trail=1.50*0.9=1.35, 1.34 <= 1.35 triggers
  const trailR = evaluateExit(pos3, trailT, null, config);
  assert("moonshot trailing triggered", trailR !== null && trailR.type === "trailing");
  closeRemaining(pos3, trailR, trailT, config);
  assert("moonshot: status closed", pos3.status === "closed");
  assert("moonshot: PnL strongly positive", pos3.realizedPnlSol > 0.2);

  fs.writeFileSync(DRY_RUN_FILE, "[]");

  // 5. Max-hold path
  const pos4 = openPosition(dummyCandidate, 1.0, config);
  pos4.entryTime = Date.now() - 7 * 3600000; // 7 hours ago
  const holdReason = evaluateExit(pos4, 1.01, null, config);
  assert("maxHold triggered after maxHoldHours", holdReason !== null && holdReason.type === "maxHold");
  closeRemaining(pos4, holdReason, 1.01, config);
  assert("maxHold: status closed", pos4.status === "closed");

  fs.writeFileSync(DRY_RUN_FILE, "[]");

  // 6. Exit slippage
  const pos5 = openPosition(dummyCandidate, 1.0, config);
  const exitR = evaluateExit(pos5, 0.90, null, config);
  partialClose(pos5, 100, exitR, 0.90, config);
  const exitEff = pos5.exits[0].priceEffective;
  const expectedExitEff = 0.90 * (1 - slip / 100);
  assert("exit price effective < quoted by slippage", Math.abs(exitEff - expectedExitEff) < 0.000001);

  fs.writeFileSync(DRY_RUN_FILE, "[]");

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
  process.exit(failures > 0 ? 1 : 0);
}

module.exports = {
  loadOpenPositions,
  openPosition,
  evaluateExit,
  partialClose,
  closeRemaining,
};
