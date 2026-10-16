# Agents

`bun run agent` runs the wallets. On Base Sepolia each wallet receives the same quick-market USDC grant as a person, once every two minutes, then bets 1 on each open window. It does not call the Coinbase faucet or sweep. `AGENT_COUNT` is 1 to 40, default 8. `AGENT_SECRET` marks the session as a bot. `CHAIN=base` does nothing unless `AGENT_MAINNET=1`. On mainnet a wallet that holds USDC sweeps it to the treasury before betting.

`bun run agents` is the dashboard. Start the agent first. The agent writes `agent/status.json` and `agent/flow.json`. The dashboard writes `agent/control.json`. Those files are gitignored. Closing the dashboard leaves the agent running.

Keys: ↑↓ or j/k select a wallet, p pauses or resumes it, P pauses or resumes every wallet, f asks the faucet once when that wallet is short, s signs it in again, q closes the dashboard. A paused wallet does not claim, sweep, or bet.

The header shows how many wallets are paused or stuck, ledger USDC, inflow, and outflow. Inflow is faucet USDC and ledger credits. Outflow is sweeps to the treasury and accepted stakes. Totals start from the balance the agent first sees, then add each later receipt once.

A row is stuck when the CDP keys are missing, a faucet receipt left the wallet short for two minutes, a sweep or sign-in failed, the server chain does not match, the same error happens three times, or the ledger has at least 1 USDC and three windows pass with no bet.
