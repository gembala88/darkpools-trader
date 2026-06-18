const gmgn = require("../signals/gmgn");

async function assessRegime(candidates, config) {
  try {
    const regimeCfg = config.marketRegime;
    if (!regimeCfg || !regimeCfg.enabled) {
      return { regime: "normal", reason: "disabled", solChangePct: null, breadthDownShare: null, sampleSize: 0 };
    }

    const solDropPct = regimeCfg.solDropPct || 8;
    const breadthDownPct = (regimeCfg.breadthDownPct || 70) / 100;
    const minBreadthSample = regimeCfg.minBreadthSample || 5;
    const solMint = regimeCfg.solMint || "So11111111111111111111111111111111111111112";

    // SOL 24h change via GMGN
    let solChangePct = null;
    let solReason = "";
    try {
      const solStats = await gmgn.getTokenStats(solMint, config);
      if (solStats.available && solStats.feeConfirm) {
        const price = solStats.feeConfirm.price;
        const price24h = solStats.feeConfirm.price24h ?? solStats.feeConfirm.price_24h;
        if (price != null && price24h != null && price24h !== 0) {
          solChangePct = parseFloat(((price - price24h) / price24h * 100).toFixed(2));
        } else {
          solReason = "no SOL price data from GMGN";
        }
      } else {
        solReason = solStats.reason || "SOL stats unavailable";
      }
    } catch {
      solReason = "SOL GMGN call threw";
    }

    // Breadth: count candidates with price < price_1h
    let downCount = 0;
    let totalWithData = 0;
    for (const item of candidates) {
      const c = item.candidate || item;
      let feeData = null;
      if (item.feeConfirm && item.feeConfirm.price != null) {
        feeData = item.feeConfirm;
      } else {
        try {
          const stats = await gmgn.getTokenStats(c.mint, config);
          if (stats.available && stats.feeConfirm && stats.feeConfirm.price != null) {
            feeData = stats.feeConfirm;
          }
        } catch {}
      }
      if (feeData && feeData.price != null && feeData.price_1h != null) {
        totalWithData++;
        if (feeData.price < feeData.price_1h) {
          downCount++;
        }
      }
    }

    const sampleSize = totalWithData;
    const breadthDownShare = sampleSize >= minBreadthSample
      ? parseFloat((downCount / sampleSize).toFixed(4))
      : null;

    // Decide regime
    const solRiskOff = solChangePct != null && solChangePct <= -solDropPct;
    const breadthRiskOff = breadthDownShare != null && breadthDownShare > breadthDownPct;

    if (solRiskOff && breadthRiskOff) {
      return { regime: "risk_off", reason: `SOL ${solChangePct}% AND breadth ${(breadthDownShare * 100).toFixed(0)}% down`, solChangePct, breadthDownShare, sampleSize };
    }
    if (solRiskOff) {
      return { regime: "risk_off", reason: `SOL ${solChangePct}% drop (>${solDropPct}%)`, solChangePct, breadthDownShare, sampleSize };
    }
    if (breadthRiskOff) {
      return { regime: "risk_off", reason: `breadth ${(breadthDownShare * 100).toFixed(0)}% down (>${breadthDownPct * 100}%)`, solChangePct, breadthDownShare, sampleSize };
    }

    // Not risk_off
    if (solChangePct == null && breadthDownShare == null) {
      return { regime: "unknown", reason: "no SOL price AND no breadth data", solChangePct, breadthDownShare, sampleSize };
    }

    return { regime: "normal", reason: solChangePct != null ? `SOL ${solChangePct}%` : `breadth ${breadthDownShare * 100}% down`, solChangePct, breadthDownShare, sampleSize };
  } catch (err) {
    return { regime: "unknown", reason: `error: ${err.message}`, solChangePct: null, breadthDownShare: null, sampleSize: 0 };
  }
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

  // Build a mock candidates list with feeConfirm data
  function makeCandidate(mint, price, price1h) {
    return {
      mint,
      candidate: { mint },
      feeConfirm: price != null ? { signal: "?", price, price_1h: price1h, buyPressure: null } : null,
    };
  }

  // Config
  const cfg = {
    marketRegime: { enabled: true, solDropPct: 8, breadthDownPct: 70, minBreadthSample: 5, solMint: "So11111111111111111111111111111111111111112" },
    sources: { gmgn: { enabled: true } },
  };
  const disabledCfg = { ...cfg, marketRegime: { ...cfg.marketRegime, enabled: false } };

  (async () => {
    // 1. disabled -> normal
    const r1 = await assessRegime([], disabledCfg);
    assert("disabled: normal", r1.regime === "normal" && r1.reason === "disabled");

    // 2. SOL change -10% (no breadth data, no candidates) -> risk_off on SOL alone
    // We need to mock GMGN. Instead, bypass SOL via config:
    // Actually, we test the logic directly by simulating assessRegime with solChangePct.
    // Since GMGN is unavailable (no API key), SOL fetch will fail -> solChangePct null.
    // With no candidates, breadth is also null -> "unknown" (fail-safe).
    const r2 = await assessRegime([], cfg);
    // GMGN will fail because no API key set -> solChangePct null, no candidates -> breadth null
    // Both null -> "unknown"
    assert("no SOL+no candidates: unknown (fail-safe)", r2.regime === "unknown");

    // 3. Breadth 80% down (6/8 down, sample >=5) -> risk_off on breadth
    const candidatesDown = [
      makeCandidate("A", 0.9, 1.0),
      makeCandidate("B", 0.8, 1.0),
      makeCandidate("C", 0.7, 1.0),
      makeCandidate("D", 0.85, 1.0),
      makeCandidate("E", 0.95, 1.0),
      makeCandidate("F", 0.88, 1.0),
      makeCandidate("G", 1.1, 1.0),
      makeCandidate("H", 1.05, 1.0),
    ];
    const r3 = await assessRegime(candidatesDown, cfg);
    assert("breadth 6/8 down: risk_off", r3.regime === "risk_off" && r3.sampleSize === 8);

    // 4. Breadth 50% (2/4 down, but sample <5) -> inconclusive breadth
    const candidatesSmall = [
      makeCandidate("A", 0.9, 1.0),
      makeCandidate("B", 1.1, 1.0),
      makeCandidate("C", 0.95, 1.0),
      makeCandidate("D", 1.05, 1.0),
    ];
    const r4 = await assessRegime(candidatesSmall, cfg);
    // Only breadth may trigger, but sample < min -> null -> not risk_off
    assert("breadth small sample: not risk_off on breadth alone", r4.regime !== "risk_off");

    // 5. All flat/up: normal
    const candidatesUp = [
      makeCandidate("A", 1.1, 1.0),
      makeCandidate("B", 1.2, 1.0),
      makeCandidate("C", 1.05, 1.0),
      makeCandidate("D", 1.15, 1.0),
      makeCandidate("E", 1.1, 1.0),
    ];
    const r5 = await assessRegime(candidatesUp, cfg);
    assert("breadth 0/5 down: normal (or unknown, not risk_off)", r5.regime !== "risk_off");

    // 6. Candidate without feeConfirm (price data) -> not counted for breadth
    const candidatesMixed = [
      makeCandidate("A", 0.9, 1.0),
      { mint: "NoPrice", candidate: { mint: "NoPrice" }, feeConfirm: null }, // no price data
      makeCandidate("B", 1.0, 1.0),
    ];
    const r6 = await assessRegime(candidatesMixed, cfg);
    // sample = 2 (<5), breadth inconclusive -> only SOL could trigger
    assert("mixed data: not risk_off (sample too small)", r6.regime !== "risk_off");

    // 7. Edge: enabled but unknown GMGN and empty candidates
    const r7 = await assessRegime([], cfg);
    assert("empty+no SOL: unknown", r7.regime === "unknown");

    // 8. Extremely narrow threshold (solDropPct=0.01) + no price data -> unknown
    const tightCfg = {
      ...cfg,
      marketRegime: { ...cfg.marketRegime, solDropPct: 0.01, breadthDownPct: 1 },
    };
    const r8 = await assessRegime([], tightCfg);
    assert("tight config+no data: unknown", r8.regime === "unknown");

    // ---- SOL-path mock tests ----
    const origGetTokenStats = gmgn.getTokenStats;
    const solMint = cfg.marketRegime.solMint;

    try {
      // 9. Mock SOL -10% (90 vs 100) -> risk_off
      gmgn.getTokenStats = async (mint) => {
        if (mint === solMint) return { available: true, feeConfirm: { price: 90, price24h: 100, price_1h: 95 } };
        return { available: false, reason: "mock unavailable" };
      };
      const r9 = await assessRegime([], cfg);
      assert("SOL -10% via price24h: risk_off", r9.regime === "risk_off" && r9.solChangePct === -10);

      // 10. Mock SOL -3% (< 8% threshold) -> not risk_off
      gmgn.getTokenStats = async (mint) => {
        if (mint === solMint) return { available: true, feeConfirm: { price: 97, price24h: 100, price_1h: 98 } };
        return { available: false, reason: "mock unavailable" };
      };
      const r10 = await assessRegime([], cfg);
      assert("SOL -3% via price24h: not risk_off", r10.regime !== "risk_off" && r10.solChangePct === -3);

      // 11. Mock SOL -10% still triggers even with weak breadth (to prove AND path works)
      gmgn.getTokenStats = async (mint) => {
        if (mint === solMint) return { available: true, feeConfirm: { price: 90, price24h: 100, price_1h: 95 } };
        return { available: false, reason: "mock unavailable" };
      };
      const candidatesUp2 = [
        { mint: "A", candidate: { mint: "A" }, feeConfirm: { price: 1.1, price_1h: 1.0 } },
        { mint: "B", candidate: { mint: "B" }, feeConfirm: { price: 1.05, price_1h: 1.0 } },
      ];
      const r11 = await assessRegime(candidatesUp2, cfg);
      assert("SOL -10% overrides weak breadth: risk_off", r11.regime === "risk_off");
    } finally {
      gmgn.getTokenStats = origGetTokenStats;
    }

    console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
    process.exit(failures > 0 ? 1 : 0);
  })();
}

module.exports = { assessRegime };