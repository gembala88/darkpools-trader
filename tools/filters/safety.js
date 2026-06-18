const holders = require("../signals/holders");
const scam = require("./scam");
const gmgn = require("../signals/gmgn");

async function applySafetyFilter(candidate, config) {
  if (!candidate) {
    return { passed: false, checks: [{ name: "invalidCandidate", value: null, threshold: null, result: "fail", reason: "candidate is null/undefined" }] };
  }
  const f = config.filters;
  const checks = [];

  // blacklist — cheapest, no RPC needed
  try {
    const blacklist = config.blacklistMints || [];
    if (candidate && blacklist.includes(candidate.mint)) {
      checks.push({
        name: "blacklist",
        value: candidate.mint,
        threshold: null,
        result: "fail",
        reason: "blacklisted mint",
      });
    } else {
      checks.push({
        name: "blacklist",
        value: candidate ? candidate.mint : null,
        threshold: null,
        result: "pass",
        reason: null,
      });
    }
  } catch (err) {
    checks.push({
      name: "blacklist",
      value: null,
      threshold: null,
      result: "fail",
      reason: `error: ${err.message}`,
    });
  }

  // mintAuthority (on-chain)
  if (candidate && f.requireMintAuthorityRevoked) {
    try {
      const auth = await scam.getTokenAuthorities(candidate.mint);
      if (auth.mintAuthorityActive === true) {
        checks.push({
          name: "mintAuthority",
          value: "active",
          threshold: "revoked",
          result: "fail",
          reason: "mint authority still active (can mint infinite tokens)",
        });
      } else if (auth.mintAuthorityActive === false) {
        checks.push({
          name: "mintAuthority",
          value: "revoked",
          threshold: "revoked",
          result: "pass",
          reason: null,
        });
      } else {
        checks.push({
          name: "mintAuthority",
          value: null,
          threshold: "revoked",
          result: "skip",
          reason: "authority data unavailable (no RPC)",
        });
      }
    } catch (err) {
      checks.push({
        name: "mintAuthority",
        value: null,
        threshold: "revoked",
        result: "fail",
        reason: `error: ${err.message}`,
      });
    }
  }

  // freezeAuthority (on-chain)
  if (candidate && f.requireFreezeAuthorityRevoked) {
    try {
      const auth = await scam.getTokenAuthorities(candidate.mint);
      if (auth.freezeAuthorityActive === true) {
        checks.push({
          name: "freezeAuthority",
          value: "active",
          threshold: "revoked",
          result: "fail",
          reason: "freeze authority active (can freeze wallets)",
        });
      } else if (auth.freezeAuthorityActive === false) {
        checks.push({
          name: "freezeAuthority",
          value: "revoked",
          threshold: "revoked",
          result: "pass",
          reason: null,
        });
      } else {
        checks.push({
          name: "freezeAuthority",
          value: null,
          threshold: "revoked",
          result: "skip",
          reason: "authority data unavailable (no RPC)",
        });
      }
    } catch (err) {
      checks.push({
        name: "freezeAuthority",
        value: null,
        threshold: "revoked",
        result: "fail",
        reason: `error: ${err.message}`,
      });
    }
  }

  // minLiquidityUsd
  if (f.minLiquidityUsd != null) {
    if (candidate.liquidityUsd == null) {
      checks.push({
        name: "minLiquidityUsd",
        value: null,
        threshold: f.minLiquidityUsd,
        result: "skip",
        reason: "liquidity data unavailable",
      });
    } else if (candidate.liquidityUsd < f.minLiquidityUsd) {
      checks.push({
        name: "minLiquidityUsd",
        value: candidate.liquidityUsd,
        threshold: f.minLiquidityUsd,
        result: "fail",
        reason: `liquidity $${candidate.liquidityUsd} < $${f.minLiquidityUsd}`,
      });
    } else {
      checks.push({
        name: "minLiquidityUsd",
        value: candidate.liquidityUsd,
        threshold: f.minLiquidityUsd,
        result: "pass",
        reason: null,
      });
    }
  }

  // minVolume24hUsd
  if (f.minVolume24hUsd != null) {
    if (candidate.volume24hUsd == null) {
      checks.push({
        name: "minVolume24hUsd",
        value: null,
        threshold: f.minVolume24hUsd,
        result: "skip",
        reason: "volume data unavailable",
      });
    } else if (candidate.volume24hUsd < f.minVolume24hUsd) {
      checks.push({
        name: "minVolume24hUsd",
        value: candidate.volume24hUsd,
        threshold: f.minVolume24hUsd,
        result: "fail",
        reason: `volume $${candidate.volume24hUsd} < $${f.minVolume24hUsd}`,
      });
    } else {
      checks.push({
        name: "minVolume24hUsd",
        value: candidate.volume24hUsd,
        threshold: f.minVolume24hUsd,
        result: "pass",
        reason: null,
      });
    }
  }

  // minTokenAgeHours
  if (f.minTokenAgeHours != null) {
    if (candidate.ageHours == null) {
      checks.push({
        name: "minTokenAgeHours",
        value: null,
        threshold: f.minTokenAgeHours,
        result: "skip",
        reason: "age data unavailable",
      });
    } else if (candidate.ageHours < f.minTokenAgeHours) {
      checks.push({
        name: "minTokenAgeHours",
        value: candidate.ageHours,
        threshold: f.minTokenAgeHours,
        result: "fail",
        reason: `age ${candidate.ageHours.toFixed(1)}h < ${f.minTokenAgeHours}h`,
      });
    } else {
      checks.push({
        name: "minTokenAgeHours",
        value: candidate.ageHours,
        threshold: f.minTokenAgeHours,
        result: "pass",
        reason: null,
      });
    }
  }

  // maxTopHolderPct
  if (f.maxTopHolderPct != null) {
    const topPct = candidate.topHolderPct;
    if (topPct == null) {
      checks.push({
        name: "maxTopHolderPct",
        value: null,
        threshold: f.maxTopHolderPct,
        result: "skip",
        reason: "holder data unavailable (no RPC or non-standard token)",
      });
    } else if (topPct * 100 > f.maxTopHolderPct) {
      checks.push({
        name: "maxTopHolderPct",
        value: (topPct * 100).toFixed(1),
        threshold: f.maxTopHolderPct,
        result: "fail",
        reason: `top holder ${(topPct * 100).toFixed(1)}% > ${f.maxTopHolderPct}%`,
      });
    } else {
      checks.push({
        name: "maxTopHolderPct",
        value: (topPct * 100).toFixed(1),
        threshold: f.maxTopHolderPct,
        result: "pass",
        reason: null,
      });
    }
  }

  // GMGN-based checks: maxBotPct, maxBundlePct, maxInsiderConcentrationPct
  const gmgnCfg = config.sources?.gmgn;
  const gmgnEnabled = gmgnCfg && gmgnCfg.enabled === true;
  let gmgnStats = null;

  if (candidate && gmgnEnabled && (f.maxBotPct != null || f.maxBundlePct != null || f.maxInsiderConcentrationPct != null)) {
    if (process.env.GMGN_API_KEY) {
      try {
        gmgnStats = await gmgn.getTokenStats(candidate.mint, config);
      } catch (err) {
        gmgnStats = { available: false, reason: `error: ${err.message}` };
      }
    } else {
      gmgnStats = { available: false, reason: "GMGN_API_KEY not set" };
    }
  }

  const _gmgnCheck = (name, pctValue, threshold) => {
    if (!gmgnStats || !gmgnStats.available) {
      const reason = gmgnStats ? gmgnStats.reason : (!gmgnEnabled ? "gmgn disabled" : "gmgn data unavailable");
      checks.push({ name, value: null, threshold, result: "skip", reason });
      return;
    }
    if (pctValue > threshold) {
      checks.push({ name, value: pctValue, threshold, result: "fail", reason: `rate ${pctValue}% > ${threshold}%` });
    } else {
      checks.push({ name, value: pctValue, threshold, result: "pass", reason: null });
    }
  };

  if (f.maxBotPct != null) {
    _gmgnCheck("maxBotPct", gmgnStats?.botPct, f.maxBotPct);
  }
  if (f.maxBundlePct != null) {
    _gmgnCheck("maxBundlePct", gmgnStats?.bundlePct, f.maxBundlePct);
  }
  if (f.maxInsiderConcentrationPct != null) {
    _gmgnCheck("maxInsiderConcentrationPct", gmgnStats?.insiderPct, f.maxInsiderConcentrationPct);
  }

  const passed = !checks.some((c) => c.result === "fail");
  return { passed, checks };
}

module.exports = { applySafetyFilter };
