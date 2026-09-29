require('dotenv').config();
const { ethers } = require('ethers');
const { RPC_ENDPOINTS } = require('../lib/state');
const f = require('../lib/fastmint');
const ms = (t) => (Number(process.hrtime.bigint() - t) / 1e6).toFixed(0);
(async () => {
  const chain = Object.keys(RPC_ENDPOINTS).find((c) => /robinhood/i.test(c));
  const url = RPC_ENDPOINTS[chain][0];
  const w = new ethers.Wallet(process.env.PRIVATE_KEYS.split(',')[0].trim());
  const chainId = await f.chainId(url);
  const fee = await f.feeSnapshot(url);
  let nonce = await f.nonceOf(url, w.address);
  await f.blockNumber(url); // warm-up koneksi
  for (let i = 0; i < 5; i++) {
    let t = process.hrtime.bigint();
    await f.blockNumber(url);
    const read = ms(t);
    const raw = await w.signTransaction({
      to: w.address, value: 0, nonce: nonce++, chainId, gasLimit: 100000n,
      type: 2, maxFeePerGas: fee.maxFeePerGas * 2n, maxPriorityFeePerGas: fee.maxPriorityFeePerGas,
    });
    t = process.hrtime.bigint();
    const sent = await f.broadcastRaw([url], raw);
    const send = ms(t);
    await f.waitReceipt([url], sent.hash, 20000);
    console.log(`#${i + 1} baca(eth_blockNumber): ${read}ms | kirim(sendRawTransaction): ${send}ms`);
  }
  process.exit(0);
})().catch((e) => { console.error('error:', e.message); process.exit(1); });
