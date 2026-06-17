const axios = require("axios");

const _cache = {};

async function getCandles(candidate, tfConfig) {
  const pairAddress = candidate.pairAddress;
  if (!pairAddress) return [];

  const timeframe = tfConfig.candleTimeframe || "hour";
  const aggregate = tfConfig.candleAggregate || 1;
  const limit = tfConfig.candleLimit || 120;
  const cacheKey = `${pairAddress}:${timeframe}:${aggregate}`;

  if (_cache[cacheKey]) return _cache[cacheKey];

  try {
    const url = `https://api.geckoterminal.com/api/v2/networks/solana/pools/${pairAddress}/ohlcv/${timeframe}`;
    const res = await axios.get(url, {
      params: { aggregate, limit, currency: "usd" },
      timeout: 10000,
    });

    const raw = res.data?.data?.attributes?.ohlcv_list;
    if (!Array.isArray(raw) || raw.length === 0) {
      _cache[cacheKey] = [];
      return [];
    }

    const parsed = raw
      .map((item) => ({
        t: item[0],
        o: item[1],
        h: item[2],
        l: item[3],
        c: item[4],
        v: item[5] || 0,
      }))
      .sort((a, b) => a.t - b.t);

    _cache[cacheKey] = parsed;
    return parsed;
  } catch (err) {
    const msg = err.response?.status
      ? `HTTP ${err.response.status}`
      : err.message;
    console.log(`candles: geckoterminal error for ${pairAddress}: ${msg}`);
    _cache[cacheKey] = [];
    return [];
  }
}

function clearCache() {
  Object.keys(_cache).forEach((k) => delete _cache[k]);
}

module.exports = { getCandles, clearCache };
