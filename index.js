const { loadConfig } = require("./config");

const cfg = loadConfig();
console.log("darkpools-trader | mode:", cfg.mode);
process.exit(0);
