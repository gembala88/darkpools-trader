const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
let passes = 0;
let warns = 0;
let fails = 0;

function pass(label) { passes++; console.log(`  PASS  ${label}`); }
function warn(label, detail) { warns++; console.log(`  WARN  ${label}${detail ? ` — ${detail}` : ""}`); }
function fail(label, detail) { fails++; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }

function section(title) {
  console.log(`\n───── ${title} ─────`);
}

// ── 1. CONFIG ──
section("1. CONFIG");
try {
  const { loadConfig, HARD_CAPS } = require(path.join(ROOT, "config"));
  const cfg = loadConfig();
  pass("loadConfig() succeeded");
  console.log(`       mode=${cfg.mode} | accountSize=${cfg.accountSizeSol} SOL | positionSize=${cfg.positionSizeSol} SOL`);
  console.log(`       TP=${cfg.takeProfitPct}% / SL=${cfg.stopLossPct}% | trailing=${cfg.trailingEnabled} | maxHold=${cfg.maxHoldHours}h`);
  console.log(`       telegram=${cfg.telegramEnabled} | dayBoundary=${cfg.dayBoundary}`);
  console.log(`       sources: dexscreener=${cfg.sources?.dexscreener?.enabled} gmgn=${cfg.sources?.gmgn?.enabled} geckoterminalTrending=${cfg.sources?.geckoterminalTrending?.enabled} signalServer=${cfg.sources?.signalServer?.enabled}`);
} catch (err) {
  fail("loadConfig() threw", err.message);
}

// ── 2. MODULE LOADING ──
section("2. MODULE LOADING");
const modules = [
  { path: "config.js", exports: ["HARD_CAPS", "loadConfig", "getConfigView", "setConfigValue"] },
  { path: "llm.js", exports: ["chat", "poolInfo"] },
  { path: "prompt.js", exports: ["buildSystemPrompt", "buildUserPrompt"] },
  { path: "agent.js", exports: ["decide"] },
  { path: "db.js", exports: [] },
  { path: "tools/screening.js", exports: ["scan"] },
  { path: "tools/execution.js", exports: [] },
  { path: "tools/positions.js", exports: ["loadOpenPositions", "openPosition", "evaluateExit", "partialClose", "closeRemaining"] },
  { path: "tools/riskManager.js", exports: ["loadState", "canOpenNewPosition", "recordTradeOpened", "recordTradeClosed", "setKillSwitch", "rolloverIfNewDay"] },
  { path: "tools/indicators.js", exports: ["ema", "sma", "rsi", "atr"] },
  { path: "tools/reporter.js", exports: ["buildReport", "formatLines", "loadAllPositions"] },
  { path: "tools/telegram.js", exports: ["init", "send", "pin", "unpin", "pollCommands", "notifyStart", "notifyError", "notifyEntry", "notifyExit", "notifyDailySummary", "checkDailyRollover"] },
  { path: "tools/signals/index.js", exports: ["getCandidates"] },
  { path: "tools/signals/dexscreener.js", exports: ["fetchTrending"] },
  { path: "tools/signals/jupiter.js", exports: ["enrichPrices"] },
  { path: "tools/signals/gmgn.js", exports: ["fetchTrending"] },
  { path: "tools/signals/geckoterminalTrending.js", exports: ["fetchTrending"] },
  { path: "tools/signals/signalServer.js", exports: ["fetchCandidates"] },
  { path: "tools/signals/holders.js", exports: ["getTopHolderPct", "clearCache"] },
  { path: "tools/signals/candles.js", exports: ["getCandles", "clearCache"] },
  { path: "tools/filters/safety.js", exports: ["applySafetyFilter"] },
  { path: "tools/filters/regime.js", exports: ["assessRegime"] },
  { path: "strategies/index.js", exports: ["registry", "getActiveStrategy"] },
  { path: "strategies/trendFollowing.js", exports: ["evaluate"] },
];

for (const mod of modules) {
  const fullPath = path.join(ROOT, mod.path);
  try {
    const loaded = require(fullPath);
    const missing = mod.exports.filter((k) => loaded[k] === undefined);
    if (missing.length === 0) {
      pass(`require(${mod.path}) — all exports present`);
    } else {
      fail(`require(${mod.path}) — missing exports: ${missing.join(", ")}`);
    }
  } catch (err) {
    fail(`require(${mod.path}) threw`, err.message);
  }
}

// ── 3. UNIT TESTS ──
section("3. UNIT TESTS");
const testSuites = [
  { name: "indicators:test", cmd: "node tools/indicators.js --test" },
  { name: "sim:test", cmd: "node tools/positions.js --test" },
  { name: "risk:test", cmd: "node tools/riskManager.js --test" },
  { name: "report:test", cmd: "node tools/reporter.js --test" },
];

for (const suite of testSuites) {
  try {
    const out = execSync(suite.cmd, { cwd: ROOT, encoding: "utf-8", timeout: 30000 });
    const passLines = (out.match(/PASS/g) || []).length;
    const failLines = (out.match(/FAIL/g) || []).length;
    if (failLines === 0) {
      pass(`${suite.name} — ${passLines}/${passLines} pass`);
    } else {
      fail(`${suite.name} — ${passLines} pass, ${failLines} FAIL`);
    }
  } catch (err) {
    fail(`${suite.name} threw or timed out`, err.message.split("\n")[0]);
  }
}

// ── 4. SAFETY INVARIANTS ──
section("4. SAFETY INVARIANTS");

// 4a. HARD_CAPS present and DEFAULT_MODE === dry_run
try {
  const { HARD_CAPS } = require(path.join(ROOT, "config"));
  if (HARD_CAPS && HARD_CAPS.DEFAULT_MODE === "dry_run") {
    pass("HARD_CAPS present and DEFAULT_MODE=dry_run");
  } else {
    fail("HARD_CAPS.DEFAULT_MODE is not dry_run");
  }
} catch (err) {
  fail("Could not load HARD_CAPS", err.message);
}

// 4b. config:set on blocked key is rejected
try {
  const { setConfigValue } = require(path.join(ROOT, "config"));
  setConfigValue("sources.signalServer.enabled", true);
  fail("config:set on signalServer.enabled was NOT rejected (should be blocked)");
} catch (err) {
  if (err.message.includes("blocked")) {
    pass("config:set on blocked key rejected — signalServer.enabled not settable from Telegram");
  } else {
    fail("config:set on blocked key threw unexpected error", err.message);
  }
}

// 4c. signalServer (Charon) must stay disabled; gmgn may be on as read-only data
try {
  const cfg = require(path.join(ROOT, "config")).loadConfig();
  if (cfg.sources?.signalServer?.enabled === true) {
    fail("signalServer (Charon) must stay disabled", `signalServer.enabled=${cfg.sources.signalServer.enabled}`);
  } else {
    pass("signalServer (Charon) disabled");
  }
  if (cfg.sources?.gmgn?.enabled === true) {
    console.log("       gmgn enabled (read-only data source)");
  }
} catch (err) {
  fail("Could not verify source defaults", err.message);
}

// 4d. .env is gitignored
try {
  const gitignore = fs.readFileSync(path.join(ROOT, ".gitignore"), "utf-8");
  if (gitignore.includes(".env")) {
    pass(".env is gitignored");
  } else {
    fail(".env NOT found in .gitignore");
  }
} catch (err) {
  fail("Could not read .gitignore", err.message);
}

// ── 5. DATA FILES ──
section("5. DATA FILES");

const dryRunFile = path.join(ROOT, "data", "dry-run-positions.json");
const liveFile = path.join(ROOT, "data", "live-positions.json");

try {
  const raw = fs.readFileSync(dryRunFile, "utf-8");
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) {
    pass(`dry-run-positions.json readable (${parsed.length} entries)`);
  } else {
    pass("dry-run-positions.json readable (non-array — empty state)");
  }
} catch (err) {
  if (err.code === "ENOENT") {
    pass("dry-run-positions.json absent (no trades yet — ok)");
  } else {
    warn("dry-run-positions.json exists but unreadable", err.message);
  }
}

if (fs.existsSync(liveFile)) {
  fail("live-positions.json MUST NOT exist (dry-run only)");
} else {
  pass("live-positions.json absent (no live data)");
}

// ── 6. EXTERNAL DEPS (WARN only) ──
section("6. EXTERNAL DEPS (network)");
(async () => {
  const axios = require("axios");

  // DexScreener
  try {
    const r = await axios.get("https://api.dexscreener.com/token-boosts/top/v1", { timeout: 8000 });
    if (r.status === 200) pass("DexScreener reachable (token-boosts top)");
    else warn("DexScreener responded", `HTTP ${r.status}`);
  } catch (err) {
    warn("DexScreener unreachable", err.message);
  }

  // GeckoTerminal
  try {
    const r = await axios.get("https://api.geckoterminal.com/api/v2/networks/solana/trending_pools", { timeout: 8000 });
    if (r.status === 200) pass("GeckoTerminal reachable (trending pools)");
    else warn("GeckoTerminal responded", `HTTP ${r.status}`);
  } catch (err) {
    warn("GeckoTerminal unreachable", err.message);
  }

  // Helius (warn only — needs RPC key)
  const rpcUrl = process.env.SOLANA_RPC_URL;
  if (rpcUrl) {
    try {
      const r = await axios.post(rpcUrl, { jsonrpc: "2.0", id: 1, method: "getHealth" }, { timeout: 8000 });
      if (r.data?.result) pass("Helius RPC reachable (getHealth OK)");
      else warn("Helius RPC responded unexpectedly", JSON.stringify(r.data));
    } catch (err) {
      warn("Helius RPC unreachable", err.message);
    }
  } else {
    warn("Helius RPC — SOLANA_RPC_URL not set, skipping");
  }

  // ── 7. STATIC SANITY ──
  section("7. STATIC SANITY (node --check)");

  function getAllJsFiles(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const files = [];
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory() && !e.name.startsWith("node_modules") && !e.name.startsWith(".")) {
        files.push(...getAllJsFiles(full));
      } else if (e.isFile() && e.name.endsWith(".js")) {
        files.push(full);
      }
    }
    return files;
  }

  const allJs = getAllJsFiles(ROOT);
  let syntaxOk = 0;
  let syntaxFail = 0;
  for (const f of allJs) {
    try {
      execSync(`node --check "${f}"`, { encoding: "utf-8", timeout: 10000 });
      syntaxOk++;
    } catch (err) {
      syntaxFail++;
      fail(`syntax error in ${path.relative(ROOT, f)}`, err.stderr?.split("\n")[0] || err.message);
    }
  }
  if (syntaxOk > 0) pass(`${syntaxOk} .js files pass node --check`);
  if (syntaxFail === 0 && syntaxOk > 0) {
    // already passed above
  }

  // ── SUMMARY ──
  console.log(`\n═══════════════════════════════════════`);
  console.log(`  CODE INTEGRITY: ${passes} pass / ${warns} warn / ${fails} fail`);
  console.log(`  NOTE: this checks code health only, NOT strategy profitability.`);
  console.log(`  A passing system can still lose money.`);
  console.log(`═══════════════════════════════════════\n`);
  process.exit(fails > 0 ? 1 : 0);
})();
