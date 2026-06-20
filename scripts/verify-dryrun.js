require("dotenv").config();
const path = require("path");
const fs = require("fs");

const ROOT = path.resolve(__dirname, "..");
let passes = 0;
let warns = 0;
let fails = 0;

function pass(label) { passes++; console.log(`  PASS  ${label}`); }
function warn(label, detail) { warns++; console.log(`  WARN  ${label}${detail ? " — " + detail : ""}`); }
function fail(label, detail) { fails++; console.log(`  FAIL  ${label}${detail ? " — " + detail : ""}`); }

function section(title) {
  console.log(`\n${"═".repeat(50)}`);
  console.log(`  ${title}`);
  console.log(`${"=".repeat(50)}`);
}

let exitCode = 0;

(async () => {
  section("1. CONFIG LOAD");
  let cfg;
  try {
    const cfgMod = require(path.join(ROOT, "config"));
    cfg = cfgMod.loadConfig();
    pass(`loadConfig() — mode=${cfg.mode}`);
    if (cfg.mode !== "dry_run") {
      fail(`mode must be dry_run for verification (got ${cfg.mode})`);
    }
  } catch (err) {
    fail("loadConfig() threw", err.message);
    process.exit(1);
  }

  section("2. MODULE LOADING");
  const deps = [
    "config.js",
    "llm.js",
    "agent.js",
    "db.js",
    "tools/screening.js",
    "tools/execution.js",
    "tools/positions.js",
    "tools/riskManager.js",
    "tools/reporter.js",
    "tools/telegram.js",
    "tools/signals/index.js",
    "tools/signals/dexscreener.js",
    "tools/signals/jupiter.js",
    "tools/signals/gmgn.js",
    "tools/signals/geckoterminalTrending.js",
    "tools/signals/candles.js",
    "tools/filters/safety.js",
    "tools/filters/regime.js",
    "strategies/index.js",
  ];
  for (const dep of deps) {
    try {
      require(path.join(ROOT, dep));
      pass(`require(${dep})`);
    } catch (err) {
      fail(`require(${dep})`, err.message);
    }
  }

  section("3. UNIT TESTS");
  const tests = [
    { name: "indicators:test", cmd: `node tools/indicators.js --test` },
    { name: "sim:test", cmd: `node tools/positions.js --test` },
    { name: "risk:test", cmd: `node tools/riskManager.js --test` },
    { name: "report:test", cmd: `node tools/reporter.js --test` },
  ];
  for (const t of tests) {
    try {
      const cp = require("child_process");
      const out = cp.execSync(t.cmd, { cwd: ROOT, encoding: "utf-8", timeout: 30000 });
      const failLines = (out.match(/FAIL/g) || []).length;
      if (failLines === 0) {
        pass(`${t.name} — all pass`);
      } else {
        fail(`${t.name} — ${failLines} failure(s)`);
      }
    } catch (err) {
      fail(`${t.name} threw`, err.message.split("\n")[0]);
    }
  }

  section("4. SCAN (real API, dry_run mode)");
  try {
    const { scan } = require(path.join(ROOT, "tools/screening"));
    const start = Date.now();
    const result = await scan(cfg);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    pass(`scan() completed in ${elapsed}s`);
    console.log(`       scanned=${result.scannedCount} safe=${result.safeCount} ranked=${result.ranked.length}`);
    if (result.ranked.length > 0) {
      const top = result.ranked[0];
      console.log(`       top: ${top.symbol} score=${top.score} timing=${top.timing?.signal || "?"}`);
    }
  } catch (err) {
    fail("scan() threw", err.message);
  }

  section("5. POSITION LIFECYCLE (dry_run)");
  const positions = require(path.join(ROOT, "tools/positions"));
  const riskManager = require(path.join(ROOT, "tools/riskManager"));
  const jupiter = require(path.join(ROOT, "tools/signals/jupiter"));

  // clean up any previous test positions
  const testMint = "DRYRUN_VERIFY_11111111111111111111111111111111";
  const existing = positions.loadOpenPositions().filter(p => p.mint === testMint);
  for (const p of existing) {
    p.status = "closed";
    positions.savePosition(p);
  }

  try {
    const candidate = { mint: testMint, symbol: "DRYTEST", pairAddress: null, timing: null, feeConfirm: null };
    const entryPrice = await jupiter.getUsdPrice("So11111111111111111111111111111111111111112");
    if (entryPrice == null) {
      warn("entry price (SOL) not available", "using mock 100.0");
    }
    const price = entryPrice || 100.0;
    const pos = await positions.openPosition(candidate, price, cfg);
    if (pos && pos.status === "open") {
      pass(`openPosition() — ${pos.symbol} @ $${price}`);
    } else {
      fail("openPosition() returned null or not open");
    }

    // evaluate exit (SL)
    const slPrice = price * 0.85; // 15% below entry — triggers SL at -8%
    const slReason = positions.evaluateExit(pos, slPrice, null, cfg);
    if (slReason && slReason.type === "SL") {
      pass(`evaluateExit() — SL triggered at $${slPrice}`);
    } else {
      fail("evaluateExit() — SL not triggered", JSON.stringify(slReason));
    }

    // partial close
    const exitResult = await positions.partialClose(pos, 100, slReason, slPrice, cfg);
    if (exitResult && exitResult.pnlSol != null) {
      pass(`partialClose() — pnl=${exitResult.pnlSol.toFixed(6)} SOL`);
    } else {
      fail("partialClose() returned null/empty");
    }

    // cleanup test position
    pos.status = "closed";
    positions.savePosition(pos);
    pass("position cleanup OK");
  } catch (err) {
    fail("position lifecycle", err.message);
  }

  section("6. TELEGRAM (if configured)");
  const telegram = require(path.join(ROOT, "tools/telegram"));
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (botToken && chatId) {
    telegram.init(cfg);
    try {
      const result = await telegram.send(
        "<b>🧪 Dry-run verification</b>\n" +
        "If you see this, Telegram notifications work correctly."
      );
      if (result && result.dm) {
        pass(`Telegram DM sent (message_id=${result.dm})`);
      } else {
        warn("Telegram send returned no DM result");
      }
    } catch (err) {
      warn("Telegram send threw", err.message);
    }
  } else {
    warn("Telegram not configured", "set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID");
  }

  section("7. SYNTAX CHECK (all .js files)");
  try {
    const cp = require("child_process");
    function getAllJsFiles(dir) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const files = [];
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory() && !e.name.startsWith("node_modules") && !e.name.startsWith(".")) {
          files.push(...getAllJsFiles(full));
        } else if (e.isFile() && e.name.endsWith(".js") && !e.name.endsWith(".test.js")) {
          files.push(full);
        }
      }
      return files;
    }
    const allJs = getAllJsFiles(ROOT);
    let ok = 0;
    let bad = 0;
    for (const f of allJs) {
      try {
        cp.execSync(`node --check "${f}"`, { encoding: "utf-8", timeout: 10000 });
        ok++;
      } catch (err) {
        bad++;
        fail(`syntax error in ${path.relative(ROOT, f)}`, err.stderr?.split("\n")[0] || "");
      }
    }
    if (ok > 0) pass(`${ok}/${ok + bad} .js files pass syntax check`);
  } catch (err) {
    warn("Syntax check walk failed", err.message);
  }

  // ── SUMMARY ──
  console.log(`\n${"═".repeat(50)}`);
  console.log(`  DRY-RUN VERIFICATION COMPLETE`);
  console.log(`  ${passes} pass · ${warns} warn · ${fails} fail`);
  console.log(`${"═".repeat(50)}`);
  console.log("");
  console.log("  NEXT STEPS:");
  if (fails > 0) {
    console.log("  ❌ Fix failures before switching modes.");
    process.exit(1);
  } else {
    console.log("  ✅ All checks pass. Ready for production.");
    console.log("    1. Set TRADING_MODE=confirm in .env");
    console.log("    2. Run: npm run bot");
    console.log("    3. Verify Telegram confirms each action");
    console.log("    4. Set TRADING_MODE=live when confident");
  }
  console.log("");
  process.exit(0);
})();
