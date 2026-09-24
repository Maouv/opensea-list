// OS API per-wallet per-stage eligibility (scope read:eligibility).
const osauth = require('./osauth');

const API = 'https://api.opensea.io';

// Official drop API carries stage UUIDs (scraped stages don't). Key: startMs|endMs|label.
async function stageUuidMap(apiKey, slug) {
  try {
    const r = await fetch(`${API}/api/v2/drops/${slug}`, { headers: { accept: 'application/json', 'x-api-key': apiKey } });
    if (!r.ok) return {};
    const d = await r.json();
    const map = {};
    for (const s of d.stages || []) map[`${Date.parse(s.start_time)}|${Date.parse(s.end_time)}|${s.label}`] = s.uuid;
    return map;
  } catch {
    return {};
  }
}

// wallets: [{wallet, address}] -> [{address, ok, stages:{uuid:bool}, error}]
async function walletsEligibility(apiKey, slug, wallets) {
  return Promise.all(wallets.map(async ({ wallet, address }) => {
    try {
      const jwt = await osauth.walletJwt(wallet);
      const data = await osauth.dropEligibility(apiKey, slug, jwt);
      const stages = {};
      for (const s of data.stages || []) stages[s.stage_uuid] = !!s.is_eligible;
      return { address, ok: true, stages };
    } catch (e) {
      return { address, ok: false, stages: {}, error: e.message.slice(0, 120) };
    }
  }));
}

module.exports = { walletsEligibility, stageUuidMap };
