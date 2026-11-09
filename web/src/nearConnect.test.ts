import { expect, test } from "bun:test"
import { nearLoginUrl, nearSignUrl, parseNearCallback, stripNearParams } from "./nearConnect"

test("NEAR wallet redirects preserve the callback and NEP-413 fields", () => {
  const login = new URL(nearLoginUrl("https://qm.example/?lang=en"))
  expect(login.origin).toBe("https://testnet.mynearwallet.com")
  expect(login.searchParams.get("success_url")).toBe("https://qm.example/?lang=en")
  const signed = new URL(nearSignUrl("Quick Market login", "nonce", "https://qm.example/"))
  expect(signed.searchParams.get("message")).toBe("Quick Market login")
  expect(signed.searchParams.get("nonce")).toBe("nonce")
  expect(signed.searchParams.get("recipient")).toBe("quick-market")
  expect(signed.searchParams.get("callbackUrl")).toBe("https://qm.example/")
})

test("NEAR callback parameters are parsed and removed without touching other query values", () => {
  const params = new URLSearchParams("accountId=alice.testnet&publicKey=ed25519%3Akey&signature=sig&lang=en")
  expect(parseNearCallback(params)).toEqual({ accountId: "alice.testnet", publicKey: "ed25519:key", signature: "sig" })
  expect(stripNearParams(`https://qm.example/?${params.toString()}`)).toBe("/?lang=en")
  expect(parseNearCallback(new URLSearchParams("accountId=alice.testnet"))).toBeNull()
})
