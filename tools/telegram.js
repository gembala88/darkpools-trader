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

      const msg = u.message;
      if (!msg || !msg.text) continue;

      // only respond to authorized chat
      const authorizedChats = [_chatId, _channelId].filter(Boolean);
      const chatIdStr = String(msg.chat.id);
      if (!authorizedChats.some((c) => String(c) === chatIdStr)) continue;

      // ignore channel posts (already handled by mirror), only process DM commands
      if (chatIdStr !== String(_chatId)) continue;

      await _sendTyping(msg.chat.id);
      const reply = await _handleCommand(msg.text.trim());
      if (reply) {
        await _call("sendMessage", {
          chat_id: msg.chat.id,
          text: reply,
          parse_mode: "HTML",
          reply_to_message_id: msg.message_id,
        });
      }
    }
  } catch (err) {
    console.log("telegram poll error:", err.message);
  }
}

async function _handleCommand(text) {
  const parts = text.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1);

  switch (cmd) {
    case "/stop":
      riskManager.setKillSwitch(true);
      return "🔴 KILL SWITCH ON — no new entries";

    case "/resume":
      riskManager.setKillSwitch(false);
      return "🟢 KILL SWITCH OFF — entries allowed";

    case "/status": {
      const state = riskManager.loadState();
      const cfg = require("./config").loadConfig();
      const openPositions = require("./positions").loadOpenPositions();
      let lines = [
        `<b>Status</b>`,
        `Mode: ${cfg.mode}`,
        `Kill switch: ${state.killSwitch ? "🔴 ON" : "🟢 OFF"}`,
        `Today PnL: ${state.realizedPnlTodaySol >= 0 ? "🟢" : "🔴"} ${state.realizedPnlTodaySol.toFixed(6)} SOL`,
        `Yesterday PnL: ${state.yesterdayPnlSol >= 0 ? "🟢" : "🔴"} ${(state.yesterdayPnlSol || 0).toFixed(6)} SOL`,
        `Trades today: ${state.tradesToday}`,
      ];
      if (openPositions.length > 0) {
        const p = openPositions[0];
        const unrealized = p.entryPriceEffective
          ? ((p.peakPrice - p.entryPriceEffective) / p.entryPriceEffective * 100).toFixed(2)
          : "?";
        lines.push(`\n<b>Open position</b>`);
        lines.push(`${p.symbol} | entry ${p.entryPriceEffective.toFixed(8)} | unrealized ${unrealized}%`);
      }
      return lines.join("\n");
    }

    case "/config": {
      const { getConfigView } = require("./config");
      return `<pre>${getConfigView()}</pre>`;
    }

    case "/set": {
      if (args.length < 2) return "Usage: /set &lt;key&gt; &lt;value&gt;";
      const key = args[0];
      const val = args.slice(1).join(" ");
      try {
        const { setConfigValue } = require("./config");
        const result = setConfigValue(key, val);
        return `✅ <code>${key}</code> → ${JSON.stringify(result)}`;
      } catch (err) {
        return `❌ ${err.message}`;
      }
    }

    case "/help":
      return [
        "<b>Commands</b>",
        "/stop — kill switch ON",
        "/resume — kill switch OFF",
        "/status — PnL, positions, state",
        "/config — show settings",
        "/set &lt;key&gt; &lt;value&gt; — change whitelisted setting",
        "/help — this list",
      ].join("\n");

    default:
      return null; // unknown command, no reply
  }
}

// notifications
async function notifyStart() {
  if (!_config?.telegram?.notify?.onStart) return;
  await send("🤖 darkpools-trader started (dry_run)");
}

async function notifyError(errMsg) {
  if (!_config?.telegram?.notify?.onError) return;
  await send(`❌ ERROR: ${errMsg.slice(0, 500)}`);
}

async function notifyEntry(position) {
  if (!_config?.telegram?.notify?.onEntry) return;
  const msg =
    `<b>🟢 SIM BUY ${position.symbol}</b>\n` +
    `@ ${position.entryPriceEffective.toFixed(8)} (quoted ${position.entryPriceQuoted.toFixed(8)})\n` +
    `Size: ${position.sizeSol} SOL | Qty: ${position.qtyTokens.toFixed(4)}`;
  const result = await send(msg);

  if (_config.telegram?.pinOnEntry && result?.dm) {
    await pin(_chatId, result.dm);
  }
}

async function notifyExit(position, exit, isFullClose) {
  if (!_config?.telegram?.notify?.onExit) return;
  const msg =
    `<b>${isFullClose ? "🔴 CLOSE" : "🔶 PARTIAL"} ${position.symbol}</b>\n` +
    `${exit.reason} | ${exit.pctOfPosition}% @ ${exit.priceEffective.toFixed(8)}\n` +
    `PnL: ${exit.pnlSol >= 0 ? "🟢" : "🔴"} ${exit.pnlSol.toFixed(6)} SOL`;
  await send(msg);

  if (isFullClose && _lastPinnedMsgId) {
    await unpin(_chatId, _lastPinnedMsgId);
    _lastPinnedMsgId = null;
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
  notifyDailySummary,
  checkDailyRollover,
};
