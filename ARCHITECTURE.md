# Architecture

This document describes the implementation. For the hosted product and the shortest local setup, start with [README.md](README.md).

## System

Bun serves HTTP, websockets, MCP, and an internal diagnostics port. React and Vite render the game. SQLite stores chain-scoped accounts, rounds, buy-ins, custody, sessions, and the BTC tape. The agent has a separate SQLite file and never opens the market ledger directly.

The NEAR integration uses a six-decimal NEP-141 QM token. Meteor Wallet signs players in with NEP-413. Buy-ins and round payouts use a custodial SQLite ledger; the NEAR contract holds and transfers QM, while round math remains on the server.

## Market lifecycle

Buy-in windows tile UTC time. The strike locks when a window closes, and settlement occurs `MARKET_SECONDS` later. Balances and payouts use integer micros. The default fee is zero.

Binance supplies the initial public price feed; Bybit, OKX, Coinbase, Kraken, and Bitstamp provide keyless backup feeds. A stale feed rejects buy-ins and can void open rounds rather than settling on missing data. One-sided pools, pushes, and void rounds return every stake.

## Agent and MCP flow

The swarm in [quick-market-agent](https://github.com/ED3N-Foundries/quick-market-agent) is an MCP client, not a privileged ledger writer. Each wallet signs in locally, receives the normal testnet grant, chooses its own side and stake, and places buy-ins through `place_buy_ins`. Withdrawals return surplus QM to the agent wallet.

For a single agent, call these tools at `/mcp?chain=near-testnet`:

1. `book` — get the current `roundId`, pools, and feed.
2. `login_message`, then `sign_in` with the locally signed NEP-413 payload — open a session and receive the first grant.
3. `place_buy_in` with `side`, `stake: "1"`, and a currently open `roundId` — enter the shared pool.
4. `account` after settlement — see the updated balance; `withdraw` sends QM back to the agent account.

## Configuration

The defaults are `WINDOW_SECONDS=10`, `MARKET_SECONDS=10`, `VIEW_SECONDS=5`, `FEE_BPS=0`, `PRICE_SOURCE=binance`, and a 100 QM grant every 120 seconds per account. `.env.example` documents RPC failover and all chain settings. `bun run demo` selects NEAR and a 30-wallet swarm; `SWARM_PIN` can override that count.

The game is also available as separate processes: `bun run dev` starts only the market, `bun run agents` in the agent repo opens its terminal dashboard, and `bun run dev` in the health repo starts only health. See those repositories for standalone configuration.

## Processes and deployment

`bun run demo` is the local judge path. `bun run start` is production mode and serves `dist/` from the API on port 3001. The optional three-repository container deployment is documented in [DEPLOY.md](DEPLOY.md).
