# Quick Market

A 10-second Bitcoin up/down game. Everyone buys into the same window, chooses Up or Down, and winners split the pool after settlement. One-sided pools, pushes, and void rounds return every stake.

The live product uses NEAR Testnet for QM, a six-decimal NEP-141 token in [`contracts/near`](contracts/near). Meteor Wallet signs players in with NEP-413. Agents use the same market through MCP. Buy-ins and round payouts are a **custodial SQLite ledger**; the NEAR contract holds and transfers QM, while round math remains on the server.

## Try the hosted demo

Open **https://quickmarket.app**. No installation is needed.

1. See the live Bitcoin chart, Up, Down, and the shared buy-in countdown. The chain reads **NEAR Testnet**.
2. Connect with Meteor Wallet. A new account receives a 100 QM test grant; no wallet transaction is needed for the grant.
3. Enter at least 1 QM and press Up or Down before the countdown closes. See your side highlighted and the clock change to **Settles**.
4. Wait about 20 seconds from a fresh buy-in window: 10 seconds to strike, then 10 seconds to settle. See the result and your updated balance.
5. Withdraw to send QM from the market treasury to your NEAR account.

Public API checks:

```bash
curl -sf https://quickmarket.app/api/markets
curl -sf https://quickmarket.app/api/state
```

The first response includes `defaultChainKey: "near-testnet"`, the QM token account, and its treasury. Agent MCP is at `https://quickmarket.app/mcp?chain=near-testnet`; the page's **Agents** panel explains the connection.

## Run the complete demo locally

The local path uses real NEAR Testnet, real agent wallets, and the public Bitcoin price feeds. It does not use Docker or any core-infrastructure service. Rust is not needed because the compiled contract is committed at `contracts/near/res/quick_market.wasm`.

### 1. Install and clone

Install [Bun 1.4.4](https://bun.sh) and confirm `bun --version`. Node/npm cannot replace Bun because the server uses `bun:sqlite`.

Clone the three public repos side by side:

```bash
git clone https://github.com/ED3N-Foundries/quick-market.git
git clone https://github.com/ED3N-Foundries/quick-market-agent.git
git clone https://github.com/ED3N-Foundries/quick-market-health.git

cd quick-market
bun install
(cd ../quick-market-agent && bun install)
(cd ../quick-market-health && bun install)
cp .env.example .env
```

Leave the Base key and token lines blank for this NEAR-only demo. Keep `.env` uncommitted; it will contain testnet secrets.

### 2. Create a funded NEAR treasury

```bash
CHAIN=near-testnet bun run treasury
```

The command generates a key, creates a funded `qm-….testnet` account through NEAR's public testnet helper, and writes `NEAR_TREASURY_PRIVATE_KEY` and `NEAR_TREASURY_ACCOUNT` to `.env`. No wallet or faucet form is needed. If the key already controls an on-chain implicit account, the command keeps that existing treasury instead. The treasury pays for contract deployment and the agents' initial QM grants.

### 3. Deploy the test token

```bash
CHAIN=near-testnet bun run token
```

The command deploys the committed WASM and writes `TOKEN_ACCOUNT` and `TOKEN_PRIVATE_KEY` to `.env`. If a valid `TOKEN_ACCOUNT` is already configured, it does not redeploy.

### 4. Start everything

```bash
bun run demo
```

This one command starts the market, a NEAR-only swarm capped at 30 online wallets, and the health page. It pins `CHAIN` to `near-testnet` regardless of the `CHAIN` value left in `.env`. It reuses the market `.env`; do not create or synchronize agent and health `.env` files.

| Service | URL | Expected result |
|---|---|---|
| Game | http://127.0.0.1:5173 | Live BTC chart and Up/Down pools |
| API | http://127.0.0.1:3001/api/state | Current round, live feed, tape, and pools |
| Agent stats | http://127.0.0.1:3011/api/health | `running: true`, then rising enrollment and bot buy-ins |
| Health | http://127.0.0.1:3101 | Timed API, websocket, feed, RPC, funding, and agent checks |

Allow about a minute for the first small swarm to enroll. Bot rows then appear in the pools and settled rounds accumulate. Press **Ctrl+C** once to stop all three processes. Ports 3001, 3002, 3011, 3101, and 5173 must be free. If they are occupied, `DEMO_PORT_OFFSET=1000 bun run demo` moves every service up by 1000 (game at 6173, health at 4101).

### 5. Verify the loop

```bash
curl -sf http://127.0.0.1:3001/api/markets
curl -sf http://127.0.0.1:3001/api/state
curl -sf http://127.0.0.1:3002/api/funding
curl -sf http://127.0.0.1:3011/api/health
curl -sf 'http://127.0.0.1:3101/api/check?fresh=1'
```

You should see NEAR listed in `markets`, a live feed in `state`, treasury balances in `funding`, agent activity in the stats response, and successful critical checks in health. Agent judges without a wallet can stop here: bot rows in the pools, accumulating settled rounds, and the agent stats response already prove the loop. To drive it directly, use an MCP client (Streamable HTTP handshake) against `/mcp?chain=near-testnet` per the [agent and MCP flow](ARCHITECTURE.md#agent-and-mcp-flow); raw `tools/call` posts without a session will not answer. A NEAR testnet wallet connect on the game page is optional; it repeats the hosted-demo buy/settle/withdraw loop.

## Agents

The swarm in [quick-market-agent](https://github.com/ED3N-Foundries/quick-market-agent) is an MCP client, not a privileged ledger writer. Every agent wallet signs in, receives the normal test grant, chooses its own side and stake, trades, settles, and can withdraw QM. See the [agent and MCP flow](ARCHITECTURE.md#agent-and-mcp-flow) for the individual tool calls.

## Why these tracks

- **Games With Real Economies (`games`):** a complete, short game loop with wallet-funded stakes and visible payouts.
- **Agent Economy (`agents`):** independent agents sign, receive test funds, spend QM, settle positions, and withdraw through MCP.
- **AI Swarms (`swarms`):** many autonomous wallets coordinate through one shared pool without a central side assignment.

This build does not claim NEAR Intents, chain signatures, agent hiring, or on-chain round settlement.

## Hackathon scope and baseline

Quick Market ran on Base Sepolia before the hackathon. That Base book, its grant flow, and Phantom sign-in are the earlier product. The work for judging is the NEAR integration: the QM NEP-141 contract, NEAR Testnet market, Meteor NEP-413 sign-in, QM grants/withdrawals, MCP, and NEAR swarm.

Tag [`pre-hackathon`](https://github.com/ED3N-Foundries/quick-market/tree/pre-hackathon) is the baseline before the 2026-10-19 announcement window. The hackathon work is the [baseline-to-submission diff](https://github.com/ED3N-Foundries/quick-market/compare/pre-hackathon...hackathon-submission). There is no mainnet deployment.

The project has three public repos: this market, [the swarm](https://github.com/ED3N-Foundries/quick-market-agent), and [the health page](https://github.com/ED3N-Foundries/quick-market-health).

## Build and test

```bash
bun test
bun run build
```

Implementation details, configuration, and the MCP tool sequence are in [ARCHITECTURE.md](ARCHITECTURE.md). Production and optional container commands are in [DEPLOY.md](DEPLOY.md); neither is needed for judging.

## Libraries

Versions are locked in `package.json`, `bun.lock`, and `contracts/near/Cargo.toml`.

- Bun 1.4.4, React 19, and Vite
- `near-sdk` 5.14.0 and `near-sys` 0.2.9
- `@meteorwallet/sdk` for NEAR wallet sign-in
- `@noble/ed25519`, `@noble/hashes`, and `bs58` for NEP-413 verification
- `@modelcontextprotocol/sdk` for agent tools
- `viem`, `wagmi`, and `@phantom/react-sdk` for the earlier Base product
- `zod`; `@coinbase/cdp-sdk` is installed but not on the NEAR path

Licensed under [MIT](LICENSE).
