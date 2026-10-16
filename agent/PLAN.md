# Selfish agent swarm

A Bun runner keeps a crowd of durable wallets whose size glides between a few hundred and a few thousand, each betting to win for itself with uneven stakes. Surplus above $1,000 is burned. Balances under $3 are refilled just enough to stay in the game. The human grant, the human withdraw, and the one-bet lock stay as they are.

## How many are online

The live crowd always prefers a window about 300 agents wide. That window slides. It does not jump.

Asia/Manila (UTC+8, no daylight saving) is the clock. Hours below are Manila local.

| Hours | Preference window |
| --- | --- |
| 02:00–07:00 | Fixed at [300, 600]. This is the off-peak example. |
| 07:00–17:00 | Center eases from 450 toward the low end of the peak box (~3,150) with `easing.cubicInOut`. The window is `[center - 150, center + 150]`. |
| 17:00–23:00 | A 300-wide window whose center wanders inside [3000, 6000]. An evening might sit near 3,400, then near 5,200. It does not occupy that whole span at once. |
| 23:00–02:00 | Center eases back to 450. |

The window is clamped so it never asks for fewer than 300 or more than 6,000. While the legal box is only 300 wide, the window is that box. While the box is wider, the center walks inside it and the window stays 300 wide.

The integer online count chases the window center with `spring.damp` (`smoothTime` about 180 seconds). It may trail the window by a few minutes. Presence changes are capped at 30 wallets a second, so a dashboard override still glides instead of signing in thousands at once.

Keys are an identity pool, not the live count. `agent/keys.json` only grows, up to 6,000, mode 0600. Dropping to off-peak sleeps wallets. It does not delete keys. The first wallets already in the file stay themselves.

`SWARM_PIN` (or the dashboard pin) replaces the clock with a fixed target for a small local run. Unset, `bun run agent` follows Manila time. The swarm refuses `CHAIN=base`. Real USDC is out of this mode.

## Layers

Each layer is a pure function with tests, except the last two, which do I/O.

### 1. Clock and preference

`agent/director.ts`

Inputs are `now`, a timezone, and the schedule above. Output is the envelope, the 300-wide window, and the spring target.

Use `math` (pmndrs, pin `0.1.0`):

- `lerp`, `clamp`, `remap` for the schedule.
- `easing.cubicInOut` on the morning rise and the late decline.
- `simplex2d` plus `fbm` for the evening wander. There is no 1D simplex in this package. Sample `simplex2d` with time on x and a constant on y, then stack octaves with `fbm`.
- `spring.damp` for the online count. One scalar spring, updated with the real delta, not a new spring each tick.
- `mulberry32` only where a decision must be reproducible from a seed.

Noise amplitude is half the spare room inside the current box, so the wander cannot leave [3000, 6000] during peak or leave [300, 600] off-peak.

### 2. Who is awake

`agent/presence.ts`

Every key has a stable score from its index: a personal hour offset of about ±2 hours, plus a slow simplex mood. Each tick, rank the pool and keep the top N near the spring target.

Hysteresis: an awake wallet stays until its rank falls ~40 places past the cutoff. A sleeping wallet stays asleep until it climbs ~40 places in. Wallets near the cutoff drift on and off. Wallets deep in the ranking stay through the evening. That is the coming-and-going, without flapping the same address every window.

Paused addresses and a global betting pause do not change presence. They only stop bets. Sleeping wallets do not sign in, bet, or receive money.

New keys are created only as the high-water mark rises, and only inside the 30-per-second budget.

### 3. Bankroll and bleed

`agent/bank.ts` decides. The server moves the tokens.

Every bot balance lives in [$3, $1,000] (3_000_000 to 1_000_000_000 micros) after a money action.

- First time a wallet is enrolled: one seed credit, log-uniform between $8 and $250, drawn with `mulberry32` and `easing.expoOut` so most wallets start small.
- Under $3: mint the gap up to a seeded pocket in [$6, $24]. Once per crossing.
- Over $1,000: burn down to a seeded pocket in [$80, $600]. That is a person taking profits, not a $1 trim off the cap.
- Inside the band: no mint and no burn.

Bots do not receive the human grant ($100 every two minutes). `applyGrant` on `/api/session`, `/api/state`, and `/api/grant` skips `is_bot`.

A bot withdrawal is a burn:

1. Debit the ledger into a pending burn row (same safety idea as a human withdraw).
2. The treasury sends that qmUSDC to `0x000000000000000000000000000000000000dEaD` with the existing `transfer`. The deployed token has `mint` and no `burn`. A dead-address transfer destroys the backing without a redeploy.
3. Mark the row burned. If the transfer fails, refund the ledger the way a reverted withdraw does.

The agent EOA is not paid. Human withdraws still transfer real qmUSDC or USDC to the person.

Bleed is the cap burn plus the pari-mutuel fee, against small floor mints. Winners cash out by burning. Losers come back cheap. The $100 grant must not run on these wallets or the band is impossible.

Dashboard `bleed off` freezes mints and burns for inspection. Betting can continue.

### 4. Each agent tries to win

`agent/persona.ts`, `agent/decide.ts`, `agent/stake.ts`

Personas are seeded once from the wallet index and stored. They are not a shared forecast and they are not told the next print.

A persona holds:

- momentum weight from about −1 (fade the move) to +1 (follow it)
- lookback of 2–12 seconds
- minimum edge before it will bet
- a Kelly fraction and a max share of its own bankroll (about 1–8%)
- a disagreement noise scale

The public tape tail is the only price input. `pUp` is a sigmoid of momentum times recent return, scaled by recent volatility, plus that wallet's noise. A flat tape puts most agents near 0.5, so they skip.

Against the pool:

- Implied up-price is `up / (up + down)`, or 0.5 when both sides are empty.
- Bet the side where `p` beats the implied price by more than that persona's edge. Otherwise skip.
- Stake is a fractional-Kelly slice of that wallet's bankroll, clamped to the persona max and to the spendable balance. Minimum remains $1. Below $1 the wallet skips until a floor mint.

Orders are walked in a `mulberry32(roundId)` shuffle against a shadow pool. Each accepted stake updates the shadow, so the next wallet sees a worse price. They compete. They do not take turns losing. Both sides fill when personas disagree. A flat or already-fair pool produces a quiet window.

Cap at 800 orders per window. Confidence is already filtered by the edge rule. The cap is only a backstop.

Stakes must not pile up on round dollars. After the Kelly size, reshape onto cents:

- Draw with the persona RNG and `easing.expoOut` so the distribution is skewed small: most tickets $1–$8, a minority $8–$40, few above that.
- If the cent string is a round dollar (`x.00`) or a poster amount (`*.00`, `*.50` on a ten), add a seeded cent offset in `±3¢` to `±40¢` that still respects the $1 floor and the wallet balance.
- Send micros. `parseMicros` already accepts up to 6 decimal places. The batch path sends integer micros directly so we do not round back to a dollar.

A wallet bets at most once per window. Same-side adds are not used by the swarm. The other side is a skip.

Local memory of the last 32 personal results nudges that wallet's edge threshold and a tiny bias. The step is capped. A wallet that is wrong becomes pickier. It does not flip the whole crowd onto one side.

No wallet sees a future print, another wallet's private noise, or the settle price.

### 5. Runner

`agent/index.ts` stops being a serial loop of RPC balance reads, `/api/state`, and one `$1` POST.

One Bun process:

1. Read `agent/control.json`.
2. Step the director and presence.
3. Enroll newly awake wallets in parallel, about 16 at a time. One signature per wallet per lifetime. `POST /api/agents/enroll` with `AGENT_SECRET`. The server verifies the signature, inserts `is_bot = 1`, and applies the seed credit. An address that already exists as a human is rejected. A leaked secret cannot take over a person.
4. Once per betting window, one `GET /api/agents/book`: join id, both pools, a short tape tail, and rounds settled since a cursor (strike, settle, fee, pools, winning side). No per-wallet RPC. No `eth_getBalance`. No `balanceOf` on the hot path.
5. Replay settlements locally with the shared pure settle function, using the stakes this process recorded. That updates the cached bankroll. A slow audit (`GET /api/agents/balances` for a slice of ~200 addresses every few seconds) corrects drift.
6. Run the shadow-pool decisions in memory.
7. `POST /api/agents/bets` in chunks of about 200: `{ address, side, stakeMicros }`. One SQLite transaction per chunk, one `publishRound` after the chunk. Per-row errors do not roll back the rows that passed. Target under ~20ms per chunk so the 16ms market loop is not stalled for long. Bun's SQLite connection is the single writer.
8. Apply bank actions (burn or floor mint) on a 5 second pass, not inside the bet transaction.
9. Write aggregates. Sleep until the next window or the next presence tick, whichever comes first. There is no 1 second pause between wallets.

Sepolia agents do not call the CDP faucet and do not sweep. The ledger is the bankroll.

If a window cannot be posted before it closes, skip it. Late bets are not retried into the next window.

### 6. See it and steer it

`bun run agents` stays a Bun ANSI dashboard. It does not open `data/quick-market.sqlite`.

The runner writes:

- `agent/swarm.sqlite` (gitignored): one row per wallet (online, phase, bankroll, last side, last stake, last skip reason, win/loss counts) and a ring of window summaries.
- `agent/swarm.json`: a small snapshot every quarter second (Manila time, window, online, spring target, bets, skips, stake percentiles, balance histogram, mint micros, burn micros, last error, book lag).

The dashboard reads those. It does not parse a 6,000-row `status.json`.

Views, switched with number keys:

1. Crowd. Manila time, schedule phase, preference window, online versus spring target, arrivals and departures this minute, an ASCII trace of the last few hours.
2. Book. This window's up and down notional, bot share versus humans, skip rate, stake p50 and p90.
3. Money. Seed, floor mints, burns, net bleed, histogram of balances ($3–10, $10–50, $50–200, $200–1000, outside).
4. Roster. One page of about 24 rows. Filters: stuck, richest, just woke, just slept. `j` / `k` move.
5. One wallet. Persona knobs, bankroll, last decisions, why it skipped.

Controls, written to `agent/control.json`:

- follow the clock, hold off-peak, hold peak, or pin a count
- pause or resume betting for the swarm, and for one address
- bleed on or off
- `q` closes the dashboard and leaves the runner up

`status.json` and `flow.json` remain as the aggregate snapshot and the mint/burn/stake totals so a non-interactive `bun run agents` still prints a page. They are no longer one row per wallet.

## Server, only where the crowd would break the book

Public clients must not receive every bot ticket.

- `board()` keeps pool totals and player counts. The tray lists humans, plus a short bot summary (count and notional per side) and a handful of sample bot rows. The pool disclosure in `web/src/App.tsx` shows that summary instead of hundreds of "Bot" lines.
- The settled websocket event keeps the round result and human payouts. Bot payout rows are left out. The client already looks up the signed-in address. The runner replays its own payouts from the public result.
- `placeBet` stays the human path. `placeBets` is the bot batch: bot flag, open window, live feed, minimum stake, balance, unique `(round_id, address)`.
- Close-round stops calling `youFor` once per bot just to fill a payload nobody renders.

Indexes already exist on `bets(round_id)` and `bets(address)`. Batch inserts use the unique pair so a retried chunk cannot double a stake.

## What changes where

- Add dependency `math@0.1.0`. Import `math` scalars, `math/time`, `math/random`, and `math/noise` only.
- New pure modules under `agent/`: `director.ts`, `presence.ts`, `persona.ts`, `decide.ts`, `stake.ts`, `bank.ts`, plus tests.
- Rewrite the hot loop in `agent/index.ts`. Keep key loading, but stop truncating `keys.json` to `AGENT_COUNT`.
- Rewrite `agent/dashboard.ts` and the summary types in `agent/status.ts`.
- `server/grant.ts` and the three grant call sites skip bots.
- `server/rounds.ts` gains the batch bet and the slim tray. Settlement payload drops bot payouts.
- `server/index.ts` gains `/api/agents/enroll`, `/api/agents/book`, `/api/agents/bets`, `/api/agents/balances`, `/api/agents/burn`, `/api/agents/resurrect`. All require `AGENT_SECRET`.
- `server/custody.ts` sends bot burns to the dead address.
- `web/src/App.tsx` renders the bot summary in the existing pool disclosure.
- `agent/README.md` describes the clock, the band, the dashboard keys, and the Sepolia-only rule.

## Tests

- Director: a Manila 03:00 timestamp yields the window [300, 600]. A Manila 21:00 timestamp yields a 300-wide window inside [3000, 6000]. Samples from 07:00 to 17:00 move the center upward. A spring stepped across ten minutes of a large gap does not teleport.
- Presence: raising the target wakes that many, and only that many. Hysteresis keeps a wallet seated when the cutoff jitters by a few ranks. The key file never shrinks.
- Stakes: across thousands of seeded draws, whole-dollar amounts are rare, nothing is under $1, the median is small, and the same seed repeats.
- Decide: a rising tape and a cheap up-pool produces an up bet for a momentum persona. A fair pool produces a skip. Two personas with opposite weights can take opposite sides of the same shadow book.
- Bank: $1,200 burns down into [$80, $600]. $2 mints into [$6, $24]. $40 does nothing. A bot session does not take the $100 grant.
- Batch: one bad row (poor balance) does not reject the good rows. A second post for the same wallet and window does not double the stake.
- Dashboard: the overview renders from a fixture snapshot and does not print thousands of lines.

## Check before calling it done

- `bun test` for the new pure modules and the server batch, grant skip, and burn.
- Run the API and a pinned swarm of about 30 wallets. Confirm a window shows mixed cent stakes, both sides when the tape is moving, skips when it is flat, and a burn when a balance is forced over $1,000.
- In the browser, open the pool disclosure and a settlement with the swarm running. Humans still appear as themselves. The list stays short. The signed-in person's result toast still shows their own payout.

## Out of scope

- Mainnet swarm, CDP faucet, and sweeping agent EOAs.
- An LLM per wallet.
- Changing the 5 second window, the human one-bet lock, or the human grant.
- A new token `burn()` and a redeploy. The dead-address transfer is the burn.
- Geometry, IK, and color from `math`. They are the wrong tools here.
