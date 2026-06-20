const axios = require("axios");

const _cache = {};
let _lastCall = 0;
const MIN_INTERVAL_MS = 1200;

function _getRpcUrls() {
  const urls = process.env.SOLANA_RPC_URLS;
  if (urls) {
    return urls.split(",").map((s) => s.trim()).filter(Boolean);
  }
  const single = process.env.SOLANA_RPC_URL;
  if (single) return [single];
  return ["https://api.mainnet-beta.solana.com"];
}

async function _rateLimited() {
  const now = Date.now();
  const elapsed = now - _lastCall;
  if (elapsed < MIN_INTERVAL_MS) {
    const wait = MIN_INTERVAL_MS - elapsed;
    await new Promise((r) => setTimeout(r, wait));
  }
  _lastCall = Date.now();
}

async function _rpcCall(method, params, rpcUrl) {
  const res = await axios.post(
    rpcUrl,
    { jsonrpc: "2.0", id: 1, method, params },
    { timeout: 10000 }
  );
  return res.data;
}

async function getTopHolderPct(mint, rpcUrl) {
  if (!rpcUrl) return null;

  if (_cache[mint] !== undefined) return _cache[mint];

  const rpcList = _getRpcUrls();
  let lastErr = null;

  for (const rpc of rpcList) {
    try {
      await _rateLimited();
      const [largestRes, supplyRes] = await Promise.all([
        _rpcCall("getTokenLargestAccounts", [mint], rpc),
        _rpcCall("getTokenSupply", [mint], rpc),
      ]);

      const largest = largestRes?.result?.value;
      const supply = supplyRes?.result?.value?.uiAmount;

      if (!largest || supply == null || supply === 0) {
        _cache[mint] = null;
        return null;
      }

      const topPct = (largest[0]?.uiAmount || 0) / supply;
      _cache[mint] = topPct;
      return topPct;
    } catch (err) {
      lastErr = err;
      const is429 = err.response?.status === 429;
      if (!is429 && err.response?.status !== 503) {
        break;
      }
      console.log(`holders: RPC ${rpc.slice(0, 30)}... ${is429 ? "429" : "503"} — trying next endpoint`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  console.log(`holders: all RPC failed for ${mint}: ${lastErr?.message}`);
  _cache[mint] = null;
  return null;
}

function clearCache() {
  Object.keys(_cache).forEach((k) => delete _cache[k]);
}

module.exports = { getTopHolderPct, clearCache };
