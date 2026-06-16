const axios = require("axios");

const _priceCache = {};

async function enrichPrices(candidates) {
  const mints = candidates
    .map((c) => c.mint)
    .filter(Boolean);

  if (mints.length === 0) return candidates;

  const uncached = mints.filter((m) => _priceCache[m] == null);

  if (uncached.length > 0) {
    const apiKey = process.env.JUPITER_API_KEY;
    const headers = {};
    if (apiKey) {
      headers["x-api-key"] = apiKey;
    }

    const batchSize = 50;
    for (let i = 0; i < uncached.length; i += batchSize) {
      const batch = uncached.slice(i, i + batchSize);
      try {
        const ids = batch.join(",");
        const res = await axios.get("https://api.jup.ag/price/v3", {
          params: { ids },
          headers,
          timeout: 10000,
        });
        const data = res.data?.data;
        if (data) {
          for (const mint of batch) {
            const entry = data[mint];
            _priceCache[mint] = entry
              ? { priceUsd: parseFloat(entry.price) || null, id: entry.id }
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

module.exports = { enrichPrices };
