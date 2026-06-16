const axios = require("axios");

function _buildPool() {
  const multi = process.env.LLM_API_KEYS;
  const single = process.env.LLM_API_KEY;
  let keys = [];
  if (multi) {
    keys = multi.split(",").map((k) => k.trim()).filter(Boolean);
  } else if (single) {
    keys = [single.trim()];
  }
  return keys;
}

let _pool = null;
let _currentIndex = 0;

function _getPool() {
  if (!_pool) {
    _pool = _buildPool();
    _currentIndex = 0;
  }
  return _pool;
}

function poolInfo() {
  return { totalKeys: _getPool().length };
}

async function chat(messages, opts) {
  const pool = _getPool();
  if (pool.length === 0) {
    throw new Error("No LLM key configured. Set LLM_API_KEY or LLM_API_KEYS in .env");
  }

  const cfg = require("./config").loadConfig();
  const llmCfg = cfg.llm;
  const keyPoolCfg = llmCfg.keyPool || {};
  const maxRetries = keyPoolCfg.maxKeyRetries || 3;
  const backoffMs = keyPoolCfg.backoffMs || 1000;
  const rotate = keyPoolCfg.rotateOnRateLimit !== false;

  const model = opts?.model || llmCfg.model;
  const temperature = opts?.temperature ?? llmCfg.temperature ?? 0.2;
  const maxTokens = opts?.maxTokens ?? llmCfg.maxTokens ?? 1024;
  const timeoutMs = opts?.timeoutMs ?? llmCfg.timeoutMs ?? 60000;

  let lastErr;

  for (let retry = 0; retry <= maxRetries; retry++) {
    const key = pool[_currentIndex % pool.length];
    const keyIndex = (_currentIndex % pool.length) + 1;

    try {
      const res = await axios.post(
        `${llmCfg.baseUrl}/chat/completions`,
        {
          model,
          messages,
          temperature,
          max_tokens: maxTokens,
        },
        {
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
          },
          timeout: timeoutMs,
        }
      );

      const text = res.data?.choices?.[0]?.message?.content;
      if (text == null) {
        throw new Error("LLM response missing choices[0].message.content");
      }
      return text;
    } catch (err) {
      lastErr = err;
      const status = err.response?.status;
      const isRateLimit = status === 429;
      const isServerError = status >= 500 && status < 600;

      if ((isRateLimit || isServerError) && rotate && pool.length > 1) {
        _currentIndex++;
        console.log(
          `LLM key #${keyIndex}/${pool.length} ${isRateLimit ? "rate-limited" : "error " + status}, rotating to key #${(_currentIndex % pool.length) + 1} (retry ${retry + 1}/${maxRetries})`
        );
        if (retry < maxRetries) {
          await new Promise((r) => setTimeout(r, backoffMs * Math.pow(2, retry)));
          continue;
        }
      }

      if (retry >= maxRetries) {
        throw err;
      }
    }
  }

  throw lastErr || new Error("LLM chat failed after retries");
}

// self-test when run directly
if (require.main === module && process.argv.includes("--test")) {
  const pool = _buildPool();
  if (pool.length === 0) {
    console.log("LLM self-test: no key configured. Set LLM_API_KEY or LLM_API_KEYS in .env to test.");
    process.exit(0);
  }

  (async () => {
    console.log(`LLM pool has ${pool.length} key(s)`);
    try {
      const msg = await chat(
        [{ role: "user", content: "Reply with exactly: OK" }],
        { maxTokens: 10 }
      );
      console.log(`LLM key #${(_currentIndex % pool.length) + 1}/${pool.length} OK`);
      if (pool.length > 1) {
        console.log("Simulating rotation...");
        _currentIndex++;
        const msg2 = await chat(
          [{ role: "user", content: "Reply with exactly: OK" }],
          { maxTokens: 10 }
        );
        console.log(`LLM key #${(_currentIndex % pool.length) + 1}/${pool.length} OK (after rotation)`);
      }
    } catch (err) {
      console.log("LLM self-test failed:", err.message);
    }
  })();
}

module.exports = { chat, poolInfo };
