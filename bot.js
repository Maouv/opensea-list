require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { ethers } = require('ethers');
const opensea = require('./lib/opensea');
const holdings = require('./lib/holdings');
const sessionStore = require('./lib/session');
const mint = require('./lib/mint');
const minttx = require('./lib/minttx');
const schedules = require('./lib/schedules');
const fs = require('fs');
const path = require('path');

function shortAddr(address) {
  return `${address.slice(0, 7)}...${address.slice(-5)}`;
}

const CA_REGEX = /^0x[0-9a-fA-F]{40}$/;

const CA_MEMORY_FILE = path.join(__dirname, 'ca-memory.json');
const CA_MEMORY_LIMIT = 3;
let caMemory = [];
try { caMemory = JSON.parse(fs.readFileSync(CA_MEMORY_FILE, 'utf8')); } catch {}
function rememberCa(entry) {
  caMemory = [entry, ...caMemory.filter((e) => e.address.toLowerCase() !== entry.address.toLowerCase() || e.chain !== entry.chain)].slice(0, CA_MEMORY_LIMIT);
  fs.writeFileSync(CA_MEMORY_FILE, JSON.stringify(caMemory));
}

// slug for the OS drop-mint builder at execution time (scheduler/mint share it)
function mintSchedulesSlug(ca, chainInput) {
  const hit = caMemory.find((e) => e.address.toLowerCase() === ca.toLowerCase() && e.chain === chainInput);
  return hit ? hit.slug : null;
}

const SETTINGS_FILE = path.join(__dirname, 'fastlist-settings.json');
let fastSettings = { price: '-40%', confirm: true, wallets: {} };
try {
  const loaded = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  if (loaded && typeof loaded === 'object') fastSettings = { ...fastSettings, ...loaded };
} catch {}
function saveFastSettings() {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(fastSettings));
}

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const AUTHORIZED_USER_ID = process.env.TELEGRAM_USER_ID;
const OPENSEA_API_KEY = process.env.OPENSEA_API_KEY;
const PRIVATE_KEYS = process.env.PRIVATE_KEYS.split(',').map((k) => k.trim());
const CONCURRENCY = Math.max(1, parseInt(process.env.LIST_CONCURRENCY, 10) || 3);
const LISTING_DURATION_DAYS = 7;

const RPC_URLS = {
  ethereum: process.env.RPC_URL_ETHEREUM,
  polygon: process.env.RPC_URL_POLYGON,
  base: process.env.RPC_URL_BASE,
  arc: process.env.RPC_URL_ARC,
  robinhood: process.env.RPC_URL_ROBINHOOD,
};

const providers = Object.fromEntries(
  Object.entries(RPC_URLS)
    .filter(([, url]) => url)
    .map(([name, url]) => [name, new ethers.JsonRpcProvider(url)]),
);
const walletAddresses = PRIVATE_KEYS.map((pk) => new ethers.Wallet(pk).address);
const walletWallets = PRIVATE_KEYS.map((pk) => { const w = new ethers.Wallet(pk); return { wallet: w, address: w.address }; });

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// Telegram calls are mostly fire-and-forget. A network blip (ECONNRESET/ETIMEDOUT) must be
// logged, not left as an unhandled rejection.
for (const method of ['sendMessage', 'answerCallbackQuery', 'editMessageText']) {
  const original = bot[method].bind(bot);
  bot[method] = (...args) => Promise.resolve(original(...args)).catch((err) => {
    console.log(`${method} failed:`, err.message);
  });
}

function isAuthorized(id) {
  return String(id) === String(AUTHORIZED_USER_ID);
}

function isBusy(chatId) {
  const s = sessionStore.getSession(chatId);
  return Boolean(s && s.step === 'executing');
}

function endAndReturnToMenu(chatId, notice, manageAddress) {
  sessionStore.endSession(chatId);
  showMainMenu(chatId, notice, manageAddress);
}

function showMainMenu(chatId, notice, manageAddress) {
  // idle: the menu is a resting state, it has no inactivity timer
  sessionStore.setSession(chatId, { flow: null, step: 'main_menu', data: {} }, bot, { idle: true });
  const text = notice ? `${notice}\n\nWhat do you want to do?` : 'What do you want to do?';
  const rows = [[
    { text: 'Fast List', callback_data: 'menu_fastlist' },
    { text: 'Listing', callback_data: 'menu_listing' },
    { text: 'Manage Listing', callback_data: 'menu_manage' },
  ]];
  rows.push([{ text: 'Mint', callback_data: 'menu_mint' }, { text: 'Settings', callback_data: 'menu_settings' }]);
  if (manageAddress) {
    rows.push([{ text: 'Manage this collection', callback_data: 'manage_recent' }]);
  }
  bot.sendMessage(chatId, text, {
    reply_markup: {
      inline_keyboard: rows,
    },
  });
}

function askCountForCurrentWallet(chatId, session) {
  const w = session.data.chosenWallets[session.data.walletCursor];
  bot.sendMessage(chatId, `How many from ${shortAddr(w.wallet.address)} (max ${w.items.length}, 0 to skip)?`);
}

function advanceWalletCursor(chatId, session) {
  session.data.walletCursor += 1;
  if (session.data.walletCursor < session.data.chosenWallets.length) {
    session.step = 'awaiting_count';
    sessionStore.setSession(chatId, session, bot);
    askCountForCurrentWallet(chatId, session);
  } else {
    goToSummary(chatId, session);
  }
}

function finalizeWalletSelection(chatId, session, wallet, count, price) {
  session.data.selections.push({
    wallet: wallet.wallet,
    items: wallet.items.slice(0, count),
    price,
  });
  advanceWalletCursor(chatId, session);
}

async function goToSummary(chatId, session) {
  if (session.data.selections.length === 0) {
    endAndReturnToMenu(chatId, 'Nothing selected, aborting');
    return;
  }

  let summary = '--- Summary ---\n';
  let totalGasEth = 0;

  if (session.flow === 'list') {
    await Promise.all(session.data.selections.map(async (selection) => {
      const gasInfo = await opensea.estimateApprovalGas(selection.wallet, session.data.contractAddress, session.data.provider, session.data.chain);
      selection.gasNeeded = gasInfo.needed;
      selection.gasCost = gasInfo.costEth;
    }));
    for (const selection of session.data.selections) {
      totalGasEth += selection.gasCost;
      summary += `${shortAddr(selection.wallet.address)}: list ${selection.items.length} NFT(s) at ${selection.price} each${selection.gasNeeded ? ` (approval needed, ~${selection.gasCost.toFixed(5)} ETH gas)` : ''}\n`;
    }
    summary += `Estimated total approval gas: ~${totalGasEth.toFixed(5)} ETH`;
    const listedMap = session.data.listedMap || {};
    const alreadyListed = session.data.selections.reduce((sum, s) => sum + s.items.filter((id) => (listedMap[s.wallet.address] || []).includes(String(id))).length, 0);
    if (alreadyListed > 0) {
      summary += `\nWARN: ${alreadyListed} item(s) already have an active listing, listing again may double-list`;
    }
  } else if (session.mode === 'close') {
    for (const selection of session.data.selections) {
      summary += `${shortAddr(selection.wallet.address)}: close ${selection.items.length} listing(s), no gas\n`;
    }
  } else {
    for (const selection of session.data.selections) {
      summary += `${shortAddr(selection.wallet.address)}: reprice ${selection.items.length} listing(s) to ${selection.price} each, no gas\n`;
    }
  }

  const skipConfirm = session.flow === 'list' && session.data.fast && fastSettings.confirm === false;
  const buttons = skipConfirm ? undefined : {
    reply_markup: {
      inline_keyboard: [[
        { text: 'Yes', callback_data: 'confirm_yes' },
        { text: 'No', callback_data: 'confirm_no' },
      ]],
    },
  };
  bot.sendMessage(chatId, skipConfirm ? `${summary.trim()}\n\nListing now (confirmation is OFF in settings)` : summary.trim(), buttons);

  if (skipConfirm) {
    session.step = 'executing';
    sessionStore.setSession(chatId, session, bot);
    await executeAction(chatId, session);
    return;
  }

  session.step = 'awaiting_confirm';
  sessionStore.setSession(chatId, session, bot);
}

// Sends up to CONCURRENCY listings at once. The OpenSea request rate itself is capped by the shared
// limiter in lib/opensea.js, so more concurrency only hides latency, it cannot exceed the limit.
async function runPool(jobs, worker, limit) {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, jobs.length) }, async () => {
    while (next < jobs.length) {
      const job = jobs[next];
      next += 1;
      await worker(job);
    }
  });
  await Promise.all(runners);
}

async function processItem(chatId, session, job, expirationTime) {
  const { selection, sdk, item } = job;
  // heartbeat: a long batch must not hit the 3 minute inactivity timeout mid-run
  sessionStore.setSession(chatId, session, bot);

  const tokenId = session.flow === 'list' ? item : item.tokenId;
  const base = { wallet: selection.wallet.address, tokenId };
  let cancelled = false;

  try {
    const stillOwned = await opensea.checkStillOwned(session.data.contractAddress, tokenId, selection.wallet.address, session.data.provider);
    if (!stillOwned) return { ...base, status: 'skipped' };

    const listingParams = {
      asset: { tokenId, tokenAddress: session.data.contractAddress },
      accountAddress: selection.wallet.address,
      amount: selection.price,
      expirationTime,
    };

    if (session.flow === 'list') {
      for (const old of job.cancelListings || []) {
        await sdk.api.orders.offchainCancelOrder(old.protocolAddress, old.orderHash, session.data.chain);
      }
      if (job.cancelListings?.length > 0) {
        console.log(`cancelled ${job.cancelListings.length} old listing(s) for token ${tokenId} before relisting`);
      }
      await sdk.createListing(listingParams);
    } else if (session.mode === 'close') {
      await sdk.api.orders.offchainCancelOrder(item.protocolAddress, item.orderHash, session.data.chain);
    } else {
      await sdk.api.orders.offchainCancelOrder(item.protocolAddress, item.orderHash, session.data.chain);
      cancelled = true;
      await sdk.createListing(listingParams);
    }
    return { ...base, status: 'ok' };
  } catch (err) {
    const error = cancelled ? `old listing cancelled but relist failed: ${err.message}` : err.message;
    return { ...base, status: 'failed', error };
  }
}

function buildResultSummary(results, startedAt, statsBefore) {
  const count = (status) => results.filter((r) => r.status === status).length;
  const statsNow = opensea.getTransportStats();
  const seconds = Math.round((Date.now() - startedAt) / 1000);
  const rateLimited = statsNow.rateLimited - statsBefore.rateLimited;

  let text = `Done in ${seconds}s. Success: ${count('ok')}, failed: ${count('failed')}, skipped due to race condition: ${count('skipped')}`;
  text += `\nOpenSea rate limited: ${rateLimited}x (cap ${statsNow.capRps} req/s)`;

  const failed = results.filter((r) => r.status === 'failed');
  if (failed.length > 0) {
    const byError = new Map();
    for (const r of failed) {
      if (!byError.has(r.error)) byError.set(r.error, []);
      byError.get(r.error).push(r.tokenId);
    }
    text += '\n\nFailed:';
    for (const [error, ids] of [...byError].slice(0, 5)) {
      text += `\n${error}\n  tokens: ${ids.slice(0, 15).join(', ')}${ids.length > 15 ? ` (+${ids.length - 15} more)` : ''}`;
    }
  }

  const skipped = results.filter((r) => r.status === 'skipped').map((r) => r.tokenId);
  if (skipped.length > 0) {
    text += `\n\nSkipped (no longer owned): ${skipped.slice(0, 15).join(', ')}${skipped.length > 15 ? ` (+${skipped.length - 15} more)` : ''}`;
  }

  return text.slice(0, 3900);
}

async function executeAction(chatId, session) {
  session.step = 'executing';
  const expirationTime = Math.round(Date.now() / 1000 + 60 * 60 * 24 * LISTING_DURATION_DAYS);
  const startedAt = Date.now();
  const statsBefore = opensea.getTransportStats();

  const firstJobs = [];
  const restJobs = [];
  for (const selection of session.data.selections) {
    const sdk = opensea.makeSdk(selection.wallet, session.data.chain, OPENSEA_API_KEY);
    let cancelMap = {};
    if (session.flow === 'list') {
      const openListings = await opensea.getOpenListings(sdk, selection.wallet.address, session.data.slug, session.data.contractAddress, session.data.chain);
      cancelMap = openListings.reduce((map, l) => {
        (map[String(l.tokenId)] = map[String(l.tokenId)] || []).push({ orderHash: l.orderHash, protocolAddress: l.protocolAddress });
        return map;
      }, {});
    }
    selection.items.forEach((item, index) => {
      const job = { selection, sdk, item, cancelListings: cancelMap[String(item)] || [] };
      // A wallet that still needs the one-time approval does its FIRST listing alone. Otherwise
      // parallel listings would each send their own approval tx from the same wallet (same nonce).
      const warmUp = session.flow === 'list' && selection.gasNeeded && index === 0;
      (warmUp ? firstJobs : restJobs).push(job);
    });
  }

  const total = firstJobs.length + restJobs.length;
  const progressMsg = await bot.sendMessage(chatId, `Executing... 0/${total}`);
  const results = [];
  let lastEdit = Date.now();

  const worker = async (job) => {
    results.push(await processItem(chatId, session, job, expirationTime));
    const now = Date.now();
    if (progressMsg && now - lastEdit >= 4000) {
      lastEdit = now;
      bot.editMessageText(`Executing... ${results.length}/${total}`, { chat_id: chatId, message_id: progressMsg.message_id });
    }
  };

  await runPool(firstJobs, worker, CONCURRENCY);
  await runPool(restJobs, worker, CONCURRENCY);

  endAndReturnToMenu(chatId, buildResultSummary(results, startedAt, statsBefore), session.flow === 'list' ? session.data.contractAddress : null);
}

async function detectChainHoldings(address) {
  return Promise.all(Object.entries(providers).map(async ([name, provider]) => {
    const contract = new ethers.Contract(address, ['function balanceOf(address) view returns (uint256)'], provider);
    const balances = await Promise.all(walletAddresses.map((a) => contract.balanceOf(a).catch(() => 0n)));
    return [name, balances.reduce((sum, b) => sum + Number(b), 0)];
  }));
}

function resolveForFlow(chatId, session, chainInput) {
  return session.flow === 'mint' ? resolveMint(chatId, session, chainInput) : resolveCollectionAndWallets(chatId, session, chainInput);
}

async function resolveCollectionAndWallets(chatId, session, chainInput) {
  const chain = opensea.CHAIN_MAP[chainInput];
  const provider = providers[chainInput];

  if (!provider) {
    console.log(`abort: no RPC for ${chainInput}`);
    endAndReturnToMenu(chatId, `No RPC_URL configured for "${chainInput}" in .env, aborting`);
    return;
  }

  console.log(`resolve chain=${chainInput} flow=${session.flow} mode=${session.mode}`);
  session.data.chainInput = chainInput;
  session.data.chain = chain;
  session.data.provider = provider;

  const slug = await opensea.getCollectionSlug(chainInput, session.data.contractAddress, OPENSEA_API_KEY);

  if (!slug) {
    console.log(`abort: no slug for ${session.data.contractAddress} on ${chainInput}`);
    endAndReturnToMenu(chatId, 'Could not resolve collection from this contract address, aborting');
    return;
  }

  session.data.slug = slug;
  rememberCa({ address: session.data.contractAddress, chain: chainInput, slug });
  bot.sendMessage(chatId, `Collection detected: ${slug}`);

  const readOnlySdk = opensea.makeSdk(provider, chain, OPENSEA_API_KEY);
  const floorPrice = await opensea.getFloorPrice(readOnlySdk, slug);

  if (!floorPrice || floorPrice <= 0) {
    endAndReturnToMenu(chatId, 'Floor price not found, aborting');
    return;
  }

  session.data.floorPrice = floorPrice;
  bot.sendMessage(chatId, `Floor price: ${floorPrice}`);

  const listedMap = {};
  const walletsData = await Promise.all(PRIVATE_KEYS.map(async (pk) => {
    const wallet = new ethers.Wallet(pk, provider);
    const sdk = opensea.makeSdk(wallet, chain, OPENSEA_API_KEY);
    const notes = [];
    let items;

    if (session.flow === 'list') {
      // On-chain is the source of truth. OpenSea's indexer lags (sold NFTs linger, fresh mints
      // are missing), so it is only used to find candidates that are then verified on-chain.
      const result = await holdings.getHoldings({
        provider,
        contractAddress: session.data.contractAddress,
        wallet: wallet.address,
        loadCandidates: (balance) => opensea.getOwnedTokenIds(sdk, wallet.address, session.data.contractAddress, { stopAt: balance }),
      });
      items = result.ids;
      notes.push(...result.warnings);
      if (result.complete === false) {
        notes.push(`on-chain balance is ${result.balance} but only ${result.ids.length} found, recent NFTs may be missing`);
      }
      const activeListings = await opensea.getOpenListings(sdk, wallet.address, slug, session.data.contractAddress, chain);
      listedMap[wallet.address] = activeListings.map((l) => String(l.tokenId));
    } else {
      const listings = await opensea.getOpenListings(sdk, wallet.address, slug, session.data.contractAddress, chain);
      const verified = await holdings.filterOwned(provider, session.data.contractAddress, wallet.address, listings, (l) => l.tokenId);
      items = verified.items;
      if (verified.removed > 0) {
        notes.push(`${verified.removed} stale listing(s) hidden, token no longer owned`);
      }
    }

    return { wallet, items, notes };
  }));

  session.data.walletsData = walletsData;
  session.data.listedMap = listedMap;

  const verb = session.flow === 'list' ? 'holds' : 'lists';
  let menuText = '';
  walletsData.forEach((w, i) => {
    const listedCount = (listedMap[w.wallet.address] || []).length;
    menuText += `${i + 1}. ${shortAddr(w.wallet.address)} ${verb} ${w.items.length} NFT(s) from this collection${listedCount > 0 ? ` (${listedCount} already listed)` : ''}\n`;
    w.notes.forEach((note) => { menuText += `   note: ${note}\n`; });
  });
  bot.sendMessage(chatId, menuText.trim());

  if (session.flow === 'list' && session.data.fast) {
    const rawPrice = opensea.parsePriceInput(fastSettings.price, session.data.floorPrice);
    const price = opensea.roundPriceForChain(rawPrice, chainInput);

    if (!Number.isFinite(price) || price <= 0) {
      endAndReturnToMenu(chatId, `Invalid fast list price in settings (${fastSettings.price}), fix it in Settings`);
      return;
    }

    const scoped = walletsData.filter((w) => w.items.length > 0 && fastSettings.wallets[w.wallet.address] !== false);
    session.data.selections = scoped.map((w) => ({ wallet: w.wallet, items: w.items, price }));
    console.log(`fast list: ${session.data.selections.length} wallet(s), price=${price}`);

    if (session.data.selections.length === 0) {
      endAndReturnToMenu(chatId, 'No wallet enabled in Fast List settings, aborting');
      return;
    }

    await goToSummary(chatId, session);
    return;
  }

  if (session.flow === 'list') {
    session.step = 'awaiting_list_mode';
    sessionStore.setSession(chatId, session, bot);
    bot.sendMessage(chatId, 'Listing mode:', {
      reply_markup: {
        inline_keyboard: [[
          { text: 'Separate List', callback_data: 'mode_separate' },
          { text: 'Bulk List', callback_data: 'mode_bulk' },
        ]],
      },
    });
    return;
  }

  enterWalletPick(chatId, session);
}

function enterWalletPick(chatId, session) {
  const menuNumbers = session.data.walletsData.map((_, i) => i + 1).join('/');
  session.step = 'awaiting_wallet_pick';
  sessionStore.setSession(chatId, session, bot);
  bot.sendMessage(chatId, `Which one you want to ${session.mode} (${menuNumbers}/all)?`);
}

function showFastSettings(chatId) {
  sessionStore.setSession(chatId, { flow: null, step: 'awaiting_settings', data: {} }, bot);
  const rows = [[{ text: `Price: ${fastSettings.price}`, callback_data: 'set_price' }]];
  rows.push([{ text: `Confirmation: ${fastSettings.confirm === false ? 'OFF' : 'ON'}`, callback_data: 'set_confirm' }]);
  PRIVATE_KEYS.forEach((pk, i) => {
    const address = new ethers.Wallet(pk).address;
    const on = fastSettings.wallets[address] !== false;
    rows.push([{ text: `${shortAddr(address)}: ${on ? 'ON' : 'OFF'}`, callback_data: `setw_${i}` }]);
  });
  rows.push([{ text: 'Done', callback_data: 'set_done' }]);
  bot.sendMessage(chatId, 'Fast List settings — tap a wallet to toggle, price applies to every enabled wallet:', {
    reply_markup: { inline_keyboard: rows },
  });
}

function promptContract(chatId, session) {
  session.step = 'awaiting_contract';
  sessionStore.setSession(chatId, session, bot);
  const rows = caMemory.map((e, i) => [{ text: `${e.slug} (${e.chain})`, callback_data: `mem_${i}` }]);
  bot.sendMessage(chatId, rows.length ? 'Contract address, or pick recent:' : 'Contract address:', rows.length ? { reply_markup: { inline_keyboard: rows } } : undefined);
}

async function startDetection(chatId, session) {
  if (session.flow === 'mint') return startMintDetection(chatId, session);
  session.step = 'detecting_chain';
  sessionStore.setSession(chatId, session, bot);
  bot.sendMessage(chatId, 'Scanning chains...');
  const counts = await detectChainHoldings(session.data.contractAddress);
  console.log(`detect ${session.data.contractAddress}:`, JSON.stringify(counts));
  const withHoldings = counts.filter(([, total]) => total > 0);
  if (withHoldings.length === 1) {
    bot.sendMessage(chatId, `Chain detected: ${withHoldings[0][0]} (${withHoldings[0][1]} NFT)`);
    await resolveCollectionAndWallets(chatId, session, withHoldings[0][0]);
  } else if (withHoldings.length > 1) {
    session.step = 'awaiting_chain_pick';
    sessionStore.setSession(chatId, session, bot);
    bot.sendMessage(chatId, 'Holdings on multiple chains, pick one:', {
      reply_markup: {
        inline_keyboard: [
          withHoldings.map(([name, total]) => ({ text: `${name} (${total})`, callback_data: `chain_${name}` })),
        ],
      },
    });
  } else {
    session.step = 'awaiting_chain';
    sessionStore.setSession(chatId, session, bot);
    bot.sendMessage(chatId, 'No holdings found on any configured chain. Chain manually (ethereum/polygon/base/arc/robinhood, d = ethereum):');
  }
}

async function startMintDetection(chatId, session) {
  session.step = 'detecting_chain';
  sessionStore.setSession(chatId, session, bot);
  bot.sendMessage(chatId, 'Scanning chains for contract...');
  const present = await Promise.all(Object.entries(providers).map(async ([name, provider]) => {
    const code = await provider.getCode(session.data.contractAddress).catch(() => '0x');
    return [name, code !== '0x'];
  }));
  console.log(`mint chain detect ${session.data.contractAddress}:`, JSON.stringify(present));
  const live = present.filter(([, exists]) => exists).map(([name]) => name);
  if (live.length === 1) {
    bot.sendMessage(chatId, `Chain detected: ${live[0]}`);
    return resolveMint(chatId, session, live[0]);
  }
  if (live.length > 1) {
    session.step = 'awaiting_chain_pick';
    sessionStore.setSession(chatId, session, bot);
    return bot.sendMessage(chatId, 'Contract exists on multiple chains, pick one:', {
      reply_markup: { inline_keyboard: [live.map((name) => ({ text: name, callback_data: `chain_${name}` }))] },
    });
  }
  session.step = 'awaiting_chain';
  sessionStore.setSession(chatId, session, bot);
  bot.sendMessage(chatId, 'Contract not found on any configured chain. Chain manually (ethereum/polygon/base/arc/robinhood, d = ethereum):');
}

async function resolveMint(chatId, session, chainInput) {
  const provider = providers[chainInput];
  if (!provider) {
    console.log(`abort: no RPC for ${chainInput}`);
    return endAndReturnToMenu(chatId, `No RPC_URL configured for "${chainInput}" in .env, aborting`);
  }
  session.data.chainInput = chainInput;
  session.data.chain = opensea.CHAIN_MAP[chainInput];
  session.data.provider = provider;

  const minter = walletAddresses[0];
  const result = await mint.detect(provider, session.data.contractAddress, minter);
  console.log(`mint probe ${chainInput}:`, JSON.stringify(result, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
  if (result.error) return endAndReturnToMenu(chatId, result.error);
  session.data.mintSig = result.sig;
  session.data.mintName = result.name;
  session.data.collection = await mint.collectionName(provider, session.data.contractAddress) || shortAddr(session.data.contractAddress);
  session.data.minted = result.minted;

  const drop = await (async () => {
    try {
      const slug = await opensea.getCollectionSlug(chainInput, session.data.contractAddress, OPENSEA_API_KEY);
      session.data.slug = slug;
      return slug ? await mint.fetchDrop(slug) : null;
    } catch {
      return null;
    }
  })();

  if (drop && drop.stages.length > 0) {
    session.data.drop = drop;
    const active = mint.activeStage(drop);
    if (!active) {
      const elig = await mint.computeStageEligibility(drop, provider, session.data.contractAddress, walletWallets, session.data.mintSig, session.data.slug, OPENSEA_API_KEY);
      session.data.stageElig = elig;
      const upcomingPublic = drop.stages.some((s) => s.type === 'PUBLIC_SALE' && s.start > Date.now());
      session.step = 'mint_stages';
      sessionStore.setSession(chatId, session, bot);
      const keyboard = upcomingPublic
        ? [[{ text: 'Set schedule mint', callback_data: 'menu_sch' }, { text: 'Menu', callback_data: 'menu_home' }]]
        : [[{ text: 'Menu', callback_data: 'menu_home' }]];
      return bot.sendMessage(
        chatId,
        `${session.data.collection} — drop stages:\n${mint.describeStages(drop, elig)}\n\nNo stage open right now, come back when one starts.`,
        { reply_markup: { inline_keyboard: keyboard } },
      );
    }
    session.data.dropStage = active;
    const elig = await mint.computeStageEligibility(drop, provider, session.data.contractAddress, walletWallets, session.data.mintSig, session.data.slug, OPENSEA_API_KEY);
    session.data.stageElig = elig;
    const matrix = `${session.data.collection} — drop stages:\n${mint.describeStages(drop, elig)}`;
    const activeElig = elig.find((e) => e.stage.index === active.index);
    const upcomingPublic = drop.stages.some((s) => s.type === 'PUBLIC_SALE' && s.start > Date.now());
    if (!activeElig || activeElig.count === 0) {
      session.step = 'mint_stages';
      sessionStore.setSession(chatId, session, bot);
      const keyboard = upcomingPublic
        ? [[{ text: 'Set schedule mint', callback_data: 'menu_sch' }, { text: 'Menu', callback_data: 'menu_home' }]]
        : [[{ text: 'Menu', callback_data: 'menu_home' }]];
      const why = active.type !== 'PUBLIC_SALE'
        ? `\n\nActive stage "${active.label}" is ${active.type} — no wallet can plain-mint it (needs an OpenSea signature). The public stage above can be scheduled.`
        : '\n\nNo wallet eligible for the active stage.';
      return bot.sendMessage(chatId, matrix + why, { reply_markup: { inline_keyboard: keyboard } });
    }
    if (active.priceEth != null) {
      session.data.priceWei = ethers.parseEther(String(active.priceEth));
    } else {
      session.data.priceWei = result.price ?? 0n;
    }
    bot.sendMessage(chatId, matrix);
    return askMintQty(chatId, session);
  }

  if (!result.active && result.needsPrice) {
    session.step = 'awaiting_mint_price';
    sessionStore.setSession(chatId, session, bot);
    return bot.sendMessage(chatId, `Found ${result.name} (${session.data.collection}) but price not auto-detected (${result.reason}). Enter mint price (0 = free):`);
  }
  if (!result.active) {
    return endAndReturnToMenu(chatId, `Mint found (${session.data.collection}) but not available now: ${result.reason}`);
  }
  session.data.priceWei = result.price;
  askMintQty(chatId, session);
}

function askMintQty(chatId, session) {
  session.step = 'awaiting_mint_qty';
  sessionStore.setSession(chatId, session, bot);
  const stage = session.data.dropStage;
  const stageLine = stage ? `\nStage: ${stage.label} (${stage.type}), max ${stage.maxPerWallet ?? '?'}/wallet` : '';
  bot.sendMessage(chatId, `Mint detected: ${session.data.mintSig} at ${ethers.formatEther(session.data.priceWei)} each.${stageLine}\nHow many per wallet?`);
}

async function askMintWallets(chatId, session) {
  const balances = await Promise.all(walletAddresses.map((a) => session.data.provider.getBalance(a)));
  let eligible = null;
  const stageElig = session.data.dropStage && session.data.stageElig
    ? session.data.stageElig.find((x) => x.stage.index === session.data.dropStage.index)
    : null;
  if (stageElig && stageElig.reasons) {
    eligible = stageElig.reasons;
  } else if (session.data.dropStage) {
    eligible = await mint.checkEligibility(
      session.data.provider,
      session.data.contractAddress,
      walletAddresses,
      session.data.mintSig,
      session.data.priceWei,
    );
  }
  const lines = walletAddresses.map((a, i) => {
    const bal = Number(ethers.formatEther(balances[i])).toFixed(4);
    const mark = eligible ? (eligible[i].ok ? ' eligible' : ` NOT eligible (${eligible[i].reason.slice(0, 60)})`) : '';
    return `${i + 1}. ${shortAddr(a)} — ${bal} native${mark}`;
  }).join('\n');
  session.step = 'awaiting_mint_wallets';
  sessionStore.setSession(chatId, session, bot);
  const head = eligible
    ? `Stage: ${session.data.dropStage.label} — eligibility (simulated on-chain):\n`
    : 'Wallet balance (native):\n';
  bot.sendMessage(chatId, `${head}${lines}\n\nWhich wallets mint? (e.g. 1,3 or all)`);
}

function parseMintWallets(text) {
  const answer = text.trim().toLowerCase();
  if (answer === 'all') return walletAddresses.map((_, i) => i);
  return answer
    .split(',')
    .map((part) => parseInt(part.trim(), 10) - 1)
    .filter((i) => Number.isInteger(i) && i >= 0 && i < walletAddresses.length);
}

async function goToMintSummary(chatId, session, indexes) {
  if (indexes.length === 0) return endAndReturnToMenu(chatId, 'Nothing selected, aborting');
  session.data.selections = indexes.map((i) => ({
    index: i,
    wallet: new ethers.Wallet(PRIVATE_KEYS[i], session.data.provider),
    qty: session.data.mintQty,
  }));
  const total = session.data.selections.reduce((sum, s) => sum + session.data.priceWei * BigInt(s.qty), 0n);
  const lines = session.data.selections
    .map((s) => `${shortAddr(s.wallet.address)}: mint ${s.qty} × ${ethers.formatEther(session.data.priceWei)} = ${ethers.formatEther(session.data.priceWei * BigInt(s.qty))}`)
    .join('\n');
  const mintedLine = session.data.minted != null ? `\nWallet[0] already minted: ${session.data.minted}` : '';
  const stageLine = session.data.dropStage ? `\nStage: ${session.data.dropStage.label} (${session.data.dropStage.type})` : '';
  session.step = 'awaiting_confirm';
  sessionStore.setSession(chatId, session, bot);
  bot.sendMessage(chatId, `--- Mint Summary ---\n${session.data.collection}${stageLine}\n${lines}\nTotal: ${ethers.formatEther(total)} + gas${mintedLine}`, {
    reply_markup: {
      inline_keyboard: [[
        { text: 'Yes', callback_data: 'confirm_yes' },
        { text: 'No', callback_data: 'confirm_no' },
      ]],
    },
  });
}

async function runMint(provider, chainInput, ca, collection, mintSig, mintName, priceWei, qty, indexes, stageLabel, chatId) {
  const iface = new ethers.Interface([`function ${mintSig} payable`]);
  const slug = mintSchedulesSlug(ca, chainInput);
  const wallets = indexes.map((i) => new ethers.Wallet(PRIVATE_KEYS[i], provider));

  const [network, feeData, blockAtStart] = await Promise.all([provider.getNetwork(), provider.getFeeData(), provider.getBlockNumber()]);
  const probeWallet = wallets[0];
  let probeData;
  let probeTo = ca;
  let probeValue = priceWei * BigInt(qty);
  let gasLimit = null;
  if (slug && OPENSEA_API_KEY) {
    const built = await minttx.buildTx(OPENSEA_API_KEY, slug, probeWallet.address, qty);
    if (built.ok) {
      probeData = built.data;
      probeTo = built.to;
      probeValue = built.value;
      console.log(`mint route: os-api (slug=${slug})`);
    } else {
      throw new Error(`OS mint build: ${built.error}`);
    }
  } else {
    probeData = iface.encodeFunctionData(mintName, mint.mintArgs(mintSig, probeWallet.address, qty));
  }
  gasLimit = await provider
    .estimateGas({ to: probeTo, data: probeData, value: probeValue, from: probeWallet.address })
    .then((g) => (g * 120n) / 100n)
    .catch(() => 600000n);

  const results = await Promise.all(wallets.map(async (wallet) => {
    const base = { wallet: wallet.address };
    try {
      const [balance, nonce] = await Promise.all([
        provider.getBalance(wallet.address),
        provider.getTransactionCount(wallet.address, 'pending'),
      ]);
      const maxGasCost = gasLimit * (feeData.maxFeePerGas ?? feeData.gasPrice);
      const walletValue = priceWei * BigInt(qty);
      if (balance < walletValue + maxGasCost) return { ...base, status: 'skipped', error: 'insufficient balance' };
      let txTo = ca;
      let txData = iface.encodeFunctionData(mintName, mint.mintArgs(mintSig, wallet.address, qty));
      let txValue = walletValue;
      if (slug && OPENSEA_API_KEY) {
        const built = await minttx.buildTx(OPENSEA_API_KEY, slug, wallet.address, qty);
        if (built.ok) {
          txTo = built.to;
          txData = built.data;
          txValue = built.value;
        } else {
          return { ...base, status: 'failed', error: `OS mint: ${built.error.slice(0, 120)}` };
        }
      }
      const tx = {
        to: txTo,
        data: txData,
        value: txValue,
        nonce,
        chainId: network.chainId,
        gasLimit,
      };
      if (feeData.maxFeePerGas) {
        tx.type = 2;
        tx.maxFeePerGas = feeData.maxFeePerGas;
        tx.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas;
      } else {
        tx.gasPrice = feeData.gasPrice;
      }
      const t0 = Date.now();
      const signed = await wallet.signTransaction(tx);
      const sent = await provider.broadcastTransaction(signed);
      const msBroadcast = Date.now() - t0;
      const receipt = await Promise.race([sent.wait(), new Promise((resolve) => setTimeout(() => resolve(null), 60000))]);
      if (!receipt) return { ...base, status: 'pending', hash: sent.hash, msBroadcast };
      return receipt.status === 1
        ? { ...base, status: 'ok', hash: sent.hash, msBroadcast, msConfirm: Date.now() - t0, block: receipt.blockNumber }
        : { ...base, status: 'failed', error: 'mint reverted on-chain', msBroadcast, msConfirm: Date.now() - t0, block: receipt.blockNumber };
    } catch (err) {
      return { ...base, status: 'failed', error: err.message.slice(0, 150) };
    }
  }));

  const count = (status) => results.filter((r) => r.status === status).length;
  let text = `Mint done — ${collection}\nBlock start: ${blockAtStart}. Success: ${count('ok')}, failed: ${count('failed')}, skipped: ${count('skipped')}, pending: ${count('pending')}`;
  for (const r of results) {
    const timing = r.msBroadcast != null ? ` [${r.msBroadcast}ms broadcast${r.msConfirm != null ? `, ${r.msConfirm}ms confirmed${r.block ? `, block ${r.block}` : ''}]` : ']'}` : '';
    text += r.hash ? `\n${shortAddr(r.wallet)}: ${r.status} ${r.hash}${timing}` : `\n${shortAddr(r.wallet)}: ${r.error}`;
  }
  const historyPath = path.join(__dirname, 'mint-history.json');
  let history = [];
  try { history = JSON.parse(fs.readFileSync(historyPath, 'utf8')); } catch {}
  history.push({
    ts: new Date().toISOString(),
    chain: chainInput,
    ca,
    collection,
    stage: stageLabel || null,
    price: ethers.formatEther(priceWei),
    qtyPerWallet: qty,
    blockAtStart,
    wallets: results.map((r) => ({
      addr: r.wallet,
      status: r.status,
      hash: r.hash || null,
      msBroadcast: r.msBroadcast ?? null,
      msConfirm: r.msConfirm ?? null,
      block: r.block ?? null,
      error: r.error || null,
    })),
  });
  fs.writeFileSync(historyPath, JSON.stringify(history, null, 2));
  return { results, blockAtStart, text };
}

async function executeMint(chatId, session) {
  session.step = 'executing';
  sessionStore.setSession(chatId, session, bot);
  const indexes = session.data.selections.map((s) => s.index);
  bot.sendMessage(chatId, `Minting ${session.data.collection}: ${indexes.length} wallet(s)...`);
  const out = await runMint(
    session.data.provider,
    session.data.chainInput,
    session.data.contractAddress,
    session.data.collection,
    session.data.mintSig,
    session.data.mintName,
    session.data.priceWei,
    session.data.mintQty,
    indexes,
    session.data.dropStage ? session.data.dropStage.label : null,
    chatId,
  );
  endAndReturnToMenu(chatId, out.text.slice(0, 3900));
}

// ---- Schedule auto-mint ----

const SCH_PAGE = 5;

function schUpcomingStages(drop, elig) {
  const now = Date.now();
  const schedulable = new Set((elig || []).filter((e) => e.count > 0).map((e) => e.stage.index));
  return drop.stages
    .filter((s) => s.start > now && (s.type === 'PUBLIC_SALE' || schedulable.has(s.index)))
    .sort((a, b) => a.start - b.start);
}

async function enterScheduleMenu(chatId, session) {
  const drop = session.data.drop;
  const upcoming = schUpcomingStages(drop, session.data.stageElig);
  if (upcoming.length === 0) {
    return endAndReturnToMenu(chatId, 'No upcoming stage with an eligible wallet to schedule.');
  }
  if (upcoming.length > 1) {
    session.step = 'sch_stage_pick';
    sessionStore.setSession(chatId, session, bot);
    return bot.sendMessage(chatId, 'Which stage?', {
      reply_markup: {
        inline_keyboard: [
          ...upcoming.map((s) => [{ text: `${s.label} — ${mint.fmtRangeWIB(s.start, s.end)} WIB`, callback_data: `stage_${s.index}` }]),
          [{ text: 'Menu', callback_data: 'menu_home' }],
        ],
      },
    });
  }
  return enterSchWalletMenu(chatId, session, upcoming[0]);
}

async function enterSchWalletMenu(chatId, session, stage) {
  session.data.schStage = stage;
  session.data.schSel = [];
  const balances = await Promise.all(walletAddresses.map((a) => session.data.provider.getBalance(a)));
  const ready = balances.filter((b) => b > 0n).length;
  session.step = 'sch_menu';
  sessionStore.setSession(chatId, session, bot);
  bot.sendMessage(
    chatId,
    `Stage: ${stage.label}\n${mint.fmtRangeWIB(stage.start, stage.end)} WIB, ${stage.priceEth} ETH, max ${stage.maxPerWallet ?? '?'}/wallet\n${ready}/${walletAddresses.length} wallet ready (balance > 0). WL eligibility is re-checked automatically at execution.`,
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Bulk-mint', callback_data: 'sch_bulk' },
            { text: 'Separate-mint', callback_data: 'sch_sep' },
          ],
          [
            { text: 'See all wallet', callback_data: 'sch_seeall' },
            { text: 'Menu', callback_data: 'menu_home' },
          ],
        ],
      },
    },
  );
}

function renderSchSepPage(chatId, session) {
  const sel = session.data.schSel;
  const page = session.data.schPage;
  const start = page * SCH_PAGE;
  const slice = walletAddresses.slice(start, start + SCH_PAGE);
  const lines = slice.map((a, i) => {
    const idx = start + i;
    return `${idx + 1}. ${shortAddr(a)}${sel.includes(idx) ? ' [x]' : ''}`;
  });
  const more = walletAddresses.length - start - slice.length;
  if (more > 0) lines.push(`+${more} more...`);
  const pages = Math.ceil(walletAddresses.length / SCH_PAGE);
  const stage = session.data.schStage;
  session.step = 'schedule_sep';
  sessionStore.setSession(chatId, session, bot);
  const nav = pages > 1
    ? [[
        ...(page > 0 ? [{ text: '<-', callback_data: 'schp_prev' }] : []),
        { text: `${page + 1}/${pages}`, callback_data: 'schp_noop' },
        ...(page < pages - 1 ? [{ text: '->', callback_data: 'schp_next' }] : []),
      ]]
    : [];
  bot.sendMessage(
    chatId,
    `Which wallet? (tap number keys below, or type numbers like 1, 7, 8)\n${lines.join('\n')}\n\nSelected: ${sel.length > 0 ? sel.map((i) => i + 1).join(',') : 'none'}`,
    {
      reply_markup: {
        inline_keyboard: [
          ...nav,
          [{ text: `Done (${sel.length} selected)`, callback_data: 'schp_done' }],
          [{ text: 'Menu', callback_data: 'menu_home' }],
        ],
      },
    },
  );
}

function renderSchSeeAll(chatId, session) {
  const page = session.data.schPage;
  const start = page * 8;
  const slice = walletAddresses.slice(start, start + 8);
  const lines = slice.map((a, i) => `${start + i + 1}. ${a}`).join('\n');
  const pages = Math.ceil(walletAddresses.length / 8);
  session.step = 'schedule_seeall';
  sessionStore.setSession(chatId, session, bot);
  bot.sendMessage(chatId, `All wallets (${page + 1}/${pages}):\n${lines}`, {
    reply_markup: {
      inline_keyboard: [
        [
          ...(page > 0 ? [{ text: '<-', callback_data: 'see_prev' }] : []),
          ...(page < pages - 1 ? [{ text: '->', callback_data: 'see_next' }] : []),
        ],
        [{ text: 'Back', callback_data: 'sch_back' }],
      ],
    },
  });
}

async function askSchQty(chatId, session) {
  const max = session.data.schStage.maxPerWallet ?? 100;
  if (max <= 1) {
    session.data.schQty = 1;
    return schConfirm(chatId, session);
  }
  session.step = 'schedule_qty';
  sessionStore.setSession(chatId, session, bot);
  bot.sendMessage(chatId, `How many per wallet? (1-${max})`);
}

function schConfirm(chatId, session) {
  const sel = session.data.schSel;
  const stage = session.data.schStage;
  const qty = session.data.schQty;
  const priceWei = ethers.parseEther(String(stage.priceEth ?? 0));
  const total = priceWei * BigInt(qty) * BigInt(sel.length);
  session.step = 'schedule_confirm';
  sessionStore.setSession(chatId, session, bot);
  bot.sendMessage(
    chatId,
    `--- Schedule Mint ---\n${session.data.collection} — ${stage.label}\n${mint.fmtRangeWIB(stage.start, stage.end)} WIB\nPrice: ${stage.priceEth} ETH × ${qty}/wallet\nWallets (${sel.length}): ${sel.map((i) => shortAddr(walletAddresses[i])).join(', ')}\nTotal: ${ethers.formatEther(total)} ETH + gas\n\nBot fires automatically when the stage opens.`,
    {
      reply_markup: {
        inline_keyboard: [[
          { text: 'Yes schedule', callback_data: 'sch_confirm_yes' },
          { text: 'Menu', callback_data: 'menu_home' },
        ]],
      },
    },
  );
}

async function fireSchedule(s) {
  schedules.mark(s.id, 'fired');
  const provider = providers[s.chain];
  if (!provider) return bot.sendMessage(s.chatId, `Auto-mint ${s.collection}: no RPC for ${s.chain}, aborting`);
  // price sanity: stage price at fire time (OS build also validates balance server-side)
  let priceWei = ethers.parseEther(String(s.priceEth));
  try {
    const drop = await mint.fetchDrop(s.slug);
    const st = drop && drop.stages.find((x) => x.index === s.stageIndex);
    if (st && Date.now() >= st.start && Date.now() <= st.end && st.priceEth != null) priceWei = ethers.parseEther(String(st.priceEth));
  } catch {}
  bot.sendMessage(s.chatId, `Auto-mint ${s.collection} — "${s.label}" is open! Firing ${s.wallets.length} wallet(s) × ${s.qty}...`);
  try {
    const out = await runMint(provider, s.chain, s.ca, s.collection, s.mintSig, s.mintName, priceWei, s.qty, s.wallets, s.label, s.chatId);
    bot.sendMessage(s.chatId, out.text.slice(0, 3900));
  } catch (err) {
    bot.sendMessage(s.chatId, `Auto-mint failed: ${err.message.slice(0, 200)}`);
  }
}

schedules.init(fireSchedule);

async function handleStep(chatId, session, text) {
  switch (session.step) {
    case 'awaiting_contract': {
      const address = text.trim();
      if (!ethers.isAddress(address)) {
        bot.sendMessage(chatId, 'Not a valid contract address, try again:');
        return;
      }
      session.data.contractAddress = address;
      await startDetection(chatId, session);
      break;
    }

    case 'awaiting_chain': {
      const rawChain = (text || '').trim().toLowerCase();
      const chainInput = rawChain === 'd' ? 'ethereum' : rawChain;

      if (!opensea.CHAIN_MAP[chainInput]) {
        bot.sendMessage(chatId, 'Unsupported chain, try again:');
        return;
      }

      await resolveForFlow(chatId, session, chainInput);
      break;
    }

    case 'awaiting_mint_price': {
      let wei = null;
      try {
        wei = ethers.parseEther(text.trim());
      } catch {}
      if (wei === null || wei < 0n) {
        bot.sendMessage(chatId, 'Invalid price, try again (0 = free):');
        return;
      }
      const check = await mint.checkWithPrice(session.data.provider, session.data.contractAddress, walletAddresses[0], session.data.mintSig, wei);
      if (!check.active) {
        endAndReturnToMenu(chatId, `Mint still not available: ${check.reason}`);
        return;
      }
      session.data.priceWei = wei;
      session.data.collection = session.data.collection || await mint.collectionName(session.data.provider, session.data.contractAddress) || shortAddr(session.data.contractAddress);
      askMintQty(chatId, session);
      break;
    }

    case 'awaiting_mint_qty': {
      const qty = parseInt(text, 10);
      if (!Number.isInteger(qty) || qty < 1 || qty > 100) {
        bot.sendMessage(chatId, 'Enter a count between 1 and 100:');
        return;
      }
      session.data.mintQty = qty;
      await askMintWallets(chatId, session);
      break;
    }

    case 'awaiting_mint_wallets': {
      await goToMintSummary(chatId, session, parseMintWallets(text));
      break;
    }

    case 'schedule_bulk_count': {
      const n = parseInt(text, 10);
      const total = walletAddresses.length;
      if (!Number.isInteger(n) || n < 1 || n > total) {
        bot.sendMessage(chatId, `Enter a count between 1 and ${total}:`);
        return;
      }
      session.data.schSel = walletAddresses.map((_, i) => i).slice(0, n);
      await askSchQty(chatId, session);
      break;
    }

    case 'schedule_qty': {
      const max = session.data.schStage.maxPerWallet ?? 100;
      const qty = parseInt(text, 10);
      if (!Number.isInteger(qty) || qty < 1 || qty > max) {
        bot.sendMessage(chatId, `Enter a count between 1 and ${max}:`);
        return;
      }
      session.data.schQty = qty;
      schConfirm(chatId, session);
      break;
    }

    case 'schedule_sep': {
      const nums = text.split(',').map((p) => parseInt(p.trim(), 10) - 1);
      const valid = nums.filter((i) => Number.isInteger(i) && i >= 0 && i < walletAddresses.length);
      if (valid.length === 0) {
        bot.sendMessage(chatId, 'No valid wallet numbers, try again (e.g. 1, 7, 8):');
        return;
      }
      const sel = new Set(session.data.schSel);
      for (const i of valid) {
        if (sel.has(i)) sel.delete(i);
        else sel.add(i);
      }
      session.data.schSel = [...sel].sort((a, b) => a - b);
      renderSchSepPage(chatId, session);
      break;
    }

    case 'awaiting_wallet_pick': {
      const answer = text.trim().toLowerCase();
      let chosen;

      if (answer === 'all') {
        chosen = session.data.walletsData.filter((w) => w.items.length > 0);
        const excluded = session.data.walletsData.length - chosen.length;
        if (excluded > 0) {
          bot.sendMessage(chatId, `Excluded ${excluded} wallet(s) with no NFTs from this collection`);
        }
      } else {
        const idx = parseInt(answer, 10) - 1;
        const picked = session.data.walletsData[idx];

        if (!picked || picked.items.length === 0) {
          endAndReturnToMenu(chatId, 'Invalid selection or wallet has no NFTs, aborting');
          return;
        }

        chosen = [picked];
      }

      session.data.chosenWallets = chosen;
      session.data.selections = [];
      session.data.walletCursor = 0;
      session.step = 'awaiting_count';
      sessionStore.setSession(chatId, session, bot);
      askCountForCurrentWallet(chatId, session);
      break;
    }

    case 'awaiting_count': {
      const currentWallet = session.data.chosenWallets[session.data.walletCursor];
      const count = Math.min(parseInt(text, 10) || 0, currentWallet.items.length);

      if (count === 0) {
        advanceWalletCursor(chatId, session);
        return;
      }

      session.data.currentCount = count;

      if (session.flow === 'list' || session.mode === 'reprice') {
        session.step = 'awaiting_price';
        sessionStore.setSession(chatId, session, bot);
        bot.sendMessage(chatId, 'Price per NFT: enter a number, or a % like -40% for discount off floor (d = floor -10%):');
      } else {
        finalizeWalletSelection(chatId, session, currentWallet, count, null);
      }
      break;
    }

    case 'awaiting_price': {
      const currentWallet = session.data.chosenWallets[session.data.walletCursor];
      const rawPrice = opensea.parsePriceInput(text, session.data.floorPrice);
      const price = opensea.roundPriceForChain(rawPrice, session.data.chain);

      if (!Number.isFinite(price) || price <= 0) {
        bot.sendMessage(chatId, 'Invalid price (use a number > 0, a % like -40%, or d), try again:');
        return;
      }

      finalizeWalletSelection(chatId, session, currentWallet, session.data.currentCount, price);
      break;
    }

    case 'awaiting_settings_price': {
      const raw = opensea.parsePriceInput(text, 1);
      if (!Number.isFinite(raw)) {
        bot.sendMessage(chatId, 'Invalid (use a number or % like -40%), try again:');
        return;
      }
      fastSettings.price = text.trim();
      saveFastSettings();
      showFastSettings(chatId);
      break;
    }

    case 'awaiting_bulk_count': {
      const maxTotal = session.data.walletsData.reduce((sum, w) => sum + w.items.length, 0);
      const count = Math.min(parseInt(text, 10) || 0, maxTotal);

      if (count === 0) {
        endAndReturnToMenu(chatId, 'Nothing selected, aborting');
        return;
      }

      session.data.bulkCount = count;
      session.step = 'awaiting_bulk_price';
      sessionStore.setSession(chatId, session, bot);
      bot.sendMessage(chatId, 'Price per NFT: enter a number, or a % like -40% for discount off floor (d = floor -10%):');
      break;
    }

    case 'awaiting_bulk_price': {
      const rawPrice = opensea.parsePriceInput(text, session.data.floorPrice);
      const price = opensea.roundPriceForChain(rawPrice, session.data.chain);

      if (!Number.isFinite(price) || price <= 0) {
        bot.sendMessage(chatId, 'Invalid price (use a number > 0, a % like -40%, or d), try again:');
        return;
      }

      session.data.selections = [];
      let remaining = session.data.bulkCount;
      for (const w of session.data.walletsData) {
        if (remaining <= 0) break;
        const take = Math.min(remaining, w.items.length);
        if (take > 0) {
          session.data.selections.push({ wallet: w.wallet, items: w.items.slice(0, take), price });
          remaining -= take;
        }
      }

      if (session.data.selections.length === 0) {
        endAndReturnToMenu(chatId, 'Nothing selected, aborting');
        return;
      }

      await goToSummary(chatId, session);
      break;
    }

    default:
      break;
  }
}

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  if (!isAuthorized(msg.from.id)) return;
  if (isBusy(chatId)) return bot.sendMessage(chatId, 'Still executing, please wait until it finishes');
  showMainMenu(chatId);
});

bot.onText(/\/manage-listing/, (msg) => {
  const chatId = msg.chat.id;
  if (!isAuthorized(msg.from.id)) return;
  if (isBusy(chatId)) return bot.sendMessage(chatId, 'Still executing, please wait until it finishes');
  sessionStore.setSession(chatId, { flow: 'manage', step: 'awaiting_mode', data: {} }, bot);
  bot.sendMessage(chatId, 'Choose action:', {
    reply_markup: {
      inline_keyboard: [[
        { text: 'Reprice', callback_data: 'mode_reprice' },
        { text: 'Close', callback_data: 'mode_close' },
      ]],
    },
  });
});

bot.on('polling_error', (err) => console.log('polling_error:', err.code, err.message));

bot.on('callback_query', async (query) => {
  console.log(`cb received: ${query.data}`);
  const chatId = query.message.chat.id;

  try {
    await handleCallback(chatId, query);
  } catch (err) {
    console.log(`callback error ${query.data}:`, err.message);
    try { await bot.answerCallbackQuery(query.id, { text: 'Error' }); } catch {}
    endAndReturnToMenu(chatId, `Error: ${err.message}`);
  }
});

async function handleCallback(chatId, query) {
  if (!isAuthorized(query.from.id)) {
    return bot.answerCallbackQuery(query.id, { text: 'Unauthorized' });
  }

  // Menu buttons always work, even on an old menu message or after a restart/timeout.
  if (['menu_listing', 'menu_manage', 'menu_fastlist', 'menu_settings', 'menu_mint'].includes(query.data)) {
    console.log(`menu tap: ${query.data}`);
    if (isBusy(chatId)) {
      return bot.answerCallbackQuery(query.id, { text: 'Still executing, please wait' });
    }

    await bot.answerCallbackQuery(query.id);

    if (query.data === 'menu_listing') {
      const session = { flow: 'list', step: 'awaiting_contract', data: {} };
      sessionStore.setSession(chatId, session, bot);
      return promptContract(chatId, session);
    }

    if (query.data === 'menu_mint') {
      const session = { flow: 'mint', step: 'awaiting_contract', data: {} };
      sessionStore.setSession(chatId, session, bot);
      return promptContract(chatId, session);
    }

    if (query.data === 'menu_fastlist') {
      sessionStore.setSession(chatId, { flow: 'list', step: 'awaiting_contract', data: { fast: true } }, bot);
      return promptContract(chatId, { flow: 'list', step: 'awaiting_contract', data: { fast: true } });
    }

    if (query.data === 'menu_settings') {
      return showFastSettings(chatId);
    }

    sessionStore.setSession(chatId, { flow: 'manage', step: 'awaiting_mode', data: {} }, bot);
    return bot.sendMessage(chatId, 'Choose action:', {
      reply_markup: {
        inline_keyboard: [[
          { text: 'Reprice', callback_data: 'mode_reprice' },
          { text: 'Close', callback_data: 'mode_close' },
        ]],
      },
    });
  }

  if (query.data === 'manage_recent') {
    if (isBusy(chatId)) {
      return bot.answerCallbackQuery(query.id, { text: 'Still executing, please wait' });
    }
    const recent = caMemory[0];
    if (!recent) {
      return bot.answerCallbackQuery(query.id, { text: 'No recent collection yet' });
    }
    await bot.answerCallbackQuery(query.id);
    sessionStore.setSession(chatId, { flow: 'manage', step: 'awaiting_mode', data: { contractAddress: recent.address } }, bot);
    return bot.sendMessage(chatId, `Manage ${recent.slug} (${recent.chain}):`, {
      reply_markup: {
        inline_keyboard: [[
          { text: 'Reprice', callback_data: 'mode_reprice' },
          { text: 'Close', callback_data: 'mode_close' },
        ]],
      },
    });
  }

  const session = sessionStore.getSession(chatId);

  // Stale button (session timed out / bot restarted): recover to the menu instead of a dead end.
  if (!session) {
    await bot.answerCallbackQuery(query.id, { text: 'Session expired' });
    return showMainMenu(chatId);
  }

  if (query.data === 'mode_reprice' || query.data === 'mode_close') {
    if (session.step !== 'awaiting_mode') {
      return bot.answerCallbackQuery(query.id, { text: 'Button no longer valid' });
    }
    session.mode = query.data === 'mode_reprice' ? 'reprice' : 'close';
    await bot.answerCallbackQuery(query.id);
    if (session.data.contractAddress) {
      return startDetection(chatId, session);
    }
    return promptContract(chatId, session);
  }

  if (query.data === 'start_list' || query.data === 'start_manage' || query.data === 'start_mint') {
    if (session.step !== 'awaiting_start_mode') {
      return bot.answerCallbackQuery(query.id, { text: 'Button no longer valid' });
    }
    await bot.answerCallbackQuery(query.id);
    if (query.data === 'start_list') {
      session.flow = 'list';
      return startDetection(chatId, session);
    }
    if (query.data === 'start_mint') {
      session.flow = 'mint';
      return startDetection(chatId, session);
    }
    if (query.data === 'start_fastlist') {
      session.flow = 'list';
      session.data.fast = true;
      return startDetection(chatId, session);
    }
    session.flow = 'manage';
    session.step = 'awaiting_mode';
    sessionStore.setSession(chatId, session, bot);
    return bot.sendMessage(chatId, 'Choose action:', {
      reply_markup: {
        inline_keyboard: [[
          { text: 'Reprice', callback_data: 'mode_reprice' },
          { text: 'Close', callback_data: 'mode_close' },
        ]],
      },
    });
  }

  if (query.data.startsWith('mem_')) {
    if (session.step !== 'awaiting_contract') {
      return bot.answerCallbackQuery(query.id, { text: 'Button no longer valid' });
    }
    const entry = caMemory[Number(query.data.slice(4))];
    if (!entry) {
      return bot.answerCallbackQuery(query.id, { text: 'Not found' });
    }
    await bot.answerCallbackQuery(query.id);
    session.data.contractAddress = entry.address;
    return startDetection(chatId, session);
  }

  if (query.data === 'set_price' || query.data === 'set_confirm' || query.data === 'set_done' || query.data.startsWith('setw_')) {
    if (!session || session.step !== 'awaiting_settings') {
      return bot.answerCallbackQuery(query.id, { text: 'Button no longer valid' });
    }
    await bot.answerCallbackQuery(query.id);

    if (query.data === 'set_price') {
      session.step = 'awaiting_settings_price';
      sessionStore.setSession(chatId, session, bot);
      return bot.sendMessage(chatId, 'New price: a number, or % off floor like -40%:');
    }

    if (query.data.startsWith('setw_')) {
      const address = new ethers.Wallet(PRIVATE_KEYS[Number(query.data.slice(5))]).address;
      fastSettings.wallets[address] = fastSettings.wallets[address] === false;
      saveFastSettings();
      return showFastSettings(chatId);
    }

    if (query.data === 'set_confirm') {
      fastSettings.confirm = fastSettings.confirm === false;
      saveFastSettings();
      return showFastSettings(chatId);
    }

    return showMainMenu(chatId, 'Fast List settings saved');
  }

  if (query.data.startsWith('chain_')) {
    if (session.step !== 'awaiting_chain_pick') {
      return bot.answerCallbackQuery(query.id, { text: 'Button no longer valid' });
    }
    await bot.answerCallbackQuery(query.id);
    return resolveForFlow(chatId, session, query.data.slice(6));
  }

  if (query.data === 'menu_home') {
    await bot.answerCallbackQuery(query.id);
    sessionStore.setSession(chatId, { flow: null, step: 'main_menu', data: {} }, bot);
    return showMainMenu(chatId);
  }

  if (query.data === 'menu_sch') {
    if (session.step !== 'mint_stages') {
      return bot.answerCallbackQuery(query.id, { text: 'Button no longer valid' });
    }
    await bot.answerCallbackQuery(query.id);
    return enterScheduleMenu(chatId, session);
  }

  if (query.data.startsWith('stage_')) {
    if (session.step !== 'sch_stage_pick') {
      return bot.answerCallbackQuery(query.id, { text: 'Button no longer valid' });
    }
    await bot.answerCallbackQuery(query.id);
    const idx = Number(query.data.slice(6));
    const stage = session.data.drop.stages.find((s) => s.index === idx);
    if (!stage) return endAndReturnToMenu(chatId, 'Stage not found, aborting');
    return enterSchWalletMenu(chatId, session, stage);
  }

  if (query.data === 'sch_bulk') {
    if (session.step !== 'sch_menu') {
      return bot.answerCallbackQuery(query.id, { text: 'Button no longer valid' });
    }
    await bot.answerCallbackQuery(query.id);
    session.step = 'schedule_bulk_count';
    sessionStore.setSession(chatId, session, bot);
    return bot.sendMessage(chatId, `How many wallets to mint? (1-${walletAddresses.length}, fills wallets in order)`);
  }

  if (query.data === 'sch_sep') {
    if (session.step !== 'sch_menu') {
      return bot.answerCallbackQuery(query.id, { text: 'Button no longer valid' });
    }
    await bot.answerCallbackQuery(query.id);
    session.data.schSel = [];
    session.data.schPage = 0;
    return renderSchSepPage(chatId, session);
  }

  if (query.data === 'schp_next' || query.data === 'schp_prev') {
    if (session.step !== 'schedule_sep') {
      return bot.answerCallbackQuery(query.id, { text: 'Button no longer valid' });
    }
    await bot.answerCallbackQuery(query.id);
    session.data.schPage += query.data === 'schp_next' ? 1 : -1;
    return renderSchSepPage(chatId, session);
  }

  if (query.data === 'schp_noop') {
    return bot.answerCallbackQuery(query.id);
  }

  if (query.data === 'schp_done') {
    if (session.step !== 'schedule_sep') {
      return bot.answerCallbackQuery(query.id, { text: 'Button no longer valid' });
    }
    await bot.answerCallbackQuery(query.id);
    if (session.data.schSel.length === 0) {
      return bot.answerCallbackQuery(query.id, { text: 'Select at least one wallet first' });
    }
    return askSchQty(chatId, session);
  }

  if (query.data === 'sch_seeall') {
    if (session.step !== 'sch_menu') {
      return bot.answerCallbackQuery(query.id, { text: 'Button no longer valid' });
    }
    await bot.answerCallbackQuery(query.id);
    session.data.schPage = 0;
    return renderSchSeeAll(chatId, session);
  }

  if (query.data === 'see_next' || query.data === 'see_prev') {
    if (session.step !== 'schedule_seeall') {
      return bot.answerCallbackQuery(query.id, { text: 'Button no longer valid' });
    }
    await bot.answerCallbackQuery(query.id);
    session.data.schPage += query.data === 'see_next' ? 1 : -1;
    return renderSchSeeAll(chatId, session);
  }

  if (query.data === 'sch_back') {
    if (session.step !== 'schedule_seeall') {
      return bot.answerCallbackQuery(query.id, { text: 'Button no longer valid' });
    }
    await bot.answerCallbackQuery(query.id);
    session.step = 'sch_menu';
    sessionStore.setSession(chatId, session, bot);
    return bot.sendMessage(chatId, `Stage: ${session.data.schStage.label} — pick a mode:`, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Bulk-mint', callback_data: 'sch_bulk' },
            { text: 'Separate-mint', callback_data: 'sch_sep' },
          ],
          [
            { text: 'See all wallet', callback_data: 'sch_seeall' },
            { text: 'Menu', callback_data: 'menu_home' },
          ],
        ],
      },
    });
  }

  if (query.data === 'sch_confirm_yes') {
    if (session.step !== 'schedule_confirm') {
      return bot.answerCallbackQuery(query.id, { text: 'Nothing to confirm' });
    }
    await bot.answerCallbackQuery(query.id);
    const stage = session.data.schStage;
    const schedule = {
      id: Date.now().toString(36),
      chatId,
      chain: session.data.chainInput,
      ca: session.data.contractAddress,
      slug: session.data.slug,
      collection: session.data.collection,
      stageIndex: stage.index,
      label: stage.label,
      type: stage.type,
      startMs: stage.start,
      endMs: stage.end,
      priceEth: stage.priceEth ?? 0,
      qty: session.data.schQty,
      wallets: session.data.schSel,
      mintSig: session.data.mintSig,
      mintName: session.data.mintName,
      status: 'pending',
    };
    schedules.add(schedule);
    session.step = 'scheduled';
    sessionStore.setSession(chatId, session, bot);
    return endAndReturnToMenu(chatId, `Scheduled ✓ #${schedule.id}\n${schedule.collection} — ${schedule.label}\n${mint.fmtRangeWIB(schedule.startMs, schedule.endMs)} WIB\n${schedule.wallets.length} wallet × ${schedule.qty}, ${schedule.priceEth} ETH each.\nBot fires automatically.`);
  }

  if (query.data === 'mode_separate' || query.data === 'mode_bulk') {
    if (session.step !== 'awaiting_list_mode') {
      return bot.answerCallbackQuery(query.id, { text: 'Button no longer valid' });
    }
    await bot.answerCallbackQuery(query.id);
    if (query.data === 'mode_separate') {
      return enterWalletPick(chatId, session);
    }
    const maxTotal = session.data.walletsData.reduce((sum, w) => sum + w.items.length, 0);
    if (maxTotal === 0) {
      return endAndReturnToMenu(chatId, 'No wallets hold NFTs from this collection, aborting');
    }
    session.step = 'awaiting_bulk_count';
    sessionStore.setSession(chatId, session, bot);
    return bot.sendMessage(chatId, `How many NFTs total (max ${maxTotal}, fills wallets in order)?`);
  }

  if (query.data === 'confirm_yes' || query.data === 'confirm_no') {
    // guards against double taps and old summary buttons
    if (session.step !== 'awaiting_confirm') {
      return bot.answerCallbackQuery(query.id, { text: 'Nothing to confirm' });
    }

    // claim the state synchronously, BEFORE any await, so a second tap can't slip in
    const confirmed = query.data === 'confirm_yes';
    session.step = confirmed ? 'executing' : 'cancelled';

    await bot.answerCallbackQuery(query.id);

    if (!confirmed) {
      return endAndReturnToMenu(chatId, 'Cancelled');
    }

    return session.flow === 'mint' ? executeMint(chatId, session) : executeAction(chatId, session);
  }
}

bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;

  const chatId = msg.chat.id;
  if (!isAuthorized(msg.from.id)) return;

  const session = sessionStore.getSession(chatId);
  const text = msg.text.trim();

  if (CA_REGEX.test(text) && (!session || session.step === 'main_menu')) {
    if (isBusy(chatId)) return bot.sendMessage(chatId, 'Still executing, please wait until it finishes');
    sessionStore.setSession(chatId, { flow: null, step: 'awaiting_start_mode', data: { contractAddress: text } }, bot);
    return bot.sendMessage(chatId, 'What do you want to do with this collection?', {
      reply_markup: {
        inline_keyboard: [[
          { text: 'Fast List', callback_data: 'start_fastlist' },
          { text: 'Listing', callback_data: 'start_list' },
          { text: 'Manage Listing', callback_data: 'start_manage' },
        ], [
          { text: 'Mint', callback_data: 'start_mint' },
        ]],
      },
    });
  }

  // nothing to handle while idle on the menu; don't re-arm a timer for it
  if (!session || session.step === 'main_menu') return;

  sessionStore.setSession(chatId, session, bot);

  try {
    await handleStep(chatId, session, msg.text);
  } catch (err) {
    endAndReturnToMenu(chatId, `Error: ${err.message}`);
  }
});

sessionStore.configureTimeoutHandler((chatId) => {
  showMainMenu(chatId, 'Session timed out after 3 minutes of inactivity.');
});

bot.on('polling_error', (err) => {
  console.log('Polling error:', err.message);
});

const armed = schedules.armAll();
if (armed > 0) console.log(`armed ${armed} mint schedule(s)`);

console.log('Bot running');
