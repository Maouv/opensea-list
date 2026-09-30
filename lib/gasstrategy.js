// gasstrategy.js — condition-aware priority-fee suggestion for the 3 presets offered in Settings
// (slow/medium/fast). Reads the actual last-N-blocks fee market via eth_feeHistory and takes a
// percentile of what really got included, instead of one fixed MINT_TIP_GWEI for every drop
// regardless of how busy the chain is right now (see chat: p50/p90/p99 sampled from 20 real
// blocks — p50 ~0.5 gwei, p90 ~2 gwei, p99 ~4-16 gwei, median ~4.4). Falls back to those static
// numbers if the RPC doesn't support eth_feeHistory or the call fails, so a preset never leaves
// the fire path without a tip.
const PRESETS = {
  slow: { percentile: 50, label: 'slow — cheapest, may lag behind a busy mint' },
  medium: { percentile: 90, label: 'medium — keeps pace with typical traffic' },
  fast: { percentile: 99, label: 'fast — competes for top-of-block' },
};
const FALLBACK_GWEI = { slow: 0.5, medium: 2, fast: 5 };

async function rpcCall(url, method, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
  return j.result;
}

// Returns { gwei, source } — source is for logs/debugging, never shown raw to the user.
// Fallback order when eth_feeHistory isn't available: the node's own suggested tip
// (eth_maxPriorityFeePerGas — what the old fixed-tip code always used) beats a hardcoded
// guess, since it's still live data. Only fall to the static default if both RPC calls fail.
async function suggestTipGwei(rpcUrl, strategy, blockCount = 20) {
  const preset = PRESETS[strategy] || PRESETS.medium;
  try {
    const hist = await rpcCall(rpcUrl, 'eth_feeHistory', ['0x' + blockCount.toString(16), 'latest', [preset.percentile]]);
    const tips = (hist.reward || []).map((r) => Number(BigInt(r[0])) / 1e9).filter((v) => Number.isFinite(v));
    if (!tips.length) throw new Error('empty feeHistory reward');
    tips.sort((a, b) => a - b);
    const median = tips[Math.floor(tips.length / 2)];
    return { gwei: median, source: `feeHistory p${preset.percentile} median/${tips.length}blk` };
  } catch (err) {
    try {
      const nodeTip = await rpcCall(rpcUrl, 'eth_maxPriorityFeePerGas', []);
      return { gwei: Number(BigInt(nodeTip)) / 1e9, source: `node suggestion (feeHistory unavailable: ${err.message})` };
    } catch (err2) {
      return { gwei: FALLBACK_GWEI[strategy] ?? FALLBACK_GWEI.medium, source: `static fallback (${err2.message})` };
    }
  }
}

module.exports = { PRESETS, FALLBACK_GWEI, suggestTipGwei };

