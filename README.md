# darkpools-trader

Solana trading bot — profit from price increases, separate from LP project.

## SAFETY

- **Default mode: `dry_run`** — no real funds are ever moved without deliberate config changes.
- **Live requires two-factor config:** `mode: "live"` **AND** `confirmLiveTrading: true`.
- **Hard caps (enforced at startup — cannot be overridden):**
  - Max 0.05 SOL per position
  - Max 1 concurrent position
  - Stop loss no looser than -15%
  - Daily loss limit, cooldown, and max-trades-per-day are all required
  - Degen mode requires explicit acknowledgment (`acknowledgeDegenRisk: true`)
- **Never commit .env or \*.sqlite files.** Never paste API keys in chat or commit them.
- **Signal server** is consumed via the owner's API key (legitimate). Charon code is NOT copied — used only as a pattern reference.

## Config map

| Layer | File | Contents |
|-------|------|----------|
| Secrets & endpoints | `.env` (excluded from git) | API keys, RPC URLs, DB path, wallet key |
| Strategy & risk tuning | `user-config.json` (committed) | Position size, limits, LLM settings, filters, sources |
| Immutable safety limits | `config.js` — `HARD_CAPS` | Enforced minimums/maximums; user-config must be stricter |

## Notes on merged config

- **positionSizeSol:** ONE field only. Consolidates the old BUY_AMOUNT_SOL / DEFAULT_BUY_SOL / POSITION_SIZE_SOL (which were 3 fields for the same thing). 0.05 is the agreed size; 0.02 is also fine (smaller = safer) but never above 0.05.
- **maxConcurrentPositions=1** for MVP (old setup had 2).
- **trending.allowDegen=false** and **minVolumeUsd** raised from 50 to 20000 for MVP safety.
- **dailyLossLimit / cooldown / maxTradesPerDay** were MISSING in the old .env — added.
- **maxBundlePct + maxInsiderConcentrationPct:** anti-rug filters inspired by ponyin.id concepts (bundle / cabal-insider detection).
- **model:** single editable string in user-config. Alternative on NVIDIA NIM: a MiniMax M2.7 model (stronger reasoning, but higher latency & messier output — verify exact model id at build.nvidia.com and watch anti-code-chatter). Keep Llama 3.3 70B for MVP.

## Build phases

| Phase | Area | Status |
|-------|------|--------|
| 1 | Scaffold + safety config + merged env | ✅ Done |
| 2 | Signal sources + shared safety filter + key pool LLM | ✅ Done |
| 3 | Indicators + pluggable strategy (Trend Following MVP) | ✅ Done |
| 4 | LLM decision layer + agent loop | ✅ Done |
| 5 | Dry-run execution sim + mechanical exits + honest costs & PnL | ✅ Done |
| 6 | Risk manager (daily loss, cooldown, kill switch) | |
| 7 | Trade memory (dry/live strictly separate) | |
| 8 | Telegram notifications | |
| 9 | Production hardening, PM2, monitoring | |
