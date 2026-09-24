const { ethers } = require('ethers');
const oselig = require('./oselig');

const PRICE_GETTERS = ['mintPrice', 'publicSalePrice', 'price', 'cost', 'MINT_PRICE', 'pricePerToken', 'salePrice', 'mintCost'];
const MINT_CANDIDATES = ['mint(uint256)', 'mintSeaDrop(address,uint256)', 'publicMint(uint256)'];

const SEA_ERRORS = (() => {
  const m = new Map();
  const put = (sig, fn) => m.set(ethers.id(sig).slice(0, 10), { sig, fn });
  put('NotOnAllowlist(address,bytes32)', () => 'wallet not on the active allowlist (WL phase)');
  put('IncorrectEthAmount(uint256,uint256)', (a, b) => `wrong price paid, contract expects ${ethers.formatEther(a)} (got ${ethers.formatEther(b)})`);
  put('WrongMessageValue(uint256,uint256)', (a) => `wrong value sent, contract expects ${ethers.formatEther(a)}`);
  put('SaleNotStarted(uint48,uint48)', (a, b) => `sale not started (window ${fmtRangeWIB(Number(a) * 1000, Number(b) * 1000)})`);
  put('SaleEnded(uint48,uint48)', (a, b) => `sale ended (window ${fmtRangeWIB(Number(a) * 1000, Number(b) * 1000)})`);
  put('MintQuantityExceedsMaxPurchasePerAddress(uint256,uint256)', (a, b) => `qty over per-wallet limit (max ${b - a})`);
  put('OverMaxTokenSupplyForDrop(uint256,uint256)', (a, b) => `drop supply exhausted (${a}/${b})`);
  put('OverMaxSupply(uint256)', (a) => `max supply exhausted (${a})`);
  put('SignedMintsNotEnabled()', () => 'signed mint phase not enabled');
  put('PublicSaleInactive()', () => 'public sale inactive');
  m.set('0x15e26ff3', { sig: 'custom', fn: () => 'phase locked or wrong price (custom error 0x15e26ff3)' });
  return m;
})();

const WIB_OFFSET = 7 * 3600 * 1000;
const MONTHS_WIB = ['jan', 'feb', 'mar', 'apr', 'mei', 'jun', 'jul', 'agu', 'sep', 'okt', 'nov', 'des'];

function fmtWIB(ts) {
  const d = new Date(ts + WIB_OFFSET);
  return {
    day: `${MONTHS_WIB[d.getUTCMonth()]} ${d.getUTCDate()}`,
    time: `${String(d.getUTCHours()).padStart(2, '0')}.${String(d.getUTCMinutes()).padStart(2, '0')}`,
  };
}

function fmtRangeWIB(start, end) {
  if (!start || !end) return '?';
  const a = fmtWIB(start);
  const b = fmtWIB(end);
  return a.day === b.day ? `${a.day} ${a.time} - ${b.time}` : `${a.day} ${a.time} - ${b.day} ${b.time}`;
}

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

async function checkEligibility(provider, address, minters, sig, priceWei) {
  return Promise.all(minters.map(async (minter) => {
    const probe = await probeSig(provider, address, minter, sig, priceWei);
    if (!probe) return { minter, ok: false, reason: 'mint call reverted without a reason' };
    return probe.active ? { minter, ok: true } : { minter, ok: false, reason: probe.reason };
  }));
}

// wallets: [{wallet, address}] (OS API) or address strings (on-chain sim fallback)
async function computeStageEligibility(drop, provider, ca, wallets, sig, slug, apiKey) {
  const now = Date.now();
  // OS API eligibility (works for signed stages too) — one call per wallet, cached PAT.
  let osData = null;
  if (slug && apiKey && wallets.length && typeof wallets[0] === 'object') {
    try {
      const [uuidMap, matrix] = await Promise.all([
        oselig.stageUuidMap(apiKey, slug),
        oselig.walletsEligibility(apiKey, slug, wallets),
      ]);
      osData = { uuidMap, matrix };
    } catch {
      osData = null;
    }
  }
  return Promise.all(drop.stages.map(async (s) => {
    const state = now < s.start ? 'upcoming' : now <= s.end ? 'active' : 'ended';
    const total = wallets.length;
    if (state === 'ended') return { stage: s, state, total, count: null, note: 'unavailable' };
    if (osData) {
      if (s.type === 'PUBLIC_SALE') return { stage: s, state, total, count: total, note: 'public, schedulable' };
      const uuid = osData.uuidMap[`${s.start}|${s.end}|${s.label}`];
      if (!uuid) return { stage: s, state, total, count: null, note: 'signed — stage uuid tidak ketemu (OS)' };
      const reasons = osData.matrix.map((w) => ({ minter: w.address, ok: !!w.stages[uuid], reason: w.ok ? '' : (w.error || 'OS API failed') }));
      const count = reasons.filter((r) => r.ok).length;
      return { stage: s, state, total, count, reasons, note: 'OS' };
    }
    if (state === 'upcoming') {
      return s.type === 'PUBLIC_SALE'
        ? { stage: s, state, total, count: total, note: 'public, schedulable' }
        : { stage: s, state, total, count: null, note: 'signed — eligibility didetermine OS saat stage aktif' };
    }
    const price = ethers.parseEther(String(s.priceEth ?? 0));
    const reasons = await checkEligibility(provider, ca, wallets, sig, price);
    const count = reasons.filter((r) => r.ok).length;
    const note = s.type === 'PUBLIC_SALE'
      ? `${count}/${total} eligible (sim on-chain)`
      : count > 0
        ? `${count}/${total} plain-mint eligible`
        : 'signed — butuh signature OS (plain mint ditolak kontrak)';
    return { stage: s, state, total, count, reasons, note };
  }));
}

async function collectionName(provider, address) {
  try {
    const contract = new ethers.Contract(address, ['function name() view returns (string)'], provider);
    return await contract.name();
  } catch {
    return null;
  }
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

async function fetchDrop(slug) {
  try {
    const r = await fetch(`https://opensea.io/collection/${slug}`, { headers: { accept: 'text/html', 'user-agent': UA } });
    if (!r.ok) return null;
    const html = await r.text();
    const key = '"dropBySlug":';
    const i = html.indexOf(key);
    if (i < 0) return null;
    const j = i + key.length;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let k = j; k < html.length; k++) {
      const c = html[k];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          const raw = JSON.parse(html.slice(j, k + 1));
          return {
            type: raw.type || null,
            maxSupply: raw.maxSupply,
            totalSupply: raw.totalSupply,
            stages: (raw.stages || []).map((s) => ({
              index: s.stageIndex,
              label: s.label || null,
              type: s.stageType || null,
              start: s.startTime ? Date.parse(s.startTime) : null,
              end: s.endTime ? Date.parse(s.endTime) : null,
              priceEth: s.price && s.price.token ? s.price.token.unit : null,
              maxPerWallet: s.maxTotalMintableByWallet ?? null,
              allowlistCount: s.allowlistMemberCount ?? null,
            })),
          };
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

function describeStages(drop, elig) {
  const now = Date.now();
  const typeShort = { PUBLIC_SALE: 'public', SIGNED_PRESALE: 'signed', ALLOWLIST: 'wl' };
  const supply = drop.maxSupply != null ? `Supply: ${drop.totalSupply ?? '?'}/${drop.maxSupply}` : '';
  const sorted = drop.stages.slice().sort((a, b) => a.start - b.start);
  const lines = sorted.map((s, i) => {
    const state = now < s.start ? 'upcoming' : now <= s.end ? 'ACTIVE' : 'ended';
    const price = s.priceEth != null ? `${s.priceEth} ETH` : '?';
    const wl = s.allowlistCount != null ? `, wl ${s.allowlistCount}` : '';
    const range = fmtRangeWIB(s.start, s.end);
    const head = `${state === 'ACTIVE' ? '>' : ' '}${i + 1} ${s.label || '?'} [${typeShort[s.type] || s.type}] — ${price}, max ${s.maxPerWallet ?? '?'}/w, ${range} WIB${state === 'ACTIVE' ? ' ACTIVE' : ''}${wl}`;
    let line = head;
    const e = elig ? elig.find((x) => x.stage.index === s.index) : null;
    if (e) {
      const short = (a) => `${a.slice(0, 6)}...${a.slice(-4)}`;
      if (e.count == null) line += `, elig ? — ${e.note}`;
      else if (e.count === 0) line += `, elig 0/${e.total}${e.note === 'OS' ? '' : ` — ${e.note}`}`;
      else if (e.count === e.total) line += `, elig ${e.count}/${e.total}${e.note === 'public, schedulable' ? ' ✓schedule' : ''}`;
      else if (e.count <= 3) line += `, elig ${e.count}/${e.total} — ${e.reasons.filter((r) => r.ok).map((r) => short(r.minter)).join(', ')}`;
      else line += `, elig ${e.count}/${e.total}`;
    } else if (state !== 'ACTIVE') {
      line += `, elig ?`;
    }
    return line;
  });
  const active = sorted.find((s) => now >= s.start && now <= s.end);
  const footer = active
    ? `\n\nActive: ${active.label} — ${typeShort[active.type] || active.type}, butuh signature OS. Stage elig: mint manual pas buka; Public bisa di-schedule.`
    : '';
  return [supply, '', ...lines].filter(Boolean).join('\n') + footer;
}

function activeStage(drop) {
  const now = Date.now();
  return drop.stages.find((s) => now >= s.start && now <= s.end) || null;
}

module.exports = {
  detect, checkWithPrice, checkEligibility, computeStageEligibility, collectionName, mintArgs,
  fetchDrop, describeStages, activeStage, fmtRangeWIB,
};
