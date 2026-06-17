const axios = require("axios");

const _boostCache = { boosted: null, fetchedAt: 0, ttlMs: 60000 };
const _pairCache = {};

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

async function fetchTrending() {
  const boosted = await _fetchBoostList();

  const results = [];
  for (const t of boosted) {
    const pair = await _fetchPairs(t.tokenAddress);
    if (pair) {
      results.push({
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
      });
    } else {
      // fallback with just boost data
      results.push({
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
      });
    }
  }

  return results;
}

module.exports = { fetchTrending };
