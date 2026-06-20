require("dotenv").config();
const { loadConfig, getConfigView, setConfigValue } = require("./config");
const { scan } = require("./tools/screening");
const positions = require("./tools/positions");
const riskManager = require("./tools/riskManager");
const telegram = require("./tools/telegram");
const jupiter = require("./tools/signals/jupiter");
const { assessRegime } = require("./tools/filters/regime");

let cfg = loadConfig();

// per-position log suppression (shared between monitor and scan)
const _posLogCache = {}; // mint -> { lastPrice, lastPeak }

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

async function monitorPositions(cfg) {
  const openPositions = positions.loadOpenPositions();
  if (openPositions.length === 0) return;

  const prices = await Promise.allSettled(
    openPositions.map((p) => jupiter.getUsdPrice(p.mint))
  );

  for (let i = 0; i < openPositions.length; i++) {
    const pos = openPositions[i];
    if (pos.status === "closed") continue;

    const priceResult = prices[i];
    let currentPrice;

    if (priceResult.status === "fulfilled" && priceResult.value != null) {
      currentPrice = priceResult.value;
    } else {
      console.log(`monitor: no price for ${pos.symbol} — skip this tick`);
      continue;
    }

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
  }
}

async function runLoop() {
  telegram.init(cfg);
  await telegram.notifyStart();

  console.log("darkpools-trader | mode:", cfg.mode, "| starting dry_run loop");

  const openPositions = positions.loadOpenPositions();
  if (openPositions.length > 0) {
    console.log(`resumed ${openPositions.length} open position(s)`);
  }
  let loopScanMs = cfg.execution?.loopScanMs || 60000;

  // start independent Telegram polling (does not block when trading loop is busy)
  const pollIntervalMs = cfg.execution?.telegramPollMs || 2000;
  setInterval(() => {
    telegram.pollCommands().catch((e) => console.log("telegram poll error:", e.message));
  }, pollIntervalMs);

  // start independent position monitor timer (ALWAYS runs, even when scan is stuck on 429)
  let _monitoring = false;
  const monitorIntervalMs = cfg.execution?.monitorIntervalMs || 10000;
  const _timeout = (ms) => new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms));
  setInterval(async () => {
    if (_monitoring) return;
    _monitoring = true;
    try {
      await Promise.race([
        monitorPositions(cfg),
        _timeout(15000),
      ]);
    } catch (e) {
      if (e.message === "timeout") {
        console.log("monitor run timed out");
      } else {
        console.log("monitor error:", e.message);
      }
    } finally {
      _monitoring = false;
    }
  }, monitorIntervalMs);

  let lastDailyCheckKey = null;

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

    // scan for entry if under max concurrent (reads open count fresh from file)
    const openCount = positions.loadOpenPositions().length;
    const maxConc = cfg.maxConcurrentPositions || 3;
    if (openCount < maxConc && now - lastScanTime > loopScanMs) {
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
        telegram.notifyScreening(result, cfg);
        if (regime.regime === "risk_off") {
          console.log(`ENTRY HELD: market risk_off (${regime.reason})`);
          continue;
        }

        const decision = result.decision;

        let pickMint = null;
        let pickCandidate = null;
        const candidates = positions.loadOpenPositions();
        const heldMints = new Set(candidates.map((p) => p.mint));

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
            const newPos = positions.openPosition(
              pickCandidate || { mint: pickMint, symbol: pickMint.slice(0, 8) },
              currentPrice,
              cfg
            );
            if (newPos) {
              riskManager.recordTradeOpened(riskState);
              // attach remaining runtime fields not on candidate
              newPos._regime = regime.regime;
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
