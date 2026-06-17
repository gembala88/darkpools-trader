/*
 * HARD_CAPS — immutable safety limits.
 *
 * These exist to prevent a repeat of going live too early.
 * User-config can only be STRICTER than hard-caps, never looser.
 * Every violation throws a clear error at startup.
 */
const HARD_CAPS = Object.freeze({
  ALLOWED_MODES: ["dry_run", "confirm", "live"],
  DEFAULT_MODE: "dry_run",
  MAX_POSITION_SIZE_SOL: 0.05,
  MAX_CONCURRENT_POSITIONS: 1,
  REQUIRE_EXPLICIT_LIVE_FLAG: true,
  MIN_STOP_LOSS_PCT: -15,
  DAILY_LOSS_LIMIT_REQUIRED: true,
  COOLDOWN_REQUIRED: true,
  MAX_TRADES_PER_DAY_REQUIRED: true,
  ALLOW_DEGEN_DEFAULT: false,
  REQUIRE_DEGEN_ACK: true,
});

function loadConfig() {
  const fs = require("fs");
  const path = require("path");

  const configPath = path.resolve(__dirname, "user-config.json");

  let cfg;
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    cfg = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Cannot read/parse user-config.json at ${configPath}: ${err.message}`
    );
  }

  // mode
  if (!cfg.mode || !HARD_CAPS.ALLOWED_MODES.includes(cfg.mode)) {
    cfg.mode = HARD_CAPS.DEFAULT_MODE;
  }

  if (
    cfg.mode === "live" &&
    HARD_CAPS.REQUIRE_EXPLICIT_LIVE_FLAG &&
    cfg.confirmLiveTrading !== true
  ) {
    throw new Error(
      "Refusing live: confirmLiveTrading not set to true in user-config.json."
    );
  }

  // position size
  if (cfg.positionSizeSol == null || cfg.positionSizeSol > HARD_CAPS.MAX_POSITION_SIZE_SOL) {
    throw new Error(
      `positionSizeSol must be set and ≤ ${HARD_CAPS.MAX_POSITION_SIZE_SOL} SOL (got ${cfg.positionSizeSol})`
    );
  }

  // concurrent positions
  if (
    cfg.maxConcurrentPositions == null ||
    cfg.maxConcurrentPositions > HARD_CAPS.MAX_CONCURRENT_POSITIONS
  ) {
    throw new Error(
      `maxConcurrentPositions must be set and ≤ ${HARD_CAPS.MAX_CONCURRENT_POSITIONS} (got ${cfg.maxConcurrentPositions})`
    );
  }

  // stop loss
  if (cfg.stopLossPct == null || cfg.stopLossPct < HARD_CAPS.MIN_STOP_LOSS_PCT) {
    throw new Error(
      `stopLossPct must be set and ≥ ${HARD_CAPS.MIN_STOP_LOSS_PCT}% (got ${cfg.stopLossPct})`
    );
  }

  // daily loss limit
  if (HARD_CAPS.DAILY_LOSS_LIMIT_REQUIRED && (cfg.dailyLossLimitPct == null)) {
    throw new Error(
      "dailyLossLimitPct is required. Set it in user-config.json."
    );
  }

  // cooldown
  if (HARD_CAPS.COOLDOWN_REQUIRED && (cfg.cooldownMinutesBetweenTrades == null)) {
    throw new Error(
      "cooldownMinutesBetweenTrades is required. Set it in user-config.json."
    );
  }

  // max trades per day
  if (HARD_CAPS.MAX_TRADES_PER_DAY_REQUIRED && (cfg.maxTradesPerDay == null)) {
    throw new Error(
      "maxTradesPerDay is required. Set it in user-config.json."
    );
  }

  // degen mode
  if (cfg.trending && cfg.trending.allowDegen === true && cfg.trending.acknowledgeDegenRisk !== true) {
    throw new Error(
      "Refusing degen mode: acknowledgeDegenRisk not set to true in user-config.json."
    );
  }

  // llm block
  const llm = cfg.llm;
  if (!llm || !llm.provider || !llm.baseUrl || !llm.model) {
    throw new Error(
      "llm block must include provider, baseUrl, and model in user-config.json."
    );
  }

  // sources block — at least one discovery source must be enabled
  const sources = cfg.sources;
  if (!sources) {
    throw new Error("sources block required in user-config.json.");
  }
  const discoverySources = Object.keys(sources).filter(
    (k) => sources[k].kind === "discovery"
  );
  const hasEnabledDiscovery = discoverySources.some((k) => sources[k].enabled === true);
  if (!hasEnabledDiscovery) {
    throw new Error("No discovery source enabled. Enable at least one (e.g. dexscreener) in user-config.json sources.");
  }

  // execution block
  const exec = cfg.execution;
  if (!exec || exec.slippagePctPerSide == null || exec.slippagePctPerSide < 0 || exec.slippagePctPerSide > 50) {
    throw new Error("execution.slippagePctPerSide must be 0..50 in user-config.json.");
  }
  if (exec.trailing) {
    if (exec.trailing.mode === "fixed" && (exec.trailing.fixedPct == null || exec.trailing.fixedPct <= 0)) {
      throw new Error("execution.trailing.fixedPct must be > 0 when mode is 'fixed'.");
    }
  }

  // decision block
  if (!cfg.decision || !Array.isArray(cfg.decision.eligibleTimings) || cfg.decision.eligibleTimings.length === 0) {
    throw new Error("decision.eligibleTimings must be a non-empty array in user-config.json.");
  }

  // strategy block
  const strategy = cfg.strategy;
  if (!strategy || !strategy.active) {
    throw new Error("strategy.active required in user-config.json.");
  }
  if (!Array.isArray(strategy.available) || !strategy.available.includes(strategy.active)) {
    throw new Error(`strategy.active "${strategy.active}" not in strategy.available [${(strategy.available || []).join(", ")}].`);
  }
  const activeParams = strategy[strategy.active];
  if (!activeParams) {
    throw new Error(`Strategy params block "strategy.${strategy.active}" missing in user-config.json.`);
  }

  return cfg;
}

module.exports = { HARD_CAPS, loadConfig };
