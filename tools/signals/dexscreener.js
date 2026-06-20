const axios = require("axios");
const fs = require("fs");
const path = require("path");

const _boostCache = { boosted: null, fetchedAt: 0, ttlMs: 60000 };
const _pairCache = {};
const _pairFile = path.resolve(__dirname, "..", "..", "data", "pair-cache.json");

function _loadPairFile() {
  try {
    const raw = fs.readFileSync(_pairFile, "utf-8");
    const data = JSON.parse(raw);
    if (typeof data === "object" && data !== null) {
      Object.assign(_pairCache, data);
    }
  } catch {}
}

function _savePairFile() {
  try {
    const dir = path.dirname(_pairFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(_pairFile, JSON.stringify(_pairCache, null, 2));
  } catch (err) {
    console.log(`dexscreener: pair-cache write error: ${err.message}`);
  }
}

_loadPairFile();

function _emptyBoost() {
  _boostCache.boosted = null;
  _boostCache.fetchedAt = 0;
}

async function _fetchBoostList() {
  const now = Date.now();
  if (_boostCache.boosted && now - _boostCache.fetchedAt < _boostCache.ttlMs) {
    return _boostCache.boosted;
  }

  let data;
  try {
    const res = await axios.get("https://api.dexscreener.com/token-boosts/top/v1", {
      timeout: 15000,
    });
    data = res.data;
  } catch (err) {
    console.log("dexscreener boost list error:", err.message);
    _emptyBoost();
    return [];
  }

  if (!Array.isArray(data)) {
    _emptyBoost();
    return [];
  }

  _boostCache.boosted = data.filter((t) => t.chainId === "solana");
  _boostCache.fetchedAt = now;
  return _boostCache.boosted;
}

async function _fetchPairs(mint) {
  if (_pairCache[mint]) return _pairCache[mint];

  try {
    const res = await axios.get(
      `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
      { timeout: 10000 }
    );
    const pairs = res.data?.pairs;
    if (Array.isArray(pairs) && pairs.length > 0) {
      const solPair = pairs.find(
        (p) => p.chainId === "solana" && p.quoteToken?.symbol === "USDC"
      ) || pairs.find((p) => p.chainId === "solana");
      if (solPair) {
        _pairCache[mint] = solPair;
        _savePairFile();
        return solPair;
      }
    }
    _pairCache[mint] = null;
    return null;
  } catch (err) {
    console.log(`dexscreener pairs error for ${mint}:`, err.message);
    _pairCache[mint] = null;
    return null;
  }
}

async function _mapConcurrent(items, fn, concurrency) {
  const results = [];
  const running = new Set();
  for (const item of items) {
    const p = fn(item).finally(() => running.delete(p));
    running.add(p);
    results.push(p);
    if (running.size >= concurrency) {
      await Promise.race(running);
    }
  }
  return Promise.all(results);
}

async function fetchTrending() {
  const boosted = await _fetchBoostList();

  const pairResults = await _mapConcurrent(boosted, async (t) => {
    const pair = await _fetchPairs(t.tokenAddress);
    return { pair, t };
  }, 5);

  const results = pairResults.map(({ pair, t }) => {
    if (pair) {
      return {
        source: "dexscreener",
        chain: "solana",
        mint: t.tokenAddress,
        symbol: pair.baseToken?.symbol || t.symbol || null,
        priceUsd: pair.priceUsd ? parseFloat(pair.priceUsd) : null,
        liquidityUsd: pair.liquidity?.usd ? parseFloat(pair.liquidity.usd) : null,
        volume24hUsd: pair.volume?.h24 ? parseFloat(pair.volume.h24) : null,
        pairCreatedAt: pair.pairCreatedAt
          ? new Date(pair.pairCreatedAt).getTime()
          : null,
        ageHours: pair.pairCreatedAt
          ? (Date.now() - new Date(pair.pairCreatedAt).getTime()) / 3600000
          : null,
        pairAddress: pair.pairAddress || null,
        dexId: pair.dexId || null,
        raw: { boost: t, pair },
      };
    }
    return {
      source: "dexscreener",
      chain: "solana",
      mint: t.tokenAddress,
      symbol: t.symbol || null,
      priceUsd: null,
      liquidityUsd: null,
      volume24hUsd: null,
      pairCreatedAt: null,
      ageHours: null,
      pairAddress: null,
      dexId: null,
      raw: { boost: t },
    };
  });

  return results;
}

module.exports = { fetchTrending };
