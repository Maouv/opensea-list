// Measure the real network floor from THIS server to each configured RPC endpoint.
//   node scripts/rtt.js        (reads .env; RPC_URL_<CHAIN> and RPC_URL_<CHAIN>_EXTRA)
// If eth_blockNumber p50 is small but your "send" time in mint results is big, the delay is on
// the provider/sequencer side (eth_sendRawTransaction forwards to the sequencer), not your code.
require('dotenv').config();
const { RPC_ENDPOINTS } = require('../lib/state');
const fastmint = require('../lib/fastmint');

const N = 20;
const pct = (arr, p) => arr.slice().sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(arr.length * p))];

(async () => {
  for (const [chain, urls] of Object.entries(RPC_ENDPOINTS)) {
    for (const url of urls) {
      const label = `${chain} ${url.replace(/\/[^/]{12,}$/, '/…')}`; // hide API key in path
      try {
        await fastmint.blockNumber(url); // discard: includes DNS + TLS handshake
        const ts = [];
        for (let i = 0; i < N; i++) {
          const t = process.hrtime.bigint();
          await fastmint.blockNumber(url);
          ts.push(Number(process.hrtime.bigint() - t) / 1e6);
        }
        console.log(`${label}\n  eth_blockNumber warm: p50 ${pct(ts, 0.5).toFixed(0)}ms  p95 ${pct(ts, 0.95).toFixed(0)}ms  min ${Math.min(...ts).toFixed(0)}ms`);
      } catch (err) {
        console.log(`${label}\n  failed: ${err.message}`);
      }
    }
  }
  process.exit(0);
})();

