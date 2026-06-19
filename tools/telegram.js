const axios = require("axios");
const riskManager = require("./riskManager");

let _config = null;
let _token = null;
let _chatId = null;
let _channelId = null;
let _topicId = null;
let _offset = 0;
let _lastPinnedMsgId = null;
let _prevDayKey = null;

function init(config) {
  _config = config;
  _token = process.env.TELEGRAM_BOT_TOKEN || "";
  _chatId = process.env.TELEGRAM_CHAT_ID || "";
  _channelId = process.env.TELEGRAM_CHANNEL_ID || "";
  _topicId = process.env.TELEGRAM_TOPIC_ID || "";
}

function _isEnabled() {
  return _config && _config.telegramEnabled && _token && _chatId;
}

async function _call(method, payload) {
  if (!_isEnabled()) return null;
  try {
    const url = `https://api.telegram.org/bot${_token}/${method}`;
    const res = await axios.post(url, payload, { timeout: 10000 });
    return res.data;
  } catch (err) {
    const msg = err.response?.data?.description || err.message;
    console.log(`telegram ${method}: ${msg}`);
    return null;
  }
}

async function send(text, opts) {
  if (!_isEnabled()) return null;
  const result = { dm: null, channel: null };

  const dm = await _call("sendMessage", {
    chat_id: _chatId,
    text,
    parse_mode: "HTML",
    ...(opts || {}),
  });
  if (dm?.result) result.dm = dm.result.message_id;

  if (_config.telegram?.mirrorToChannel && _channelId) {
    const channelPayload = {
      chat_id: _channelId,
      text,
      parse_mode: "HTML",
    };
    if (_topicId) {
      channelPayload.message_thread_id = parseInt(_topicId, 10);
    }
    const ch = await _call("sendMessage", channelPayload);
    if (ch?.result) result.channel = ch.result.message_id;
  }

  return result;
}

async function pin(chatId, messageId) {
  if (!_isEnabled()) return;
  // unpin previous
  if (_lastPinnedMsgId) {
    await unpin(chatId, _lastPinnedMsgId);
  }
  await _call("pinChatMessage", {
    chat_id: chatId,
    message_id: messageId,
  });
  _lastPinnedMsgId = messageId;
}

async function unpin(chatId, messageId) {
  await _call("unpinChatMessage", {
    chat_id: chatId,
    message_id: messageId,
  });
}

async function _sendTyping(chatId) {
  await _call("sendChatAction", {
    chat_id: chatId,
    action: "typing",
  });
}

function _replyKeyboard() {
  return {
    keyboard: [
      [{ text: "📊 Status" }, { text: "📈 Report" }],
      [{ text: "🔔 Notif" }, { text: "⚙️ Config" }],
      [{ text: "⏸️ Stop" }, { text: "▶️ Resume" }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
}

// button label routing map
const _buttonRoutes = {
  "📊 status": "/status",
  "📈 report": "/report",
  "🔔 notif": "/menu",
  "⚙️ config": "/config",
  "⏸️ stop": "/stop",
  "▶️ resume": "/resume",
};

async function pollCommands() {
  if (!_isEnabled()) return;

  try {
    const url = `https://api.telegram.org/bot${_token}/getUpdates`;
    const res = await axios.get(url, {
      params: { offset: _offset, timeout: 5 },
      timeout: 10000,
    });

    const updates = res.data?.result || [];
    for (const u of updates) {
      _offset = u.update_id + 1;

      // callback_query (inline button press)
      if (u.callback_query) {
        const cq = u.callback_query;
        const chatId = cq.message?.chat?.id;
        const msgId = cq.message?.message_id;
        const data = cq.data || "";

        const authorizedChats = [_chatId, _channelId].filter(Boolean);
        if (!authorizedChats.some((c) => String(c) === chatId)) continue;

        try {
          if (data === "confirm_stop") {
            riskManager.setKillSwitch(true);
            await _call("answerCallbackQuery", {
              callback_query_id: cq.id,
              text: "⏸️ STOP confirmed — no new entries",
              show_alert: true,
            });
            await _call("editMessageText", {
              chat_id: chatId,
              message_id: msgId,
              text: "🔴 KILL SWITCH ON — no new entries",
              parse_mode: "HTML",
            });
          } else if (data.startsWith("toggle:")) {
            const key = data.replace("toggle:", "");
            const cfg = require("./config").loadConfig();
            const current = cfg.telegram?.notify?.[key];
            const newVal = current === true ? "false" : "true";
            require("./config").setConfigValue(`telegram.notify.${key}`, newVal);
            // answer callback
            await _call("answerCallbackQuery", {
              callback_query_id: cq.id,
              text: `${key} → ${newVal === "true" ? "ON" : "OFF"}`,
              show_alert: false,
            });
            // edit message to reflect new states
            const updatedCfg = require("./config").loadConfig();
            const keyboard = _menuKeyboard(updatedCfg);
            await _call("editMessageText", {
              chat_id: chatId,
              message_id: msgId,
              text: "<b>🔔 Notification Toggles</b>\nTap to toggle:",
              parse_mode: "HTML",
              reply_markup: { inline_keyboard: keyboard },
            });
          }
        } catch (err) {
          console.log("callback handler error:", err.message);
        }
        continue;
      }

      const msg = u.message;
      if (!msg || !msg.text) continue;

      // only respond to authorized chat
      const authorizedChats = [_chatId, _channelId].filter(Boolean);
      const chatIdStr = String(msg.chat.id);
      if (!authorizedChats.some((c) => String(c) === chatIdStr)) continue;

      // ignore channel posts (already handled by mirror), only process DM commands
      if (chatIdStr !== String(_chatId)) continue;

      await _sendTyping(msg.chat.id);

      // route button labels to commands
      let cmdText = msg.text.trim();
      const normalized = cmdText.toLowerCase().replace(/\ufe0f/g, ""); // strip variation-selector from emoji
      if (_buttonRoutes[normalized]) {
        cmdText = _buttonRoutes[normalized];
      }

      const reply = await _handleCommand(cmdText);
      if (reply) {
        let payload = {
          chat_id: msg.chat.id,
          text: reply.text || reply,
          parse_mode: "HTML",
          reply_to_message_id: msg.message_id,
        };
        if (reply.replyKeyboard) {
          payload.reply_markup = _replyKeyboard();
        } else if (reply.keyboard) {
          payload.reply_markup = { inline_keyboard: reply.keyboard };
        } else {
          payload.reply_markup = _replyKeyboard();
        }
        await _call("sendMessage", payload);
      }
    }
  } catch (err) {
    console.log("telegram poll error:", err.message);
  }
}

function _menuKeyboard(cfg) {
  const n = cfg?.telegram?.notify || {};
  const btn = (key, label) => ({
    text: `${label}: ${n[key] ? "✅ ON" : "⬜ OFF"}`,
    callback_data: `toggle:${key}`,
  });
  return [
    [btn("onEntry", "Entry")],
    [btn("onExit", "Exit")],
    [btn("onScreening", "Screening")],
  ];
}

async function _handleCommand(text) {
  const parts = text.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1);

  switch (cmd) {
    case "/start":
    case "/help":
      return {
        text: [
          "<b>🤖 darkpools-trader</b>",
          "Use the buttons below or type /help for commands.",
        ].join("\n"),
        replyKeyboard: true,
      };

    case "/stop":
      return {
        text: "⏸️ Confirm STOP? This halts all new entries.",
        keyboard: [[{ text: "Confirm STOP", callback_data: "confirm_stop" }]],
      };

    case "/resume":
      riskManager.setKillSwitch(false);
      return { text: "🟢 KILL SWITCH OFF — entries allowed" };

    case "/status": {
      const state = riskManager.loadState();
      const cfg = require("./config").loadConfig();
      const openPositions = require("./positions").loadOpenPositions();
      const jupiter = require("./signals/jupiter");
      const lines = [
        `<b>Status</b>`,
        `Mode: ${cfg.mode}`,
        `Kill switch: ${state.killSwitch ? "🔴 ON" : "🟢 OFF"}`,
        `Today PnL: ${state.realizedPnlTodaySol >= 0 ? "🟢" : "🔴"} ${state.realizedPnlTodaySol.toFixed(6)} SOL`,
        `Yesterday PnL: ${state.yesterdayPnlSol >= 0 ? "🟢" : "🔴"} ${(state.yesterdayPnlSol || 0).toFixed(6)} SOL`,
        `Trades today: ${state.tradesToday}`,
      ];
      if (openPositions.length > 0) {
        lines.push(`\n<b>Open positions (${openPositions.length})</b>`);
        for (const p of openPositions) {
          const held = p.entryTime ? ((Date.now() - p.entryTime) / 3600000).toFixed(1) : "?";
          let unrealized;
          try {
            const now = await jupiter.getUsdPrice(p.mint);
            unrealized = now && p.entryPriceEffective
              ? (((now - p.entryPriceEffective) / p.entryPriceEffective) * 100).toFixed(2)
              : "?";
          } catch {
            unrealized = "?";
          }
          lines.push(`${escapeHtml(p.symbol)} | entry $${(p.entryPriceEffective || 0).toFixed(8)} | ${held}h | unreal ${unrealized}%`);
        }
      }
      return { text: lines.join("\n") };
    }

    case "/menu": {
      const cfg = require("./config").loadConfig();
      return {
        text: "<b>🔔 Notification Toggles</b>\nTap to toggle:",
        keyboard: _menuKeyboard(cfg),
      };
    }

    case "/report": {
      const { loadAllPositions, buildReport } = require("./reporter");
      const positions = loadAllPositions();
      const report = buildReport(positions);
      if (report.totalClosed === 0) {
        return { text: "📊 0 closed trades yet" };
      }
      const lines = [
        `<b>📊 Trade Report</b>`,
        `Closed: ${report.totalClosed}`,
        `Win rate: ${report.winRatePct != null ? report.winRatePct.toFixed(1) + "%" : "?"}`,
        `Total PnL: ${report.totalPnlSol >= 0 ? "🟢" : "🔴"} ${report.totalPnlSol.toFixed(6)} SOL`,
        `Avg PnL: ${report.avgPnlSol != null ? report.avgPnlSol.toFixed(6) + " SOL" : "?"}`,
        `Best: ${report.biggestWinSol != null ? report.biggestWinSol.toFixed(6) + " SOL" : "?"}`,
        `Worst: ${report.biggestLossSol != null ? report.biggestLossSol.toFixed(6) + " SOL" : "?"}`,
        `Breakdown:`,
        `  SL: ${report.exitBreakdown?.SL || 0}`,
        `  TP: ${report.exitBreakdown?.partialTP || 0}`,
        `  Trailing: ${report.exitBreakdown?.trailing || 0}`,
        `  MaxHold: ${report.exitBreakdown?.maxHold || 0}`,
      ];
      return { text: lines.join("\n") };
    }

    case "/config": {
      const { getConfigView } = require("./config");
      return { text: `<pre>${getConfigView()}</pre>` };
    }

    case "/set": {
      if (args.length < 2) return { text: "Usage: /set &lt;key&gt; &lt;value&gt;" };
      const key = args[0];
      const val = args.slice(1).join(" ");
      try {
        const { setConfigValue } = require("./config");
        const result = setConfigValue(key, val);
        return { text: `<code>${key}</code> → ${JSON.stringify(result)}` };
      } catch (err) {
        return { text: `${err.message}` };
      }
    }

    default:
      return null; // unknown command, no reply
  }
}

function escapeHtml(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function _tokenLinks(mint) {
  if (!mint) return "";
  const e = escapeHtml;
  return [
    `🔗 <a href="https://gmgn.ai/sol/token/${e(mint)}">GMGN</a>`,
    `<a href="https://dexscreener.com/solana/${e(mint)}">DEX</a>`,
    `<a href="https://solscan.io/token/${e(mint)}">Solscan</a>`,
  ].join(" · ");
}

// notifications
async function notifyStart() {
  if (!_config?.telegram?.notify?.onStart) return;
  await send("🤖 darkpools-trader started (dry_run)", { reply_markup: _replyKeyboard() });
}

async function notifyError(errMsg) {
  if (!_config?.telegram?.notify?.onError) return;
  await send(`❌ ERROR: ${escapeHtml(errMsg).slice(0, 500)}`);
}

async function notifyEntry(position) {
  if (!_config?.telegram?.notify?.onEntry) return;
  const sym = escapeHtml(position.symbol || "?");
  const lines = [
    `<b>🟢 SIM BUY · ${sym}</b>`,
    `Entry: $${(position.entryPriceEffective || 0).toFixed(8)} (quoted $${(position.entryPriceQuoted || 0).toFixed(8)})`,
    `Size: ${position.sizeSol || "?"} SOL · Qty: ${(position.qtyTokens || 0).toFixed(4)}`,
  ];

  // optional metrics from candidate (attached in index.js before calling)
  const extras = [];
  const t = position._timing || {};
  if (t.rsi != null) extras.push(`RSI: ${t.rsi}`);
  if (position.liquidityUsd != null) extras.push(`Liq: $${Number(position.liquidityUsd).toLocaleString()}`);
  if (position.volume24hUsd != null) extras.push(`Vol: $${Number(position.volume24hUsd).toLocaleString()}`);
  if (position.feeConfirm?.signal && position.feeConfirm.signal !== "unknown") extras.push(`Fee: ${position.feeConfirm.signal}`);
  if (position._regime) extras.push(`Regime: ${position._regime}`);
  if (extras.length) lines.push(extras.join(" · "));

  lines.push(_tokenLinks(position.mint));
  const result = await send(lines.join("\n"));

  if (_config.telegram?.pinOnEntry && result?.dm) {
    await pin(_chatId, result.dm);
  }
}

async function notifyExit(position, exit, isFullClose) {
  if (!_config?.telegram?.notify?.onExit) return;
  const sym = escapeHtml(position.symbol || "?");
  const pnl = exit.pnlSol || 0;
  const entryEff = position.entryPriceEffective;
  const exitEff = exit.priceEffective;
  const pnlPct = entryEff && exitEff ? (((exitEff - entryEff) / entryEff) * 100).toFixed(2) : "?";
  const heldHours = position.entryTime ? ((Date.now() - position.entryTime) / 3600000).toFixed(1) : "?";

  const lines = [
    `<b>${isFullClose ? "🔴 CLOSE" : "🔶 PARTIAL"} · ${sym}</b>`,
    `${escapeHtml(exit.reason || "?")} · ${exit.pctOfPosition || "?"}% @ $${(exitEff || 0).toFixed(8)}`,
    `PnL: ${pnl >= 0 ? "🟢" : "🔴"} ${pnl.toFixed(6)} SOL (${pnlPct}%)`,
    `Held: ${heldHours}h`,
  ];

  // day PnL if risk state available
  try {
    const state = riskManager.loadState();
    if (state && state.realizedPnlTodaySol != null) {
      const d = state.realizedPnlTodaySol;
      lines.push(`Day PnL: ${d >= 0 ? "🟢" : "🔴"} ${d.toFixed(6)} SOL`);
    }
  } catch {}

  lines.push(_tokenLinks(position.mint));
  await send(lines.join("\n"));

  if (isFullClose && _lastPinnedMsgId) {
    await unpin(_chatId, _lastPinnedMsgId);
    _lastPinnedMsgId = null;
  }
}

async function notifyScreening(result, config) {
  if (!config?.telegram?.notify?.onScreening) return;
  try {
    const top = (result.ranked || []).slice(0, 3);
    const topLine = top
      .map((c) => {
        const sym = escapeHtml(c.symbol || c.mint?.slice(0, 8) || "?");
        const sig = c.timing?.signal || "?";
        const rsi = c.timing?.indicators?.rsi != null ? ` R${c.timing.indicators.rsi}` : "";
        return `${sym} ${sig}${rsi}`;
      })
      .join(" · ");
    const msg =
      `🔍 Scan: ${result.scannedCount || "?"} · Safe: ${result.safeCount || "?"}\n` +
      `Top: ${topLine || "—"}`;
    await _call("sendMessage", {
      chat_id: _chatId,
      text: msg,
      parse_mode: "HTML",
    });
  } catch (err) {
    console.log("notifyScreening error:", err.message);
  }
}

async function notifyDailySummary(state, config) {
  if (!config?.telegram?.notify?.dailySummary) return;
  const yesterday = state.yesterdayPnlSol || 0;
  const msg =
    `<b>📊 Daily Summary</b>\n` +
    `Yesterday PnL: ${yesterday >= 0 ? "🟢" : "🔴"} ${yesterday.toFixed(6)} SOL`;
  await send(msg);
}

// check for daily rollover to send summary
async function checkDailyRollover(state, config) {
  const dayKey = state.dayKey;
  if (_prevDayKey && dayKey !== _prevDayKey) {
    // day just rolled over — send yesterday's summary
    await notifyDailySummary(state, config);
  }
  _prevDayKey = dayKey;
}

// self-test
if (require.main === module && process.argv.includes("--test")) {
  const cfgPath = require("path").resolve(__dirname, "..", "user-config.json");
  const cfg = JSON.parse(require("fs").readFileSync(cfgPath, "utf-8"));
  cfg.telegramEnabled = true;
  init(cfg);
  if (!_token) {
    console.log("TELEGRAM_BOT_TOKEN not set — skipping test. Set it in .env to test.");
    process.exit(0);
  }
  (async () => {
    const result = await send(
      "<b>🧪 Telegram test message</b>\n" +
      "If you see this, telegram:test worked.\n" +
      "DM + channel (if configured) should both receive this."
    );
    if (result) {
      console.log(`DM message_id: ${result.dm}`);
      console.log(`Channel message_id: ${result.channel}`);
      console.log("Telegram test OK");
    }
    process.exit(0);
  })();
}

module.exports = {
  init,
  send,
  pin,
  unpin,
  pollCommands,
  notifyStart,
  notifyError,
  notifyEntry,
  notifyExit,
  notifyScreening,
  notifyDailySummary,
  checkDailyRollover,
};
