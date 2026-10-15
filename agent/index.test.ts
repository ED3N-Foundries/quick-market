import { expect, test } from "bun:test"
import { needsFaucet, planKeys, sideFor, type StoredKey } from "./index"

test("planKeys keeps existing keys and fills up to the count", () => {
  const first = planKeys([], 2)
  expect(planKeys(first, 2)).toEqual(first)
  const more = planKeys(first, 3)
  expect(more.slice(0, 2)).toEqual(first)
  expect(more).toHaveLength(3)
  expect(more[2]!.privateKey).toMatch(/^0x[0-9a-f]{64}$/)
  expect(more[2]!.address).toMatch(/^0x[0-9a-fA-F]{40}$/)
})

test("planKeys skips a damaged key", () => {
  const broken = [{ address: "0x0", privateKey: "0x123" }] as StoredKey[]
  const keys = planKeys(broken, 1)
  expect(keys).toHaveLength(1)
  expect(keys[0]!.privateKey).not.toBe("0x123")
})

test("sideFor pins the first two wallets and stays stable", () => {
  const address = `0x${"ab".repeat(20)}`
  expect(sideFor(0, 1, address)).toBe("up")
  expect(sideFor(1, 1, address)).toBe("down")
  expect(sideFor(2, 9, address)).toBe(sideFor(2, 9, address))
  expect(["up", "down"]).toContain(sideFor(2, 9, address))
})

test("needsFaucet is only on a faucet chain and only when the wallet is short", () => {
  expect(needsFaucet(false, 0n, 0n)).toEqual({ eth: false, usdc: false })
  expect(needsFaucet(true, 0n, 0n)).toEqual({ eth: true, usdc: true })
  expect(needsFaucet(true, 10n ** 16n, 2_000_000n)).toEqual({ eth: false, usdc: false })
})
