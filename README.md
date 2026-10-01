# seasore

A Telegram bot (plus an optional web panel) for managing NFTs on OpenSea across multiple wallets: bulk listing, repricing and closing listings, accepting offers, and fast mints on OpenSea drops, including scheduled auto-mints. Built with Node.js, the OpenSea SDK and ethers.

## What it does

### Listing

Lists NFTs from one or more wallets for a given collection. You send a contract address, the bot resolves the collection, fetches the floor price, shows how many NFTs each wallet holds, and asks how many to list and at what price. Listings last 7 days.

### Fast List

One-tap listing: lists every NFT from every enabled wallet at the price configured in Settings (see [Fast List](#fast-list)).

### Manage Listing

Works on existing active listings for a collection.

- **Reprice**: cancels the current listing and creates a new one at the new price.
- **Close**: cancels the listing.

### Accept offer (Acc offer)

Accepts offers on NFTs you hold. Paste a contract address and tap **Acc offer**. The bot detects the chain, shows your held tokens, then offers two modes:

- **Separate accept offer**: pick one token, see its active offers (per-NFT price, batch offers are shown as per-unit with the batch total), pick one and accept. Any active listing on that token is cancelled first (off-chain, free). The accept transaction is sent from the wallet that owns the token.
- **Bulk accept offer**: scans every held token for its own best offer plus the collection-wide offers, lets you tick which offers to use (Load more reveals them page by page), then allocates tokens across the ticked offers, highest per-unit price first, capped by what each offer can still take on chain. Tokens that already have a better individual offer are excluded and left untouched (Show excluded lists them). After you confirm, all allocated accepts fire in parallel and the result is reported per offer.

### Mint

Mints from one or more wallets on public and allowlist drops. Send a contract address and the bot finds the chain and resolves the mint route:

- **OpenSea drops** (collection has an OpenSea drop page): the bot builds ready-to-sign calldata through OpenSea's drop-mint API, which works for any stage, including allowlist/signed stages (OpenSea bundles the signature). Per-wallet eligibility comes from the OpenSea API, authenticated by signing in (SIWE) with each wallet itself.
- **Plain contracts**: the bot probes for a public mint function (`mint(uint256)`, `mintSeaDrop(address,uint256)`, `publicMint(uint256)`) and reads the mint price from common price getters. If no price getter exists (SeaDrop-style drops), it asks for the price and validates it with a simulation before continuing.

You pick how many per wallet and which wallets, confirm, and every wallet broadcasts in parallel with nonces and fees fetched up front. Wallets without enough native balance for the mint plus gas are skipped automatically. Wallet selection accepts a count (`3` = first 3 eligible wallets), a range (`2-3`) or a list (`1,3`), by the order shown on screen.

The summary shows the collection name, per-wallet totals, and how many wallet[0] has already minted. Reverts are translated to plain language where possible (allowlist phase, sale window with dates, per-wallet limit, supply exhausted, wrong price with the expected amount). The result reports build time, send time and total confirmation time in ms per wallet, plus the block the mint landed in. Every mint is appended to `mint-history.json` (timestamp, chain, contract, collection, price, per-wallet status/timings/tx hashes) for later analysis. Note: the bot writes it to `lib/mint-history.json`, while the web panel writes it to the project root.

For OpenSea drops, the bot shows the stage schedule in WIB (e.g. `sep 24 19.30 - 20.00`, with supply header and allowlist sizes). When a stage is active, the wallet picker marks each wallet eligible or not with the reason (simulated on chain for public stages, OpenSea eligibility for signed stages).

### Schedule Mint

When no stage is open, the schedule view offers **Set schedule mint**. Pick an upcoming stage (public stages, or any stage where at least one of your wallets is eligible), then:

- **Bulk-mint**: enter how many wallets, filled in order.
- **Separate-mint**: paginated 5-per-page wallet list, select by typing numbers, toggle off by re-typing.
- **Elig wallet**: shows only wallets eligible for that stage.
- **See all wallet**: full wallet list.

Per-wallet quantity is only asked when the stage allows more than 1. After confirmation the schedule is stored in `mint-schedules.json` and the bot fires automatically at the stage start time. The **Schedule Mint** menu lists pending schedules (time remaining, wallets, Refresh) and lets you change the max mint per wallet or cancel.

Timeline of a scheduled mint: heavy preparation at T-20s (`MINT_PREWARM_SEC`), fresh nonce/fee and socket warm-up at T-2s (`MINT_REFRESH_SEC`), fire at T. The live price is re-read from the drop page before minting. Schedules that were pending while the bot was down and whose stage already started are marked missed; a pending schedule with a future start re-arms on boot.

**Drop watch**: while a schedule is pending, the bot polls the drop page every 2 minutes (`DROP_WATCH_INTERVAL_SEC`) until prewarm starts. If the stage price or per-wallet limit changes, or the stage disappears, the schedule is cancelled and you get a Telegram message. If only the start/end time moves, the schedule is re-armed to the new time and you are told.

### Safety checks

Every action ends with a summary and a Yes/No confirmation before anything is executed (Fast List can skip it, see Settings). Before each token is processed, the bot checks on chain that the wallet still owns it, so tokens sold in the meantime are skipped.

## Web panel

An optional browser UI that shares the same wallets, settings and schedules as the bot: wallet balances, list, manage listing, mint (now or scheduled), accept offer, scheduled mints and Fast List settings, with a live job log for running actions. Enable it by setting `PANEL_TOKEN` in `.env`, then run:

```
node panel/server.js
```

It listens on `PANEL_PORT` (default 20129). Open `http://localhost:20129` and enter the token; every API call requires it as a bearer token. Without `PANEL_TOKEN` the panel stays disabled. The panel is plain HTTP and listens on all interfaces, so do not expose it directly to the internet: put it behind a reverse proxy with HTTPS or reach it through an SSH tunnel.

## Supported chains

ethereum, polygon, base, arc, robinhood

## Requirements

- Node.js 22 or newer (required by @opensea/sdk)
- A Telegram bot token from BotFather
- Your Telegram numeric user ID
- An OpenSea API key
- An RPC URL for each chain you plan to use
- The private keys of the wallets you want to manage

## Setup

```
git clone https://github.com/Maouv/seasore.git
cd seasore
npm install
```

Create a `.env` file in the project root (`.env.example` has the full template):

```
TELEGRAM_BOT_TOKEN=your_bot_token
AUTHORIZED_USER_ID=your_numeric_telegram_id
TELEGRAM_USER_ID=your_numeric_telegram_id
OPENSEA_API_KEY=your_opensea_api_key
PRIVATE_KEYS=0xkey1,0xkey2,0xkey3
RPC_URL_ETHEREUM=https://...
RPC_URL_POLYGON=https://...
RPC_URL_BASE=https://...
RPC_URL_ARC=https://...
RPC_URL_ROBINHOOD=https://...
```

`AUTHORIZED_USER_ID` is the only Telegram user the bot answers to. `TELEGRAM_USER_ID` is used by the web panel to know which chat to message; set both to the same ID. `PRIVATE_KEYS` is a comma separated list. Only the RPC URLs for chains you actually use are needed. If a chain has no RPC URL, the bot aborts that session with a message.

### Optional settings

| Variable | Default | What it does |
| --- | --- | --- |
| `OPENSEA_RPS` | 2 | Max OpenSea requests per second, see [Speed and rate limits](#speed-and-rate-limits) |
| `LIST_CONCURRENCY` | 3 | Listings running at the same time |
| `HOLDINGS_LOOKBACK_MINUTES` | 180 | How far back the Transfer-log scan goes, see [Holdings](#holdings) |
| `RPC_URL_<CHAIN>_EXTRA` | none | Extra RPC endpoints for a chain, comma separated. Signed mint txs are sent to the primary and all extras at once; the first acceptance wins |
| `MINT_PREWARM_SEC` | 20 | Scheduled mint: when heavy preparation starts, seconds before fire |
| `MINT_REFRESH_SEC` | 2 | Scheduled mint: when fresh nonce/fee and socket warm-up happen, seconds before fire |
| `MINT_FIRE_LEAD_MS` | 0 | Above 0, send slightly before T. Too early causes a NotActive revert and wasted gas |
| `MINT_TIP_GWEI` | gas preset | Fixed priority fee that overrides the Settings gas preset. Per-chain form: `MINT_TIP_GWEI_ETHEREUM` |
| `MINT_GAS_LIMIT` | estimate | Gas limit override when estimateGas cannot run. Per-chain form: `MINT_GAS_LIMIT_ETHEREUM` |
| `FAST_LOCAL_CALLDATA` | 0 | 1 = build SeaDrop `mintPublic` calldata locally and pre-sign even for OpenSea drops. Fastest, but unverified against OpenSea-built calldata: test on a live drop first |
| `DROP_WATCH_INTERVAL_SEC` | 120 | How often pending schedules are re-checked against the live drop page |
| `PANEL_TOKEN` | none | Enables the web panel and sets its bearer token |
| `PANEL_PORT` | 20129 | Web panel port |

## Run

```
npm start
```

Then open your bot in Telegram and send /start. To keep it running under PM2, use the included config (auto-restart, 300 MB memory cap):

```
pm2 start ecosystem.config.js
```

Other scripts:

- `npm test` runs the mint pipeline tests against a mock RPC.
- `npm run rtt` measures round-trip time from your server to every configured RPC endpoint (and its `_EXTRA` endpoints). Useful to tell whether slow sends come from the network or from your code.

## Project layout

```
bot.js              Telegram bot: menus, listing, manage listing, fast list, settings
lib/                OpenSea API, mint pipeline, schedules, drop watch, offers, holdings, limiter
panel/              Optional web panel (server.js + public/index.html)
scripts/            rtt.js, findseadrop.js, sendtest.js (RPC and SeaDrop debugging helpers)
test/               Mint pipeline tests
ecosystem.config.js PM2 config
```

Runtime state files in the project root: `fastlist-settings.json` (Fast List settings), `gas-settings.json` (gas preset), `ca-memory.json` (last 3 collections), `mint-schedules.json` (scheduled mints). OpenSea sign-in tokens are cached in `.os-jwt-cache.json` (git-ignored).

## Fast List

One-tap listing. The main menu shows Fast List next to Listing and Manage Listing; pasting a contract address also offers Fast List.

1. Tap Fast List and send (or pick from recent) a contract address.
2. The bot scans chains, then lists every NFT from every wallet enabled in Settings at the configured price. The normal summary and confirm still apply.

## Settings

No slash commands. Settings is an inline button on the main menu.

- **Price**: a fixed number, or a percentage off floor like `-40%` (default). Applies to every Fast List execution, resolved against the floor at run time.
- **Confirmation**: tap to toggle ON or OFF (default ON). ON = Fast List shows the summary with a Yes/No confirm before listing. OFF = Fast List lists immediately after the summary. Normal Listing is always confirmed.
- **Wallets**: tap a wallet row to toggle it ON or OFF. Wallets default to ON; OFF wallets are skipped by Fast List only. Stored in `fastlist-settings.json`.
- **Gas**: priority-fee preset for mints, stored in `gas-settings.json`. The tip is taken from the real fee market (a percentile of the last 20 blocks via `eth_feeHistory`), falling back to the node's suggested tip, then to a static value:
  - `slow`: p50, cheapest, may lag behind a busy mint
  - `medium` (default): p90, keeps pace with typical traffic
  - `fast`: p99, competes for top of block

  A `MINT_TIP_GWEI` set in `.env` always overrides the preset.

## Usage

1. Paste the collection contract address any time, even from the main menu. The bot asks what to do: Fast List, Listing, Manage Listing, Mint or Acc offer. You can also pick a menu button first and paste the address when asked.
2. For Manage Listing, choose Reprice or Close.
   Wallet and contract addresses in bot messages are shortened to first and last characters, for example `0x3ff72...f1414`.
3. Send the collection contract address. The bot scans every configured chain on-chain and auto-picks the one where your wallets hold NFTs. A picker appears only if several chains have holdings; if none do, you type the chain manually.
4. Pick Separate List to configure each wallet (count and price per wallet), or Bulk List to set one total count and one price for every wallet at once. Bulk fills wallets in the order they were listed.
   Listing a token that already has an active listing cancels the old listing first (free off-chain cancel), so relisting replaces instead of stacking duplicate orders.
5. Separate List: pick a wallet by number, or send `all`, then set count and price per wallet. Bulk List: send the total count, then the price.
   Wallets with items already listed are marked "(N already listed)" and the summary warns before you confirm, since listing again may double-list.
   Collections you successfully resolve are remembered (last 3). When asked for a contract address you can either paste one or tap a recent collection button. After a successful listing the menu shows "Manage this collection" for that same collection.
6. Price formats:
   - a number, for example `0.05`
   - a percentage relative to floor, for example `-40%`
   - `d`, which means floor price minus 10%
7. Review the summary and press Yes to execute.

Sessions time out after 3 minutes of inactivity.

## Holdings

Holdings are verified on chain, because OpenSea's indexer lags by minutes in both directions (sold NFTs keep showing up, fresh mints are missing).

For each wallet the bot reads `balanceOf` on chain, then uses OpenSea only to find candidates and confirms every candidate with `ownerOf`. If fewer NFTs are confirmed than `balanceOf` says, the missing ones are looked up through ERC721Enumerable when the contract supports it, otherwise through recent Transfer events. `HOLDINGS_LOOKBACK_MINUTES` (default 180) is how far back that log scan goes, and it stops as soon as the count matches `balanceOf`.

If the wallet screen still cannot find every NFT (for example an old NFT that OpenSea has not indexed, on a contract without enumeration, or an RPC that rejects log queries), it prints a note with the on-chain balance instead of silently showing an incomplete list.

Manage Listing hides listings of tokens the wallet no longer owns.

Only ERC721 is supported.

## Speed and rate limits

All OpenSea requests go through one shared limiter, because OpenSea limits per API key.

- `OPENSEA_RPS` is the maximum number of OpenSea requests per second (default 2). A listing costs about 2 requests, so the ceiling is roughly `OPENSEA_RPS` divided by 2 listings per second.
- `LIST_CONCURRENCY` is how many listings run at the same time (default 3). It hides latency, it cannot exceed `OPENSEA_RPS`.

If OpenSea answers 429, the limiter pauses every request for the Retry-After time, halves the rate, then climbs back to `OPENSEA_RPS` after a streak of successful requests.

To find your real limit, raise `OPENSEA_RPS` step by step and watch the "OpenSea rate limited" line in the final summary. Stop when it stops being 0. Limits depend on your API key type, permanent keys get higher limits than temporary ones.

While a batch runs the bot edits one progress message instead of sending a message per token. The final message lists failures grouped by error.

### Mint speed

Mint transactions skip ethers' provider on the hot path: plain JSON-RPC over keep-alive HTTP, so a send is one round trip, the same signed tx can be fanned out to several endpoints (`RPC_URL_<CHAIN>_EXTRA`), and receipts are polled about every 150 ms. For scheduled mints, fees, nonces, balances and gas are prepared ahead of time so the fire step only sends. Use `npm run rtt` to see your real network floor to each RPC.

## Security

Only the Telegram user ID set in `AUTHORIZED_USER_ID` can use the bot. All other users are ignored.

The `.env` file holds raw private keys. Never commit it (it is already in `.gitignore`), keep file permissions tight, and use dedicated wallets that hold only what you intend to list. Anyone who can read this file or take over your Telegram account can move your assets.

If you enable the web panel, treat `PANEL_TOKEN` like a password and keep the panel off the public internet (see [Web panel](#web-panel)). Scheduled-mint data in `mint-schedules.json` includes your Telegram chat ID, so think twice before committing that file to a public repo.

## Notes and limitations

- The wallet RPC must be reachable at all times. If it is down, the wallet screen fails with an error instead of showing a possibly stale list.
- If a wallet has not approved the OpenSea conduit for the collection yet, the bot estimates the approval gas cost in the summary. Approval gas is paid from that wallet.
- Close and Reprice use OpenSea's off chain cancellation. This removes the listing from OpenSea but does not invalidate the signed order on chain.
- Reprice cancels first and then relists. If the relist fails, the token ends up with no active listing.
- The wallet RPC also receives one ownership check per token, so a slow or limited RPC can become the bottleneck at high speed.
- Accepting an offer is an on-chain transaction paid for by the seller wallet (gas applies).
- Drop watch cancels a schedule when price or per-wallet limit changes before prewarm. A price change after prewarm starts is applied at fire time without stopping the schedule.

