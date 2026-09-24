const { ethers } = require('ethers');

const API = 'https://api.opensea.io';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// SIWE with the wallet itself on api.opensea.io — the JWT must carry THIS wallet,
// eligibility is matched by the signing wallet (PAT-cache JWTs resolve to the PAT
// owner's linked wallet list and give wrong answers).
async function sessionCookies(wallet) {
  const nonce = await fetch(API + '/api/v2/auth/siwe/nonce', { method: 'POST' }).then((r) => r.json());
  const message = [
    'opensea.io wants you to sign in with your Ethereum account:',
    wallet.address,
    '',
    'Sign in to OpenSea.',
    '',
    'URI: https://opensea.io',
    'Version: 1',
    'Chain ID: 1',
    `Nonce: ${nonce.nonce}`,
    `Issued At: ${new Date().toISOString()}`,
  ].join('\n');
  const signature = await wallet.signMessage(message);
  const res = await fetch(API + '/api/v2/auth/siwe/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://opensea.io' },
    body: JSON.stringify({
      message: { domain: 'opensea.io', address: wallet.address, statement: 'Sign in to OpenSea.', uri: 'https://opensea.io', version: '1', chainId: '1', nonce: nonce.nonce, issuedAt: message.split('Issued At: ')[1], accountType: 'Ethereum' },
      signature,
      chainArch: 'EVM',
      connectorId: 'io.metamask',
    }),
  });
  if (!res.ok) throw new Error(`siwe verify ${res.status}`);
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

async function walletJwt(wallet) {
  const cookies = await sessionCookies(wallet);
  const patRes = await fetch(API + '/api/v2/auth/tokens', {
    method: 'POST',
    headers: { cookie: cookies, 'content-type': 'application/json', 'x-api-key': process.env.OPENSEA_API_KEY },
    body: JSON.stringify({ label: `opensea-list-bot-${wallet.address.slice(0, 10)}`, scopes: ['read:eligibility'], expiresInDays: 1 }),
  }).then((r) => r.json());
  if (!patRes.token) throw new Error(`PAT failed: ${JSON.stringify(patRes).slice(0, 120)}`);
  // exchange works without cookies
  const jwtRes = await fetch(API + '/api/v2/auth/tokens/exchange', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.OPENSEA_API_KEY },
    body: JSON.stringify({ subjectToken: patRes.token, subjectTokenType: 'ACCESS_TOKEN' }),
  }).then((r) => r.json());
  if (!jwtRes.accessToken) throw new Error(`exchange failed: ${JSON.stringify(jwtRes).slice(0, 120)}`);
  if (patRes.id) {
    // disposable PAT (25/account cap): delete right after the exchange
    fetch(`${API}/api/v2/auth/tokens/${patRes.id}`, { method: 'DELETE', headers: { cookie: cookies, 'x-api-key': process.env.OPENSEA_API_KEY } }).catch(() => {});
  }
  return jwtRes.accessToken;
}

async function dropEligibility(apiKey, slug, jwt) {
  const res = await fetch(`${API}/api/v2/drops/${slug}/eligibility`, {
    headers: { accept: 'application/json', 'x-api-key': apiKey, authorization: `Bearer ${jwt}`, 'user-agent': UA },
  });
  if (!res.ok) throw new Error(`eligibility ${res.status}: ${(await res.text()).slice(0, 120)}`);
  return res.json();
}

module.exports = { sessionCookies, walletJwt, dropEligibility };
