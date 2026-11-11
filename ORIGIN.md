# Quick Market origin

The original product brief, the progress checklist that went with it, and the 2026-11-10 migration diary. How the market runs now is in README.md. NEAR hackathon instructions stay in HACKATHON.md.

## Progress

- [x] Scaffold: Bun, SQLite, React shell
- [x] Live BTC tape and continuous chart
- [x] Successive betting windows, pari-mutuel settlement, ride-only market chart
- [x] Trading screen
- [x] History, NEAR wallet, and dormant Base wallet support

## Migration

On 2026-11-10 the chain-scoped schema (`chain_key` on users, rounds, buy-ins, custody, sessions, and agent state) cut over on `project-ed3n.local`, and trading history was reset: rounds, buy-ins, and ticks were wiped while users, balances ($380,536.55 across 5,368 wallets), deposits, withdrawals, burns, sessions, and meta were kept. The treasury and `deploy/quick-market.env` were untouched (0.0285 Base Sepolia ETH, ~$753k QM USDC on-chain, so no faucet top-up was needed). Rollback image `ed3n/quick-market:pre-multichain-20261110` is on the host.

Backups on `project-ed3n.local`:

* `/home/admin/backups/quick-market-multichain-20261110/` — pre-migration volume tarball, table baselines, and rehearsal copy
* `/home/admin/backups/quick-market-prewipe-20261110-1603/` — full pre-wipe database copy
* `ed3n_qm_data` volume `quick-market.sqlite.bak-full*` — shelved 3.1 GB original (remove after trading looks normal)

## Brief

I want to make a quick polymarket like interface trading app, where it's focused on "betting" feel and simplicity. Starting with just one thing: bitcoin price, which we will aggregate from trading view, but initially is there a free way? We need to get second by second prices and chart that. the premise is two buttons, up or down, every 5/10s (we configure this server side) you bet up or down with an amount of money you specify which is a %, so if you are like 50% of your side of the bet, you get 50% of the money from the losers. Platform takes 0.25% fees off of each concluded trade. For now we want to simulate but this will all be smart contracts soon. We want to place hold wallet connect, fund, withdraw, etc. but not wire it up yet just have the buttons and simulate in React for now. We want to use Bun + SQLite as the backend. We want to tables for previous bets and also a current bet tray that shows the current time we are on for what pub addresses (truncated) are playing in this pool and how much they bet. We can view the pools and addresses of our previous plays, too.

The main focus of the app is the up down buttons and the main view showing our window to bet in and then green above the line and red below the line, where we are only ever going to bet if Bitcoin will END this round on up or down.

We need to show big the % of people and the amount of money on each side of the pool the whole time.

Once a market is started (this is universal time for everyone) we set server side in our config the time on how far out but I want it to be 5 or 10s out for now. Where once that resolves, winners take all. We need a clean minimalistic and nice interface.

Let's do this in pieces and mark off what we have done. SC's, wallet connect, etc. come later. Research and find ways to oracle the price that are cheap or even free for us ideally.
