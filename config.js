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
  MAX_CONCURRENT_POSITIONS: 3,
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

  // risk params
  if (cfg.accountSizeSol == null || cfg.accountSizeSol <= 0) {
    throw new Error("accountSizeSol must be > 0 in user-config.json.");
  }
  if (cfg.dayBoundary) {
    const validTz = ["utc", "local"];
    try {
      Intl.DateTimeFormat(undefined, { timeZone: cfg.dayBoundary });
      validTz.push(cfg.dayBoundary);
    } catch {}
    if (!validTz.includes(cfg.dayBoundary)) {
      throw new Error(`dayBoundary must be "utc", "local", or a valid IANA timezone (got "${cfg.dayBoundary}").`);
    }
  }
  if (cfg.cooldownMinutesBetweenTrades == null || cfg.cooldownMinutesBetweenTrades < 0) {
    throw new Error("cooldownMinutesBetweenTrades must be >= 0 in user-config.json.");
  }
  if (cfg.maxTradesPerDay == null || cfg.maxTradesPerDay < 0) {
    throw new Error("maxTradesPerDay must be >= 0 (0 = unlimited) in user-config.json.");
  }
  if (cfg.loseStreak) {
    if (cfg.loseStreak.threshold == null || cfg.loseStreak.threshold < 1) {
      throw new Error("loseStreak.threshold must be >= 1 in user-config.json.");
    }
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

  // scam / blacklist
  if (cfg.blacklistMints != null && !Array.isArray(cfg.blacklistMints)) {
    throw new Error("blacklistMints must be an array in user-config.json.");
  }
  const scamFlags = ["requireMintAuthorityRevoked", "requireFreezeAuthorityRevoked"];
  for (const key of scamFlags) {
    if (cfg.filters?.[key] != null && typeof cfg.filters[key] !== "boolean") {
      throw new Error(`filters.${key} must be boolean in user-config.json (got ${JSON.stringify(cfg.filters[key])}).`);
    }
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

function getConfigView(cfg) {
  if (!cfg) cfg = loadConfig();
  const lines = [
    `mode=${cfg.mode} | confirmLive=${cfg.confirmLiveTrading}`,
    `accountSize=${cfg.accountSizeSol} SOL | positionSize=${cfg.positionSizeSol} SOL | maxConcurrent=${cfg.maxConcurrentPositions}`,
    `TP=${cfg.takeProfitPct}% | SL=${cfg.stopLossPct}% | trailing=${cfg.trailingEnabled} | maxHold=${cfg.maxHoldHours}h`,
    `dailyLossLimit=${cfg.dailyLossLimitPct}% | cooldown=${cfg.cooldownMinutesBetweenTrades}m | maxTradesPerDay=${cfg.maxTradesPerDay}`,
    `loseStreak=${cfg.loseStreak?.threshold}x/${cfg.loseStreak?.cooldownMinutes}m`,
    `strategy=${cfg.strategy?.active}`,
    `sources: dexscreener=${cfg.sources?.dexscreener?.enabled} gmgn=${cfg.sources?.gmgn?.enabled} signalServer=${cfg.sources?.signalServer?.enabled}`,
    `llm: enabled=${cfg.llm?.enabled} provider=${cfg.llm?.provider} model=${cfg.llm?.model}`,
    `telegram=${cfg.telegramEnabled} dayBoundary=${cfg.dayBoundary}`,
    `eligibleTimings=[${cfg.decision?.eligibleTimings?.join(",") || ""}]`,
  ];
  return lines.join("\n");
}

function setConfigValue(path, value) {
  const fs = require("fs");
  const cfgPath = require("path").resolve(__dirname, "user-config.json");
  const cfg = loadConfig();
  const whitelist = cfg.configSettableWhitelist || [];

  if (!whitelist.includes(path)) {
    throw new Error(`blocked: change "${path}" in user-config.json directly (safety)`);
  }

  // parse value
  let parsedValue;
  try {
    parsedValue = JSON.parse(value);
  } catch {
    parsedValue = value; // keep as string
  }

  // apply to a COPY and validate
  const copy = JSON.parse(JSON.stringify(cfg));
  const keys = path.split(".");
  let obj = copy;
  for (let i = 0; i < keys.length - 1; i++) {
    if (obj[keys[i]] == null) obj[keys[i]] = {};
    obj = obj[keys[i]];
  }
  obj[keys[keys.length - 1]] = parsedValue;

  // run validation by re-reading from a temp write
  const tmpPath = cfgPath + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(copy, null, 2));
  try {
    // reload to trigger validation
    const { loadConfig } = require("./config");
    // temporarily swap the file
    const original = fs.readFileSync(cfgPath, "utf-8");
    fs.writeFileSync(cfgPath, fs.readFileSync(tmpPath, "utf-8"));
    try {
      loadConfig(); // throws if invalid
    } finally {
      fs.writeFileSync(cfgPath, original);
    }
  } finally {
    try { fs.unlinkSync(tmpPath); } catch {}
  }

  // write for real
  cfg[keys[0]] = copy[keys[0]];
  // reload full config from copy (in case top-level keys changed)
  fs.writeFileSync(cfgPath, JSON.stringify(copy, null, 2));
  return parsedValue;
}

module.exports = { HARD_CAPS, loadConfig, getConfigView, setConfigValue };
