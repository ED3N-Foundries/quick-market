import type { Handoff } from "../../shared/source"
import type { Board, FeedState, OpenBuyIn } from "../../shared/stream"
import { focusPool } from "./focus"

/** A `/api/state` board is usable when it is at least as new as the board on screen. */
export function acceptStateBoard(appliedServerNow: number | null, incomingServerNow: number): boolean {
  if (appliedServerNow == null) return true
  return incomingServerNow >= appliedServerNow
}

/** A live book with no handoff and no bet card has to be replaced by a snapshot.
 *  `focusPool` keeps the published card through the render grace, so a null result
 *  is past that grace or the card is already gone. Zero pools still count as a card.
 */
export function patchNeedsSnapshot(input: {
  board: Board
  openBuyIns: OpenBuyIn[]
  now: number
  feed: FeedState
  handoff: Handoff | null
}): boolean {
  if (input.feed !== "live" || input.handoff) return false
  return focusPool(input.board, input.openBuyIns, input.now) == null
}

/** One snapshot request per `windowEndsAt`. A snapshot that still has no card does not ask again. */
export function missingCardWindow(input: {
  board: Board | null
  openBuyIns: OpenBuyIn[]
  now: number
  feed: FeedState
  handoff: Handoff | null
  requestedWindow: number | null
}): number | null {
  const board = input.board
  if (!board) return null
  if (!patchNeedsSnapshot({ ...input, board })) return null
  if (input.requestedWindow === board.windowEndsAt) return null
  return board.windowEndsAt
}
