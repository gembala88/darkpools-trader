const holders = require("../signals/holders");
const scam = require("./scam");

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

  // maxBotPct — always skip unless gmgn is enabled and provides data
  if (f.maxBotPct != null) {
    checks.push({
      name: "maxBotPct",
      value: null,
      threshold: f.maxBotPct,
      result: "skip",
      reason: "no data source until GMGN enabled",
    });
  }

  // maxBundlePct — always skip unless gmgn is enabled
  if (f.maxBundlePct != null) {
    checks.push({
      name: "maxBundlePct",
      value: null,
      threshold: f.maxBundlePct,
      result: "skip",
      reason: "no data source until GMGN enabled",
    });
  }

  // maxInsiderConcentrationPct — always skip unless gmgn is enabled
  if (f.maxInsiderConcentrationPct != null) {
    checks.push({
      name: "maxInsiderConcentrationPct",
      value: null,
      threshold: f.maxInsiderConcentrationPct,
      result: "skip",
      reason: "no data source until GMGN enabled",
    });
  }

  const passed = !checks.some((c) => c.result === "fail");
  return { passed, checks };
}

module.exports = { applySafetyFilter };
