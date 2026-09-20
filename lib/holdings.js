// On-chain holdings. The chain is the source of truth, OpenSea's indexer is only a hint: it lags by
// minutes in BOTH directions (sold NFTs linger, fresh mints are missing).
//
// getHoldings(), per wallet:
//   1. balanceOf(wallet) on-chain gives the exact number of NFTs the wallet holds right now.
//      0 means nothing to list, no further lookups.
//   2. OpenSea candidates (loadCandidates) are verified one by one with ownerOf, stale ones drop out.
//   3. If fewer were verified than balanceOf says, the rest were not indexed yet. Find them via
//      ERC721Enumerable if the contract supports it, otherwise by scanning recent Transfer logs
//      (newest first, stops as soon as the count matches balanceOf).
//   4. If still short, `complete` is false so the bot can warn instead of silently showing stale data.

const { ethers } = require('ethers');

const ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
];
const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');

const VERIFY_BATCH = 25;
const START_CHUNK = 10000;
const MIN_CHUNK = 200;
const MAX_ENUMERATE = 500;
const DEFAULT_LOOKBACK_MINUTES = Number(process.env.HOLDINGS_LOOKBACK_MINUTES) > 0
  ? Number(process.env.HOLDINGS_LOOKBACK_MINUTES)
  : 180;
const DEFAULT_MAX_BLOCKS = 300000;

// Only "call reverted / no such function" means "not owned / not supported". Network and RPC
// errors must surface, they must never be mistaken for "sold".
const isRevert = (err) => Boolean(err) && (err.code === 'CALL_EXCEPTION' || err.code === 'BAD_DATA');

async function verifyOwned(contract, wallet, ids) {
  const target = wallet.toLowerCase();
  const owned = new Set();
  for (let i = 0; i < ids.length; i += VERIFY_BATCH) {
    const slice = ids.slice(i, i + VERIFY_BATCH);
    const owners = await Promise.all(slice.map(async (id) => {
      try {
        return (await contract.ownerOf(id)).toLowerCase();
      } catch (err) {
        if (isRevert(err)) return null;
        throw err;
      }
    }));
    owners.forEach((owner, index) => {
      if (owner === target) owned.add(String(slice[index]));
    });
  }
  return owned;
}

async function readBalance(contract, wallet) {
  try {
    return Number(await contract.balanceOf(wallet));
  } catch (err) {
    if (isRevert(err)) return null;
    throw err;
  }
}

async function tryEnumerate(contract, wallet, balance) {
  if (balance > MAX_ENUMERATE) return null;
  let first;
  try {
    first = await contract.tokenOfOwnerByIndex(wallet, 0);
  } catch (err) {
    if (isRevert(err)) return null;
    throw err;
  }
  const rest = await Promise.all(
    Array.from({ length: balance - 1 }, (_, i) => contract.tokenOfOwnerByIndex(wallet, i + 1)),
  );
  return [first, ...rest].map(String);
}

async function estimateBlockSeconds(provider, latest) {
  try {
    const span = Math.min(latest, 1000);
    if (span < 10) return 12;
    const [newer, older] = await Promise.all([
      provider.send('eth_getBlockByNumber', [ethers.toQuantity(latest), false]),
      provider.send('eth_getBlockByNumber', [ethers.toQuantity(latest - span), false]),
    ]);
    const seconds = (Number(newer.timestamp) - Number(older.timestamp)) / span;
    return Math.max(0.05, seconds || 12);
  } catch (err) {
    return 12;
  }
}

// Newest first. RPCs cap eth_getLogs ranges differently, so the chunk shrinks on error and the scan
// gives up (reporting why) instead of hammering a provider that will not allow it.
async function scanRecentTransfers({ provider, contractAddress, wallet, lookbackMinutes, maxBlocks, isDone, onCandidates }) {
  const latest = await provider.getBlockNumber();
  const blockSeconds = await estimateBlockSeconds(provider, latest);
  const lookback = Math.min(maxBlocks, Math.ceil((lookbackMinutes * 60) / blockSeconds));
  const lowest = Math.max(0, latest - lookback);
  const walletTopic = ethers.zeroPadValue(wallet, 32);

  let to = latest;
  let chunk = START_CHUNK;
  while (to >= lowest) {
    chunk = Math.min(chunk, to - lowest + 1); // never ask for more than what is left to scan
    const from = to - chunk + 1;
    let logs;
    try {
      logs = await provider.getLogs({
        address: contractAddress,
        topics: [TRANSFER_TOPIC, null, walletTopic],
        fromBlock: from,
        toBlock: to,
      });
    } catch (err) {
      chunk = Math.floor(chunk / 2);
      if (chunk < MIN_CHUNK) {
        // ethers wraps provider errors as "could not coalesce error"; the real reason is in err.error
        const reason = (err.error && err.error.message) || err.shortMessage || err.message;
        return { ok: false, reason, scannedBlocks: latest - to };
      }
      continue;
    }

    const ids = logs.filter((log) => log.topics.length === 4).map((log) => BigInt(log.topics[3]).toString());
    if (ids.length > 0) await onCandidates(ids);
    if (isDone()) return { ok: true, scannedBlocks: latest - from + 1 };
    to = from - 1;
  }
  return { ok: true, scannedBlocks: latest - lowest + 1 };
}

async function getHoldings({
  provider,
  contractAddress,
  wallet,
  loadCandidates = async () => [],
  lookbackMinutes = DEFAULT_LOOKBACK_MINUTES,
  maxBlocks = DEFAULT_MAX_BLOCKS,
}) {
  const contract = new ethers.Contract(contractAddress, ABI, provider);
  const balance = await readBalance(contract, wallet);
  const warnings = [];

  if (balance === 0) {
    return { ids: [], balance, complete: true, warnings };
  }

  let candidates = [];
  try {
    candidates = (await loadCandidates(balance)).map(String);
  } catch (err) {
    warnings.push(`OpenSea holdings lookup failed (${err.message}), using on-chain data only`);
  }

  const owned = await verifyOwned(contract, wallet, [...new Set(candidates)]);

  if (balance === null) {
    warnings.push('contract has no ERC721 balanceOf, holdings could not be cross-checked on-chain');
    return { ids: [...owned], balance, complete: null, warnings };
  }
  if (owned.size >= balance) {
    return { ids: [...owned], balance, complete: true, warnings };
  }

  const enumerated = await tryEnumerate(contract, wallet, balance);
  if (enumerated) {
    return { ids: enumerated, balance, complete: true, warnings };
  }

  const tried = new Set(candidates);
  const scan = await scanRecentTransfers({
    provider,
    contractAddress,
    wallet,
    lookbackMinutes,
    maxBlocks,
    isDone: () => owned.size >= balance,
    onCandidates: async (ids) => {
      const fresh = [...new Set(ids)].filter((id) => !tried.has(id));
      fresh.forEach((id) => tried.add(id));
      (await verifyOwned(contract, wallet, fresh)).forEach((id) => owned.add(id));
    },
  });

  if (!scan.ok) warnings.push(`RPC rejected log queries (${scan.reason})`);
  return { ids: [...owned], balance, complete: owned.size >= balance, scan, warnings };
}

// For Manage Listing: OpenSea keeps showing listings of tokens that were already sold.
async function filterOwned(provider, contractAddress, wallet, items, idOf) {
  const contract = new ethers.Contract(contractAddress, ABI, provider);
  const owned = await verifyOwned(contract, wallet, [...new Set(items.map((item) => String(idOf(item))))]);
  const kept = items.filter((item) => owned.has(String(idOf(item))));
  return { items: kept, removed: items.length - kept.length };
}

module.exports = { getHoldings, filterOwned, verifyOwned };
