A push should mark as blue on the chart and dashed line if the price is ever sitting at its baseline.

Furthermore, we need to make fund amounts adjustable, put quick buttons for fund +$10, +1000, and adjustable.

Current market stats shouldn't be in the chart but rather in the boxes right below the chart as we have, so we know how much we stand to win there. Also round the spendable amounts to two decimal places.

Market and bet periods should be denoted in footer, improve footer layout and withdraw section.

Results in the table should be color coded too. Also round to two decimal places everything EXCEPT the price, that must be decimal'd. Also in the database nothing should be rounded (unless there's a good reason, and in that case still try to keep as much precision as possible), rounding should all be done client side for viewing purposes.

Put arrows next to up and down labels in the two main boxes, in the current pool table, and the previous rounds. Of course color code them too as appropriate.

Wallet code should go into the spendable box.

Put dollar signs next to the items in the up down boxes. In my plays it should be gain/loss, so if I bet $10 and lost then it should show -$10, if I won then it would show $10+the winnings.

Show an opacity lock over the left side once the market starts running so people know it's locked in.

Remove the last market completing logic from the chart, it confuses people. We care about the markets we bet on only.

Also, the market result push notifications should only show for markets we participated in and in that case it should be more contrasty so we see it but not modal blocking, so sit at the bottom of the page like real toasts. Allow them to stack if needed. Use some react toast lib or something like shadcn or whatevs if we have to.

Make this pool table collapsable and default collapse it.