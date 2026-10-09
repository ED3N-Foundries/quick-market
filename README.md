# Quick Market

Simulated bitcoin up/down pools. One shared window, two sides, pari-mutuel payout. Balances are demo USDC. Wallet connect and contracts are not wired.

## Progress

- [x] Scaffold: Bun, SQLite, React shell
- [x] Live BTC tape and continuous chart
- [x] Rounds, pari-mutuel settlement, overlapping window
- [x] Trading screen
- [x] History and demo wallet

## Run

```bash
bun install
bun test
bun run dev
```

Open http://127.0.0.1:5173. The API listens on http://127.0.0.1:3001.

`WINDOW_SECONDS` and `MARKET_SECONDS` both default to 5. `VIEW_SECONDS` defaults to 5 and is how wide the scrolling market chart is. `PRICE_SOURCE=binance` (or `coinbase`) picks the only price feed. `BOT_COUNT` defaults to 8.

## Rules

- Time is a UTC block of window plus market. The first part is the betting window, and the previous market is still live on that same stretch. The second part is the new market, with betting closed.
- The open prints when the window closes. That market settles when the next window closes. A player stays on that market until it settles and cannot join the next window yet. The betting window stays a fixed frame. The market chart is `VIEW_SECONDS` wide and scrolls with now on the right edge. A held market keeps that scroll until it settles, two widths at the default block.
- The line is one feed for the whole session: Binance `BTCUSDT` or Coinbase `BTC-USD`. The server does not switch between them. Green is above that market's open, red is below.
- Stake is demo USDC. Your payout is your share of the winning side, after a 0.25% fee on the pot.
- A tie is a push: stakes return, no fee. A market with no print across its whole life is void, and stakes return.
- Bots, marked Bot, fill both sides of every window.
- Connect, Fund, and Withdraw move the demo balance only. Withdraw spends only the spendable balance.

## Brief

I want to make a quick polymarket like interface trading app, where it's focused on "betting" feel and simplicity. Starting with just one thing: bitcoin price, which we will aggregate from trading view, but initially is there a free way? We need to get second by second prices and chart that. the premise is two buttons, up or down, every 5/10s (we configure this server side) you bet up or down with an amount of money you specify which is a %, so if you are like 50% of your side of the bet, you get 50% of the money from the losers. Platform takes 0.25% fees off of each concluded trade. For now we want to simulate but this will all be smart contracts soon. We want to place hold wallet connect, fund, withdraw, etc. but not wire it up yet just have the buttons and simulate in React for now. We want to use Bun + SQLite as the backend. We want to tables for previous bets and also a current bet tray that shows the current time we are on for what pub addresses (truncated) are playing in this pool and how much they bet. We can view the pools and addresses of our previous plays, too.

The main focus of the app is the up down buttons and the main view showing our window to bet in and then green above the line and red below the line, where we are only ever going to bet if Bitcoin will END this round on up or down.

We need to show big the % of people and the amount of money on each side of the pool the whole time.

Once a market is started (this is universal time for everyone) we set server side in our config the time on how far out but I want it to be 5 or 10s out for now. Where once that resolves, winners take all. We need a clean minimalistic and nice interface.

Let's do this in pieces and mark off what we have done. SC's, wallet connect, etc. come later. Research and find ways to oracle the price that are cheap or even free for us ideally.