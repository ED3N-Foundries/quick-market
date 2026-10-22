import { expect, test } from "bun:test"
import { inkNudge } from "./ink"

test("qm side margins center, and the letter weight centers vertically", () => {
  expect(inkNudge(16, 16, 2, 13, 8.06)).toEqual({ dx: 0, dy: -1 })
  expect(inkNudge(32, 32, 3, 29, 17.27)).toEqual({ dx: -1, dy: -2 })
  expect(inkNudge(180, 180, 30, 152, 102.6)).toEqual({ dx: -2, dy: -13 })
})
