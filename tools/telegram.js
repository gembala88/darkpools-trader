const axios = require("axios");
const riskManager = require("./riskManager");
const config = require("../config");
const positions = require("./positions");
const reporter = require("./reporter");
const jupiter = require("./signals/jupiter");

let _config = null;
let _token = null;
let _chatId = null;
let _channelId = null;
let _topicId = null;
let _offset = 0;
let _lastPinnedMsgId = null;
let _prevDayKey = null;

// PnL auto-refresh
let _pnlMessages = {}; // { [chatId]: msgId }
let _pnlRefreshTimer = null;
const PNL_REFRESH_MS = 30000;

// settings menu state (per chat)
const _settingsState = {}; // { [chatId]: { category } }

function init(config) {
  _config = config;
  _token = process.env.TELEGRAM_BOT_TOKEN || "";
  _chatId = process.env.TELEGRAM_CHAT_ID || "";
  _channelId = process.env.TELEGRAM_CHANNEL_ID || "";
  _topicId = process.env.TELEGRAM_TOPIC_ID || "";
  _startPnlAutoRefresh();
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

// ——— PnL auto-refresh ———

function _startPnlAutoRefresh() {
  if (_pnlRefreshTimer) return;
  _pnlRefreshTimer = setInterval(async () => {
    try {
      await _autoRefreshPnls();
    } catch (e) {
      console.log("pnl auto-refresh error:", e.message);
    }
  }, PNL_REFRESH_MS);
}

async function _autoRefreshPnls() {
  const entries = Object.entries(_pnlMessages);
  if (entries.length === 0) return;
  const openPositions = positions.loadOpenPositions();
  const content = openPositions.length === 0
    ? { text: "No open positions.", keyboard: [] }
    : await _buildPnlContent(openPositions);

  for (const [chatId, msgId] of entries) {
    const payload = {
      chat_id: Number(chatId),
      message_id: msgId,
      text: content.text,
      parse_mode: "HTML",
    };
    if (content.keyboard) {
      payload.reply_markup = { inline_keyboard: content.keyboard };
    }
    const result = await _call("editMessageText", payload);
    if (!result) {
      delete _pnlMessages[chatId];
    }
  }

  // if all positions closed, stop tracking
  if (openPositions.length === 0) {
    _pnlMessages = {};
  }
}

function _registerPnlMessage(chatId, msgId) {
  const key = String(chatId);
  _pnlMessages[key] = msgId;
}

async function _buildPnlContent(openPositions) {
  const lines = ["<b>💰 Live PnL</b>"];
  let anyPrice = false;
  for (const p of openPositions) {
    const held = p.entryTime ? ((Date.now() - p.entryTime) / 3600000).toFixed(1) : "?";
    let currentPrice;
    try {
      currentPrice = await jupiter.getUsdPrice(p.mint);
    } catch {}
    if (currentPrice != null) {
      anyPrice = true;
      const pnlPct = p.entryPriceEffective
        ? (((currentPrice - p.entryPriceEffective) / p.entryPriceEffective) * 100).toFixed(2)
        : "?";
      const arrow = pnlPct !== "?" && parseFloat(pnlPct) >= 0 ? "🟢" : "🔴";
      const pnlSol = p.entryPriceEffective
        ? ((currentPrice - p.entryPriceEffective) * p.qtyTokens).toFixed(6)
        : "?";
      lines.push(
        `${arrow} <b>${escapeHtml(p.symbol)}</b>`,
        `  Entry $${p.entryPriceEffective.toFixed(8)} → Current $${currentPrice.toFixed(8)}`,
        `  PnL: ${pnlPct}% · ${pnlSol} SOL · ${held}h`
      );
    } else {
      lines.push(
        `⚪ <b>${escapeHtml(p.symbol)}</b>`,
        `  Entry $${(p.entryPriceEffective || 0).toFixed(8)} → Price: ? · ${held}h`
      );
    }
  }
  if (!anyPrice) lines.push("(no price data)");
  return {
    text: lines.join("\n"),
    keyboard: [[{ text: "🔄 Refresh", callback_data: "refresh_pnl" }]],
  };
}

// ——— send message (DM + optional channel mirror) ———

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
  if (_lastPinnedMsgId) await unpin(chatId, _lastPinnedMsgId);
  await _call("pinChatMessage", { chat_id: chatId, message_id: messageId });
  _lastPinnedMsgId = messageId;
}

async function unpin(chatId, messageId) {
  await _call("unpinChatMessage", { chat_id: chatId, message_id: messageId });
}

async function _sendTyping(chatId) {
  await _call("sendChatAction", { chat_id: chatId, action: "typing" });
}

function _replyKeyboard() {
  return {
    keyboard: [
      [{ text: "📊 Status" }, { text: "📈 Report" }],
      [{ text: "💰 PnL" }, { text: "🔔 Notif" }],
      [{ text: "⚙️ Config" }, { text: "⚙️ Settings" }],
      [{ text: "⏸️ Stop" }, { text: "▶️ Resume" }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
}

const _buttonRoutes = {
  "📊 status": "/status",
  "📈 report": "/report",
  "💰 pnl": "/pnl",
  "🔔 notif": "/menu",
  "⚙️ config": "/config",
  "⚙️ settings": "/settings",
  "⏸️ stop": "/stop",
  "▶️ resume": "/resume",
};

// ——— settings menu config ———

const SETTINGS_CATEGORIES = {
  trading: { label: "📈 Trading", keys: ["positionSizeSol", "takeProfitPct", "stopLossPct", "maxHoldHours", "maxConcurrentPositions"] },
  risk: { label: "🛡️ Risk", keys: ["dailyLossLimitPct", "cooldownMinutesBetweenTrades", "maxTradesPerDay"] },
  filters: { label: "🔍 Filters", keys: ["filters.minLiquidityUsd", "filters.minVolume24hUsd", "filters.minTokenAgeHours", "filters.maxTopHolderPct"] },
  notify: { label: "🔔 Notifications", keys: ["telegram.notify.onEntry", "telegram.notify.onExit", "telegram.notify.onScreening", "telegram.notify.onError"] },
};

function _resolveConfigValue(cfg, path) {
  const keys = path.split(".");
  let obj = cfg;
  for (const k of keys) {
    if (obj == null || typeof obj !== "object") return undefined;
    obj = obj[k];
  }
  return obj;
}

// ——— polling ———

let _polling = false;

async function pollCommands() {
  if (!_isEnabled()) return;
  if (_polling) return;
  _polling = true;

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
        if (!authorizedChats.some((c) => String(c) === String(chatId))) continue;

        try {
          await _handleCallback(cq, chatId, msgId, data);
        } catch (err) {
          console.log("callback handler error:", err.message);
        }
        continue;
      }

      const msg = u.message;
      if (!msg || !msg.text) continue;

      const authorizedChats = [_chatId, _channelId].filter(Boolean);
      const chatIdStr = String(msg.chat.id);
      if (!authorizedChats.some((c) => String(c) === chatIdStr)) continue;
      if (chatIdStr !== String(_chatId)) continue;

      await _sendTyping(msg.chat.id);

      let cmdText = msg.text.trim();
      const normalized = cmdText.toLowerCase().replace(/\ufe0f/g, "");
      if (_buttonRoutes[normalized]) {
        cmdText = _buttonRoutes[normalized];
      }

      const reply = await _handleCommand(cmdText, msg.chat.id);
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
        const sendResult = await _call("sendMessage", payload);
        if (reply._afterSend && sendResult?.result?.message_id) {
          reply._afterSend(String(msg.chat.id), sendResult.result.message_id);
        }
      }
    }
  } catch (err) {
    const status = err.response?.status;
    if (status === 409) return;
    console.log("telegram poll error:", err.message);
  } finally {
    _polling = false;
  }
}

// ——— callback handler ———

async function _handleCallback(cq, chatId, msgId, data) {
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
    return;
  }

  if (data === "refresh_pnl") {
    const openPositions = positions.loadOpenPositions();
    const reply = openPositions.length === 0
      ? { text: "No open positions.", keyboard: [] }
      : await _buildPnlContent(openPositions);
    await _call("editMessageText", {
      chat_id: chatId,
      message_id: msgId,
      text: reply.text,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: reply.keyboard },
    });
    await _call("answerCallbackQuery", {
      callback_query_id: cq.id,
      text: "Refreshed",
      show_alert: false,
    });
    return;
  }

  // settings category selected
  if (data.startsWith("settings_cat:")) {
    const category = data.replace("settings_cat:", "");
    _settingsState[String(chatId)] = { category };
    const kb = _buildSettingsKeysKeyboard(category);
    await _call("editMessageText", {
      chat_id: chatId,
      message_id: msgId,
      text: `<b>⚙️ ${SETTINGS_CATEGORIES[category]?.label || category}</b>\nTap a key to edit:`,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: kb },
    });
    await _call("answerCallbackQuery", {
      callback_query_id: cq.id,
      text: SETTINGS_CATEGORIES[category]?.label || category,
      show_alert: false,
    });
    return;
  }

  // settings key selected — show value + edit prompt
  if (data.startsWith("settings_key:")) {
    const key = data.replace("settings_key:", "");
    const cfg = config.loadConfig();
    const val = _resolveConfigValue(cfg, key);
    const prompt =
      `<b>${key}</b>\n` +
      `Current value: <code>${JSON.stringify(val)}</code>\n\n` +
      `Reply with:\n<code>/set ${key} &lt;new-value&gt;</code>`;
    await _call("editMessageText", {
      chat_id: chatId,
      message_id: msgId,
      text: prompt,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔙 Back", callback_data: `settings_back:${key.split(".")[0]}` }],
        ],
      },
    });
    await _call("answerCallbackQuery", {
      callback_query_id: cq.id,
      text: `Editing ${key}`,
      show_alert: false,
    });
    return;
  }

  // settings back to category
  if (data.startsWith("settings_back:")) {
    const category = data.replace("settings_back:", "");
    const kb = _buildSettingsKeysKeyboard(category);
    await _call("editMessageText", {
      chat_id: chatId,
      message_id: msgId,
      text: `<b>⚙️ ${SETTINGS_CATEGORIES[category]?.label || category}</b>\nTap a key to edit:`,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: kb },
    });
    await _call("answerCallbackQuery", {
      callback_query_id: cq.id,
      text: "Back",
      show_alert: false,
    });
    return;
  }

  // settings main menu
  if (data === "settings_main") {
    const kb = _buildSettingsMainKeyboard();
    await _call("editMessageText", {
      chat_id: chatId,
      message_id: msgId,
      text: "<b>⚙️ Settings</b>\nChoose a category:",
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: kb },
    });
    await _call("answerCallbackQuery", {
      callback_query_id: cq.id,
      text: "Categories",
      show_alert: false,
    });
    return;
  }

  // notification toggles (legacy)
  if (data.startsWith("toggle:")) {
    const key = data.replace("toggle:", "");
    const currentCfg = config.loadConfig();
    const current = currentCfg.telegram?.notify?.[key];
    const newVal = current === true ? "false" : "true";
    config.setConfigValue(`telegram.notify.${key}`, newVal);
    await _call("answerCallbackQuery", {
      callback_query_id: cq.id,
      text: `${key} → ${newVal === "true" ? "ON" : "OFF"}`,
      show_alert: false,
    });
    const updatedCfg = config.loadConfig();
    const keyboard = _menuKeyboard(updatedCfg);
    await _call("editMessageText", {
      chat_id: chatId,
      message_id: msgId,
      text: "<b>🔔 Notification Toggles</b>\nTap to toggle:",
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: keyboard },
    });
    return;
  }
}

// ——— settings keyboard builders ———

function _buildSettingsMainKeyboard() {
  return Object.entries(SETTINGS_CATEGORIES).map(([key, cat]) => [
    { text: cat.label, callback_data: `settings_cat:${key}` },
  ]);
}

function _buildSettingsKeysKeyboard(category) {
  const cat = SETTINGS_CATEGORIES[category];
  if (!cat) return [];
  const cfg = config.loadConfig();
  const rows = cat.keys.map((key) => {
    const val = _resolveConfigValue(cfg, key);
    const display = val != null ? JSON.stringify(val) : "?";
    return [{ text: `${key.split(".").pop()}: ${display}`, callback_data: `settings_key:${key}` }];
  });
  rows.push([{ text: "🔙 Categories", callback_data: "settings_main" }]);
  return rows;
}

// ——— command handler ———

async function _handleCommand(text, chatId) {
  const parts = text.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1);

  switch (cmd) {
    case "/start":
    case "/help":
      return {
        text: [
          "<b>🤖 darkpools-trader</b>",
          "",
          "Use the buttons below or type a command:",
          "📊 Status — bot state + open positions",
          "📈 Report — closed trade summary",
          "💰 PnL — live unrealized PnL per position",
          "🔔 Notif — toggle notification types",
          "⚙️ Config — view current settings",
          "⚙️ Settings — multi-level config editor",
          "⏸️ Stop — kill switch (no new entries)",
          "▶️ Resume — re-enable entries",
          "/add &lt;mint&gt; — manually enter a position",
          "/set &lt;key&gt; &lt;value&gt; — change a setting",
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
      const cfg = config.loadConfig();
      const openPositions = positions.loadOpenPositions();
      const lines = [
        `<b>📊 Status</b>`,
        `Mode: ${cfg.mode}`,
        `Kill switch: ${state.killSwitch ? "🔴 ON" : "🟢 OFF"}`,
        ``,
        `<b>— Daily PnL —</b>`,
        `Today: ${state.realizedPnlTodaySol >= 0 ? "🟢" : "🔴"} ${state.realizedPnlTodaySol.toFixed(6)} SOL`,
        `Yesterday: ${(state.yesterdayPnlSol || 0) >= 0 ? "🟢" : "🔴"} ${(state.yesterdayPnlSol || 0).toFixed(6)} SOL`,
        `Trades: ${state.tradesToday}`,
      ];
      if (openPositions.length > 0) {
        lines.push(``, `<b>— Open (${openPositions.length}) —</b>`);
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
          const arrow = unrealized !== "?" && parseFloat(unrealized) >= 0 ? "🟢" : "🔴";
          lines.push(
            `${arrow} ${escapeHtml(p.symbol)} — $${(p.entryPriceEffective || 0).toFixed(8)} · ${held}h · ${unrealized}%`
          );
        }
      }
      return { text: lines.join("\n") };
    }

    case "/menu": {
      const cfg = config.loadConfig();
      return {
        text: "<b>🔔 Notification Toggles</b>\nTap to toggle:",
        keyboard: _menuKeyboard(cfg),
      };
    }

    case "/report": {
      const allPositions = reporter.loadAllPositions();
      const report = reporter.buildReport(allPositions);
      if (report.totalClosed === 0) {
        return { text: "📊 0 closed trades yet" };
      }
      const lines = [
        `<b>📊 Trade Report</b>`,
        `Closed: ${report.totalClosed}`,
        `Win rate: ${report.winRatePct != null ? report.winRatePct.toFixed(1) + "%" : "?"}`,
        ``,
        `<b>— PnL —</b>`,
        `Total: ${report.totalPnlSol >= 0 ? "🟢" : "🔴"} ${report.totalPnlSol.toFixed(6)} SOL`,
        `Avg: ${report.avgPnlSol != null ? report.avgPnlSol.toFixed(6) + " SOL" : "?"}`,
        `Best: ${report.biggestWinSol != null ? "🟢 " + report.biggestWinSol.toFixed(6) + " SOL" : "?"}`,
        `Worst: ${report.biggestLossSol != null ? "🔴 " + report.biggestLossSol.toFixed(6) + " SOL" : "?"}`,
        ``,
        `<b>— Exits —</b>`,
        `SL: ${report.exitBreakdown?.SL || 0}`,
        `TP: ${report.exitBreakdown?.partialTP || 0}`,
        `Trailing: ${report.exitBreakdown?.trailing || 0}`,
        `MaxHold: ${report.exitBreakdown?.maxHold || 0}`,
      ];
      return { text: lines.join("\n") };
    }

    case "/config": {
      const cfg = config.loadConfig();
      const lines = [
        "<b>⚙️ Config</b>",
        `Mode: ${cfg.mode}`,
        `Position: ${cfg.positionSizeSol} SOL`,
        `TP: ${cfg.takeProfitPct}% / SL: ${cfg.stopLossPct}%`,
        `Trailing: ${cfg.trailingEnabled ? "ON" : "OFF"}`,
        `Max Hold: ${cfg.maxHoldHours}h`,
        `Max Concurrent: ${cfg.maxConcurrentPositions}`,
        `Cooldown: ${cfg.cooldownMinutesBetweenTrades}m`,
        `Day Loss Limit: ${cfg.dailyLossLimitPct}%`,
        `Filters: liq≥$${(cfg.filters?.minLiquidityUsd || 0).toLocaleString()} age≥${cfg.filters?.minTokenAgeHours || "?"}h`,
      ];
      return { text: lines.join("\n") };
    }

    case "/settings":
      return {
        text: "<b>⚙️ Settings</b>\nChoose a category:",
        keyboard: _buildSettingsMainKeyboard(),
      };

    case "/add": {
      if (args.length < 1) return { text: "Usage: /add &lt;mint&gt;" };
      const mint = args[0].trim();
      if (mint.length < 32) return { text: "Invalid mint address" };
      const cfg = config.loadConfig();
      const currentPrice = await jupiter.getUsdPrice(mint);
      if (currentPrice == null) return { text: "Could not fetch price for this mint" };
      const candidate = { mint, symbol: mint.slice(0, 8), pairAddress: null, timing: null, feeConfirm: null };
      const newPos = await positions.openPosition(candidate, currentPrice, cfg);
      if (!newPos) return { text: "Failed to open position (check limits/duplicates)" };
      return {
        text: [
          `<b>🟢 Manual Entry · ${escapeHtml(newPos.symbol)}</b>`,
          `Entry: $${newPos.entryPriceEffective.toFixed(8)}`,
          `Size: ${newPos.sizeSol} SOL · Qty: ${newPos.qtyTokens.toFixed(4)}`,
          _tokenLinks(mint),
        ].join("\n"),
      };
    }

    case "/set": {
      if (args.length < 2) return { text: "Usage: /set &lt;key&gt; &lt;value&gt;" };
      const key = args[0];
      const val = args.slice(1).join(" ");
      const _hardLockedKeys = [
        "mode", "confirmLiveTrading", "positionSizeSol", "accountSizeSol",
        "maxConcurrentPositions", "dailyLossLimitPct",
      ];
      const _hardLockedPrefixes = ["filters.", "sources."];
      if (_hardLockedKeys.includes(key) || _hardLockedPrefixes.some((p) => key.startsWith(p))) {
        return { text: `🔒 <code>${key}</code> locked for safety — edit on server` };
      }
      try {
        const result = config.setConfigValue(key, val);
        return { text: `<code>${key}</code> → ${JSON.stringify(result)}` };
      } catch (err) {
        return { text: `${err.message}` };
      }
    }

    case "/pnl": {
      const openPositions = positions.loadOpenPositions();
      if (openPositions.length === 0) {
        return { text: "No open positions." };
      }
      const reply = await _buildPnlContent(openPositions);
      return {
        ...reply,
        _afterSend: (chatIdKey, msgId) => _registerPnlMessage(chatIdKey, msgId),
      };
    }

    default:
      return null;
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

// ——— formatting helpers ———

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

// ——— notifications ———

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
    `<b>🟢 ENTRY · ${sym}</b>`,
    `Price: $${(position.entryPriceEffective || 0).toFixed(8)} (quoted $${(position.entryPriceQuoted || 0).toFixed(8)})`,
    `Size: ${position.sizeSol || "?"} SOL · Qty: ${(position.qtyTokens || 0).toFixed(4)}`,
  ];

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
    `PnL: ${pnl >= 0 ? "🟢" : "🔴"} ${pnl.toFixed(6)} SOL (${pnlPct}%) · ${heldHours}h`,
  ];

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

async function checkDailyRollover(state, config) {
  const dayKey = state.dayKey;
  if (_prevDayKey && dayKey !== _prevDayKey) {
    await notifyDailySummary(state, config);
  }
  _prevDayKey = dayKey;
}

// ——— self-test ———

if (require.main === module && process.argv.includes("--test")) {
  const cfgPath = require("path").resolve(__dirname, "..", "user-config.json");
  const cfg = JSON.parse(require("fs").readFileSync(cfgPath, "utf-8"));
  cfg.telegramEnabled = true;
  init(cfg);
  if (!_token) {
    console.log("TELEGRAM_BOT_TOKEN not set — skipping test.");
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
