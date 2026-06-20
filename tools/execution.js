const axios = require("axios");
const { Connection, Keypair, VersionedTransaction, PublicKey } = require("@solana/web3.js");
const bs58 = require("bs58");

const WSOL_MINT = "So11111111111111111111111111111111111111112";
const JUPITER_QUOTE_API = "https://quote-api.jup.ag/v6/quote";
const JUPITER_SWAP_API = "https://quote-api.jup.ag/v6/swap";

let _connection = null;
let _wallet = null;

function _getConnection() {
  if (_connection) return _connection;
  const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
  _connection = new Connection(rpcUrl, {
    commitment: "confirmed",
    confirmTransactionInitialTimeout: 60000,
  });
  return _connection;
}

function _getWallet() {
  if (_wallet) return _wallet;
  const pk = process.env.SOLANA_PRIVATE_KEY;
  if (!pk) throw new Error("SOLANA_PRIVATE_KEY not set");
  let decoded;
  if (pk.startsWith("[")) {
    decoded = Uint8Array.from(JSON.parse(pk));
  } else {
    decoded = bs58.decode(pk);
  }
  _wallet = Keypair.fromSecretKey(decoded);
  return _wallet;
}

async function _getQuote(inputMint, outputMint, amount, slippageBps) {
  const url = `${JUPITER_QUOTE_API}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}`;
  const res = await axios.get(url, { timeout: 15000 });
  if (!res.data || res.data.error) throw new Error(res.data?.error || "empty quote");
  return res.data;
}

async function _getSwapTx(quoteResponse, userPublicKey) {
  const res = await axios.post(JUPITER_SWAP_API, {
    quoteResponse,
    userPublicKey,
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: "auto",
  }, { timeout: 15000 });
  if (!res.data?.swapTransaction) throw new Error("swap tx missing swapTransaction");
  return res.data;
}

async function _getTokenDecimals(connection, mint) {
  try {
    const pubkey = new PublicKey(mint);
    const info = await connection.getTokenSupply(pubkey, "confirmed");
    return info?.value?.decimals ?? 6;
  } catch {
    return 6;
  }
}

async function buy(mint, amountSol, config) {
  const mode = config.mode;
  const slippageBps = Math.round((config.execution?.slippagePctPerSide || 3) * 100);

  if (mode === "dry_run") {
    console.log(`DRY_RUN BUY ${mint}: ${amountSol} SOL @ ${slippageBps}bps slip`);
    return { success: true, mock: true, signature: null, tokenDecimals: null };
  }

  try {
    const wallet = _getWallet();
    const connection = _getConnection();
    const amountLamports = Math.floor(amountSol * 1e9);

    const quote = await _getQuote(WSOL_MINT, mint, amountLamports, slippageBps);
    const swapData = await _getSwapTx(quote, wallet.publicKey.toString());
    const txBuf = Buffer.from(swapData.swapTransaction, "base64");
    const tx = VersionedTransaction.deserialize(txBuf);
    tx.sign([wallet]);

    if (mode === "confirm") {
      console.log(`CONFIRM BUY ${mint}: tx signed, awaiting manual approval`);
      return { success: true, mock: true, signature: null, tokenDecimals: null };
    }

    const sig = await connection.sendTransaction(tx, { skipPreflight: false });
    console.log(`BUY sent: ${sig}`);
    const conf = await connection.confirmTransaction(sig, "confirmed");
    if (conf.value?.err) throw new Error(`tx failed: ${JSON.stringify(conf.value.err)}`);

    const tokenDecimals = await _getTokenDecimals(connection, mint);
    console.log(`BUY confirmed: ${sig}, decimals=${tokenDecimals}`);
    return { success: true, mock: false, signature: sig, tokenDecimals };
  } catch (err) {
    console.error(`BUY failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}

async function sell(mint, amountTokens, tokenDecimals, config) {
  const mode = config.mode;
  const slippageBps = Math.round((config.execution?.slippagePctPerSide || 3) * 100);
  const rawAmount = Math.floor(amountTokens * Math.pow(10, tokenDecimals || 6));

  if (mode === "dry_run") {
    console.log(`DRY_RUN SELL ${mint}: ${amountTokens} tokens @ ${slippageBps}bps slip`);
    return { success: true, mock: true, signature: null };
  }

  try {
    const wallet = _getWallet();
    const connection = _getConnection();

    const quote = await _getQuote(mint, WSOL_MINT, rawAmount, slippageBps);
    const swapData = await _getSwapTx(quote, wallet.publicKey.toString());
    const txBuf = Buffer.from(swapData.swapTransaction, "base64");
    const tx = VersionedTransaction.deserialize(txBuf);
    tx.sign([wallet]);

    if (mode === "confirm") {
      console.log(`CONFIRM SELL ${mint}: tx signed, awaiting manual approval`);
      return { success: true, mock: true, signature: null };
    }

    const sig = await connection.sendTransaction(tx, { skipPreflight: false });
    console.log(`SELL sent: ${sig}`);
    const conf = await connection.confirmTransaction(sig, "confirmed");
    if (conf.value?.err) throw new Error(`tx failed: ${JSON.stringify(conf.value.err)}`);

    console.log(`SELL confirmed: ${sig}`);
    return { success: true, mock: false, signature: sig };
  } catch (err) {
    console.error(`SELL failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}

module.exports = { buy, sell };
