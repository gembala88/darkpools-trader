const axios = require("axios");

const _cache = {};

async function getTopHolderPct(mint, rpcUrl) {
  if (!rpcUrl) return null;

  if (_cache[mint] !== undefined) return _cache[mint];

  try {
    const [largestRes, supplyRes] = await Promise.all([
      axios.post(
        rpcUrl,
        {
          jsonrpc: "2.0",
          id: 1,
          method: "getTokenLargestAccounts",
          params: [mint],
        },
        { timeout: 10000 }
      ),
      axios.post(
        rpcUrl,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "getTokenSupply",
          params: [mint],
        },
        { timeout: 10000 }
      ),
    ]);

    const largest = largestRes.data?.result?.value;
    const supply = supplyRes.data?.result?.value?.uiAmount;

    if (!largest || supply == null || supply === 0) {
      _cache[mint] = null;
      return null;
    }

    const topPct = (largest[0]?.uiAmount || 0) / supply;
    _cache[mint] = topPct;
    return topPct;
  } catch (err) {
    console.log(`holders: RPC error for ${mint}:`, err.message);
    _cache[mint] = null;
    return null;
  }
}

function clearCache() {
  Object.keys(_cache).forEach((k) => delete _cache[k]);
}

module.exports = { getTopHolderPct, clearCache };
