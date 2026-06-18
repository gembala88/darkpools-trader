const axios = require("axios");

const _authorityCache = {};

function _rpcUrl() {
  return process.env.SOLANA_RPC_URL || null;
}

async function getTokenAuthorities(mint) {
  if (_authorityCache[mint]) return _authorityCache[mint];

  const rpc = _rpcUrl();
  if (!rpc) {
    const result = { mintAuthorityActive: null, freezeAuthorityActive: null, supply: null, decimals: null };
    _authorityCache[mint] = result;
    return result;
  }

  try {
    const res = await axios.post(
      rpc,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "getAccountInfo",
        params: [
          mint,
          { encoding: "jsonParsed" },
        ],
      },
      { timeout: 10000 }
    );

    const data = res.data?.result?.value?.data?.parsed?.info;
    if (!data) {
      const result = { mintAuthorityActive: null, freezeAuthorityActive: null, supply: null, decimals: null };
      _authorityCache[mint] = result;
      return result;
    }

    const mintAuthorityActive = data.mintAuthority ? true : false;
    const freezeAuthorityActive = data.freezeAuthority ? true : false;
    const result = {
      mintAuthorityActive,
      freezeAuthorityActive,
      supply: data.supply != null ? data.supply : null,
      decimals: data.decimals != null ? data.decimals : null,
    };
    _authorityCache[mint] = result;
    return result;
  } catch (err) {
    const result = { mintAuthorityActive: null, freezeAuthorityActive: null, supply: null, decimals: null };
    _authorityCache[mint] = result;
    return result;
  }
}

function clearCache() {
  Object.keys(_authorityCache).forEach((k) => delete _authorityCache[k]);
}

// ---- self-test ----
if (require.main === module && process.argv.includes("--test")) {
  let failures = 0;
  function assert(label, condition) {
    if (condition) {
      console.log(`PASS  ${label}`);
    } else {
      console.log(`FAIL  ${label}`);
      failures++;
    }
  }

  // 1. No RPC -> all null (skip)
  const savedRpc = process.env.SOLANA_RPC_URL;
  delete process.env.SOLANA_RPC_URL;
  (async () => {
    const r = await getTokenAuthorities("FakeMintNoRpc");
    assert("no RPC: mintAuthorityActive=null", r.mintAuthorityActive === null);
    assert("no RPC: freezeAuthorityActive=null", r.freezeAuthorityActive === null);
    process.env.SOLANA_RPC_URL = savedRpc;

    // 2. blacklist check via safety filter integration test
    const safety = require("./safety");
    const cfg = require("../../config").loadConfig();

    // blacklisted mint -> fail
    const testCfg = JSON.parse(JSON.stringify(cfg));
    testCfg.blacklistMints = ["BadTokenMintBlacklisted"];
    const blResult = await safety.applySafetyFilter(
      { mint: "BadTokenMintBlacklisted", liquidityUsd: 100000, volume24hUsd: 50000, ageHours: 48 },
      testCfg
    );
    const blCheck = blResult.checks.find((c) => c.name === "blacklist");
    assert("blacklisted mint -> fail", blCheck && blCheck.result === "fail");
    assert("blacklist -> passed=false", blResult.passed === false);

    // non-blacklisted mint -> pass (for that check)
    const okResult = await safety.applySafetyFilter(
      { mint: "GoodMint", liquidityUsd: 100000, volume24hUsd: 50000, ageHours: 48 },
      testCfg
    );
    const passCheck = okResult.checks.find((c) => c.name === "blacklist");
    assert("non-blacklisted -> pass", passCheck && passCheck.result === "pass");

    // 3. No RPC -> authority checks skip (producer of safety filter)
    const noRpcResult = await safety.applySafetyFilter(
      { mint: "SomeMint", liquidityUsd: 100000, volume24hUsd: 50000, ageHours: 48 },
      { ...testCfg, blacklistMints: [], filters: { ...testCfg.filters, requireMintAuthorityRevoked: true, requireFreezeAuthorityRevoked: true } }
    );
    const mintCheck = noRpcResult.checks.find((c) => c.name === "mintAuthority");
    const freezeCheck = noRpcResult.checks.find((c) => c.name === "freezeAuthority");
    assert("no RPC: mintAuthority -> skip", mintCheck && mintCheck.result === "skip");
    assert("no RPC: freezeAuthority -> skip", freezeCheck && freezeCheck.result === "skip");
    assert("no RPC: overall still pass (skips != fails)", noRpcResult.passed === true);

    // 4. Error inside check -> treated as fail (fail-safe)
    // We can simulate by making the scam module throw — test the safety filter's
    // error handling by passing null candidate that would trigger a crash
    const crashResult = await safety.applySafetyFilter(null, testCfg);
    // If candidate is null, it'll crash in the check — safety should catch and return fail
    assert("null candidate handled gracefully (fail-safe)", crashResult.passed === false);

    console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
    process.exit(failures > 0 ? 1 : 0);
  })();
}

module.exports = { getTokenAuthorities, clearCache };
