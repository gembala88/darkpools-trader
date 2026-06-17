const axios = require("axios");

const _cache = {};
const _requestTimestamps = [];
let _config = null;

function _loadConfig() {
  if (_config) return _config;
  try {
    _config = require("../config").loadConfig();
  } catch {
    _config = {};
  }
  return _config;
}

function _getCfgVal(path, def) {
  const cfg = _loadConfig();
  const keys = path.split(".");
  let obj = cfg;
  for (const k of keys) {
    if (obj == null || typeof obj !== "object") return def;
    obj = obj[k];
  }
  return obj != null ? obj : def;
}

function _cacheMs() {
  return _getCfgVal("execution.candleCacheMs", 600000);
}
function _requestDelayMs() {
  return _getCfgVal("execution.candleRequestDelayMs", 2500);
}

async function _throttle() {
  const now = Date.now();
  const delay = _requestDelayMs();
  const cutoff = now - 60000;
  // keep only timestamps within the last 60s
  while (_requestTimestamps.length && _requestTimestamps[0] < cutoff) {
    _requestTimestamps.shift();
  }
  if (_requestTimestamps.length > 0) {
    const elapsed = now - _requestTimestamps[_requestTimestamps.length - 1];
    if (elapsed < delay) {
      const wait = delay - elapsed;
      console.log(`candles: throttle — waiting ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  _requestTimestamps.push(Date.now());
}

async function _fetchWithRetry(url, params, retriesLeft) {
  try {
    await _throttle();
    const res = await axios.get(url, { params, timeout: 10000 });
    return res;
  } catch (err) {
    if (err.response?.status === 429 && retriesLeft > 0) {
      const wait = 3000 * Math.pow(2, 2 - retriesLeft); // 3s, 6s
      console.log(`candles: 429 on ${url.slice(-20)} — retry in ${wait}ms (${retriesLeft} left)`);
      await new Promise((r) => setTimeout(r, wait));
      return _fetchWithRetry(url, params, retriesLeft - 1);
    }
    throw err;
  }
}

async function getCandles(candidate, tfConfig) {
  const pairAddress = candidate.pairAddress;
  if (!pairAddress) return [];

  const timeframe = tfConfig.candleTimeframe || "hour";
  const aggregate = tfConfig.candleAggregate || 1;
  const limit = tfConfig.candleLimit || 120;
  const cacheKey = `${pairAddress}:${timeframe}:${aggregate}`;

  const cached = _cache[cacheKey];
  if (cached && Date.now() - cached.ts < _cacheMs()) {
    console.log(`candles: cache HIT ${pairAddress.slice(0, 8)}... ${timeframe}/${aggregate}`);
    return cached.data;
  }

  console.log(`candles: FETCH ${pairAddress.slice(0, 8)}... ${timeframe}/${aggregate}`);

  try {
    const url = `https://api.geckoterminal.com/api/v2/networks/solana/pools/${pairAddress}/ohlcv/${timeframe}`;
    const res = await _fetchWithRetry(url, { aggregate, limit, currency: "usd" }, 2);

    const raw = res.data?.data?.attributes?.ohlcv_list;
    if (!Array.isArray(raw) || raw.length === 0) {
      _cache[cacheKey] = { ts: Date.now(), data: [] };
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

    _cache[cacheKey] = { ts: Date.now(), data: parsed };
    return parsed;
  } catch (err) {
    const status = err.response?.status;
    const msg = status ? `HTTP ${status}` : err.message;
    console.log(`candles: geckoterminal error for ${pairAddress}: ${msg}${status === 429 ? " (retries exhausted)" : ""}`);
    _cache[cacheKey] = { ts: Date.now(), data: [] };
    return [];
  }
}

function clearCache() {
  Object.keys(_cache).forEach((k) => delete _cache[k]);
  _config = null;
}

module.exports = { getCandles, clearCache };
