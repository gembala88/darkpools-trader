const { atr } = require("../indicators");

function _getIntervalMinutes(tfConfig) {
  const tf = tfConfig.candleTimeframe || "hour";
  const agg = tfConfig.candleAggregate || 1;
  const base = { minute: 1, hour: 60, day: 1440 };
  return (base[tf] || 60) * agg;
}

function _lookback(intervalMinutes, desiredMinutes) {
  return Math.max(1, Math.ceil(desiredMinutes / intervalMinutes));
}

function _priceChange(candles, lookback, currentPrice) {
  if (!candles || candles.length <= lookback) return null;
  const idx = candles.length - 1 - lookback;
  const entry = candles[idx];
  if (!entry || entry.c == null || entry.c === 0) return null;
  return ((currentPrice - entry.c) / entry.c) * 100;
}

function _calcVolatility(candles, currentPrice) {
  if (!candles || candles.length < 20 || currentPrice == null || currentPrice === 0) return null;
  const highs = candles.map((c) => c.h);
  const lows = candles.map((c) => c.l);
  const closes = candles.map((c) => c.c);
  const atrVal = atr(highs, lows, closes, 14);
  if (atrVal == null) return null;
  return (atrVal / currentPrice) * 100;
}

function _classifyMomentum(pc1h, pc30m, pc5m) {
  const ref = pc1h != null ? Math.abs(pc1h) : (pc30m != null ? Math.abs(pc30m * 2) : (pc5m != null ? Math.abs(pc5m * 12) : 0));
  if (ref >= 100) return { tier: "extreme", level: 5, description: "100%+ move — explosive" };
  if (ref >= 50) return { tier: "high", level: 4, description: "50%+ move — strong momentum" };
  if (ref >= 20) return { tier: "moderate", level: 3, description: "20%+ move — moderate momentum" };
  if (ref >= 10) return { tier: "low", level: 2, description: "10%+ move — low momentum" };
  return { tier: "minimal", level: 1, description: "<10% move — minimal momentum" };
}

function _calcBinsBelow(momentumTier, volatility) {
  if (volatility == null) return null;
  const base = Math.round(35 + (volatility / 5) * 55);
  const clamped = Math.max(10, Math.min(200, base));

  let min, max;
  if (momentumTier.level >= 4) {
    min = Math.max(10, clamped - 15);
    max = Math.min(200, clamped + 15);
  } else if (momentumTier.level >= 2) {
    min = Math.max(10, clamped - 25);
    max = Math.min(200, clamped + 25);
  } else {
    min = Math.max(10, clamped - 30);
    max = Math.min(200, clamped + 30);
  }
  if (min > max) { const tmp = min; min = max; max = tmp; }
  return { min, max, base: clamped };
}

function _pathwayGuidance(momentumTier) {
  const map = {
    extreme:
      "Pathway A — explosive momentum; can enter immediately but use tight stop. " +
      "Narrow bins_below range (70-100). High risk of reversal.",
    high:
      "Pathway B — strong momentum; normal entry justified. " +
      "Standard bins_below range. Favorable risk/reward.",
    moderate:
      "Pathway C — moderate momentum; prefer waiting for pullback to lower bins. " +
      "Wide bins_below range (100-150). Partial entry if price dips.",
    low:
      "Pathway D — low momentum; skip unless exceptional fundamentals. " +
      "Wide bins_below range (100-150). Cautious only.",
    minimal:
      "Pathway D — minimal momentum; skip. " +
      "Wide bins_below range. Not worth the risk.",
  };
  return map[momentumTier.tier] || map.minimal;
}

function analyze(candles, tfConfig, currentPrice) {
  if (!candles || candles.length === 0) {
    return {
      priceChange5m: null, priceChange30m: null, priceChange1h: null,
      volatility: null, momentumTier: null, binsBelow: null, pathway: null,
    };
  }

  const intervalMinutes = _getIntervalMinutes(tfConfig);

  const lb5m = _lookback(intervalMinutes, 5);
  const lb30m = _lookback(intervalMinutes, 30);
  const lb1h = _lookback(intervalMinutes, 60);

  const priceChange5m = _priceChange(candles, lb5m, currentPrice);
  const priceChange30m = _priceChange(candles, lb30m, currentPrice);
  const priceChange1h = _priceChange(candles, lb1h, currentPrice);

  const volatility = _calcVolatility(candles, currentPrice);

  const momentumTier = _classifyMomentum(priceChange1h, priceChange30m, priceChange5m);

  const binsBelow = _calcBinsBelow(momentumTier, volatility);

  const pathway = _pathwayGuidance(momentumTier);

  return {
    priceChange5m: priceChange5m != null ? parseFloat(priceChange5m.toFixed(2)) : null,
    priceChange30m: priceChange30m != null ? parseFloat(priceChange30m.toFixed(2)) : null,
    priceChange1h: priceChange1h != null ? parseFloat(priceChange1h.toFixed(2)) : null,
    volatility: volatility != null ? parseFloat(volatility.toFixed(2)) : null,
    momentumTier,
    binsBelow,
    pathway,
  };
}

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

  const tfConfig = { candleTimeframe: "minute", candleAggregate: 1 };

  // 1. Empty candles → all nulls
  const empty = analyze([], tfConfig, 100);
  assert("empty candles: priceChange5m null", empty.priceChange5m === null);
  assert("empty candles: momentumTier null", empty.momentumTier === null);

  // 2. Steady rising price for 50 candles (1 minute each)
  const candles = [];
  let price = 100;
  for (let i = 0; i < 50; i++) {
    price += 1 + Math.random() * 0.5;
    candles.push({ t: Date.now() + i * 60000, o: price - 0.5, h: price + 0.3, l: price - 0.3, c: price, v: 1000 });
  }
  const rising = analyze(candles, tfConfig, price);
  assert("rising: priceChange5m near ~5%", rising.priceChange5m != null && rising.priceChange5m > 3);
  assert("rising: priceChange30m computed", rising.priceChange30m != null && rising.priceChange30m > 10);
  assert("rising: momentumTier tier defined", rising.momentumTier != null && typeof rising.momentumTier.tier === "string");
  assert("rising: pathway string", typeof rising.pathway === "string");

  // 3. Volatility with known values (hand-checkable ATR from indicators.js)
  const highs = [12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31];
  const lows = [10, 11, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28];
  const closes = [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30];
  const volCandles = [];
  for (let i = 0; i < 20; i++) {
    volCandles.push({ t: Date.now() + i * 60000, o: closes[i] - 0.5, h: highs[i], l: lows[i], c: closes[i], v: 1000 });
  }
  const volResult = analyze(volCandles, tfConfig, 30);
  assert("volatility: computed", volResult.volatility != null);
  assert("binsBelow: min <= max", volResult.binsBelow == null || volResult.binsBelow.min <= volResult.binsBelow.max);

  // 4. Hourly candles without enough data for 5m lookback
  const hourlyConfig = { candleTimeframe: "hour", candleAggregate: 1 };
  const hourlyCandles = [];
  for (let i = 0; i < 24; i++) {
    hourlyCandles.push({ t: Date.now() + i * 3600000, o: 100 + i, h: 101 + i, l: 99 + i, c: 100 + i, v: 5000 });
  }
  const hourlyResult = analyze(hourlyCandles, hourlyConfig, 124);
  assert("hourly: priceChange1h ~1%", hourlyResult.priceChange1h != null && hourlyResult.priceChange1h < 2 && hourlyResult.priceChange1h > 0.5);

  // 5. BinsBelow range logic: extreme tier narrows range
  const extremeCandles = [];
  for (let i = 0; i < 30; i++) {
    extremeCandles.push({ t: Date.now() + i * 60000, o: 100 + i * 4, h: 105 + i * 4, l: 99 + i * 4, c: 102 + i * 4, v: 1000 });
  }
  const extremeResult = analyze(extremeCandles, tfConfig, 102 + 29 * 4);
  assert("extreme: momentum tier is extreme", extremeResult.momentumTier != null && extremeResult.momentumTier.tier === "extreme");
  assert("extreme: binsBelow range exists", extremeResult.binsBelow != null && extremeResult.binsBelow.min <= extremeResult.binsBelow.max);

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
  process.exit(failures > 0 ? 1 : 0);
}

module.exports = { analyze };
