// Bot helpers: OS API per-stage eligibility matrix across all bot wallets.
const { ethers } = require('ethers');
const osauth = require('./osauth');

// wallets = [{wallet, address}] -> [{ address, byStage: [bool per eligibility stage order], notes }]
async function walletsEligibility(apiKey, slug, wallets) {
  const results = await Promise.all(wallets.map(async ({ wallet, address }) => {
    try {
      const jwt = await osauth.walletJwt(wallet);
      const data = await osauth.dropEligibility(apiKey, slug, jwt);
      return { address, ok: true, stages: data.stages.map((s) => !!s.is_eligible) };
    } catch (e) {
      return { address, ok: false, stages: [], error: e.message.slice(0, 120) };
    }
  }));
  return results;
}

module.exports = { walletsEligibility };
