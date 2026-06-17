const { ema, rsi } = require("../tools/indicators");

function evaluate(candidate, candles, params) {
  const reasons = [];
  const indicators = {};

  if (!candles || candles.length < params.minCandles) {
    return {
      signal: "insufficient_data",
      indicators: { emaFast: null, emaSlow: null, rsi: null },
      reasons: [
        `candles ${candles ? candles.length : 0} < min ${params.minCandles}`,
      ],
    };
  }

  const closes = candles.map((c) => c.c);

  const emaFastVal = ema(closes, params.emaFast);
  const emaSlowVal = ema(closes, params.emaSlow);
  const rsiVal = rsi(closes, params.rsiPeriod);

  indicators.emaFast = emaFastVal != null ? parseFloat(emaFastVal.toFixed(8)) : null;
  indicators.emaSlow = emaSlowVal != null ? parseFloat(emaSlowVal.toFixed(8)) : null;
  indicators.rsi = rsiVal != null ? parseFloat(rsiVal.toFixed(2)) : null;

  if (emaFastVal == null || emaSlowVal == null || rsiVal == null) {
    return {
      signal: "insufficient_data",
      indicators,
      reasons: ["indicator computation returned null (insufficient data)"],
    };
  }

  const uptrend = emaFastVal > emaSlowVal;

  if (!uptrend) {
    reasons.push(
      `EMA${params.emaFast} (${indicators.emaFast}) not above EMA${params.emaSlow} (${indicators.emaSlow}) — not an uptrend`
    );
    return { signal: "no", indicators, reasons };
  }

  reasons.push(
    `EMA${params.emaFast} (${indicators.emaFast}) > EMA${params.emaSlow} (${indicators.emaSlow}) — uptrend confirmed`
  );

  if (rsiVal >= params.rsiMin && rsiVal <= params.rsiMax) {
    reasons.push(
      `RSI ${indicators.rsi} in range [${params.rsiMin}, ${params.rsiMax}] — momentum OK`
    );
    return { signal: "go", indicators, reasons };
  }

  if (rsiVal > params.rsiMax) {
    reasons.push(
      `RSI ${indicators.rsi} > ${params.rsiMax} — overbought, too late`
    );
    return { signal: "no", indicators, reasons };
  }

  // rsiVal < params.rsiMin
  reasons.push(
    `RSI ${indicators.rsi} < ${params.rsiMin} — uptrend but momentum not confirmed yet`
  );
  return { signal: "wait", indicators, reasons };
}

module.exports = { evaluate };
