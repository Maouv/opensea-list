const { ethers } = require('ethers');
const fs = require('fs');

const API = 'https://api.opensea.io';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const PAT_FILE = '.os-pat-cache.json';

// --- SIWE login at api.opensea.io -> session cookies -> create scoped PAT (saved once) ---
async function createPat(wallet, scopes = ['read:eligibility'], expiresInDays = 30) {
  const nonceRes = await fetch(`${API}/api/v2/auth/siwe/nonce`, {
    method: 'POST',
    headers: { accept: 'application/json', 'user-agent': UA },
  });
  if (!nonceRes.ok) throw new Error(`nonce failed: ${nonceRes.status} ${await nonceRes.text()}`);
  const { nonce } = await nonceRes.json();

  const issuedAt = new Date().toISOString();
  const message = [
    'opensea.io wants you to sign in with your Ethereum account:',
    wallet.address,
    '',
    'Sign in to OpenSea.',
    '',
    'URI: https://opensea.io',
    'Version: 1',
    'Chain ID: 1',
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
  ].join('\n');

  const signature = await wallet.signMessage(message);

  const verifyRes = await fetch(`${API}/api/v2/auth/siwe/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://opensea.io', 'user-agent': UA },
    body: JSON.stringify({
      message: {
        domain: 'opensea.io',
        address: wallet.address,
        statement: 'Sign in to OpenSea.',
        uri: 'https://opensea.io',
        version: '1',
        chainId: '1',
        nonce,
        issuedAt,
        accountType: 'Ethereum',
      },
      signature,
      chainArch: 'EVM',
      connectorId: 'io.metamask',
    }),
  });
  if (!verifyRes.ok) throw new Error(`siwe verify failed: ${verifyRes.status} ${await verifyRes.text()}`);
  const cookies = verifyRes.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');

  const patRes = await fetch(`${API}/api/v2/auth/tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://opensea.io', 'user-agent': UA, cookie: cookies },
    body: JSON.stringify({ label: `opensea-list-${wallet.address.slice(0, 10)}`, scopes, expiresInDays }),
  });
  if (!patRes.ok) throw new Error(`pat create failed: ${patRes.status} ${await patRes.text()}`);
  const patJson = await patRes.json();
  const pat = patJson.token || patJson.pat || patJson.accessToken || patJson.value;
  if (!pat) throw new Error(`no PAT in response: ${JSON.stringify(patJson).slice(0, 300)}`);
  return pat;
}

// PAT -> short-lived wallet JWT (~12h)
async function exchange(pat) {
  const res = await fetch(`${API}/api/v2/auth/tokens/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': UA },
    body: JSON.stringify({ subjectToken: pat, subjectTokenType: 'ACCESS_TOKEN' }),
  });
  if (!res.ok) {
    const err = new Error(`exchange failed: ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const json = await res.json();
  return json.accessToken;
}

// JWT for a wallet: cached PAT -> exchange; re-SIWE if PAT dead
async function walletJwt(wallet, cache = PAT_FILE) {
  let pats = {};
  try { pats = JSON.parse(fs.readFileSync(cache, 'utf8')); } catch {}
  let pat = pats[wallet.address.toLowerCase()];
  if (pat) {
    try {
      return await exchange(pat);
    } catch (e) {
      if (e.status !== 403) throw e;
    }
  }
  pat = await createPat(wallet);
  pats[wallet.address.toLowerCase()] = pat;
  fs.writeFileSync(cache, JSON.stringify(pats, null, 1), { mode: 0o600 });
  return exchange(pat);
}

// Per-stage eligibility for the authenticated wallet (scope read:eligibility)
async function dropEligibility(apiKey, slug, token) {
  const res = await fetch(`${API}/api/v2/drops/${slug}/eligibility`, {
    headers: { accept: 'application/json', 'x-api-key': apiKey, authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`eligibility failed: ${res.status} ${await res.text()}`);
  return res.json();
}

module.exports = { createPat, exchange, walletJwt, dropEligibility };
