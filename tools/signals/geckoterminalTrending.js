const axios = require("axios");

const _cache = { data: null, fetchedAt: 0, ttlMs: 60000 };
const _requestTimestamps = [];

async function _throttle() {
  const now = Date.now();
  const cutoff = now - 60000;
  while (_requestTimestamps.length && _requestTimestamps[0] < cutoff) {
    _requestTimestamps.shift();
  }
  if (_requestTimestamps.length > 0) {
    const elapsed = now - _requestTimestamps[_requestTimestamps.length - 1];
    const delay = 2500;
    if (elapsed < delay) {
      const wait = delay - elapsed;
      console.log(`geckoterminalTrending: throttle — waiting ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  _requestTimestamps.push(Date.now());
}

async function fetchTrending() {
  const now = Date.now();
  if (_cache.data && now - _cache.fetchedAt < _cache.ttlMs) {
    return _cache.data;
  }

  let limit = 20;
  try {
    const config = require("../config").loadConfig();
    limit = config.sources?.geckoterminalTrending?.limit || 20;
  } catch {}

  try {
    await _throttle();
    const url = "https://api.geckoterminal.com/api/v2/networks/solana/trending_pools";
    const res = await axios.get(url, {
      params: { include: "base_token", page: 1 },
      timeout: 15000,
    });

    const raw = res.data?.data;
    if (!Array.isArray(raw)) {
      _cache.data = [];
      _cache.fetchedAt = now;
      return [];
    }

    const results = [];
    for (const pool of raw.slice(0, limit)) {
      const attr = pool.attributes || {};
      const rel = pool.relationships || {};
      const baseTokenId = rel.base_token?.data?.id || "";
      const mint = baseTokenId.startsWith("solana_") ? baseTokenId.slice(7) : null;
      if (!mint) continue;

      const pairCreatedAt = attr.pool_created_at ? new Date(attr.pool_created_at).getTime() : null;

      results.push({
        source: "geckoterminal",
        chain: "solana",
        mint,
        symbol: attr.name ? attr.name.split("/")[0]?.trim() : null,
        priceUsd: attr.base_token_price_usd ? parseFloat(attr.base_token_price_usd) : null,
        liquidityUsd: attr.reserve_in_usd ? parseFloat(attr.reserve_in_usd) : null,
        volume24hUsd: attr.volume_usd?.h24 ? parseFloat(attr.volume_usd.h24) : null,
        pairCreatedAt,
        ageHours: pairCreatedAt ? (Date.now() - pairCreatedAt) / 3600000 : null,
        pairAddress: attr.address || null,
        dexId: null,
        raw: { pool },
      });
    }

    _cache.data = results;
    _cache.fetchedAt = now;
    return results;
  } catch (err) {
    console.log("geckoterminalTrending source error:", err.message);
    _cache.data = [];
    _cache.fetchedAt = now;
    return [];
  }
}

module.exports = { fetchTrending };
