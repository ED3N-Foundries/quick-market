import type { Band } from "./types"

/** Fixed frame for a bet that is still open, from its open through settlement.
 *  This span stays put after betting closes. The bet chart must not use it,
 *  or the tape parks on the finished window until the next session.
 */
export function marketSession(market: Pick<Band, "betsOpen" | "settlesAt">): { start: number; end: number } {
  return { start: market.betsOpen, end: market.settlesAt }
}
