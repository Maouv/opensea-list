const { ethers } = require('ethers');

const PRICE_GETTERS = ['mintPrice', 'publicSalePrice', 'price', 'cost', 'MINT_PRICE', 'pricePerToken', 'salePrice', 'mintCost'];
const MINT_CANDIDATES = ['mint(uint256)', 'mintSeaDrop(uint256)', 'publicMint(uint256)'];

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

async function probeSig(provider, address, sig, valueWei) {
  const name = sig.split('(')[0];
  const contract = new ethers.Contract(address, [`function ${sig} payable`], provider);
  try {
    await contract[name].staticCall(1n, { value: valueWei });
    return { active: true };
  } catch (err) {
    const reason = revertReason(err);
    if (reason) return { active: false, reason };
    const data = revertData(err);
    if (data && data.length >= 10) return { active: false, reason: `blocked by custom error (${data.slice(0, 10)})` };
    return null;
  }
}

async function detect(provider, address) {
  const price = await probePrice(provider, address);
  for (const sig of MINT_CANDIDATES) {
    const probe = await probeSig(provider, address, sig, price ?? 0n);
    if (!probe) continue;
    const name = sig.split('(')[0];
    if (probe.active) return { sig, name, price: price ?? 0n };
    return {
      sig,
      name,
      reason: probe.reason,
      needsPrice: !price && /price|value|ether|amount|cost/i.test(probe.reason),
    };
  }
  return { error: 'No public mint function found (tried mint(uint256), mintSeaDrop(uint256), publicMint(uint256))' };
}

async function checkWithPrice(provider, address, sig, priceWei) {
  const probe = await probeSig(provider, address, sig, priceWei);
  return probe || { active: false, reason: 'mint call reverted without a reason string' };
}

module.exports = { detect, checkWithPrice };
