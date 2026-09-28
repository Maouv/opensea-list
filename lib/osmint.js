// OS drop-mint builder: official POST /api/v2/drops/{slug}/mint returns ready-to-sign
// calldata for any stage (signed included — OpenSea bundles the allowlist signature).
// 409 = drop inactive, 422 = wallet-level precondition (balance/allowlist/limit/supply).
const API = 'https://api.opensea.io';

async function buildMintTx(apiKey, slug, minter, quantity = 1) {
  const res = await fetch(`${API}/api/v2/drops/${slug}/mint`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({ minter, quantity }),
  });
  const text = await res.text();
  if (res.status === 200) {
    const t = JSON.parse(text);
    return { ok: true, to: t.to, data: t.data, value: t.value, chain: t.chain };
  }
  let msg = text;
  try { msg = JSON.parse(text).errors.join('; '); } catch {}
  return { ok: false, status: res.status, error: msg };
}

// Open (and keep alive) TLS connections to the OS API before the fire moment so the real
// POST /mint doesn't pay a TCP+TLS handshake. Response is irrelevant (even a 404 warms it).
async function warm(apiKey, slug, connections = 1) {
  await Promise.all(Array.from({ length: connections }, async () => {
    try {
      const res = await fetch(`${API}/api/v2/drops/${slug}`, { headers: { 'x-api-key': apiKey } });
      await res.arrayBuffer();
    } catch {}
  }));
}

module.exports = { buildMintTx, warm };

