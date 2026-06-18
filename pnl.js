require("dotenv").config();
const j = require("./tools/signals/jupiter");
const positions = require("./data/dry-run-positions.json");
const p = positions[0];
if (!p) { console.log("no open position"); process.exit(); }
j.getUsdPrice(p.mint).then((now) => {
  const pnlPct = ((now - p.entryPriceEffective) / p.entryPriceEffective) * 100;
  const held = ((Date.now() - p.entryTime) / 3600000).toFixed(1);
  const sign = pnlPct >= 0 ? "+" : "";
  console.log(p.symbol + ": entry $" + p.entryPriceEffective.toFixed(8)
    + " | now $" + now.toFixed(8)
    + " | unrealized " + sign + pnlPct.toFixed(2) + "% (before exit cost)"
    + " | hold " + held + "h");
});
