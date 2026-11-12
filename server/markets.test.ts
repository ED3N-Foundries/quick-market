import { expect, test } from "bun:test"
import { pickChain } from "./markets"

const both = ["base-sepolia", "near-testnet"] as const

test("a public request opens on Near when that market is on", () => {
  expect(pickChain({ raw: null, sessionChain: null, live: [...both] })).toEqual({
    ok: true,
    chain: "near-testnet",
  })
})

test("a session chain wins when the query is empty and loses when it disagrees", () => {
  expect(pickChain({ raw: null, sessionChain: "base-sepolia", live: [...both] })).toEqual({
    ok: true,
    chain: "base-sepolia",
  })
  const clash = pickChain({ raw: "near-testnet", sessionChain: "base-sepolia", live: [...both] })
  expect(clash.ok).toBe(false)
  if (!clash.ok) expect(clash.status).toBe(401)
})

test("an off market is not selected", () => {
  const onlyBase = pickChain({ raw: null, sessionChain: null, live: ["base-sepolia"] })
  expect(onlyBase).toEqual({ ok: true, chain: "base-sepolia" })
  const missing = pickChain({ raw: "near-testnet", sessionChain: null, live: ["base-sepolia"] })
  expect(missing.ok).toBe(false)
})
