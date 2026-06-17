require("dotenv").config();
const { loadConfig } = require("./config");
const { scan } = require("./tools/screening");
const positions = require("./tools/positions");

const cfg = loadConfig();

async function runLoop() {
  console.log("darkpools-trader | mode:", cfg.mode, "| starting dry_run loop");

  // restore open positions
  const openPositions = positions.loadOpenPositions();

  const loopScanMs = cfg.execution.loopScanMs || 30000;
  const loopMonitorMs = cfg.execution.loopMonitorMs || 10000;

  // track positions in memory
  let currentPosition = openPositions[0] || null;

  // handle graceful shutdown
  process.on("SIGINT", () => {
    console.log("\nSIGINT received — state saved, exiting cleanly");
    process.exit(0);
  });

  let lastScanTime = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const now = Date.now();

    // monitor if position open
    if (currentPosition) {
      // refresh from disk to get latest state
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
        // fetch current price (use Jupiter price or similar)
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
              positions.partialClose(
                currentPosition,
                cfg.execution.partialTpSellPct,
                reason,
                currentPrice,
                cfg
              );
              // reload after partial close
              const allOpen2 = positions.loadOpenPositions();
              currentPosition = allOpen2.find(
                (p) =>
                  p.mint === currentPosition.mint &&
                  p.entryTime === currentPosition.entryTime
              );
            } else {
              positions.closeRemaining(
                currentPosition,
                reason,
                currentPrice,
                cfg
              );
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
      try {
        const result = await scan(cfg);
        const decision = result.decision;

        let pickMint = null;
        let pickCandidate = null;

        if (decision && decision.called && decision.pick) {
          pickMint = decision.pick;
          pickCandidate = result.ranked.find((c) => c.mint === pickMint);
        } else {
          // fallback: highest score with timing "go"
          const goCandidate = result.ranked.find(
            (c) => c.timing && c.timing.signal === "go"
          );
          if (goCandidate) {
            pickMint = goCandidate.mint;
            pickCandidate = goCandidate;
          }
        }

        if (pickMint && pickCandidate) {
          // fetch current price
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
