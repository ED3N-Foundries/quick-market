# Quick Market

A 10-second game on the Bitcoin price. Everyone shares one buy-in window. Up and Down are the only sides. A winner is paid their share of the other side. The loser is paid nothing. A one-sided pool, a push, and a void return every stake.

The problem is a market people can finish in one sitting: see the price, choose a side, and see the payout before the decision goes cold. The product is that loop, with a chart, a stake, and a balance.

NEAR's role is the NEAR Testnet book. The chip is this repo's NEP-141, symbol QM, 6 decimals (`contracts/near`, spec `ft-1.0.0`). Meteor Wallet signs the player in with NEP-413. A new account is granted QM. A withdrawal transfers QM back to that account. Buy-ins, stakes, and payouts are a custodial SQLite ledger scoped by chain. The contract holds the token. The round math stays on the server. Agents reach the same book through `/mcp?chain=near-testnet` and spend QM there.

The hosted book is https://quickmarket.app. The same process also serves https://qmkt.app and https://qm.ed3n.com. `GET /api/markets` returns `"defaultChainKey": "near-testnet"` while that book is up, and the page opens there.

This file is the judge's path first, then how to run the market, the swarm, and the admin page. The swarm and the admin page are separate clones. Nothing below uses the Pi, Compose, Caddy, or the hypervisor.

## Tracks

The submission lists every track this project fits. A fit is the track's job, not a prize. Hints in the hackathon file are wishes, not requirements. Testnet is enough.

### games

The loop is the market. Open the site, sign in, take QM, buy Up or Down for at least $1, and wait one window (10 seconds) plus the settle (10 seconds). The balance changes by the payout. Withdraw sends QM to the NEAR account. The screen is the chart and the two buttons. The chain shows up as the wallet and the token.

### agents

An agent earns QM and spends it. Earning is the testnet grant on first sign-in, and any later winning payout. Spending is `place_buy_in` and `withdraw` on `/mcp?chain=near-testnet`. The house swarm does that continuously: each NEAR account signs in, receives the grant, and buys in for itself. Negotiate, hire, and pay-for-API are not in this build. NEAR Intents and chain signatures are not either.

### swarms

Many agents share one pool. Each account has its own key, bankroll, and buy-in. Nobody assigns the crowd a side. The pool on a round is whatever those accounts just staked, and the payout follows from that. Bidding, collective purchase, NEAR Intents, and sub-accounts are not in this build.

## Try the game

1. Open https://quickmarket.app. See the Bitcoin chart, Up, and Down. The chain control reads NEAR Testnet.
2. `curl -sf https://quickmarket.app/api/markets`. See `defaultChainKey` of `near-testnet`, a 10-second window, a 10-second market, and a grant of `100000000` micros ($100) every `120000` ms. The NEAR entry's `usdc` field is the QM token account. Its `treasury` field is the minter.
3. Sign in with Meteor Wallet. See a QM balance. A new account receives the grant without a wallet transaction.
4. Enter at least $1 during the buy-in countdown and press Up or Down. See that side highlight and the clock switch to Settles.
5. Wait for the round to settle. See the balance move, and a result notice if this account played.
6. Withdraw. See the QM balance fall. The token transfer goes to the signed-in NEAR account.

The hosted book is the demo to keep up through 2026-11-18, and through 2026-11-25 if it can stay up.

## Try an agent

MCP is on the same host: `https://quickmarket.app/mcp?chain=near-testnet`. A client signs locally. The server never takes a private key.

1. Call `book`. See the open round id, the Up and Down pools, and the feed name.
2. Call `login_message` with the account id, sign that NEP-413 payload, and call `sign_in` with the address, signature, issued time, nonce, and public key. See `account` return a QM balance. The first sign-in grants.
3. Call `place_buy_in` with `side` of `up` or `down`, `stake` of `"1"`, and `roundId` from `book`. See the buy-in, or an error if the window already closed. Call `book` again and use the new round id.
4. After that round settles, call `account`. See the balance after the payout. `withdraw` sends QM back.

The house swarm is that loop across a crowd. Its code is [quick-market-agent](https://github.com/ED3N-Foundries/quick-market-agent). One process trades Base Sepolia, NEAR Testnet, or both. `AGENT_SPLIT_BASE` and `AGENT_SPLIT_NEAR` are whole numbers that sum to 100 and divide one crowd. The process refuses `CHAIN=base`.

## What is in scope

Quick Market already ran on Base Sepolia before this hackathon. That book, the Base grant, and Phantom sign-in are the earlier product. Only the NEAR integration is judged: the QM contract, the NEAR Testnet book, Meteor NEP-413 sign-in, QM grants and withdrawals, and `/mcp`. The NEAR half of the swarm is in [quick-market-agent](https://github.com/ED3N-Foundries/quick-market-agent). There is no mainnet deployment.

Libraries, beyond this repo's own code. Versions are in `package.json` and `contracts/near/Cargo.toml`.

- Bun 1.4.4, the runtime. React 19 and Vite draw the screen.
- `near-sdk` 5.14.0 and `near-sys` 0.2.9, the QM contract.
- `@meteorwallet/sdk`, NEAR sign-in in the browser.
- `@noble/ed25519`, `@noble/hashes`, and `bs58`, NEP-413 checks.
- `@modelcontextprotocol/sdk`, the agent tools.
- `viem`, `wagmi`, and `@phantom/react-sdk`, the Base Sepolia book.
- `zod`. `@coinbase/cdp-sdk` is a dependency and is not on the NEAR path.

## Run

Install [Bun 1.4.4](https://bun.sh). The lockfile and the app image are that release. The server opens SQLite through `bun:sqlite`, so Node, npm, and yarn cannot run it. `package.json` names yarn as `packageManager`. Use `bun install` anyway. `bun.lock` is the lockfile.

```bash
git clone https://github.com/ED3N-Foundries/quick-market.git
cd quick-market
bun install
cp .env.example .env
```

Bun reads `.env` from the working directory. `bun run treasury` and `bun run token` write secrets into that file at mode `0600`. Leave it uncommitted.

The price feed is public websockets, Binance first, with Bybit, OKX, Coinbase, Kraken, and Bitstamp as backups. No API key. The process also needs the chain RPC. A feed with no print in the last 5 seconds rejects buy-ins.

### Market `.env`

`CHAIN` is required. It is `base`, `base-sepolia`, or `near-testnet`. A blank value exits before listen: `CHAIN must be set to base, base-sepolia, or near-testnet.` `CHAIN` does not pick the only book. The server starts every market whose key pair is filled. Neither pair filled exits with `Fill Base keys (TREASURY_PRIVATE_KEY and USDC_ADDRESS) or NEAR keys (NEAR_TREASURY_PRIVATE_KEY and TOKEN_ACCOUNT).`

Base Sepolia is on when `TREASURY_PRIVATE_KEY` is a 32-byte hex key (`0x` optional; the file stores `0x` plus 64 hex digits) and `USDC_ADDRESS` is a 20-byte hex address. That address is quick-market USDC from `bun run token`. Circle's Base Sepolia USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e` makes startup throw `Set USDC_ADDRESS to the quick-market USDC contract before starting on Base Sepolia.` A treasury key with a blank `USDC_ADDRESS` leaves Base Sepolia off.

NEAR testnet is on when `NEAR_TREASURY_PRIVATE_KEY` is an `ed25519:` secret and `TOKEN_ACCOUNT` is the quick-market NEP-141 account, symbol `QM`, 6 decimals. A missing key, or a token that is not that QM, stops NEAR. Startup then says `Set TOKEN_ACCOUNT to the quick-market contract before starting on NEAR testnet.` or `TOKEN_ACCOUNT must be quick-market QM with 6 decimals.` If Base Sepolia already started, the process keeps serving Base and logs the NEAR error. A short NEAR balance keeps the process listening.

The hex pair starts Base Sepolia. These keys do not start a Base mainnet book.

| Name | Default | Role |
|---|---|---|
| `PORT` | `3001` | Public API and `/ws`. `HOST` defaults to `127.0.0.1`. |
| port `3002` | bound on `0.0.0.0` | No env name. `/api/status`, `/api/funding`, and the richer `/api/health`. The admin page reads this. Keep it off the public internet. |
| `DB_PATH` | `data/quick-market.sqlite` | Ledger. Created on start. Each agent uses its own file. |
| `API_URL` | `http://127.0.0.1:3001` | Origin this process advertises. |
| `RPC_URL` | empty | Empty uses `https://sepolia.base.org` or `https://rpc.testnet.near.org`. A set URL applies only to the matching family. A NEAR url is ignored on Base, and the reverse. |
| `WINDOW_SECONDS` | `10` | Buy-in window. Integer 1–120. |
| `MARKET_SECONDS` | `10` | Open to settle. Integer 1–120. |
| `VIEW_SECONDS` | `5` | Width of a struck bet's chart, and how long a quiet socket waits before the tape reloads. Integer 1–120. |
| `FEE_BPS` | `0` | Fee on a paid two-sided pot. Integer 0–10000. |
| `PRICE_SOURCE` | `binance` | `binance`, `bybit`, `okx`, `coinbase`, `kraken`, or `bitstamp`. |
| `GRANT_MICROS` | `100000000` | Testnet grant. 100 USDC. One USDC is one million micros. |
| `GRANT_INTERVAL_MS` | `120000` | Gap before the same address can take another grant. |
| `TOKEN_PRIVATE_KEY` | written by `bun run token` | NEAR contract account key. The server can serve without it. Keep it to redeploy. |

`HOST=0.0.0.0` publishes the API on port 3001. `bun run dev` still proxies `/api` and `/ws` to `http://127.0.0.1:3001`, so the UI on this machine expects the API there.

The agent copies `WINDOW_SECONDS`, `MARKET_SECONDS`, `VIEW_SECONDS`, `FEE_BPS`, and `PRICE_SOURCE` from this file. A mismatch makes the swarm replay payouts against different rules.

### Keys and gas

`bun run treasury` and `bun run token` follow `CHAIN`. A value already on the command line wins over the file, so the second chain is a one-shot prefix. A line that already has a value is left as it is. Treasury writes only the key for the chain it is on: the Base hex line, or `NEAR_TREASURY_PRIVATE_KEY`.

Base Sepolia, with `CHAIN=base-sepolia` already in the example:

```bash
bun run treasury
```

Fund the printed address with Base Sepolia ETH before `bun run token`. The deploy spends gas. Withdrawals need at least 0.00005 ETH. Each new wallet's first sign-in mints one grant in its own transaction, so a swarm needs more than that floor. `bun run treasury` prints the balances. Then:

```bash
bun run token
```

That deploys `contracts/QuickMarketUSDC.json` and writes `USDC_ADDRESS`. An address already set is not deployed again.

NEAR, after the Base lines are whatever you want them to be:

```bash
CHAIN=near-testnet bun run treasury
```

Fund the printed implicit account with testnet NEAR. The script says the account needs NEAR from the faucet before it can pay gas. The faucet named in the project notes is https://near-faucet.io. Then:

```bash
CHAIN=near-testnet bun run token
```

That deploys `contracts/near/res/quick_market.wasm`, which ships in this repo, and writes `TOKEN_ACCOUNT` and `TOKEN_PRIVATE_KEY`. Storage NEAR comes from the treasury. A short treasury exits with `Treasury is short` and the yocto figures. If `quick_market.wasm` is missing, the script prints this rebuild:

```bash
rustup target add wasm32-unknown-unknown
cargo +1.86.0 build --manifest-path contracts/near/Cargo.toml --target wasm32-unknown-unknown --release
mkdir -p contracts/near/res
cp contracts/near/target/wasm32-unknown-unknown/release/quick_market.wasm contracts/near/res/quick_market.wasm
```

A NEAR-only machine leaves the Base lines blank and sets `CHAIN=near-testnet` in `.env` before the first `bun run treasury`. A Base-only machine skips the `CHAIN=near-testnet` commands. After both pairs are filled, `CHAIN` can stay on either value. Both books start.

### Start the market

```bash
bun test
bun run dev
```

The UI is http://127.0.0.1:5173. Vite uses that port strictly. A busy 5173 exits the dev pair, API included. The API is http://127.0.0.1:3001. Vite proxies `/api` and `/ws` there. Base Sepolia in the browser is Phantom. NEAR is Meteor Wallet.

Confirm the books before the agents:

```bash
curl -sf http://127.0.0.1:3001/api/markets
curl -sf http://127.0.0.1:3001/api/state
curl -sf http://127.0.0.1:3002/api/funding
```

`/api/markets` lists the chains whose keys are filled. The browser loads that list and opens NEAR when NEAR is on. `/api/funding` on port 3002 shows treasury gas and token balances. `bun run feeds` shows the live source and the backup venues. Closing that dashboard leaves the server up.

`/mcp` is streamable-HTTP MCP on this process. A client signs in by signing the login message. The tools read the book, place a buy-in, claim the testnet grant, and withdraw. The agent below is one such client. Chain is `?chain=base-sepolia` or `?chain=near-testnet` on that URL.

`bun run build` stays chain-agnostic. Production serves the built UI from the API:

```bash
bun run build
NODE_ENV=production bun run start
```

That listens on port 3001 and does not start Vite. Port 3002 still comes up.

Ports that must be free: 3001, 3002, and 5173 while `bun run dev` is running. The agent adds 3011. The admin page adds 3101.

## Agents

The swarm is [quick-market-agent](https://github.com/ED3N-Foundries/quick-market-agent). Clone it beside this repo. It is its own `bun install` and its own `.env`.

One process trades either market, or both. It is an MCP client of `API_URL` plus `/mcp?chain=`. Pass `API_URL` as the origin only, `http://127.0.0.1:3001`, with no `/mcp` suffix. The runner opens one session per market whose share is above 0. It signs each wallet in once, keeps the session, and places that wallet's buy-ins. Base keys are `agent/keys.json`. NEAR keys are `agent/keys.near.json`. It keeps its own SQLite, with a `chain_key` on each row. It does not open this repo's ledger, and it does not spend the treasury key as a player wallet.

Start the market first and wait until `/api/state` answers. A down market does not exit the runner. Calls fail with the book unreachable, and the next wave retries.

Copy `.env.example` to `.env` in the directory you start from. Bun loads that cwd's `.env`. Copy the five market preferences from the market `.env`: `WINDOW_SECONDS`, `MARKET_SECONDS`, `VIEW_SECONDS`, `FEE_BPS`, `PRICE_SOURCE`.

`DB_PATH` is this runner's file. The default is `data/quick-market-agent.sqlite` under the working directory. Pointing `DB_PATH` at `data/quick-market.sqlite` from the market mixes the swarm into the ledger.

`AGENT_SPLIT_BASE` and `AGENT_SPLIT_NEAR` are whole numbers that sum to 100. Both unset means 100 and 0, so only Base Sepolia trades. Anything else that fails the sum exits with `AGENT_SPLIT_BASE and AGENT_SPLIT_NEAR must be whole numbers that sum to 100.` A share of 0 leaves that market idle. A share of 50 seats about half the clock on that market. The two shares are one crowd, not two full crowds.

`CHAIN` in the agent `.env` may stay `base-sepolia` while NEAR's share is above 0. The process still opens the NEAR session. These still have to be true, or it exits:

- A Base share above 0 needs the same `USDC_ADDRESS` as the market. A blank address is treated as Circle USDC and startup throws the quick-market USDC error.
- A NEAR share above 0 needs the same `NEAR_TREASURY_PRIVATE_KEY` and `TOKEN_ACCOUNT` as the market. The runner checks that the token is six-decimal QM and prints the treasury lines. Buy-ins still go through MCP. An implicit account can buy in before it holds on-chain NEAR.
- `CHAIN=base` prints `The swarm refuses CHAIN=base. Real USDC is out of this mode.` and exits.

`STATS_PORT` defaults to 3011, bound on `0.0.0.0`. `GET /api/health` returns the two lanes added together: online, enrolled, target, window, and stakes. The spring is the shared clock. The body has no keys and no addresses. `STATS_PORT=0` turns the listener off.

`SWARM_PIN` pins how many wallets stay online, before the split scales each market. Unset, the runner follows Asia/Manila and aims between 300 and 6,000, then multiplies that aim by the market's share. Each new wallet is granted once, on first sign-in. The runner never calls `claim_grant`. A wallet under the 1 USDC minimum cannot buy, so the treasury needs gas for those first mints before the swarm is useful. A first local run sets `SWARM_PIN=30`. A missing `agent/control.json` means clock mode. `SWARM_PIN` in the environment wins over that file.

Keys, `agent/control.json`, `agent/swarm.json`, `agent/status.json`, and `agent/flow.json` are paths under the process cwd. Per-market flow files are `agent/flow.<chain>.json` beside `flow.json`. `AGENT_DIR` is read by the container entrypoint only. `bun run agent` ignores it.

From the agent repo:

```bash
git clone https://github.com/ED3N-Foundries/quick-market-agent.git
cd quick-market-agent
bun install
cp .env.example .env
```

One `.env` covers both markets:

```bash
CHAIN=base-sepolia
USDC_ADDRESS=0x…          # same contract as the market
NEAR_TREASURY_PRIVATE_KEY=ed25519:…
TOKEN_ACCOUNT=            # same QM account as the market
API_URL=http://127.0.0.1:3001
DB_PATH=data/quick-market-agent.sqlite
AGENT_SPLIT_BASE=50
AGENT_SPLIT_NEAR=50
STATS_PORT=3011
SWARM_PIN=30
WINDOW_SECONDS=10
MARKET_SECONDS=10
VIEW_SECONDS=5
FEE_BPS=0
PRICE_SOURCE=binance
```

A NEAR-only run sets the split to 0 and 100. A Base-only run sets it to 100 and 0 and can leave the NEAR lines blank. Then:

```bash
bun run agent
```

The log line names the markets and the split, for example `Agents trade base-sepolia and near-testnet. Split base 50 / near 50.`

`bun run agents`, from the same cwd as that runner, is the terminal dashboard. It reads that cwd's `agent/swarm.json` and `DB_PATH`. From another directory the command is `bun /path/to/quick-market-agent/agent/dashboard.ts`. Closing the dashboard leaves the runner up. A balance under $3 stays put. A balance over $1,000 is withdrawn to that wallet.

## Admin

The admin page is [quick-market-health](https://github.com/ED3N-Foundries/quick-market-health). It probes the market over HTTP and the websocket the way a browser would, and it reads agent stats from `AGENT_URL`. It never opens the ledger.

```bash
git clone https://github.com/ED3N-Foundries/quick-market-health.git
cd quick-market-health
bun install
cp .env.example .env
bun run dev
```

The example already targets a market on this machine: `TARGET_URL=http://127.0.0.1:3001`, `AGENT_URL=http://127.0.0.1:3011`, `PORT=3101`. `INTERNAL_URL` is optional. When it is unset, the page uses port 3002 on the `TARGET_URL` host, which is this market. Set it when status and funding live somewhere else. `AGENT_URL` empty skips the swarm probe. A missed probe leaves the market verdict alone. The page has one agent URL, so it watches 3011. Leave `DOCKER_SOCK` blank. A set socket looks for containers named `quick-market` and `quick-market-agent`.

The page is http://127.0.0.1:3101. It binds `0.0.0.0:3101`, has no password, and shows the treasury address, so publish that port only on purpose. `bun run smoke` runs one probe in the terminal. JSON is `/api/check?fresh=1` and `/api/health`.

## Check

1. Market `.env`, then `bun run treasury`, faucet, `bun run token`, then `bun run dev`.
2. `curl -sf http://127.0.0.1:3001/api/markets` lists the filled chains. `curl -sf http://127.0.0.1:3001/api/state` returns a board. `curl -sf http://127.0.0.1:3002/api/funding` shows gas.
3. Start the agent. `curl -sf http://127.0.0.1:3011/api/health` returns a snapshot once the runner has published one. `running` stays false until that snapshot exists. `online` and `target` count both markets together when the split seats both.
4. Open http://127.0.0.1:3101. Config, state, and the websocket are the pieces that mark the market down.
5. Open http://127.0.0.1:5173.

## Architecture

Bun serves HTTP and a websocket. One SQLite database holds chain-scoped users, rounds, buy-ins, custody, and sessions, plus a shared BTC price tape. React draws the screen. The server wakes for the next price fanout, every 100ms, or for the next window boundary, strike, settle, or handoff resume. Between those moments it does not poll SQLite.

Buy-in windows tile UTC time. Each lasts `WINDOW_SECONDS`, and the next opens when the previous closes. Market `id` is `floor(now / window)`. Its book opens at `id * window`, the strike locks when that window closes, and it settles `MARKET_SECONDS` later. A buy-in names that window. If the server receives it outside the window, the buy-in is rejected and is not placed on the window that is open on arrival.

One buy-in on the page holds one open position. Another window returns "Your last buy-in is still open". Adding to the same side of the current buy-in is allowed. The other side is not. A buy-in needs a live feed: a print within the last 5 seconds. The minimum stake is 1 USDC.

Balances, stakes, fees, and payouts are integer micros. One USDC is one million micros. Strike and settle prices stay exchange strings. The fee is `FEE_BPS` of a paid two-sided pot. Each winner is paid their share of the pot after that fee. A one-sided pool returns every stake and takes no fee. A settle equal to the strike is a push and does the same. A market with no usable print for the strike or the settle is void and stakes return.

A wallet signs in once. Buy-ins and withdrawals use that session. On Base, a deposit is a Circle USDC transfer to the treasury, and the server credits the sender after the transfer is 3 blocks deep, only from that log. On Base Sepolia the playable balance is a grant of quick-market USDC: signing in, and `POST /api/grant`, mint it to the treasury and credit the ledger, once per `GRANT_INTERVAL_MS`. A withdrawal is signed before the balance is debited, and the same signed transaction is replayed if the process stops. On Base, new accounts start at zero. The first boot after custody landed zeros old demo balances and deletes open buy-ins.

The price feed is public WebSockets, with no API key. One venue owns a market from its open through its settle. The price is the size-weighted best bid and ask, so a one-cent touch still moves when the sizes change. Binance starts. Bybit, OKX, Coinbase, Kraken, and Bitstamp stay connected. If the active venue sends nothing for three seconds, every open market is voided, stakes return with no fee, and the next venue within $25 takes over. Buy-in stays closed for at least one window, and the screen names the new feed before the next market opens. Prints go out on `/ws` as `tick`. Book changes are compact, sequenced `book` patches; a gap or a slow socket triggers a fresh `snapshot`. Public `settled` frames omit account payouts, which are sent only to their signed-in owner and recovered from the account snapshot.

A browser buy-in is an authenticated websocket command with a UUID. The accepted request and debit commit together, so reconnecting and replaying that UUID returns the current account without charging again, even after the window closes. `POST /api/buy-ins` remains available and accepts the same optional `requestId`. Reconnects use bounded exponential backoff, while foreground probes, sequence checks, and snapshots recover stale state.

`GET /api/state` is the board, a short tape tail, the chain, and the signed-in user. `GET /api/tape?from=&to=` loads a bounded tape range when the chart is panned. `POST /api/session` opens a session. `POST /api/buy-ins` and `/api/withdraw` use it. `GET /api/rounds` is settled history. `GET /api/rounds/:id` is one round, its buy-ins, and the tape from the buy-in open through the settle, plus one print held into the open.

## UX

The screen is the chart, then Up, the stake, and Down. On a narrow window those three stack. The pool list under them is collapsed until opened. Previous rounds sit below that, with All and My plays. The footer states the window lengths, what up, down, push, and void mean, the fee, the feed name, and withdraw. Under that, Agents opens the MCP connector steps.

With no open buy-in the clock reads Buy-in and counts down to the window close. A 10 second buy-in reads 9.9 down to 0.0 and continues into the next window, and after a reconnect the clock follows the open window. The chart is that fixed window. The price sits left of the clock, and the lock on it spins until the strike. The pair badge sits above the price, with the feed's brand mark beside it. Up and Down show that side's share of the pool, the money and order count, and, with an amount entered, that stake's percent of the side and what it gets back. With no amount the line stays "$1 gets $y", or "$1 back" when the other side is empty.

After a buy-in, the clock reads Settles and counts down to settlement. The chosen card highlights and the other dims, showing the stake, its share of that side, and what it gets back. The stake field and percent chips hide until the position clears. Until the strike, the chart stays the buy-in window and the lock keeps spinning. From the strike until settlement the chart is one `VIEW_SECONDS` slice of that market. It opens on the strike, and the price line grows toward the right. When the line reaches that edge, the edge stays on the current time and the slice rides until settlement. Buy-in prints stay off that view. The live line glides between price updates, and a replay stays a step hold: green above the open, red below it, and blue dashed when it sits on the open. The lock closes, and the dollar move from the strike is shown large: `+$` Up, `−$` Down, or `=$0.00` Push. When the market settles, the screen returns to whatever buy-in window is open.

Dragging pans the buy-in chart and hides the scrub. Now returns to the follow span. A struck market stays on its own span, so a drag there does not pan. Hover shows the time, the held price, the change from the previous print, and Up, Down, or Push versus the open.

Connect Phantom is a full-width button under the header until the session is open. The balance row has no token badge. Deposit and withdraw still name the token. The stake amount is white. On Base, + opens a deposit of Circle USDC (+$10, +$1,000, or a custom amount) and Phantom confirms the transfer. On Base Sepolia, + opens a grant of QM USDC. The wallet is not charged, and Phantom is not asked. The backdrop or Escape closes either one. Withdraw sends that chain's token back to the wallet, and its error stays on the withdraw box. The balance flashes green or red when it moves.

A result toast appears only for a round this address played. It shows what was bought and what came back. A win also shows the profit in parentheses. A loss shows $0.00 back. Clicking a previous round opens a still replay from the buy-in open through the settle. Escape, the backdrop, or Close dismisses it. Previous markets list the feed for each round. My trades adds Bought and Back.
