require("dotenv").config();
const { loadConfig, getConfigView, setConfigValue } = require("./config");
const { scan } = require("./tools/screening");
const positions = require("./tools/positions");
const riskManager = require("./tools/riskManager");
const telegram = require("./tools/telegram");
const jupiter = require("./tools/signals/jupiter");
const { assessRegime } = require("./tools/filters/regime");

let cfg = loadConfig();

// one-shot commands
if (process.argv.includes("stop")) {
  riskManager.setKillSwitch(true);
  process.exit(0);
}
if (process.argv.includes("resume")) {
  riskManager.setKillSwitch(false);
  process.exit(0);
}
if (process.argv.includes("config:show")) {
  console.log(getConfigView(cfg));
  process.exit(0);
}
if (process.argv.includes("config:set")) {
  const idx = process.argv.indexOf("config:set");
  const path = process.argv[idx + 1];
  const value = process.argv.slice(idx + 2).join(" ");
  if (!path || !value) {
    console.error("Usage: npm run config:set -- <path> <value>");
    process.exit(1);
  }
  try {
    const result = setConfigValue(path, value);
    console.log(`${path} → ${JSON.stringify(result)}`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  process.exit(0);
}

async function runLoop() {
  telegram.init(cfg);
  await telegram.notifyStart();

  console.log("darkpools-trader | mode:", cfg.mode, "| starting dry_run loop");

  let openPositions = positions.loadOpenPositions();
  let loopScanMs = cfg.execution?.loopScanMs || 60000;

  let lastTelegramPoll = 0;
  let lastDailyCheckKey = null;
  // per-position log suppression
  const _posLogCache = {}; // mint -> { lastPrice, lastPeak }

  process.on("SIGINT", () => {
    console.log("\nSIGINT received — state saved, exiting cleanly");
    process.exit(0);
  });

  process.on("uncaughtException", (err) => {
    telegram.notifyError(`Uncaught: ${err.message}`);
    console.error("uncaught:", err.message);
  });

  let lastScanTime = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const now = Date.now();

    // hot-reload config at start of each cycle
    try {
      const newCfg = loadConfig();
      cfg = newCfg;
      telegram.init(cfg);
    } catch (err) {
      console.log(`config reload failed: ${err.message} — keeping previous config`);
      telegram.notifyError(`config reload failed: ${err.message}`);
    }
    loopScanMs = cfg.execution?.loopScanMs || 60000;

    // Telegram command polling every 3s
    if (now - lastTelegramPoll > 3000) {
      lastTelegramPoll = now;
      await telegram.pollCommands();
    }

    // monitor ALL open positions (ALWAYS allowed, regardless of gate/kill switch)
    const maxConc = cfg.maxConcurrentPositions || 3;
    for (let i = openPositions.length - 1; i >= 0; i--) {
      const pos = openPositions[i];
      if (pos.status === "closed") {
        openPositions.splice(i, 1);
        continue;
      }
      let currentPrice = await jupiter.getUsdPrice(pos.mint);

      if (currentPrice != null) {
        const reason = positions.evaluateExit(pos, currentPrice, null, cfg);
        positions.savePosition(pos);

        if (reason) {
          if (reason.type === "partialTP") {
            positions.partialClose(pos, cfg.execution.partialTpSellPct, reason, currentPrice, cfg);
            const exitPnl = pos.exits[pos.exits.length - 1].pnlSol;
            const riskState = riskManager.loadState();
            riskManager.recordTradeClosed(riskState, exitPnl, false, cfg);
            telegram.notifyExit(pos, pos.exits[pos.exits.length - 1], false);
            if (pos.status === "closed") {
              openPositions.splice(i, 1);
              console.log(`Position ${pos.symbol} fully closed`);
            }
          } else {
            const posTotalPnl = pos.realizedPnlSol;
            positions.closeRemaining(pos, reason, currentPrice, cfg);
            const finalPnl = pos.realizedPnlSol;
            const riskState = riskManager.loadState();
            riskManager.recordTradeClosed(riskState, finalPnl - posTotalPnl, true, cfg);
            const lastExit = pos.exits[pos.exits.length - 1];
            telegram.notifyExit(pos, lastExit, true);
            openPositions.splice(i, 1);
            console.log(`Position ${pos.symbol} fully closed`);
          }
        } else {
          const cache = _posLogCache[pos.mint] || {};
          const pStr = currentPrice.toFixed(8);
          const pkStr = pos.peakPrice.toFixed(8);
          if (pStr !== cache.lastPrice || pkStr !== cache.lastPeak) {
            console.log(`monitor ${pos.symbol}: $${pStr} peak $${pkStr}`);
            _posLogCache[pos.mint] = { lastPrice: pStr, lastPeak: pkStr };
          }
        }
      } else {
        console.log(`monitor: no price for ${pos.symbol} — will retry`);
      }
    }

    // scan for entry if under max concurrent
    if (openPositions.length < maxConc && now - lastScanTime > loopScanMs) {
      lastScanTime = now;
      console.log("Scanning for entry...");

      const riskState = riskManager.loadState();
      riskManager.rolloverIfNewDay(riskState, cfg);

      await telegram.checkDailyRollover(riskState, cfg);

      const gate = riskManager.canOpenNewPosition(riskState, cfg);
      if (!gate.allowed) {
        console.log(`ENTRY BLOCKED: ${gate.reason}`);
        continue;
      }

      try {
        const result = await scan(cfg);

        const regime = await assessRegime(result.ranked, cfg);
        result.regime = regime;
        if (regime.regime === "risk_off") {
          console.log(`ENTRY HELD: market risk_off (${regime.reason})`);
          continue;
        }

        const decision = result.decision;

        let pickMint = null;
        let pickCandidate = null;
        const heldMints = new Set(openPositions.map((p) => p.mint));

        if (decision && decision.called && decision.pick) {
          if (!heldMints.has(decision.pick)) {
            pickMint = decision.pick;
            pickCandidate = result.ranked.find((c) => c.mint === pickMint);
          } else {
            console.log(`LLM pick ${decision.pick.slice(0, 8)}... already held, skipping`);
          }
        }
        if (!pickMint) {
          const goCandidate = result.ranked.find(
            (c) => c.timing && c.timing.signal === "go" && !heldMints.has(c.mint)
          );
          if (goCandidate) {
            pickMint = goCandidate.mint;
            pickCandidate = goCandidate;
          }
        }

        if (pickMint && pickCandidate) {
          const currentPrice = await jupiter.getUsdPrice(pickMint);

          if (currentPrice != null) {
            const candidateData = result.ranked
              .filter((r) => r.mint === pickMint)
              .map((r) => ({
                mint: r.mint,
                symbol: r.symbol,
              }))[0];
            const newPos = positions.openPosition(
              candidateData || { mint: pickMint, symbol: pickMint.slice(0, 8) },
              currentPrice,
              cfg
            );
            if (newPos) {
              openPositions.push(newPos);
              riskManager.recordTradeOpened(riskState);
              telegram.notifyEntry(newPos);
            }
          } else {
            console.log("entry skipped: no price for " + (pickCandidate.symbol || pickMint));
          }
        } else {
          console.log("No eligible candidate for entry this cycle");
        }
      } catch (err) {
        console.log("Scan error:", err.message);
      }
    }

    await new Promise((r) => setTimeout(r, 1000));
  }
}

if (process.argv.includes("report")) {
  const { buildReport, formatLines, loadAllPositions } = require("./tools/reporter");
  const positions = loadAllPositions();
  const report = buildReport(positions);
  const lines = formatLines(report);

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    for (const l of lines) console.log(l);
  }
  process.exit(0);
}

if (process.argv.includes("scan")) {
  scan(cfg).then(() => process.exit(0)).catch((err) => {
    console.error("scan error:", err.message);
    process.exit(1);
  });
} else if (process.argv.includes("run")) {
  runLoop().catch((err) => {
    console.error("run error:", err.message);
    process.exit(1);
  });
} else {
  console.log("darkpools-trader | mode:", cfg.mode);
  process.exit(0);
}
