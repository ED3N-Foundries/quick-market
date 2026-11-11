import { expect, test } from "bun:test"
import { buyIsStuck, shouldReleaseStuckBuy, STUCK_BUY_MS } from "./stuckBuy"

test("a live in-flight buy is not stuck and is not released early", () => {
  const sentAt = 1_000
  const now = sentAt + STUCK_BUY_MS - 1
  expect(buyIsStuck({ pending: true, sentAt, now, socketOpen: true })).toBe(false)
  expect(shouldReleaseStuckBuy({ pending: true, releaseRequested: false, serverYouApplied: true })).toBe(false)
  expect(shouldReleaseStuckBuy({ pending: true, releaseRequested: true, serverYouApplied: false })).toBe(false)
})

test("a dead socket or an 8s silence is stuck, and the lock clears only with the reloaded account", () => {
  expect(buyIsStuck({ pending: true, sentAt: 0, now: 1, socketOpen: false })).toBe(true)
  expect(buyIsStuck({ pending: true, sentAt: 0, now: STUCK_BUY_MS, socketOpen: true })).toBe(true)
  expect(buyIsStuck({ pending: false, sentAt: 0, now: STUCK_BUY_MS, socketOpen: false })).toBe(false)
  expect(shouldReleaseStuckBuy({ pending: true, releaseRequested: true, serverYouApplied: true })).toBe(true)
  expect(shouldReleaseStuckBuy({ pending: false, releaseRequested: true, serverYouApplied: true })).toBe(false)
})
