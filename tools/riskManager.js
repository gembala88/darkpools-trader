const fs = require("fs");
const path = require("path");

const STATE_FILE = path.resolve(__dirname, "..", "data", "risk-state.json");

function _defaultState() {
  return {
    dayKey: null,
    tradesToday: 0,
    realizedPnlTodaySol: 0,
    yesterdayPnlSol: 0,
    lastTradeTime: 0,
    consecutiveLosses: 0,
    loseStreakUntil: 0,
    killSwitch: false,
  };
}

function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf-8");
    const data = JSON.parse(raw);
    return { ..._defaultState(), ...data };
  } catch {
    return _defaultState();
  }
}

function saveState(state) {
  const dir = path.dirname(STATE_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function _getDayKey(config) {
  const now = new Date();
  const tz = config.dayBoundary;
  if (!tz || tz === "utc") {
    return `${now.getUTCFullYear()}-${now.getUTCMonth() + 1}-${now.getUTCDate()}`;
  }
  if (tz === "local") {
    return `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
  }
  // IANA timezone (e.g. Asia/Jakarta)
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  const day = parts.find((p) => p.type === "day")?.value;
  return `${year}-${month}-${day}`;
}

function rolloverIfNewDay(state, config) {
  const newKey = _getDayKey(config);
  if (state.dayKey !== newKey) {
    state.yesterdayPnlSol = state.realizedPnlTodaySol;
    state.dayKey = newKey;
    state.tradesToday = 0;
    state.realizedPnlTodaySol = 0;
    // killSwitch and loseStreak/cooldown PERSIST across days
    saveState(state);
  }
}

function canOpenNewPosition(state, config) {
  const now = Date.now();

  // 1) kill switch
  if (state.killSwitch) {
    return { allowed: false, reason: "kill switch active" };
  }

  // 2) daily loss limit
  const limitSol = config.accountSizeSol * Math.abs(config.dailyLossLimitPct) / 100;
  if (state.realizedPnlTodaySol <= -limitSol) {
    return { allowed: false, reason: `daily loss limit hit (${state.realizedPnlTodaySol.toFixed(4)} SOL <= -${limitSol} SOL)` };
  }

  // 3) lose-streak cooldown
  if (state.loseStreakUntil && now < state.loseStreakUntil) {
    const leftMs = state.loseStreakUntil - now;
    const leftMin = Math.ceil(leftMs / 60000);
    return { allowed: false, reason: `lose-streak cooldown (${leftMin}m left)` };
  }

  // 4) per-trade cooldown
  if (state.lastTradeTime > 0) {
    const elapsed = now - state.lastTradeTime;
    const cooldownMs = config.cooldownMinutesBetweenTrades * 60000;
    if (elapsed < cooldownMs) {
      const leftMs = cooldownMs - elapsed;
      const leftSec = Math.ceil(leftMs / 1000);
      return { allowed: false, reason: `cooldown active (${leftSec}s left)` };
    }
  }

  // 5) max trades per day (0 = unlimited)
  if (config.maxTradesPerDay > 0 && state.tradesToday >= config.maxTradesPerDay) {
    return { allowed: false, reason: `max trades/day (${state.tradesToday} >= ${config.maxTradesPerDay})` };
  }

  return { allowed: true, reason: "ok" };
}

function recordTradeOpened(state) {
  state.tradesToday++;
  state.lastTradeTime = Date.now();
  saveState(state);
}

function recordTradeClosed(state, pnlSol, isFullClose, config) {
  state.realizedPnlTodaySol += pnlSol;

  if (isFullClose) {
    if (pnlSol < 0) {
      state.consecutiveLosses++;
    } else {
      state.consecutiveLosses = 0;
    }

    if (state.consecutiveLosses >= (config.loseStreak?.threshold || 5)) {
      state.loseStreakUntil = Date.now() + (config.loseStreak?.cooldownMinutes || 60) * 60000;
      state.consecutiveLosses = 0; // reset counter so it re-arms
      console.log(`Lose streak of ${config.loseStreak?.threshold} triggered — cooldown until ${new Date(state.loseStreakUntil).toISOString()}`);
    }
  }

  saveState(state);
}

function setKillSwitch(on) {
  const state = loadState();
  state.killSwitch = on;
  saveState(state);
  console.log(`KILL SWITCH ${on ? "ON" : "OFF"} — ${on ? "no new entries" : "entries allowed"}`);
}

// ---- self-test ----
if (require.main === module && process.argv.includes("--test")) {
  const config = {
    accountSizeSol: 1.0,
    dayBoundary: "utc",
    dailyLossLimitPct: -15,
    cooldownMinutesBetweenTrades: 10,
    maxTradesPerDay: 0,
    loseStreak: { threshold: 5, cooldownMinutes: 60 },
  };

  let failures = 0;
  function assert(label, condition) {
    if (condition) {
      console.log(`PASS  ${label}`);
    } else {
      console.log(`FAIL  ${label}`);
      failures++;
    }
  }

  // cleanup before test
  saveState(_defaultState());
  let state = loadState();

  // 1. Fresh state -> allowed
  assert("fresh state: allowed", canOpenNewPosition(state, config).allowed);

  // 2. Daily loss limit
  state.realizedPnlTodaySol = -0.16; // accountSizeSol=1.0, 15% = 0.15
  assert("daily loss limit: denied when -0.16 < -0.15", !canOpenNewPosition(state, config).allowed);
  assert("daily loss limit: reason mentions 'daily loss limit'", canOpenNewPosition(state, config).reason.includes("daily loss limit"));
  state.realizedPnlTodaySol = -0.14; // back under
  assert("daily loss limit: allowed when -0.14 > -0.15", canOpenNewPosition(state, config).allowed);

  // 3. Per-trade cooldown
  state.lastTradeTime = Date.now();
  state.realizedPnlTodaySol = 0;
  assert("cooldown: denied immediately after trade", !canOpenNewPosition(state, config).allowed);
  assert("cooldown: reason mentions 'cooldown'", canOpenNewPosition(state, config).reason.includes("cooldown"));
  state.lastTradeTime = Date.now() - 11 * 60000; // 11 min ago > 10 min cooldown
  assert("cooldown: allowed after cooldown passes", canOpenNewPosition(state, config).allowed);

  // 4. Lose-streak: 5 consecutive losses
  state.lastTradeTime = 0;
  for (let i = 0; i < 5; i++) {
    recordTradeClosed(state, -0.01, true, config);
  }
  assert("lose-streak: loseStreakUntil set after 5 losses", state.loseStreakUntil > 0);
  assert("lose-streak: denied during cooldown", !canOpenNewPosition(state, config).allowed);
  assert("lose-streak: reason mentions 'lose-streak'", canOpenNewPosition(state, config).reason.includes("lose-streak"));
  // fast-forward past cooldown
  state.loseStreakUntil = 0;
  assert("lose-streak: allowed after cooldown expires", canOpenNewPosition(state, config).allowed);
  // winning close resets counter
  state.consecutiveLosses = 4;
  recordTradeClosed(state, 0.01, true, config);
  assert("lose-streak: win resets consecutiveLosses to 0", state.consecutiveLosses === 0);

  // 5. maxTradesPerDay=0 -> unlimited
  state = loadState();
  state.tradesToday = 999;
  assert("maxPerDay=0: never blocks on count", canOpenNewPosition(state, config).allowed);

  // 6. maxTradesPerDay=3 -> blocks after 3
  const configLimited = { ...config, maxTradesPerDay: 3 };
  state.tradesToday = 3;
  assert("maxPerDay=3: blocks at 3", !canOpenNewPosition(state, configLimited).allowed);
  assert("maxPerDay=3: reason mentions 'max trades/day'", canOpenNewPosition(state, configLimited).reason.includes("max trades/day"));
  state.tradesToday = 2;
  assert("maxPerDay=3: allowed at 2", canOpenNewPosition(state, configLimited).allowed);

  // 7. Kill switch
  state = loadState();
  state.killSwitch = true;
  assert("killSwitch: denied when true", !canOpenNewPosition(state, config).allowed);
  assert("killSwitch: reason mentions 'kill switch'", canOpenNewPosition(state, config).reason.includes("kill switch"));
  state.killSwitch = false;
  assert("killSwitch: allowed when false", canOpenNewPosition(state, config).allowed);

  // 8. Rollover
  state = loadState();
  state.tradesToday = 5;
  state.realizedPnlTodaySol = -0.5;
  state.killSwitch = true;
  state.loseStreakUntil = 999999;
  rolloverIfNewDay(state, config);
  // Since dayKey changes (probably), tradesToday and PnL reset
  // but killSwitch and loseStreakUntil persist
  // We can't guarantee dayKey changes in test, but we can force it
  const oldKey = state.dayKey;
  state.dayKey = "force-new-day-9999";
  rolloverIfNewDay(state, config);
  // The forced oldKey vs the computed new key will trigger reset
  // Reset back properly
  saveState(_defaultState());
  state = loadState();
  state.tradesToday = 5;
  state.realizedPnlTodaySol = -0.5;
  state.killSwitch = true;
  state.loseStreakUntil = 999999;
  state.dayKey = "old-day";
  saveState(state);
  state = loadState();
  rolloverIfNewDay(state, config);
  // dayKey should have changed from "old-day"
  assert("rollover: tradesToday reset to 0 after new day", state.tradesToday === 0);
  assert("rollover: realizedPnlTodaySol reset to 0", state.realizedPnlTodaySol === 0);
  assert("rollover: killSwitch persists across days", state.killSwitch === true);
  assert("rollover: loseStreakUntil persists across days", state.loseStreakUntil === 999999);

  // cleanup
  saveState(_defaultState());

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
  process.exit(failures > 0 ? 1 : 0);
}

module.exports = {
  loadState,
  saveState,
  rolloverIfNewDay,
  canOpenNewPosition,
  recordTradeOpened,
  recordTradeClosed,
  setKillSwitch,
};
