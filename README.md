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

Node.js 22 or newer (required by @opensea/sdk)
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
    OPENSEA_RPS=2
    LIST_CONCURRENCY=3
    HOLDINGS_LOOKBACK_MINUTES=180

OPENSEA_RPS, LIST_CONCURRENCY and HOLDINGS_LOOKBACK_MINUTES are optional, see Speed and rate limits and Holdings below.

PRIVATE_KEYS is a comma separated list. Only the RPC URLs for chains you actually use are needed. If a chain has no RPC URL, the bot aborts that session with a message.

## Run

    npm start

Then open your bot in Telegram and send /start.

## Usage

1. Choose Listing or Manage Listing from the menu.
2. For Manage Listing, choose Reprice or Close.
3. Send the collection contract address. The bot scans every configured chain on-chain and auto-picks the one where your wallets hold NFTs. A picker appears only if several chains have holdings; if none do, you type the chain manually.
4. Pick Separate List to configure each wallet (count and price per wallet), or Bulk List to set one total count and one price for every wallet at once. Bulk fills wallets in the order they were listed.
5. Separate List: pick a wallet by number, or send all, then set count and price per wallet. Bulk List: send the total count, then the price.
6. Price formats:
   a number, for example 0.05
   a percentage relative to floor, for example -40%
   d, which means floor price minus 10%
7. Review the summary and press Yes to execute.

Sessions time out after 3 minutes of inactivity.

## Holdings

Holdings are verified on chain, because OpenSea's indexer lags by minutes in both directions (sold NFTs keep showing up, fresh mints are missing).

For each wallet the bot reads balanceOf on chain, then uses OpenSea only to find candidates and confirms every candidate with ownerOf. If fewer NFTs are confirmed than balanceOf says, the missing ones are looked up through ERC721Enumerable when the contract supports it, otherwise through recent Transfer events. HOLDINGS_LOOKBACK_MINUTES (default 180) is how far back that log scan goes, and it stops as soon as the count matches balanceOf.

If the wallet screen still cannot find every NFT (for example an old NFT that OpenSea has not indexed, on a contract without enumeration, or an RPC that rejects log queries), it prints a note with the on-chain balance instead of silently showing an incomplete list.

Manage Listing hides listings of tokens the wallet no longer owns.

Only ERC721 is supported.

## Speed and rate limits

All OpenSea requests go through one shared limiter, because OpenSea limits per API key.

OPENSEA_RPS is the maximum number of OpenSea requests per second (default 2). A listing costs about 2 requests, so the ceiling is roughly OPENSEA_RPS divided by 2 listings per second.
LIST_CONCURRENCY is how many listings run at the same time (default 3). It hides latency, it cannot exceed OPENSEA_RPS.

If OpenSea answers 429, the limiter pauses every request for the Retry-After time, halves the rate, then climbs back to OPENSEA_RPS after a streak of successful requests.

To find your real limit, raise OPENSEA_RPS step by step and watch the "OpenSea rate limited" line in the final summary. Stop when it stops being 0. Limits depend on your API key type, permanent keys get higher limits than temporary ones.

While a batch runs the bot edits one progress message instead of sending a message per token. The final message lists failures grouped by error.

## Security

Only the Telegram user ID set in TELEGRAM_USER_ID can use the bot. All other users are ignored.

The .env file holds raw private keys. Never commit it (it is already in .gitignore), keep file permissions tight, and use dedicated wallets that hold only what you intend to list. Anyone who can read this file or take over your Telegram account can move your assets.

## Notes and limitations

The wallet RPC must be reachable at all times. If it is down, the wallet screen fails with an error instead of showing a possibly stale list.
If a wallet has not approved the OpenSea conduit for the collection yet, the bot estimates the approval gas cost in the summary. Approval gas is paid from that wallet.
Close and Reprice use OpenSea's off chain cancellation. This removes the listing from OpenSea but does not invalidate the signed order on chain.
Reprice cancels first and then relists. If the relist fails, the token ends up with no active listing.
The wallet RPC also receives one ownership check per token, so a slow or limited RPC can become the bottleneck at high speed.
