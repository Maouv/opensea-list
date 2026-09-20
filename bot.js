require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { ethers } = require('ethers');
const opensea = require('./lib/opensea');
const sessionStore = require('./lib/session');

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const AUTHORIZED_USER_ID = process.env.TELEGRAM_USER_ID;
const OPENSEA_API_KEY = process.env.OPENSEA_API_KEY;
const PRIVATE_KEYS = process.env.PRIVATE_KEYS.split(',').map((k) => k.trim());
const DELAY_MS = 3000;
const LISTING_DURATION_DAYS = 7;

const RPC_URLS = {
  ethereum: process.env.RPC_URL_ETHEREUM,
  polygon: process.env.RPC_URL_POLYGON,
  base: process.env.RPC_URL_BASE,
  arc: process.env.RPC_URL_ARC,
  robinhood: process.env.RPC_URL_ROBINHOOD,
};

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAuthorized(id) {
  return String(id) === String(AUTHORIZED_USER_ID);
}

function endAndReturnToMenu(chatId) {
  sessionStore.endSession(chatId);
  showMainMenu(chatId);
}

function showMainMenu(chatId) {
  sessionStore.setSession(chatId, { flow: null, step: 'main_menu', data: {} }, bot);
  bot.sendMessage(chatId, 'What do you want to do?', {
    reply_markup: {
      inline_keyboard: [[
        { text: 'Listing', callback_data: 'menu_listing' },
        { text: 'Manage Listing', callback_data: 'menu_manage' },
      ]],
    },
  });
}

function askCountForCurrentWallet(chatId, session) {
  const w = session.data.chosenWallets[session.data.walletCursor];
  bot.sendMessage(chatId, `How many from ${w.wallet.address} (max ${w.items.length}, 0 to skip)?`);
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
    bot.sendMessage(chatId, 'Nothing selected, aborting');
    endAndReturnToMenu(chatId);
    return;
  }

  let summary = '--- Summary ---\n';
  let totalGasEth = 0;

  if (session.flow === 'list') {
    for (const selection of session.data.selections) {
      const gasInfo = await opensea.estimateApprovalGas(selection.wallet, session.data.contractAddress, session.data.provider, session.data.chain);
      selection.gasNeeded = gasInfo.needed;
      totalGasEth += gasInfo.costEth;
      summary += `${selection.wallet.address}: list ${selection.items.length} NFT(s) at ${selection.price} each${gasInfo.needed ? ` (approval needed, ~${gasInfo.costEth.toFixed(5)} ETH gas)` : ''}\n`;
    }
    summary += `Estimated total approval gas: ~${totalGasEth.toFixed(5)} ETH`;
  } else if (session.mode === 'close') {
    for (const selection of session.data.selections) {
      summary += `${selection.wallet.address}: close ${selection.items.length} listing(s), no gas\n`;
    }
  } else {
    for (const selection of session.data.selections) {
      summary += `${selection.wallet.address}: reprice ${selection.items.length} listing(s) to ${selection.price} each, no gas\n`;
    }
  }

  bot.sendMessage(chatId, summary.trim(), {
    reply_markup: {
      inline_keyboard: [[
        { text: 'Yes', callback_data: 'confirm_yes' },
        { text: 'No', callback_data: 'confirm_no' },
      ]],
    },
  });

  session.step = 'awaiting_confirm';
  sessionStore.setSession(chatId, session, bot);
}

async function executeAction(chatId, session) {
  bot.sendMessage(chatId, 'Executing...');
  let successCount = 0;
  let skippedCount = 0;
  const expirationTime = Math.round(Date.now() / 1000 + 60 * 60 * 24 * LISTING_DURATION_DAYS);

  for (const selection of session.data.selections) {
    const sdk = opensea.makeSdk(selection.wallet, session.data.chain, OPENSEA_API_KEY);

    for (const item of selection.items) {
      const tokenId = session.flow === 'list' ? item : item.tokenId;

      const stillOwned = await opensea.checkStillOwned(session.data.contractAddress, tokenId, selection.wallet.address, session.data.provider);

      if (!stillOwned) {
        bot.sendMessage(chatId, `Token ${tokenId} no longer owned by ${selection.wallet.address}, likely sold — skipped`);
        skippedCount += 1;
        await sleep(DELAY_MS);
        continue;
      }

      try {
        if (session.flow === 'list') {
          await sdk.createListing({
            asset: { tokenId, tokenAddress: session.data.contractAddress },
            accountAddress: selection.wallet.address,
            amount: selection.price,
            expirationTime,
          });
          bot.sendMessage(chatId, `${selection.wallet.address} listed token ${tokenId} at ${selection.price}`);
        } else if (session.mode === 'close') {
          await sdk.api.orders.offchainCancelOrder(item.protocolAddress, item.orderHash, session.data.chain);
          bot.sendMessage(chatId, `${selection.wallet.address} closed listing for token ${tokenId}`);
        } else {
          await sdk.api.orders.offchainCancelOrder(item.protocolAddress, item.orderHash, session.data.chain);
          await sdk.createListing({
            asset: { tokenId, tokenAddress: session.data.contractAddress },
            accountAddress: selection.wallet.address,
            amount: selection.price,
            expirationTime,
          });
          bot.sendMessage(chatId, `${selection.wallet.address} repriced token ${tokenId} to ${selection.price}`);
        }
        successCount += 1;
      } catch (err) {
        bot.sendMessage(chatId, `Failed on token ${tokenId}: ${err.message}`);
      }

      await sleep(DELAY_MS);
    }
  }

  bot.sendMessage(chatId, `Done. Success: ${successCount}, skipped due to race condition: ${skippedCount}`);
  endAndReturnToMenu(chatId);
}

async function handleStep(chatId, session, text) {
  switch (session.step) {
    case 'awaiting_contract': {
      session.data.contractAddress = text.trim();
      session.step = 'awaiting_chain';
      sessionStore.setSession(chatId, session, bot);
      bot.sendMessage(chatId, 'Chain (ethereum/polygon/base/arc/robinhood, blank = ethereum):');
      break;
    }

    case 'awaiting_chain': {
      const chainInput = (text || '').trim().toLowerCase() || 'ethereum';
      const chain = opensea.CHAIN_MAP[chainInput];

      if (!chain) {
        bot.sendMessage(chatId, 'Unsupported chain, try again:');
        return;
      }

      const rpcUrl = RPC_URLS[chainInput];

      if (!rpcUrl) {
        bot.sendMessage(chatId, `No RPC_URL configured for "${chainInput}" in .env, aborting`);
        endAndReturnToMenu(chatId);
        return;
      }

      session.data.chainInput = chainInput;
      session.data.chain = chain;
      session.data.provider = new ethers.JsonRpcProvider(rpcUrl);

      const slug = await opensea.getCollectionSlug(chainInput, session.data.contractAddress, OPENSEA_API_KEY);

      if (!slug) {
        bot.sendMessage(chatId, 'Could not resolve collection from this contract address, aborting');
        endAndReturnToMenu(chatId);
        return;
      }

      session.data.slug = slug;
      bot.sendMessage(chatId, `Collection detected: ${slug}`);

      const readOnlySdk = opensea.makeSdk(session.data.provider, chain, OPENSEA_API_KEY);
      const floorPrice = await opensea.getFloorPrice(readOnlySdk, slug);

      if (!floorPrice || floorPrice <= 0) {
        bot.sendMessage(chatId, 'Floor price not found, aborting');
        endAndReturnToMenu(chatId);
        return;
      }

      session.data.floorPrice = floorPrice;
      bot.sendMessage(chatId, `Floor price: ${floorPrice}`);

      const walletsData = [];

      for (const pk of PRIVATE_KEYS) {
        const wallet = new ethers.Wallet(pk, session.data.provider);
        const sdk = opensea.makeSdk(wallet, chain, OPENSEA_API_KEY);
        const items = session.flow === 'list'
          ? await opensea.getOwnedTokenIds(sdk, wallet.address, session.data.contractAddress)
          : await opensea.getOpenListings(sdk, wallet.address, slug, session.data.contractAddress, chain);

        walletsData.push({ wallet, items });
      }

      session.data.walletsData = walletsData;

      const verb = session.flow === 'list' ? 'holds' : 'lists';
      let menuText = '';
      walletsData.forEach((w, i) => {
        menuText += `${i + 1}. ${w.wallet.address} ${verb} ${w.items.length} NFT(s) from this collection\n`;
      });
      bot.sendMessage(chatId, menuText.trim());

      const menuNumbers = walletsData.map((_, i) => i + 1).join('/');
      const actionVerb = session.flow === 'list' ? 'list' : session.mode;
      session.step = 'awaiting_wallet_pick';
      sessionStore.setSession(chatId, session, bot);
      bot.sendMessage(chatId, `Which one you want to ${actionVerb} (${menuNumbers}/all)?`);
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
          bot.sendMessage(chatId, 'Invalid selection or wallet has no NFTs, aborting');
          endAndReturnToMenu(chatId);
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
        bot.sendMessage(chatId, 'Price per NFT: enter a number, or a % like -40% for discount off floor (blank = floor -10%):');
      } else {
        finalizeWalletSelection(chatId, session, currentWallet, count, null);
      }
      break;
    }

    case 'awaiting_price': {
      const currentWallet = session.data.chosenWallets[session.data.walletCursor];
      const rawPrice = opensea.parsePriceInput(text, session.data.floorPrice);
      const price = opensea.roundPriceForChain(rawPrice, session.data.chain);
      finalizeWalletSelection(chatId, session, currentWallet, session.data.currentCount, price);
      break;
    }

    default:
      break;
  }
}

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  if (!isAuthorized(msg.from.id)) return;
  showMainMenu(chatId);
});

bot.onText(/\/manage-listing/, (msg) => {
  const chatId = msg.chat.id;
  if (!isAuthorized(msg.from.id)) return;
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

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;

  if (!isAuthorized(query.from.id)) {
    return bot.answerCallbackQuery(query.id, { text: 'Unauthorized' });
  }

  const session = sessionStore.getSession(chatId);

  if (!session) {
    return bot.answerCallbackQuery(query.id, { text: 'Session expired' });
  }

  if (query.data === 'menu_listing') {
    session.flow = 'list';
    session.step = 'awaiting_contract';
    sessionStore.setSession(chatId, session, bot);
    await bot.answerCallbackQuery(query.id);
    return bot.sendMessage(chatId, 'Contract address:');
  }

  if (query.data === 'menu_manage') {
    session.flow = 'manage';
    session.step = 'awaiting_mode';
    sessionStore.setSession(chatId, session, bot);
    await bot.answerCallbackQuery(query.id);
    return bot.sendMessage(chatId, 'Choose action:', {
      reply_markup: {
        inline_keyboard: [[
          { text: 'Reprice', callback_data: 'mode_reprice' },
          { text: 'Close', callback_data: 'mode_close' },
        ]],
      },
    });
  }

  if (query.data === 'mode_reprice' || query.data === 'mode_close') {
    session.mode = query.data === 'mode_reprice' ? 'reprice' : 'close';
    session.step = 'awaiting_contract';
    sessionStore.setSession(chatId, session, bot);
    await bot.answerCallbackQuery(query.id);
    return bot.sendMessage(chatId, 'Contract address:');
  }

  if (query.data === 'confirm_yes' || query.data === 'confirm_no') {
    await bot.answerCallbackQuery(query.id);

    if (query.data === 'confirm_no') {
      bot.sendMessage(chatId, 'Cancelled');
      return endAndReturnToMenu(chatId);
    }

    return executeAction(chatId, session);
  }
});

bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;

  const chatId = msg.chat.id;
  if (!isAuthorized(msg.from.id)) return;

  const session = sessionStore.getSession(chatId);
  if (!session) return;

  sessionStore.setSession(chatId, session, bot);

  try {
    await handleStep(chatId, session, msg.text);
  } catch (err) {
    bot.sendMessage(chatId, `Error: ${err.message}`);
    endAndReturnToMenu(chatId);
  }
});

sessionStore.configureTimeoutHandler((chatId) => {
  bot.sendMessage(chatId, 'Session timed out after 3 minutes of inactivity.');
  showMainMenu(chatId);
});

bot.on('polling_error', (err) => {
  console.log('Polling error:', err.message);
});

console.log('Bot running');

