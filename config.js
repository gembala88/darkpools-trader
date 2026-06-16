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

  return cfg;
}

module.exports = { HARD_CAPS, loadConfig };
