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

## Optimization

The current release removes the startup active-five aggregate, resets the local round epoch, adds a fresh-database path that keeps wallet identities and session tokens, and adds fast `resume_sessions` repair. The reliability hotfix adds indexed open-round reads, a bounded feed handoff with an all-down pin reset, and a once-per-second agent write batch. Phase 1 lands MCP session TTL, auth pruning, and tape caps; the `buy_ins` rebuild (P1-6) replaces the UUID primary key with the composite `(chain_key, round_id, address)` key, dropping two of four per-insert index writes and refreshing planner statistics behind a one-shot migration. Phase 2 lands the NEAR reliability set: a failed NEAR boot degrades to a retrying watchdog instead of omitting the market for the process lifetime (`nearWatchdog.ts`), RPC failures classify into abort/rate/server/history/execution kinds so an abort rotates without parking and never looks like a rate ban, the default endpoint order demotes dRPC to last for reads while broadcasts still sort to its short send ceiling, and deposit custody self-schedules with a bounded catch-up (bigger batches under a time budget while the lag is past `NEAR_DEPOSIT_CATCHUP_LAG`) that records pruned-range jumps in `near_deposit_skips` instead of only logging them. The items below are still unaddressed, roughly in priority order.

### Reliability and market continuity

- **Every venue is connected and parsed all the time.** On constrained machines `quick-market` sits near one CPU core; JSON parsing and reconnect churn are the likely cost. Keep the active venue plus two standbys hot and warm the rest only when a switch fails, or move feed parsing off the main event loop. Profile the `hangs` samples after that.
- **Snapshots and tape payloads are rebuilt frequently.** Cap or sample the tape tail and avoid rebuilding unchanged bands. The agent only needs the recent tape and the open book.
- **The fixed feed handoff pauses the whole market.** The wait is now bounded to 30 seconds and an all-down reset reconnects once, but a per-venue readiness signal (first print after adoption) would resume buy-ins as soon as the new venue is actually live.

### Agent startup and local database

- **Fresh-database reset is a manual one-off.** Add a documented reset path that creates the new file, copies only `wallets`, sets `agent_swarm_v1`, initializes `settle_cursor`, and deletes the legacy `swarm.sqlite`. The current reset was performed by hand.
- **No compaction or vacuum policy (market side addressed on this branch).** P3-3 archives settled rounds and their buy-ins behind `ROUND_RETENTION_MS` (default 3 days), which bounds the live set; the `db` object in `/api/health` and `/api/status` reports `autoVacuum`/`freelistPages`/`pageCount`, so the one-time maintenance `VACUUM` that shrinks the file itself is an informed operator call. The agent file still has no compaction policy.
- **Re-enabling active-five needs an index or aggregate.** The weekly `GROUP BY` over `stakes` caused the startup OOM. If it returns, use `stakes(chain_key, address, round_id)` or a rolling weekly table, exclude the prior epoch, and never run it on the startup path.
- **The fresh database starts with no replay history.** That is correct for a reset, but a short warm replay of recent settled rounds would restore the local win/loss memory sooner.

### Session and authentication

- **`resume_sessions` is an MCP call carrying up to 1,000 tokens.** It works, but a dedicated agent batch endpoint or an agent-level credential would remove per-wallet sign-in from the hot path and keep the server account map small.
- **A single session can hold about 10,000 accounts.** Cap accounts per session and rate-limit `resume_sessions`; otherwise one client can consume the event loop with token validation and map growth.
- **Two lanes share one Bun process and one MCP event loop.** A heavy base resume or audit can delay the near lane. Add a global limiter or run each chain in its own process.
- **Live sessions do not expire until reconnect.** Tokens last seven days; `refresh` is now out of the hot path. Add a bounded periodic expiry sweep or close idle sessions with very large account maps.
- **There is no per-call deadline for every tool.** `book`, `rounds`, `sign_in`, `place_buy_ins`, and `resume_sessions` use different timeouts. Centralize the policy and record the tool name with timeout failures.

### Agent trading shape

- **Some rounds still have no buy-in.** Most gaps are the gate, tempo, or tape doing their job; feed-switch voids account for others. If “never empty” is a requirement, add a small forced seed trade or document the empty window as deliberate.
- **Late chunks can still land after the close.** The one-second margin reduced this, but a slow `place_buy_ins` can straddle the boundary. The server’s idempotent `(round, address)` handling prevents doubles; add a server-side deadline/drop response and report accepted-but-timed-out orders instead of counting them as rejected.
- **The order cap and fire slots assume ten-second windows.** `orderCap`, `betChunk`, and `marginMs` are coupled to `WINDOW_SECONDS` and need revisiting if the window changes.

### Observability and operations

- **The health page is merged, not per lane.** A bad lane can hide behind a healthy one. Expose per-lane `online`, `enrolled`, `bound`, `book`, `lastError`, and `bookLag`; the agent already writes per-chain meta for diagnostics.
- **`lastError` clears on the next successful book load.** Keep a ring of recent errors and rejections with timestamps so transient transport timeouts remain visible after recovery.
- **`downReason` can read `feed live` while status is OK.** Normalize the health payload so an OK status carries no down reason.
- **The dashboard still writes the repo’s `agent/control.json`.** The container reads `/data/agent/control.json`. Move steering to a small authenticated `POST /api/control` on the runner’s stats listener, or run the dashboard against the volume.
- **The player default is near-testnet.** Keep it if that is the primary demo; otherwise change `defaultChainKey` or the split. The 25/75 split is deployment configuration, not a code constant.

### Build and deployment

- **`qm:deploy` can discard dirty submodules.** Its update step checks out `origin/master`. Refuse to deploy when the three submodules are dirty, or make `build`/`up` the documented path for local changes.
- **Images can be built from a dirty tree.** The current images were built that way. Commit and push the submodule changes and update the superproject pointers before the next `qm:deploy`.
- **There is no end-to-end smoke test.** Add a test that starts the market and a small agent against a mock feed, asserts the first buy-in within one window, exercises a reconnect/resume, and enforces a clean RSS/OOM bound. The current tests cover units and the MCP contract but not the full restart path.
