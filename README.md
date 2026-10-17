# Quick Market

Bitcoin up/down pools. One shared betting window, two sides, pari-mutuel payout. Bets stay in the ledger. Deposits and withdrawals are USDC on Base.

## Progress

- [x] Scaffold: Bun, SQLite, React shell
- [x] Live BTC tape and continuous chart
- [x] Successive betting windows, pari-mutuel settlement, ride-only market chart
- [x] Trading screen
- [x] History and Base wallet

## Run

```bash
bun install
bun test
bun run dev
```

Open http://127.0.0.1:5173. The API listens on http://127.0.0.1:3001. Vite proxies `/api` and `/ws` there. `NODE_ENV=production` (`bun run start`) serves `dist/` from the API.

`WINDOW_SECONDS` and `MARKET_SECONDS` both default to 5. `VIEW_SECONDS` defaults to 5 and is the scrolling chart width. `PRICE_SOURCE=binance` (or `coinbase`, or `average`) is the only price feed for the process. `FEE_BPS` defaults to 0. `DB_PATH` defaults to `data/quick-market.sqlite`.

`CHAIN=base-sepolia` (or `base`) picks the only chain this process accepts. `TREASURY_PRIVATE_KEY` is the hot wallet that receives deposits and pays withdrawals. The server will not listen without it. On Base Sepolia the token is quick-market USDC: `bun run token` deploys it from that treasury key, writes `USDC_ADDRESS`, and mints enough to cover existing ledger balances once. The server and the agent will not start on Base Sepolia until that address is set, and they will not use Circle's Sepolia USDC. Base mainnet stays on Circle USDC. A signed-in wallet on Sepolia is granted `GRANT_MICROS` (default 100 USDC) once per `GRANT_INTERVAL_MS` (default two minutes). Agent wallets use that same interval. `bun run treasury` prints that wallet's ETH and token balance on Base and Base Sepolia, the ledger against the configured chain, and the last 10 transfers. It generates a key when the line is empty and writes it into `.env`. Use a different key for mainnet than for Base Sepolia. Connect uses the Phantom extension. `RPC_URL` overrides the public Base RPC for the server and the agents. Copy `.env.example` to `.env`.

`bun run agent` keeps `AGENT_COUNT` wallets in `agent/keys.json` and trades with them. On Base Sepolia each wallet gets the same grant as a person and bets from that balance. It does not call the Coinbase faucet or sweep. `AGENT_SECRET` marks those sessions as bots so they can bet every window. `CHAIN=base` does nothing unless `AGENT_MAINNET=1`. `bun run agents` is the terminal dashboard for the swarm: crowd, book, money, and roster, with clock, pin, betting pause, and bleed.

## Architecture

Bun serves HTTP and a websocket. SQLite holds users, rounds, bets, and one price per second. React draws the screen. The server advances the clock every 16ms.

Betting windows tile UTC time. Each lasts `WINDOW_SECONDS`, and the next opens when the previous closes. Market `id` is `floor(now / window)`. Its book opens at `id * window`, the strike locks when that window closes, and it settles `MARKET_SECONDS` later. A bet names that window. If the server receives it outside the window, the bet is rejected and is not placed on the window that is open on arrival.

A human may hold one open bet. Another window returns "Your last bet is still open". Adding to the same side of the current bet is allowed. The other side is not. Agent wallets are exempt. A bet needs a live feed: a print within the last 5 seconds. The minimum stake is 1 USDC.

Balances, stakes, fees, and payouts are integer micros. One USDC is one million micros. Strike and settle prices stay exchange strings. The fee is `FEE_BPS` of a paid two-sided pot. Each winner is paid their share of the pot after that fee. A one-sided pool returns every stake and takes no fee. A settle equal to the strike is a push and does the same. A market with no usable print for the strike or the settle is void and stakes return.

A wallet signs in once. Bets and withdrawals use that session. On Base, a deposit is a Circle USDC transfer to the treasury, and the server credits the sender after the transfer is 3 blocks deep, only from that log. On Base Sepolia the playable balance is a grant of quick-market USDC: signing in, and `POST /api/grant`, mint it to the treasury and credit the ledger, once per `GRANT_INTERVAL_MS`. A withdrawal is signed before the balance is debited, and the same signed transaction is replayed if the process stops. On Base, new accounts start at zero. The first boot after custody landed zeros old demo balances and deletes open bets.

The price feed is public WebSockets, with no API key. Each venue walks its own sockets before the other venue is used alone. Binance tries `BTCUSDT` trades on `data-stream.binance.vision`, then `stream.binance.com` (443, then 9443), then aggregated trades, then the book ticker. Coinbase tries the Advanced Trade ticker, then Exchange matches, then the Exchange ticker, then Advanced Trade trades. `PRICE_SOURCE=average` is the equal-weight mean while both prints are under 5 seconds old and within 1% of each other. If one venue is missing or older than that, the feed uses the venue that is still live. Prints go out on `/ws` as `tick`. Round and settlement updates go out as `round` and `settled`.

`GET /api/state` is the board, the tape, the chain, and the signed-in user. `POST /api/session` opens a session. `POST /api/bets` and `/api/withdraw` use it. `GET /api/rounds` is settled history. `GET /api/rounds/:id` is one round, its bets, and the tape from the betting open through the settle, plus one print held into the open.

## UX

The screen is the chart, then Up, the stake, and Down. On a narrow window those three stack. The pool list under them is collapsed until opened. Bots are marked Bot. Previous rounds sit below that, with All and My plays. The footer states the window lengths, what up, down, push, and void mean, the fee, the feed name, and withdraw.

With no open bet the clock reads Bets and counts down to the window close. The chart is that fixed window. The price sits left of the clock, and the lock on it spins until the strike. Up and Down show that side's share of the pool, the money and player count, and "$1 wins $y", or "$1 back" when the other side is empty.

After a bet, the clock reads Settles and counts down to settlement. Until the strike, the chart stays the betting window and the lock keeps spinning. A ticket shows the side, the stake, and To win. From the strike until settlement the chart scrolls, `VIEW_SECONDS` wide, with now on the right. The line is a step hold: green above the open, red below it, and blue dashed when it sits on the open. The lock closes, and the dollar move from the strike is shown large: `+$` Up, `−$` Down, or `=$0.00` Push. When the market settles, the screen returns to whatever betting window is open.

Dragging pans the chart and hides the scrub. Now returns to the follow span. Hover shows the time, the held price, the change from the previous print, and Up, Down, or Push versus the open.

Connect opens the Phantom modal. The stake amount is white. The balance carries a token badge: a blue Circle coin labeled USDC on Base, and a gold QM coin labeled QM USDC on Base Sepolia. On Base, + opens a deposit of Circle USDC (+$10, +$1,000, or a custom amount) and Phantom confirms the transfer. On Base Sepolia, + opens a grant of QM USDC. The wallet is not charged, and Phantom is not asked. The backdrop or Escape closes either one. Withdraw sends that chain's token back to the wallet, and its error stays on the withdraw box. The balance flashes green or red when it moves.

A result toast appears only for a round this address played. Clicking a previous round opens a still replay from the betting open through the settle. Escape, the backdrop, or Close dismisses it.

## Brief

I want to make a quick polymarket like interface trading app, where it's focused on "betting" feel and simplicity. Starting with just one thing: bitcoin price, which we will aggregate from trading view, but initially is there a free way? We need to get second by second prices and chart that. the premise is two buttons, up or down, every 5/10s (we configure this server side) you bet up or down with an amount of money you specify which is a %, so if you are like 50% of your side of the bet, you get 50% of the money from the losers. Platform takes 0.25% fees off of each concluded trade. For now we want to simulate but this will all be smart contracts soon. We want to place hold wallet connect, fund, withdraw, etc. but not wire it up yet just have the buttons and simulate in React for now. We want to use Bun + SQLite as the backend. We want to tables for previous bets and also a current bet tray that shows the current time we are on for what pub addresses (truncated) are playing in this pool and how much they bet. We can view the pools and addresses of our previous plays, too.

The main focus of the app is the up down buttons and the main view showing our window to bet in and then green above the line and red below the line, where we are only ever going to bet if Bitcoin will END this round on up or down.

We need to show big the % of people and the amount of money on each side of the pool the whole time.

Once a market is started (this is universal time for everyone) we set server side in our config the time on how far out but I want it to be 5 or 10s out for now. Where once that resolves, winners take all. We need a clean minimalistic and nice interface.

Let's do this in pieces and mark off what we have done. SC's, wallet connect, etc. come later. Research and find ways to oracle the price that are cheap or even free for us ideally.