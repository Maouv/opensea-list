const { ethers } = require('ethers');

const PRICE_GETTERS = ['mintPrice', 'publicSalePrice', 'price', 'cost', 'MINT_PRICE', 'pricePerToken', 'salePrice', 'mintCost'];
const MINT_CANDIDATES = ['mint(uint256)', 'mintSeaDrop(address,uint256)', 'publicMint(uint256)'];

const SEA_ERRORS = (() => {
  const m = new Map();
  const put = (sig, fn) => m.set(ethers.id(sig).slice(0, 10), { sig, fn });
  put('NotOnAllowlist(address,bytes32)', () => 'wallet not on the active allowlist (WL phase)');
  put('IncorrectEthAmount(uint256,uint256)', (a, b) => `wrong price paid, contract expects ${ethers.formatEther(a)} (got ${ethers.formatEther(b)})`);
  put('WrongMessageValue(uint256,uint256)', (a) => `wrong value sent, contract expects ${ethers.formatEther(a)}`);
  put('SaleNotStarted(uint48,uint48)', (a, b) => `sale not started (window ${new Date(Number(a) * 1000).toISOString()} .. ${new Date(Number(b) * 1000).toISOString()})`);
  put('SaleEnded(uint48,uint48)', (a, b) => `sale ended (window ${new Date(Number(a) * 1000).toISOString()} .. ${new Date(Number(b) * 1000).toISOString()})`);
  put('MintQuantityExceedsMaxPurchasePerAddress(uint256,uint256)', (a, b) => `qty over per-wallet limit (max ${b - a})`);
  put('OverMaxTokenSupplyForDrop(uint256,uint256)', (a, b) => `drop supply exhausted (${a}/${b})`);
  put('OverMaxSupply(uint256)', (a) => `max supply exhausted (${a})`);
  put('SignedMintsNotEnabled()', () => 'signed mint phase not enabled');
  put('PublicSaleInactive()', () => 'public sale inactive');
  m.set('0x15e26ff3', { sig: 'custom', fn: () => 'phase locked or wrong price (custom error 0x15e26ff3)' });
  return m;
})();

function revertData(err) {
  const data = err && (err.data || (err.info && err.info.data));
  return typeof data === 'string' ? data : null;
}

function revertReason(err) {
  const data = revertData(err);
  if (!data || data.length < 10) return null;
  try {
    return new ethers.Interface(['error Error(string)']).decodeErrorResult('Error', data)[0];
  } catch {
    return null;
  }
}

function classify(err) {
  const reason = revertReason(err);
  if (reason) return { reason, unknown: false };
  const data = revertData(err);
  if (data && data.length >= 10) {
    const entry = SEA_ERRORS.get(data.slice(0, 10));
    if (entry) {
      let args = [];
      try {
        args = data.length > 10
          ? ethers.AbiCoder.defaultAbiCoder().decode(['uint256', 'uint256'], '0x' + data.slice(10))
          : [];
      } catch {}
      return { reason: entry.fn(...args), unknown: false };
    }
    return { reason: `blocked by custom error (${data.slice(0, 10)})`, unknown: true };
  }
  return { reason: null, unknown: false };
}

function mintArgs(sig, minter, qty) {
  return sig.includes('address') ? [minter, qty] : [qty];
}

async function probePrice(provider, address) {
  const contract = new ethers.Contract(
    address,
    PRICE_GETTERS.map((s) => `function ${s}() view returns (uint256)`),
    provider,
  );
  for (const name of PRICE_GETTERS) {
    try {
      return await contract[name]();
    } catch {}
  }
  return null;
}

async function probeMinted(provider, address, minter) {
  try {
    const contract = new ethers.Contract(address, ['function getMintStats(address) view returns (uint256,uint256)'], provider);
    const [minted] = await contract.getMintStats(minter);
    return minted;
  } catch {
    return null;
  }
}

async function probeSig(provider, address, minter, sig, valueWei, qty = 1n) {
  const iface = new ethers.Interface([`function ${sig} payable`]);
  const data = iface.encodeFunctionData(sig.split('(')[0], mintArgs(sig, minter, qty));
  try {
    await provider.call({ from: minter, to: address, data, value: valueWei });
    return { active: true };
  } catch (err) {
    const verdict = classify(err);
    if (verdict.reason) return { active: false, reason: verdict.reason, unknown: verdict.unknown };
    return null;
  }
}

async function detect(provider, address, minter) {
  const [price, minted] = await Promise.all([probePrice(provider, address), probeMinted(provider, address, minter)]);
  for (const sig of MINT_CANDIDATES) {
    const probe = await probeSig(provider, address, minter, sig, price ?? 0n);
    if (!probe) continue;
    const name = sig.split('(')[0];
    if (probe.active) return { sig, name, price: price ?? 0n, minted };
    return {
      sig,
      name,
      reason: probe.reason,
      minted,
      needsPrice: !price && (/price|value|ether|amount|cost/i.test(probe.reason) || probe.unknown),
    };
  }
  return { error: 'No public mint function found (tried mint(uint256), mintSeaDrop(address,uint256), publicMint(uint256))' };
}

async function checkWithPrice(provider, address, minter, sig, priceWei) {
  const probe = await probeSig(provider, address, minter, sig, priceWei);
  return probe || { active: false, reason: 'mint call reverted without a reason string' };
}

async function collectionName(provider, address) {
  try {
    const contract = new ethers.Contract(address, ['function name() view returns (string)'], provider);
    return await contract.name();
  } catch {
    return null;
  }
}

module.exports = { detect, checkWithPrice, collectionName, mintArgs };
