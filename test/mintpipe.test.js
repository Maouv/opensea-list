const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { ethers } = require('ethers');
const createPipeline = require('../lib/mintpipe');
const mint = require('../lib/mint');

const CA = '0x00000000000000000000000000000000000000aa';
const CHAIN_ID = 46630;

// Minimal JSON-RPC node. opts: status, traceOutput, sendError, dupOnly, estimateFails
function mockNode(opts = {}) {
  const st = { sent: [], accountNonce: 0, balance: ethers.parseEther('1'), calls: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const { id, method, params } = JSON.parse(body);
      st.calls.push(method);
      const ok = (result) => res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
      const err = (message, data) => res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message, data } }));
      switch (method) {
        case 'eth_chainId': return ok(ethers.toBeHex(CHAIN_ID));
        case 'eth_blockNumber': return ok('0x10');
        case 'eth_getBalance': return ok(ethers.toBeHex(st.balance));
        case 'eth_getTransactionCount': return ok(ethers.toBeHex(st.accountNonce));
        case 'eth_maxPriorityFeePerGas': return ok('0x3b9aca00'); // 1 gwei
        case 'eth_getBlockByNumber': return ok({ baseFeePerGas: '0x5f5e100' }); // 0.1 gwei
        case 'eth_estimateGas': return opts.estimateFails ? err('execution reverted') : ok('0x30d40'); // 200000
        case 'eth_sendRawTransaction': {
          if (opts.sendError) return err(opts.sendError);
          if (opts.dupOnly) return err('already known');
          const tx = ethers.Transaction.from(params[0]);
          if (tx.nonce < st.accountNonce) return err('nonce too low');
          st.sent.push({ raw: params[0], tx });
          return ok(tx.hash);
        }
        case 'eth_getTransactionReceipt': {
          const hit = st.sent.find((s) => s.tx.hash === params[0]);
          return ok(hit ? { status: opts.status || '0x1', blockNumber: '0x11', transactionHash: params[0] } : null);
        }
        case 'debug_traceTransaction': return opts.traceOutput ? ok({ output: opts.traceOutput }) : err('method not found');
        case 'eth_call': return err('execution reverted');
        default: return err(`unsupported ${method}`);
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    st.url = `http://127.0.0.1:${server.address().port}`;
    st.close = () => server.close();
    resolve(st);
  }));
}

const keys = [ethers.Wallet.createRandom().privateKey, ethers.Wallet.createRandom().privateKey];
const pipe = (urls, extra = {}) => createPipeline({
  PRIVATE_KEYS: keys,
  OPENSEA_API_KEY: extra.apiKey || null,
  RPC_ENDPOINTS: { robinhood: urls },
  mintSchedulesSlug: () => extra.slug || null,
});
const args = (o = {}) => ({
  chainInput: 'robinhood', ca: CA, mintSig: 'mint(uint256)', mintName: 'mint',
  priceWei: ethers.parseEther('0.01'), qty: 2, indexes: [0, 1], ...o,
});

test('plain route: pre-signed txs land, correct fields/signer/hash', async () => {
  const node = await mockNode();
  const p = pipe([node.url]);
  const prep = await p.prepareMint(args());
  assert.equal(prep.route, 'plain');
  assert.ok(prep.items.every((i) => i.signed), 'signed during prepare');
  const sentBefore = node.sent.length;
  assert.equal(sentBefore, 0, 'nothing broadcast before fire');
  const { results } = await p.fireMint(prep);
  assert.deepEqual(results.map((r) => r.status), ['ok', 'ok']);
  assert.equal(node.sent.length, 2);
  for (const [i, s] of node.sent.entries()) {
    const addr = new ethers.Wallet(keys[i]).address;
    assert.equal(s.tx.from.toLowerCase(), addr.toLowerCase());
    assert.equal(s.tx.to.toLowerCase(), CA);
    assert.equal(s.tx.value, ethers.parseEther('0.02'));
    assert.equal(s.tx.chainId, BigInt(CHAIN_ID));
    assert.equal(s.tx.type, 2);
    assert.equal(s.tx.maxPriorityFeePerGas, 1000000000n);
    assert.equal(s.tx.maxFeePerGas, 100000000n * 2n + 1000000000n); // 2*base + tip, same as ethers
    assert.equal(s.tx.gasLimit, (200000n * 120n) / 100n);
  }
  assert.ok(results[0].msBroadcast >= 0 && results[0].msConfirm >= results[0].msBroadcast);
  node.close();
});

test('insufficient funds -> skipped, nothing sent', async () => {
  const node = await mockNode();
  node.balance = ethers.parseEther('0.001');
  const p = pipe([node.url]);
  const { results } = await p.fireMint(await p.prepareMint(args()));
  assert.ok(results.every((r) => r.status === 'skipped' && /insufficient funds/.test(r.error)));
  assert.equal(node.sent.length, 0);
  node.close();
});

test('multi-endpoint: one dead RPC does not block; "already known" counts as accepted', async () => {
  const bad = await mockNode({ sendError: 'internal error' });
  const good = await mockNode();
  const p = pipe([bad.url, good.url]);
  const { results } = await p.fireMint(await p.prepareMint(args({ indexes: [0] })));
  assert.equal(results[0].status, 'ok');
  assert.equal(good.sent.length, 1);

  const dup = await mockNode({ dupOnly: true });
  const good2 = await mockNode();
  const p2 = pipe([dup.url, good2.url]);
  const r2 = await p2.fireMint(await p2.prepareMint(args({ indexes: [0] })));
  assert.equal(r2.results[0].status, 'ok');
  [bad, good, dup, good2].forEach((n) => n.close());
});

test('all endpoints failing surfaces a failed result, not a crash', async () => {
  const bad = await mockNode({ sendError: 'rate limited' });
  const p = pipe([bad.url]);
  const { results } = await p.fireMint(await p.prepareMint(args({ indexes: [0] })));
  assert.equal(results[0].status, 'failed');
  assert.match(results[0].error, /rate limited/);
  bad.close();
});

test('stale pre-signed nonce is re-nonced once at fire time', async () => {
  const node = await mockNode();
  const p = pipe([node.url]);
  const prep = await p.prepareMint(args({ indexes: [0] }));
  node.accountNonce = 3; // wallet sent other txs after prepare
  const { results } = await p.fireMint(prep);
  assert.equal(results[0].status, 'ok');
  assert.equal(node.sent[0].tx.nonce, 3);
  node.close();
});

test('refreshPrep picks up new nonce + re-signs', async () => {
  const node = await mockNode();
  const p = pipe([node.url]);
  const prep = await p.prepareMint(args({ indexes: [0] }));
  node.accountNonce = 7;
  await p.refreshPrep(prep);
  await p.fireMint(prep);
  assert.equal(node.sent[0].tx.nonce, 7);
  node.close();
});

test('on-chain revert is decoded into a plain-language reason', async () => {
  const data = ethers.id('SaleNotStarted(uint48,uint48)').slice(0, 10)
    + ethers.AbiCoder.defaultAbiCoder().encode(['uint256', 'uint256'], [1800000000, 1800003600]).slice(2);
  const node = await mockNode({ status: '0x0', traceOutput: data });
  const p = pipe([node.url]);
  const { results } = await p.fireMint(await p.prepareMint(args({ indexes: [0] })));
  assert.equal(results[0].status, 'failed');
  assert.match(results[0].error, /sale not started/);
  node.close();
});

test('seadrop-local route: calldata is SeaDrop.mintPublic, pre-signed', async () => {
  const node = await mockNode();
  const fee = ethers.Wallet.createRandom().address;
  const p = pipe([node.url]);
  const prep = await p.prepareMint(args({ indexes: [0], qty: 1, seadrop: { feeRecipient: fee } }));
  assert.equal(prep.route, 'seadrop-local');
  await p.fireMint(prep);
  const tx = node.sent[0].tx;
  assert.equal(tx.to.toLowerCase(), mint.SEADROP_SINGLETON.toLowerCase());
  const iface = new ethers.Interface(['function mintPublic(address,address,address,uint256)']);
  const dec = iface.decodeFunctionData('mintPublic', tx.data);
  assert.equal(dec[0].toLowerCase(), CA);
  assert.equal(dec[1], fee);
  assert.equal(dec[2], new ethers.Wallet(keys[0]).address);
  node.close();
});

// --- OS API route (regression: minttx.buildTx used to omit `ok`, so this route ALWAYS failed) ---
function withOsFetch(handler) {
  const real = globalThis.fetch;
  globalThis.fetch = (url, init) => (String(url).startsWith('https://api.opensea.io') ? handler(String(url), init) : real(url, init));
  return () => { globalThis.fetch = real; };
}

test('os-api route: uses OS calldata/value, signs after build, sends', async () => {
  const node = await mockNode();
  const osTo = '0x00000000000000000000000000000000000000bb';
  const restore = withOsFetch(async (url, init) => {
    if (init && init.method === 'POST') {
      const { minter } = JSON.parse(init.body);
      return { status: 200, text: async () => JSON.stringify({ to: osTo, data: '0xdeadbeef', value: '12345', chain: 'x', minter }), arrayBuffer: async () => new ArrayBuffer(0) };
    }
    return { status: 404, text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) };
  });
  try {
    const p = pipe([node.url], { slug: 'duck', apiKey: 'k' });
    const prep = await p.prepareMint(args({ indexes: [0], qty: 1 }));
    assert.equal(prep.route, 'os-api');
    assert.equal(prep.items[0].signed, null, 'cannot pre-sign: calldata only exists while stage is open');
    const { results } = await p.fireMint(prep);
    assert.equal(results[0].status, 'ok', results[0].error);
    const tx = node.sent[0].tx;
    assert.equal(tx.to.toLowerCase(), osTo);
    assert.equal(tx.data, '0xdeadbeef');
    assert.equal(tx.value, 12345n);
  } finally { restore(); node.close(); }
});

test('os-api route: OS 422 becomes a per-wallet failure with the OS message', async () => {
  const node = await mockNode();
  const restore = withOsFetch(async () => ({ status: 422, text: async () => JSON.stringify({ errors: ['wallet not eligible'] }), arrayBuffer: async () => new ArrayBuffer(0) }));
  try {
    const p = pipe([node.url], { slug: 'duck', apiKey: 'k' });
    const { results } = await p.fireMint(await p.prepareMint(args({ indexes: [0] })));
    assert.equal(results[0].status, 'failed');
    assert.match(results[0].error, /wallet not eligible/);
    assert.equal(node.sent.length, 0);
  } finally { restore(); node.close(); }
});

test('tip/gas overrides are per-chain: ETHEREUM setting does not leak into robinhood', async () => {
  const node = await mockNode();
  process.env.MINT_TIP_GWEI_ETHEREUM = '9';
  process.env.MINT_GAS_LIMIT_ETHEREUM = '250000';
  try {
    const p = pipe([node.url]); // chainInput = robinhood
    await p.fireMint(await p.prepareMint(args({ indexes: [0] })));
    assert.equal(node.sent[0].tx.maxPriorityFeePerGas, 1000000000n, 'robinhood untouched by ETHEREUM tip');
    assert.equal(node.sent[0].tx.gasLimit, (200000n * 120n) / 100n, 'robinhood untouched by ETHEREUM gas limit');

    const node2 = await mockNode();
    const eth = createPipeline({ PRIVATE_KEYS: keys, OPENSEA_API_KEY: null, RPC_ENDPOINTS: { ethereum: [node2.url] }, mintSchedulesSlug: () => null });
    await eth.fireMint(await eth.prepareMint(args({ chainInput: 'ethereum', indexes: [0] })));
    const tx = node2.sent[0].tx;
    assert.equal(tx.maxPriorityFeePerGas, 9000000000n);
    assert.equal(tx.maxFeePerGas, 100000000n * 2n + 9000000000n);
    assert.equal(tx.gasLimit, 250000n);
    node2.close();
  } finally {
    delete process.env.MINT_TIP_GWEI_ETHEREUM;
    delete process.env.MINT_GAS_LIMIT_ETHEREUM;
    node.close();
  }
});

test('global MINT_TIP_GWEI is the fallback, per-chain beats it', async () => {
  const node = await mockNode();
  process.env.MINT_TIP_GWEI = '3';
  try {
    const p = pipe([node.url]);
    await p.fireMint(await p.prepareMint(args({ indexes: [0] })));
    assert.equal(node.sent[0].tx.maxPriorityFeePerGas, 3000000000n);
    process.env.MINT_TIP_GWEI_ROBINHOOD = '0';
    node.accountNonce = 1;
    const prep = await p.prepareMint(args({ indexes: [0] }));
    await p.fireMint(prep);
    assert.equal(node.sent[1].tx.maxPriorityFeePerGas, 0n);
  } finally {
    delete process.env.MINT_TIP_GWEI; delete process.env.MINT_TIP_GWEI_ROBINHOOD; node.close();
  }
});

