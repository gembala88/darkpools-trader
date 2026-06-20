const fs = require("fs");
const path = require("path");
const config = require("../config");

const cfgPath = path.resolve(__dirname, "..", "user-config.json");

if (!fs.existsSync(cfgPath)) {
  console.error("ERROR: user-config.json not found. Create it from user-config.example.json first.");
  process.exit(1);
}

const keyPath = process.argv[2];
const rawValue = process.argv[3];

if (!keyPath || rawValue == null) {
  console.error("Usage: node scripts/setconfig.js <key.path> <value>");
  process.exit(1);
}

// dangerous keys require CONFIRM=1
const dangerous = ["mode", "confirmLiveTrading"];
if (dangerous.includes(keyPath) && !process.env.CONFIRM) {
  console.error([
    "",
    "  ⚠️  DANGEROUS CHANGE",
    `  You are about to change "${keyPath}" — this may enable LIVE trading.`,
    "  If you are sure, re-run with:",
    `    CONFIRM=1 npm run set ${keyPath} ${rawValue}`,
    "",
  ].join("\n"));
  process.exit(1);
}

try {
  const result = config.setConfigValueUnsafeServer(keyPath, rawValue);
  console.log(`✓ set ${keyPath} = ${JSON.stringify(result.parsedValue)} (was ${JSON.stringify(result.oldValue)}); backup at user-config.json.bak`);
} catch (err) {
  console.error(`ERROR: ${err.message}`);
  console.error("Nothing was written. Fix the value and try again.");
  process.exit(1);
}
