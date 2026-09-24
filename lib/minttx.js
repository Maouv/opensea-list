// Universal mint executor: prefers OS drop-mint calldata (any stage incl. signed),
// falls back to plain on-chain encode when no slug/API key.
const { ethers } = require('ethers');
const osmint = require('./osmint');

// Build {to, data, value} for one wallet.
// OS path: POST /drops/{slug}/mint — backend picks the active stage, handles signed
// allowlist signatures. 422 errors surface per-wallet (balance/allowlist/limit/supply).
async function buildTx(apiKey, slug, minter, qty, plainFn) {
  if (slug && apiKey) {
    const built = await osmint.buildMintTx(apiKey, slug, minter, qty);
    if (built.ok) {
      return {
        to: built.to,
        data: built.data,
        value: BigInt(built.value),
        via: 'os-api',
      };
    }
    return { via: 'os-api', error: built.error, status: built.status };
  }
  if (plainFn) {
    return { to: plainFn.to, data: plainFn.data, value: plainFn.value, via: 'plain' };
  }
  return { via: 'none', error: 'no mint route' };
}

module.exports = { buildTx };
