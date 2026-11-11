# Quick Market

Bitcoin up/down pools. One shared buy-in window, two sides, pari-mutuel payout. Buy-ins stay in the ledger. Base, Base Sepolia, and NEAR Testnet are selectable at runtime.

## Run

```bash
bun install
bun test
bun run dev
```

Open http://127.0.0.1:5173. The API listens on http://127.0.0.1:3001. Vite proxies `/api` and `/ws` there. `NODE_ENV=production` (`bun run start`) serves `dist/` from the API.

`WINDOW_SECONDS` and `MARKET_SECONDS` both default to 10. `VIEW_SECONDS` defaults to 5. That is the width of a struck bet's chart, and how long a quiet socket waits before the tape reloads. The price starts on Binance. `FEE_BPS` defaults to 0. `DB_PATH` defaults to `data/quick-market.sqlite`.

One `.env` file holds both markets. Base Sepolia is on when `TREASURY_PRIVATE_KEY` is a hex key and `USDC_ADDRESS` is set. NEAR testnet is on when `NEAR_TREASURY_PRIVATE_KEY` is an `ed25519:` secret and `TOKEN_ACCOUNT` is set. Blank lines leave that market off. `CHAIN` is still required, and it no longer selects the only book. The server starts every market whose keys are filled. The browser loads `GET /api/markets` and opens Near when that market is on. `bun run build` stays chain-agnostic.

On NEAR, `TOKEN_ACCOUNT` is the quick-market NEP-141 contract (`QM`, 6 decimals), and the UI connects through My NEAR Wallet. `bun run treasury` writes a missing NEAR treasury key to `NEAR_TREASURY_PRIVATE_KEY` and leaves the Base hex line alone. `bun run token` writes `TOKEN_ACCOUNT` and `TOKEN_PRIVATE_KEY`, or Base Sepolia `USDC_ADDRESS`. The server checks treasury NEAR and treasury QM on NEAR startup. A short balance keeps the process listening; a missing key or a token that is not six-decimal QM stops that market. If Base already started, the process keeps serving Base.

Both books share the BTC tape. Balances, rounds, sessions, grants, deposits, and withdrawals stay on their own `chain_key`. `RPC_URL` is used for a market only when the URL matches that family. Base Sepolia keeps Phantom, quick-market USDC grants, deposits, and withdrawals. Base mainnet uses Circle USDC and does not grant test funds.

`AGENT_SPLIT_BASE` and `AGENT_SPLIT_NEAR` are whole numbers that sum to 100. They are `100` and `0` today, so the swarm (private repo `ED3N-Foundries/quick-market-agent`) keeps betting on Base Sepolia. A NEAR share other than 0 stops the runner before enroll, and the server rejects `/api/agents` on NEAR while that share is 0. Filling NEAR keys does not point the swarm at NEAR. Base mainnet still refuses the swarm. `AGENT_SECRET` authorizes the agent API. The dashboard line includes `split base 100 / near 0`. `bun run feeds` shows the live source and backup venues. Closing the dashboard leaves the server up.

## Architecture

Bun serves HTTP and a websocket. One SQLite database holds chain-scoped users, rounds, buy-ins, custody, sessions, and agent state, plus a shared BTC price tape. Legacy runner state is imported once; the runner keeps its own SQLite file and no longer shares this one. React draws the screen. The server wakes for the next price fanout, every 100ms, or for the next window boundary, strike, settle, or handoff resume. Between those moments it does not poll SQLite.

Buy-in windows tile UTC time. Each lasts `WINDOW_SECONDS`, and the next opens when the previous closes. Market `id` is `floor(now / window)`. Its book opens at `id * window`, the strike locks when that window closes, and it settles `MARKET_SECONDS` later. A buy-in names that window. If the server receives it outside the window, the buy-in is rejected and is not placed on the window that is open on arrival.

A human may hold one open buy-in. Another window returns "Your last buy-in is still open". Adding to the same side of the current buy-in is allowed. The other side is not. Agent wallets are exempt. A buy-in needs a live feed: a print within the last 5 seconds. The minimum stake is 1 USDC.

Balances, stakes, fees, and payouts are integer micros. One USDC is one million micros. Strike and settle prices stay exchange strings. The fee is `FEE_BPS` of a paid two-sided pot. Each winner is paid their share of the pot after that fee. A one-sided pool returns every stake and takes no fee. A settle equal to the strike is a push and does the same. A market with no usable print for the strike or the settle is void and stakes return.

A wallet signs in once. Buy-ins and withdrawals use that session. On Base, a deposit is a Circle USDC transfer to the treasury, and the server credits the sender after the transfer is 3 blocks deep, only from that log. On Base Sepolia the playable balance is a grant of quick-market USDC: signing in, and `POST /api/grant`, mint it to the treasury and credit the ledger, once per `GRANT_INTERVAL_MS`. A withdrawal is signed before the balance is debited, and the same signed transaction is replayed if the process stops. On Base, new accounts start at zero. The first boot after custody landed zeros old demo balances and deletes open buy-ins.

The price feed is public WebSockets, with no API key. One venue owns a market from its open through its settle. The price is the size-weighted best bid and ask, so a one-cent touch still moves when the sizes change. Binance starts. Bybit, OKX, Coinbase, Kraken, and Bitstamp stay connected. If the active venue sends nothing for three seconds, every open market is voided, stakes return with no fee, and the next venue within $25 takes over. Buy-in stays closed for at least one window, and the screen names the new feed before the next market opens. Prints go out on `/ws` as `tick`. Book changes are compact, sequenced `book` patches; a gap or a slow socket triggers a fresh `snapshot`. Public `settled` frames omit account payouts, which are sent only to their signed-in owner and recovered from the account snapshot.

A browser buy-in is an authenticated websocket command with a UUID. The accepted request and debit commit together, so reconnecting and replaying that UUID returns the current account without charging again, even after the window closes. `POST /api/buy-ins` remains available and accepts the same optional `requestId`. Reconnects use bounded exponential backoff, while foreground probes, sequence checks, and snapshots recover stale state.

`GET /api/state` is the board, a short tape tail, the chain, and the signed-in user. `GET /api/tape?from=&to=` loads a bounded tape range when the chart is panned. `POST /api/session` opens a session. `POST /api/buy-ins` and `/api/withdraw` use it. `GET /api/rounds` is settled history. `GET /api/rounds/:id` is one round, its buy-ins, and the tape from the buy-in open through the settle, plus one print held into the open.

## UX

The screen is the chart, then Up, the stake, and Down. On a narrow window those three stack. The pool list under them is collapsed until opened. Bots are marked Bot. Previous rounds sit below that, with All and My plays. The footer states the window lengths, what up, down, push, and void mean, the fee, the feed name, and withdraw.

With no open buy-in the clock reads Buy-in and counts down to the window close. A 10 second buy-in reads 9.9 down to 0.0 and continues into the next window, and after a reconnect the clock follows the open window. The chart is that fixed window. The price sits left of the clock, and the lock on it spins until the strike. The pair badge sits above the price, with the feed's brand mark beside it. Up and Down show that side's share of the pool, the money and order count, and, with an amount entered, that stake's percent of the side and what it gets back. With no amount the line stays "$1 gets $y", or "$1 back" when the other side is empty.

After a buy-in, the clock reads Settles and counts down to settlement. The chosen card highlights and the other dims, showing the stake, its share of that side, and what it gets back. The stake field and percent chips hide until the position clears. Until the strike, the chart stays the buy-in window and the lock keeps spinning. From the strike until settlement the chart is one `VIEW_SECONDS` slice of that market. It opens on the strike, and the price line grows toward the right. When the line reaches that edge, the edge stays on the current time and the slice rides until settlement. Buy-in prints stay off that view. The live line glides between price updates, and a replay stays a step hold: green above the open, red below it, and blue dashed when it sits on the open. The lock closes, and the dollar move from the strike is shown large: `+$` Up, `−$` Down, or `=$0.00` Push. When the market settles, the screen returns to whatever buy-in window is open.

Dragging pans the buy-in chart and hides the scrub. Now returns to the follow span. A struck market stays on its own span, so a drag there does not pan. Hover shows the time, the held price, the change from the previous print, and Up, Down, or Push versus the open.

Connect Phantom is a full-width button under the header until the session is open. The balance row has no token badge. Deposit and withdraw still name the token. The stake amount is white. On Base, + opens a deposit of Circle USDC (+$10, +$1,000, or a custom amount) and Phantom confirms the transfer. On Base Sepolia, + opens a grant of QM USDC. The wallet is not charged, and Phantom is not asked. The backdrop or Escape closes either one. Withdraw sends that chain's token back to the wallet, and its error stays on the withdraw box. The balance flashes green or red when it moves.

A result toast appears only for a round this address played. It shows what was bought and what came back. A win also shows the profit in parentheses. A loss shows $0.00 back. Clicking a previous round opens a still replay from the buy-in open through the settle. Escape, the backdrop, or Close dismisses it. Previous markets list the feed for each round. My trades adds Bought and Back.
