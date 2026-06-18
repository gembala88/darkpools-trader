const axios = require("axios");

const _priceCache = {};

function _getBaseUrl() {
  return process.env.JUPITER_API_KEY
    ? "https://api.jup.ag/price/v3"
    : "https://lite-api.jup.ag/price/v3";
}

function _getHeaders() {
  const apiKey = process.env.JUPITER_API_KEY;
  return apiKey ? { "x-api-key": apiKey } : {};
}

async function getUsdPrice(mint) {
  if (_priceCache[mint] && _priceCache[mint].priceUsd != null) {
    return _priceCache[mint].priceUsd;
  }

  try {
    const res = await axios.get(_getBaseUrl(), {
      params: { ids: mint },
      headers: _getHeaders(),
      timeout: 10000,
    });
    const entry = res.data?.[mint];
    if (entry && entry.usdPrice != null) {
      const price = parseFloat(entry.usdPrice);
      _priceCache[mint] = { priceUsd: price, id: entry.id || null };
      return price;
    }
    _priceCache[mint] = { priceUsd: null, id: null };
    return null;
  } catch (err) {
    const status = err.response?.status || "";
    console.log(`jupiter price fetch failed for ${mint}: ${status} ${err.message}`);
    _priceCache[mint] = { priceUsd: null, id: null };
    return null;
  }
}

async function enrichPrices(candidates) {
  const mints = candidates
    .map((c) => c.mint)
    .filter(Boolean);

  if (mints.length === 0) return candidates;

  const uncached = mints.filter((m) => _priceCache[m] == null);

  if (uncached.length > 0) {
    const batchSize = 50;
    for (let i = 0; i < uncached.length; i += batchSize) {
      const batch = uncached.slice(i, i + batchSize);
      try {
        const ids = batch.join(",");
        const res = await axios.get(_getBaseUrl(), {
          params: { ids },
          headers: _getHeaders(),
          timeout: 10000,
        });
        const data = res.data;
        if (data) {
          for (const mint of batch) {
            const entry = data[mint];
            _priceCache[mint] = entry
              ? { priceUsd: parseFloat(entry.usdPrice) || null, id: entry.id || null }
              : { priceUsd: null, id: null };
          }
        }
      } catch (err) {
        console.log("jupiter price error:", err.message);
      }
    }
  }

  return candidates.map((c) => {
    if (_priceCache[c.mint] && _priceCache[c.mint].priceUsd != null) {
      c.priceUsd = _priceCache[c.mint].priceUsd;
    }
    return c;
  });
}

module.exports = { enrichPrices, getUsdPrice };
