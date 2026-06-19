const dexscreener = require("./dexscreener");
const gmgn = require("./gmgn");
const signalServer = require("./signalServer");
const jupiter = require("./jupiter");
const holders = require("./holders");

async function getCandidates(config) {
  const sources = config.sources;
  let all = [];

  // discovery sources
  if (sources.dexscreener?.enabled) {
    try {
      const ds = await dexscreener.fetchTrending();
      all = all.concat(ds);
    } catch (err) {
      console.log("dexscreener source error:", err.message);
    }
  }

  if (sources.gmgn?.enabled) {
    try {
      const gm = await gmgn.fetchTrending();
      all = all.concat(gm);
    } catch (err) {
      console.log("gmgn source error:", err.message);
    }
  }

  if (sources.signalServer?.enabled) {
    try {
      const ss = await signalServer.fetchCandidates();
      all = all.concat(ss);
    } catch (err) {
      console.log("signalServer source error:", err.message);
    }
  }

  if (sources.geckoterminalTrending?.enabled) {
    try {
      const gt = await require("./geckoterminalTrending").fetchTrending();
      all = all.concat(gt);
    } catch (err) {
      console.log("geckoterminalTrending source error:", err.message);
    }
  }

  // dedupe by mint — keep entry with most non-null fields
  const deduped = new Map();
  for (const c of all) {
    if (!c.mint) continue;
    const existing = deduped.get(c.mint);
    if (!existing) {
      deduped.set(c.mint, c);
    } else {
      const existingScore = Object.values(existing).filter((v) => v != null).length;
      const newScore = Object.values(c).filter((v) => v != null).length;
      if (newScore > existingScore) {
        deduped.set(c.mint, c);
      }
    }
  }

  let result = Array.from(deduped.values());

  // enrichment sources
  if (sources.jupiterPrice?.enabled) {
    try {
      result = await jupiter.enrichPrices(result);
    } catch (err) {
      console.log("jupiter enrichment error:", err.message);
    }
  }

  if (sources.heliusHolders?.enabled) {
    const rpcUrl = process.env.SOLANA_RPC_URL;
    if (rpcUrl) {
      for (const c of result) {
        if (c.mint) {
          try {
            const pct = await holders.getTopHolderPct(c.mint, rpcUrl);
            c.topHolderPct = pct;
          } catch (err) {
            console.log(`holders enrichment error for ${c.mint}:`, err.message);
          }
        }
      }
    } else {
      console.log("holders enrichment: no SOLANA_RPC_URL — skipping all holder checks");
    }
  }

  return result;
}

module.exports = { getCandidates };
