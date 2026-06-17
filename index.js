require("dotenv").config();
const { loadConfig, getConfigView, setConfigValue } = require("./config");
const { scan } = require("./tools/screening");
const positions = require("./tools/positions");
const riskManager = require("./tools/riskManager");
const telegram = require("./tools/telegram");

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

  const openPositions = positions.loadOpenPositions();
  const loopScanMs = cfg.execution.loopScanMs || 30000;
  const loopMonitorMs = cfg.execution.loopMonitorMs || 10000;

  let currentPosition = openPositions[0] || null;
  let lastTelegramPoll = 0;
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

    // Telegram command polling every 3s
    if (now - lastTelegramPoll > 3000) {
      lastTelegramPoll = now;
      await telegram.pollCommands();
    }

    // monitor if position open (ALWAYS allowed, regardless of gate/kill switch)
    if (currentPosition) {
      const allOpen = positions.loadOpenPositions();
      currentPosition = allOpen.find(
        (p) =>
          p.mint === currentPosition.mint &&
          p.entryTime === currentPosition.entryTime
      );

      if (!currentPosition || currentPosition.status === "closed") {
        currentPosition = null;
        console.log("Position closed, ready for next entry");
      } else {
        let currentPrice = null;
        try {
          const axios = require("axios");
          const res = await axios.get(
            "https://api.jup.ag/price/v3",
            {
              params: { ids: currentPosition.mint },
              headers: process.env.JUPITER_API_KEY
                ? { "x-api-key": process.env.JUPITER_API_KEY }
                : {},
              timeout: 10000,
            }
          );
          const data = res.data?.data?.[currentPosition.mint];
          if (data && data.price) {
            currentPrice = parseFloat(data.price);
          }
        } catch (err) {
          // silent
        }

        if (currentPrice != null) {
          const reason = positions.evaluateExit(
            currentPosition,
            currentPrice,
            null,
            cfg
          );
          if (reason) {
            if (reason.type === "partialTP") {
              const pnlBefore = currentPosition.realizedPnlSol;
              positions.partialClose(
                currentPosition,
                cfg.execution.partialTpSellPct,
                reason,
                currentPrice,
                cfg
              );
              const exitPnl = currentPosition.exits[currentPosition.exits.length - 1].pnlSol;
              const riskState = riskManager.loadState();
              riskManager.recordTradeClosed(riskState, exitPnl, false, cfg);
              telegram.notifyExit(currentPosition, currentPosition.exits[currentPosition.exits.length - 1], false);

              const allOpen2 = positions.loadOpenPositions();
              currentPosition = allOpen2.find(
                (p) =>
                  p.mint === currentPosition.mint &&
                  p.entryTime === currentPosition.entryTime
              );
            } else {
              const posTotalPnl = currentPosition.realizedPnlSol;
              positions.closeRemaining(
                currentPosition,
                reason,
                currentPrice,
                cfg
              );
              const finalPnl = currentPosition.realizedPnlSol;
              const riskState = riskManager.loadState();
              riskManager.recordTradeClosed(riskState, finalPnl - posTotalPnl, true, cfg);
              const lastExit = currentPosition.exits[currentPosition.exits.length - 1];
              telegram.notifyExit(currentPosition, lastExit, true);
              currentPosition = null;
              console.log("Position fully closed");
            }
          } else {
            console.log(
              `monitor ${currentPosition.symbol}: $${currentPrice.toFixed(8)} peak $${currentPosition.peakPrice.toFixed(8)}`
            );
          }
        }
      }
    }

    // scan if no position open
    if (!currentPosition && now - lastScanTime > loopScanMs) {
      lastScanTime = now;
      console.log("Scanning for entry...");

      const riskState = riskManager.loadState();
      riskManager.rolloverIfNewDay(riskState, cfg);

      // daily rollover notification
      await telegram.checkDailyRollover(riskState, cfg);

      const gate = riskManager.canOpenNewPosition(riskState, cfg);
      if (!gate.allowed) {
        console.log(`ENTRY BLOCKED: ${gate.reason}`);
        continue;
      }

      try {
        const result = await scan(cfg);
        const decision = result.decision;

        let pickMint = null;
        let pickCandidate = null;

        if (decision && decision.called && decision.pick) {
          pickMint = decision.pick;
          pickCandidate = result.ranked.find((c) => c.mint === pickMint);
        } else {
          const goCandidate = result.ranked.find(
            (c) => c.timing && c.timing.signal === "go"
          );
          if (goCandidate) {
            pickMint = goCandidate.mint;
            pickCandidate = goCandidate;
          }
        }

        if (pickMint && pickCandidate) {
          let currentPrice = null;
          try {
            const axios = require("axios");
            const res = await axios.get(
              "https://api.jup.ag/price/v3",
              {
                params: { ids: pickMint },
                headers: process.env.JUPITER_API_KEY
                  ? { "x-api-key": process.env.JUPITER_API_KEY }
                  : {},
                timeout: 10000,
              }
            );
            const data = res.data?.data?.[pickMint];
            if (data && data.price) {
              currentPrice = parseFloat(data.price);
            }
          } catch (err) {
            // silent
          }

          if (currentPrice != null) {
            const candidateData = result.ranked
              .filter((r) => r.mint === pickMint)
              .map((r) => ({
                mint: r.mint,
                symbol: r.symbol,
              }))[0];
            currentPosition = positions.openPosition(
              candidateData || { mint: pickMint, symbol: pickMint.slice(0, 8) },
              currentPrice,
              cfg
            );
            if (currentPosition) {
              riskManager.recordTradeOpened(riskState);
              telegram.notifyEntry(currentPosition);
            }
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
