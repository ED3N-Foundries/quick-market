# Agents

`bun run agent` is one Bun process for the whole swarm. It follows Asia/Manila (UTC+8, no daylight saving). The preference window is 300–600 wallets from 02:00 to 07:00, eases up through the morning, wanders inside 3,000–6,000 from 17:00 to 23:00, and eases back overnight. The live count chases that window and can trail it by minutes. Wallets sleep when the room shrinks. Their keys stay.

Each wallet bets for itself. Stakes are uneven cents, usually a few dollars. A balance under $3 is refilled into a small pocket. A balance over $1,000 is burned down into a pocket between $80 and $600. The burn is a transfer of qmUSDC to the dead address. Bots do not take the human grant.

`SWARM_PIN` pins the online count and bypasses the clock floor, which is how a 30-wallet check runs. Unset, the process follows the clock. The swarm refuses `CHAIN=base`. Real USDC is out of this mode. Sepolia agents do not call the CDP faucet and do not sweep. The ledger is the bankroll.

`AGENT_SECRET` is required. The runner signs each wallet in once through `POST /api/agents/enroll`.

Edit `agent/config.ts`. That file is the schedule, the minds, the stake shape, and the runner batch sizes. `agent/control.json` only steers a running swarm: follow the clock, hold off-peak, hold peak, pin a count, pause betting, or freeze mints and burns.

`bun run agents` is the dashboard. It reads `agent/swarm.json` and `agent/swarm.sqlite`. It does not open `data/quick-market.sqlite`. Closing it leaves the runner up. A non-interactive run prints one page from `agent/status.json` and `agent/flow.json`.

The interactive screen is one OpenTUI view. Crowd, book, and money stay on screen. The roster fills the rows that are left and follows the terminal size. On a wide terminal the book and money sit on one line and the roster shows mind, last bet, and W/L. On a short terminal the sparkline and the balance histogram drop out. `?` shows the keys.

Keys:

- `j` / `k` or the arrow keys move the selection. The mouse wheel scrolls it
- `c` follow the clock, `o` hold off-peak, `e` hold peak
- `[` / `]` step the pin by one, `-` / `=` step it by ten
- `b` pause or resume swarm betting, `p` pause or resume the selected wallet, `P` clear wallet pauses
- `m` bleed on or off, `f` cycle all, stuck, and richest
- `r` start or stop the background runner
- `q` closes the dashboard
