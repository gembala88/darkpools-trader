const trendFollowing = require("./trendFollowing");

const registry = {
  trendFollowing,
};

function getActiveStrategy(config) {
  const active = config.strategy.active;
  const impl = registry[active];
  if (!impl) {
    throw new Error(`Unknown strategy "${active}"`);
  }
  return impl;
}

module.exports = { registry, getActiveStrategy };
