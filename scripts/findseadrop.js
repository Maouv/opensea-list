require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { ethers } = require('ethers');

const SEADROP = '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5';
const TOPIC = ethers.id('SeaDropMint(address,address,address,address,uint256,uint256,uint256,uint256)');
const rpc = process.env.RPC_URL_ETHEREUM;
if (!rpc) { console.error('RPC_URL_ETHEREUM missing in .env'); process.exit(1); }

const call = async (method, params) => {
  const j = await (await fetch(rpc, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })).json();
  if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
  return j.result;
};

async function getLogs(from, to) {
  try {
    return await call('eth_getLogs', [{ address: SEADROP, topics: [TOPIC], fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) }]);
  } catch (e) {
    if (to - from < 200) throw e;
    const mid = Math.floor((from + to) / 2);
    return [...await getLogs(from, mid), ...await getLogs(mid + 1, to)];
  }
}

(async () => {
  const span = +process.argv[2] || 40000;
  const head = parseInt(await call('eth_blockNumber', []));
  const logs = await getLogs(head - span, head);
  if (!logs.length) { console.log(`no SeaDropMint events in last ${span} blocks`); return; }
  const m = new Map();
  for (const l of logs) {
    const nft = '0x' + l.topics[1].slice(26);
    const e = m.get(nft) || { mints: 0, txs: new Set(), perBlock: {}, first: Infinity, last: 0 };
    const bn = parseInt(l.blockNumber);
    e.mints += Number(BigInt('0x' + l.data.slice(66, 130)));
    if (!e.txs.has(l.transactionHash)) { e.txs.add(l.transactionHash); e.perBlock[bn] = (e.perBlock[bn] || 0) + 1; }
    e.first = Math.min(e.first, bn); e.last = Math.max(e.last, bn);
    m.set(nft, e);
  }
  const rows = [...m].map(([nft, e]) => ({ nft, mints: e.mints, txs: e.txs.size, peak: Math.max(...Object.values(e.perBlock)), blocks: e.last - e.first + 1 }))
    .sort((a, b) => b.peak - a.peak || b.txs - a.txs).slice(0, 15);
  console.log(`SeaDrop mints in last ${span} blocks (~${(span * 12 / 86400).toFixed(1)} days), sorted by busiest single block:\n`);
  console.log('nft contract                                mints  txs  peakTx/block  spanBlocks');
  for (const r of rows) console.log(`${r.nft}  ${String(r.mints).padStart(5)} ${String(r.txs).padStart(4)} ${String(r.peak).padStart(12)} ${String(r.blocks).padStart(11)}`);
  console.log('\nHigh peakTx/block + small spanBlocks = competitive drop. Next: node scripts/mintscan.js <nft contract> <qty>');
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
