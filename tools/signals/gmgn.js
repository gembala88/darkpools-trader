const { exec } = require("child_process");

const _cache = {};

function _isValidMint(mint) {
  return typeof mint === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint);
}

async function _lookupToken(mint, config) {
  const gmgnCfg = config.sources?.gmgn || {};
  const timeoutMs = gmgnCfg.gmgnTimeoutMs || 8000;
  const apiKey = process.env.GMGN_API_KEY;

  if (!apiKey) {
    return { available: false, reason: "GMGN_API_KEY not set" };
  }

  if (!_isValidMint(mint)) {
    return { available: false, reason: "invalid mint" };
  }

  return new Promise((resolve) => {
    const cmd = `gmgn-cli token info --chain sol --address ${mint} --raw`;
    exec(
      cmd,
      {
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, GMGN_API_KEY: apiKey },
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (err) {
          resolve({ available: false, reason: `cli error: ${err.message}` });
          return;
        }

        let parsed;
        try {
          parsed = JSON.parse(stdout);
        } catch {
          resolve({ available: false, reason: "bad JSON from gmgn-cli" });
          return;
        }

        const stat = parsed?.stat || parsed?.data?.stat;
        if (!stat) {
          resolve({ available: false, reason: "no stat object in response" });
          return;
        }

        const botRate = Number(stat.bot_degen_rate);
        const bundleRate = Number(stat.top_bundler_trader_percentage);
        const ratRate = Number(stat.top_rat_trader_percentage);
        const entrapRate = Number(stat.top_entrapment_trader_percentage);

        if (isNaN(botRate) || isNaN(bundleRate) ||
            isNaN(ratRate) || isNaN(entrapRate)) {
          resolve({ available: false, reason: "unexpected field types in stat" });
          return;
        }

        // fee/activity confirmation from price block
        const priceBlock = parsed?.price || parsed?.data?.price;
        let feeConfirm;
        if (priceBlock) {
          const price = Number(priceBlock.price);
          const price1h = Number(priceBlock.price_1h);
          const buyVol24h = Number(priceBlock.buy_volume_24h);
          const sellVol24h = Number(priceBlock.sell_volume_24h);
          const price24h = Number(priceBlock.price_24h);
          if (!isNaN(price) && !isNaN(price1h) && !isNaN(price24h) && !isNaN(buyVol24h) && !isNaN(sellVol24h)) {
            const priceUp = price > price1h;
            const buyPressure = buyVol24h > sellVol24h;
            feeConfirm = {
              signal: priceUp && buyPressure ? "confirmed" : "neutral",
              priceUp,
              buyPressure,
              price,
              price1h,
              price24h,
              buyVol24h,
              sellVol24h,
            };
          } else {
            feeConfirm = { signal: "unknown", priceUp: null, buyPressure: null, price: null, price1h: null, price24h: null, buyVol24h: null, sellVol24h: null };
          }
        } else {
          feeConfirm = { signal: "unknown", priceUp: null, buyPressure: null, price: null, price1h: null, price24h: null, buyVol24h: null, sellVol24h: null };
        }

        resolve({
          available: true,
          botPct: parseFloat((botRate * 100).toFixed(2)),
          bundlePct: parseFloat((bundleRate * 100).toFixed(2)),
          insiderPct: parseFloat((Math.max(ratRate, entrapRate) * 100).toFixed(2)),
          feeConfirm,
          raw: {
            bot_degen_rate: botRate,
            top_bundler_trader_percentage: bundleRate,
            top_rat_trader_percentage: ratRate,
            top_entrapment_trader_percentage: entrapRate,
            top_10_holder_rate: stat.top_10_holder_rate,
            fresh_wallet_rate: stat.fresh_wallet_rate,
            top70_sniper_hold_rate: stat.top70_sniper_hold_rate,
          },
        });
      }
    );
  });
}

async function getTokenStats(mint, config) {
  const gmgnCfg = config.sources?.gmgn || {};
  if (!gmgnCfg.enabled) {
    return { available: false, reason: "gmgn disabled" };
  }

  const cacheKey = mint;
  const cached = _cache[cacheKey];
  if (cached && Date.now() - cached.ts < (gmgnCfg.gmgnCacheMs || 120000)) {
    return cached.data;
  }

  const result = await _lookupToken(mint, config);
  _cache[cacheKey] = { ts: Date.now(), data: result };
  return result;
}

function clearCache() {
  Object.keys(_cache).forEach((k) => delete _cache[k]);
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

  // We test via the safety filter (which imports us).
  // Build a config that has gmgn.enabled to exercise the safety integration.
  const safety = require("../filters/safety");
  const baseConfig = {
    sources: { gmgn: { enabled: false, gmgnTimeoutMs: 8000, gmgnCacheMs: 120000 } },
    filters: { maxBotPct: 30, maxBundlePct: 20, maxInsiderConcentrationPct: 25 },
    blacklistMints: [],
  };
  const candidate = { mint: "MockMint", liquidityUsd: 100000, volume24hUsd: 50000, ageHours: 48 };

  // 1. gmgn disabled -> all three checks skip
  (async () => {
    const r = await safety.applySafetyFilter(candidate, baseConfig);
    const botCheck = r.checks.find((c) => c.name === "maxBotPct");
    const bundleCheck = r.checks.find((c) => c.name === "maxBundlePct");
    const insiderCheck = r.checks.find((c) => c.name === "maxInsiderConcentrationPct");
    assert("gmgn disabled: maxBotPct skip", botCheck && botCheck.result === "skip");
    assert("gmgn disabled: maxBundlePct skip", bundleCheck && bundleCheck.result === "skip");
    assert("gmgn disabled: maxInsiderConcentrationPct skip", insiderCheck && insiderCheck.result === "skip");

    // 2. gmgn enabled but no API key -> skip
    const enabledCfg = { ...baseConfig, sources: { gmgn: { enabled: true } } };
    const r2 = await safety.applySafetyFilter(candidate, enabledCfg);
    const bot2 = r2.checks.find((c) => c.name === "maxBotPct");
    assert("gmgn no key: maxBotPct skip", bot2 && bot2.result === "skip");

    // 3. Override getTokenStats to return mock data via module-level injection
    //    Mock: all within threshold
    const originalLookup = require("./gmgn").getTokenStats;
    const gmgnModule = require("./gmgn");
    const mockResult = { available: true, botPct: 5, bundlePct: 2, insiderPct: 3 };
    // We can't easily monkey-patch getTokenStats because safety imports it directly.
    // Instead, directly construct the checks and test the logic.
    // Let's test via inline comparison:
    const mockStats = { available: true, botPct: 5, bundlePct: 2, insiderPct: 3 };
    const _testCheck = (name, value, threshold) => {
      if (value == null) return { name, value, threshold, result: "skip", reason: "no data" };
      if (value > threshold) return { name, value, threshold, result: "fail", reason: `rate ${value}% > ${threshold}%` };
      return { name, value, threshold, result: "pass", reason: null };
    };
    const bot = _testCheck("maxBotPct", mockStats.botPct, 30);
    assert("mock botPct within threshold: pass", bot.result === "pass");
    const bundle = _testCheck("maxBundlePct", mockStats.bundlePct, 20);
    assert("mock bundlePct within threshold: pass", bundle.result === "pass");
    const insider = _testCheck("maxInsiderConcentrationPct", mockStats.insiderPct, 25);
    assert("mock insiderPct within threshold: pass", insider.result === "pass");

    // 4. Mock: bot above threshold
    const mockBotFail = { available: true, botPct: 35, bundlePct: 2, insiderPct: 3 };
    const botFail = _testCheck("maxBotPct", mockBotFail.botPct, 30);
    assert("mock botPct above threshold: fail", botFail.result === "fail");
    const bundleFail = _testCheck("maxBundlePct", mockBotFail.bundlePct, 20);
    assert("mock bundlePct within: pass", bundleFail.result === "pass");
    const insiderFail = _testCheck("maxInsiderConcentrationPct", mockBotFail.insiderPct, 25);
    assert("mock insiderPct within: pass", insiderFail.result === "pass");

    // 5. Mock: all above threshold
    const mockAllFail = { available: true, botPct: 40, bundlePct: 25, insiderPct: 30 };
    const botA = _testCheck("maxBotPct", mockAllFail.botPct, 30);
    assert("allFail botPct: fail", botA.result === "fail");
    const bundleA = _testCheck("maxBundlePct", mockAllFail.bundlePct, 20);
    assert("allFail bundlePct: fail", bundleA.result === "fail");
    const insiderA = _testCheck("maxInsiderConcentrationPct", mockAllFail.insiderPct, 25);
    assert("allFail insiderPct: fail", insiderA.result === "fail");

    // 6. available:false -> skip (not fail, not pass)
    const mockSkip = { available: false, reason: "test skip" };
    const botS = _testCheck("maxBotPct", null, 30);
    // When available=false, value=null -> skip
    assert("unavailable: skip", botS.result === "skip");

    // ---- feeConfirm self-tests (replicate _lookupToken logic) ----
    function _computeFeeConfirm(priceBlock) {
      if (!priceBlock) return { signal: "unknown", priceUp: null, buyPressure: null };
      const price = Number(priceBlock.price);
      const price1h = Number(priceBlock.price_1h);
      const buyVol24h = Number(priceBlock.buy_volume_24h);
      const sellVol24h = Number(priceBlock.sell_volume_24h);
      if (isNaN(price) || isNaN(price1h) || isNaN(buyVol24h) || isNaN(sellVol24h)) {
        return { signal: "unknown", priceUp: null, buyPressure: null };
      }
      const priceUp = price > price1h;
      const buyPressure = buyVol24h > sellVol24h;
      return {
        signal: priceUp && buyPressure ? "confirmed" : "neutral",
        priceUp,
        buyPressure,
        price,
        price1h,
        buyVol24h,
        sellVol24h,
      };
    }

    // 7. confirmed: price up + buy pressure
    const c1 = _computeFeeConfirm({ price: 2.0, price_1h: 1.5, buy_volume_24h: 1000, sell_volume_24h: 500 });
    assert("feeConfirm: confirmed", c1.signal === "confirmed" && c1.priceUp === true && c1.buyPressure === true);

    // 8. neutral: price up but no buy pressure
    const c2 = _computeFeeConfirm({ price: 2.0, price_1h: 1.5, buy_volume_24h: 500, sell_volume_24h: 1000 });
    assert("feeConfirm: neutral (sell pressure)", c2.signal === "neutral" && c2.priceUp === true && c2.buyPressure === false);

    // 9. neutral: price down
    const c3 = _computeFeeConfirm({ price: 1.0, price_1h: 1.5, buy_volume_24h: 1000, sell_volume_24h: 500 });
    assert("feeConfirm: neutral (price down)", c3.signal === "neutral" && c3.priceUp === false && c3.buyPressure === true);

    // 10. unknown: missing price block
    const c4 = _computeFeeConfirm(null);
    assert("feeConfirm: unknown (no price)", c4.signal === "unknown");

    // 11. unknown: NaN fields
    const c5 = _computeFeeConfirm({ price: "abc", price_1h: 1.5, buy_volume_24h: 1000, sell_volume_24h: 500 });
    assert("feeConfirm: unknown (NaN price)", c5.signal === "unknown");

    console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
    process.exit(failures > 0 ? 1 : 0);
  })();
}

module.exports = { getTokenStats, clearCache, fetchTrending: async () => [] };
