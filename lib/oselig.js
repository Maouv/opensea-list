// OS API per-wallet per-stage eligibility (scope read:eligibility).
const { ethers } = require('ethers');
const osauth = require('./osauth');
const fs = require('fs');

const API = 'https://api.opensea.io';
const JWT_CACHE_FILE = '.os-jwt-cache.json';
const JWT_TTL_MS = 6 * 60 * 60 * 1000; // 12h server-side, use 6h

// JWT cache is per-signing-wallet (no cross-wallet leak like the old PAT cache).
function loadJwtCache() {
  try {
    return JSON.parse(fs.readFileSync(JWT_CACHE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveJwtCache(cache) {
  try {
    fs.writeFileSync(JWT_CACHE_FILE, JSON.stringify(cache), { mode: 0o600 });
  } catch {}
}

const memJwt = new Map();

async function walletJwtCached(wallet) {
  const addr = wallet.address.toLowerCase();
  const now = Date.now();
  const mem = memJwt.get(addr);
  if (mem && mem.exp > now) return mem.jwt;
  const cache = loadJwtCache();
  const hit = cache[addr];
  if (hit && hit.exp > now) {
    memJwt.set(addr, hit);
    return hit.jwt;
  }
  const jwt = await osauth.walletJwt(wallet);
  const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64').toString());
  const exp = (payload.exp || Math.floor(now / 1000) + 43200) * 1000;
  const entry = { jwt, exp: Math.min(exp, now + JWT_TTL_MS) };
  memJwt.set(addr, entry);
  cache[addr] = entry;
  saveJwtCache(cache);
  return jwt;
}

// Official drop API carries stage UUIDs (scraped stages don't). Key: startMs|endMs|label.
async function stageUuidMap(apiKey, slug) {
  try {
    const r = await fetch(`${API}/api/v2/drops/${slug}`, { headers: { accept: 'application/json', 'x-api-key': apiKey } });
    if (!r.ok) return {};
    const d = await r.json();
    const map = {};
    for (const s of d.stages || []) map[`${Date.parse(s.start_time)}|${Date.parse(s.end_time)}|${s.label}`] = s.uuid.replaceAll('-', '');
    return map;
  } catch {
    return {};
  }
}

// wallets: [{wallet, address}] -> [{address, ok, stages:{uuid:bool}, error}]
async function walletsEligibility(apiKey, slug, wallets) {
  // sequential: parallel SIWE verify + PAT creation race (PAT cap 25/account)
  const out = [];
  for (const { wallet, address } of wallets) {
    try {
      const jwt = await walletJwtCached(wallet);
      const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64').toString());
      if (payload.wallet && payload.wallet.toLowerCase() !== wallet.address.toLowerCase()) throw new Error('jwt wallet mismatch');
      const data = await osauth.dropEligibility(apiKey, slug, jwt);
      const stages = {};
      for (const s of data.stages || []) stages[s.stage_uuid.replaceAll('-', '')] = !!s.is_eligible;
      out.push({ address, ok: true, stages });
    } catch (e) {
      out.push({ address, ok: false, stages: {}, error: e.message.slice(0, 120) });
    }
  }
  return out;
}

module.exports = { walletsEligibility, stageUuidMap };
