const { loadConfig } = require("./config");
const { scan } = require("./tools/screening");

const cfg = loadConfig();

if (process.argv.includes("scan")) {
  scan(cfg).then((result) => {
    process.exit(0);
  }).catch((err) => {
    console.error("scan error:", err.message);
    process.exit(1);
  });
} else {
  console.log("darkpools-trader | mode:", cfg.mode);
  process.exit(0);
}
