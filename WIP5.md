There's a bug in the chart that causes it to use easing in scaling. It should not do that. It should snap.

Funding should be a separate box in the middle, stacked under the stake, stake shoudl be same height as the other stake boxes. On mobile this ensures that we can keep the three boxes close but then push funding down as that's less important.

Push should get an = sign.

Wire up withdraw for demo so it deducted from my balance.

Why do markets take so logn to resolve if I played? Is there a bug or a purposeful timer? I sense that there are some potential bugs around resolution. Investigate and simplify. Remove things that are unnecessary or hinder the process or create possibility for bugs.

Also animate our balance changes after changes happen, up or down.

if we didnt bet yet there should be no market time, just constant rolling bet windows because we didn't bet anything yet so why would we see a false 5s view of market when a market is 10s, that's false on its face. So we need to fix that.

## Winnings

Also, the to win indicators in the up and down boxes doesn't make sense yet or maybe it does? Make it more clear like how polymarket would:

Polymarket shows it. You do not have to work out the resolution payout yourself.

On the trade ticket, after you pick a side and enter an amount, a **To win** field shows the total payout if that outcome wins. Profit is that figure minus what you paid. A trading guide walking through the current order box gives this example: buy $5 of a side at 66¢ and the ticket shows **To win $7.58**, so the profit if that side wins is $2.58.

Older Polymarket docs labeled the same idea **Maximum Winnings** (the USDC you can redeem if you are right) and **Max. Return on Investment** (the percentage gain if you are right). The portfolio view also surfaces potential or max payout on open positions, alongside average entry and current price.

Under the hood it is simple: a winning share redeems for $1, a losing share for $0 (or a split payout in the rare 50/50 resolution). So “To win” is essentially shares × $1, and the profit is that minus your cost (fees are separate and small on taker trades). The ticket just does that arithmetic for the size you type in.

### Consider

We should say $1 = $y to win or something? Because as it stands I am confused how if I did not bet anything yet how that would work.

### Make spendable a "ticket" view

If you placed a bet on this market, we should show what we bet and how much and how much we stand to win.