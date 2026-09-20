# opensea-list

A Telegram bot for bulk listing and managing NFT listings on OpenSea across multiple wallets. Built with Node.js, the OpenSea SDK and ethers.

## What it does

Listing
Lists NFTs from one or more wallets for a given collection. You send a contract address and a chain, the bot resolves the collection, fetches the floor price, shows how many NFTs each wallet holds, and asks how many to list and at what price. Listings last 7 days.

Manage Listing
Works on existing active listings for a collection.
Reprice: cancels the current listing and creates a new one at the new price.
Close: cancels the listing.

Every action ends with a summary and a Yes/No confirmation before anything is executed. Before each token is processed, the bot checks on chain that the wallet still owns it, so tokens sold in the meantime are skipped.

## Supported chains

ethereum, polygon, base, arc, robinhood

## Requirements

Node.js 18 or newer (the bot uses the built in fetch)
A Telegram bot token from BotFather
Your Telegram numeric user ID
An OpenSea API key
An RPC URL for each chain you plan to use
The private keys of the wallets you want to manage

## Setup

    git clone https://github.com/Maouv/opensea-list.git
    cd opensea-list
    npm install

Create a .env file in the project root:

    TELEGRAM_BOT_TOKEN=your_bot_token
    TELEGRAM_USER_ID=your_numeric_telegram_id
    OPENSEA_API_KEY=your_opensea_api_key
    PRIVATE_KEYS=0xkey1,0xkey2,0xkey3
    RPC_URL_ETHEREUM=https://...
    RPC_URL_POLYGON=https://...
    RPC_URL_BASE=https://...
    RPC_URL_ARC=https://...
    RPC_URL_ROBINHOOD=https://...

PRIVATE_KEYS is a comma separated list. Only the RPC URLs for chains you actually use are needed. If a chain has no RPC URL, the bot aborts that session with a message.

## Run

    npm start

Then open your bot in Telegram and send /start.

## Usage

1. Choose Listing or Manage Listing from the menu.
2. For Manage Listing, choose Reprice or Close.
3. Send the collection contract address.
4. Send the chain name, or leave it blank for ethereum.
5. Pick a wallet by number, or send all.
6. Send how many NFTs to process for each wallet. Send 0 to skip a wallet.
7. For Listing and Reprice, send the price. Accepted formats:
   a number, for example 0.05
   a percentage relative to floor, for example -40%
   blank, which means floor price minus 10%
8. Review the summary and press Yes to execute.

Sessions time out after 3 minutes of inactivity.

## Security

Only the Telegram user ID set in TELEGRAM_USER_ID can use the bot. All other users are ignored.

The .env file holds raw private keys. Never commit it (it is already in .gitignore), keep file permissions tight, and use dedicated wallets that hold only what you intend to list. Anyone who can read this file or take over your Telegram account can move your assets.

## Notes and limitations

Wallet holdings are fetched with a limit of 50 NFTs per wallet, so larger holdings are not fully shown.
If a wallet has not approved the OpenSea conduit for the collection yet, the bot estimates the approval gas cost in the summary. Approval gas is paid from that wallet.
Close and Reprice use OpenSea's off chain cancellation. This removes the listing from OpenSea but does not invalidate the signed order on chain.
Reprice cancels first and then relists. If the relist fails, the token ends up with no active listing.
A 3 second delay is applied between tokens to avoid API rate limits.
