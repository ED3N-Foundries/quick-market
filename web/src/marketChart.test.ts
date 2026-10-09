import { expect, test } from "bun:test"
import { marketSession } from "./marketChart"

test("a held bet stays on that market through settlement", () => {
  const frame = marketSession({ betsOpen: 10_000, settlesAt: 25_000 })
  expect(frame).toEqual({ start: 10_000, end: 25_000 })
})
