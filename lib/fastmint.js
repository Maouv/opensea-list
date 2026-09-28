// Hot-path helpers for minting. Deliberately does NOT go through ethers' provider:
// plain JSON-RPC over global fetch (undici keep-alive) so a send is exactly one HTTP round trip,
// the same tx can be fanned out to several endpoints, and receipts are polled at ~150ms
// instead of ethers' 4s polling interval.
const { ethers } = require('ethers');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function rpcCall(url, method, params, timeoutMs = 8000) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let json;
  try {
    json = await res.json();
  } catch {
    throw new Error(`RPC ${method}: HTTP ${res.status}, non-JSON body`);
  }
  if (json.error) {
    const err = new Error(json.error.message || `RPC ${method} error`);
    err.code = json.error.code;
    err.data = typeof json.error.data === 'string' ? json.error.data : null;
    throw err;
  }
  return json.result;
}

const chainIdCache = new Map();
async function chainId(url) {
  if (!chainIdCache.has(url)) chainIdCache.set(url, BigInt(await rpcCall(url, 'eth_chainId', [])));
  return chainIdCache.get(url);
}

async function blockNumber(url) {
  return Number(BigInt(await rpcCall(url, 'eth_blockNumber', [])));
}

async function balanceOf(url, address) {
  return BigInt(await rpcCall(url, 'eth_getBalance', [address, 'latest']));
}

async function nonceOf(url, address) {
  return Number(BigInt(await rpcCall(url, 'eth_getTransactionCount', [address, 'pending'])));
}

async function estimateGas(url, tx) {
  return BigInt(await rpcCall(url, 'eth_estimateGas', [{
    from: tx.from,
    to: tx.to,
    data: tx.data,
    value: ethers.toBeHex(tx.value),
  }]));
}

// Same heuristic ethers' getFeeData uses (maxFee = 2*baseFee + tip, tip = node suggestion or
// 1 gwei), so behaviour matches the old code unless MINT_TIP_GWEI is set.
async function feeSnapshot(url, tipOverrideGwei = null) {
  const [block, tip] = await Promise.all([
    rpcCall(url, 'eth_getBlockByNumber', ['latest', false]),
    rpcCall(url, 'eth_maxPriorityFeePerGas', []).catch(() => null),
  ]);
  if (block && block.baseFeePerGas) {
    const base = BigInt(block.baseFeePerGas);
    const priority = tipOverrideGwei != null && tipOverrideGwei !== ''
      ? ethers.parseUnits(String(tipOverrideGwei), 'gwei')
      : tip != null ? BigInt(tip) : 1000000000n;
    return { eip1559: true, maxFeePerGas: base * 2n + priority, maxPriorityFeePerGas: priority };
  }
  return { eip1559: false, gasPrice: BigInt(await rpcCall(url, 'eth_gasPrice', [])) };
}

// "already known" from a second endpoint means the tx IS in the pool — that's a success.
// "nonce too low" is deliberately NOT treated as success (could be a different tx).
const DUPLICATE = /already known|known transaction|already imported|already exists|ALREADY_EXISTS/i;

// Fire the same signed tx at every endpoint at once; resolve on the first acceptance.
async function broadcastRaw(urls, signed) {
  const hash = ethers.keccak256(signed);
  const attempts = urls.map((url) =>
    rpcCall(url, 'eth_sendRawTransaction', [signed]).then(
      () => ({ url }),
      (err) => (DUPLICATE.test(err.message) ? { url, duplicate: true } : Promise.reject(err)),
    ));
  try {
    const first = await Promise.any(attempts);
    return { hash, via: first.url };
  } catch (agg) {
    throw (agg && agg.errors && agg.errors[0]) || agg;
  }
}

// Poll ALL endpoints for the receipt (the tx may only have been accepted by one of them):
// 150ms for the first 4s (where an L2 mint lands), then back off to 500ms so a slow tx doesn't
// burn through the RPC plan's compute-unit budget.
async function waitReceipt(urls, hash, timeoutMs = 60000) {
  const list = Array.isArray(urls) ? urls : [urls];
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = await Promise.all(list.map((url) => rpcCall(url, 'eth_getTransactionReceipt', [hash], 5000).catch(() => null)));
    const receipt = found.find(Boolean);
    if (receipt) return receipt;
    await sleep(Date.now() - start < 4000 ? 150 : 500);
  }
  return null;
}

// Revert reason for a mined-but-reverted tx. callTracer first (returns top-level `output`),
// then fall back to replaying the call one block earlier via eth_call.
async function revertOutput(url, hash, call, blockNum) {
  try {
    const trace = await rpcCall(url, 'debug_traceTransaction', [hash, { tracer: 'callTracer' }], 8000);
    const out = trace && (trace.output || (trace.result && trace.result.output));
    if (out && out !== '0x') return out;
  } catch {}
  try {
    await rpcCall(url, 'eth_call', [{
      from: call.from,
      to: call.to,
      data: call.data,
      value: ethers.toBeHex(call.value),
    }, ethers.toBeHex(Math.max(0, blockNum - 1))], 8000);
  } catch (err) {
    if (err.data && err.data.length >= 10) return err.data;
  }
  return null;
}

module.exports = {
  sleep, rpcCall, chainId, blockNumber, balanceOf, nonceOf, estimateGas, feeSnapshot,
  broadcastRaw, waitReceipt, revertOutput,
};

