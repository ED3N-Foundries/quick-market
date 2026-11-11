import { expect, test } from "bun:test"
import { nearLoginMessage } from "../../shared/login"
import { LOGIN_SKEW_MS } from "../../shared/login"
import {
  METEOR_POPUP_BLOCKED,
  meteorCancelled,
  meteorPopupBlocked,
  meteorPopupClosed,
  METEOR_POPUP_GRACE_MS,
  nearLoginResume,
  nearSignedFrom,
  nearSignParams,
} from "./nearConnect"

test("NEAR sign-in asks Meteor for a NEP-413 signature without a callback URL", () => {
  const nonce = new Uint8Array(32)
  nonce[0] = 7
  const params = nearSignParams("alice.testnet", 5, nonce)
  expect(params).toEqual({
    message: nearLoginMessage("alice.testnet", 5),
    recipient: "quick-market",
    nonce,
  })
  expect(params).not.toHaveProperty("callbackUrl")
})

test("Meteor's signature object becomes the session POST fields", () => {
  const bytes = new Uint8Array(64)
  bytes[0] = 1
  bytes[63] = 2
  const signature = btoa(String.fromCharCode(...bytes))
  expect(
    nearSignedFrom({
      accountId: "alice.testnet",
      publicKey: { toString: () => "ed25519:abc" },
      signature: bytes,
    }),
  ).toEqual({ accountId: "alice.testnet", publicKey: "ed25519:abc", signature })
  expect(nearSignedFrom({ accountId: "alice.testnet", publicKey: "ed25519:abc", signature })).toEqual({
    accountId: "alice.testnet",
    publicKey: "ed25519:abc",
    signature,
  })
  expect(nearSignedFrom({ accountId: "alice.testnet", publicKey: "secp256k1:abc", signature })).toBeNull()
  expect(nearSignedFrom({ accountId: "", publicKey: "ed25519:abc", signature })).toBeNull()
})

test("a closed Meteor popup is a quiet cancel", () => {
  expect(meteorCancelled(new Error("Action was cancelled"))).toBe(true)
  expect(meteorCancelled(new Error("User closed the window"))).toBe(true)
  expect(meteorCancelled(new Error("User closed the window before completing the action"))).toBe(true)
  expect(meteorCancelled(new Error("Sign-in failed"))).toBe(false)
  expect(meteorCancelled(new Error("Couldn't open popup window to complete wallet action"))).toBe(false)
})

test("a blocked Meteor popup stays a visible toast", () => {
  expect(METEOR_POPUP_BLOCKED.length).toBeLessThanOrEqual(80)
  expect(meteorPopupBlocked(new Error("Couldn't open popup window to complete wallet action"))).toBe(true)
  expect(meteorPopupBlocked(new Error("Popup window failed to open"))).toBe(true)
  expect(meteorPopupBlocked(new Error("User refused to allow the popup window to open"))).toBe(true)
  expect(meteorPopupBlocked(new Error("User closed the window"))).toBe(false)
  expect(meteorPopupBlocked(new Error("Sign-in failed"))).toBe(false)
})

test("a blocked signature can be retried until the login message expires", () => {
  const draft = { accountId: "alice.testnet", issued: 5_000, nonce: { bytes: new Uint8Array(32), base64: "aa" } }
  expect(nearLoginResume(draft, 5_000 + LOGIN_SKEW_MS)).toBe(draft)
  expect(nearLoginResume(draft, 5_000 + LOGIN_SKEW_MS + 1)).toBeNull()
  expect(nearLoginResume(null, 5_000)).toBeNull()
})

test("a popup that just closed stays open long enough for Meteor's success message", () => {
  const now = 5_000
  const first = meteorPopupClosed(true, 0, now)
  expect(first).toEqual({ closed: false, seenClosedAt: now })
  expect(meteorPopupClosed(true, first.seenClosedAt, now + METEOR_POPUP_GRACE_MS - 1).closed).toBe(false)
  expect(meteorPopupClosed(true, first.seenClosedAt, now + METEOR_POPUP_GRACE_MS).closed).toBe(true)
  expect(meteorPopupClosed(false, now, now + 50)).toEqual({ closed: false, seenClosedAt: 0 })
})
