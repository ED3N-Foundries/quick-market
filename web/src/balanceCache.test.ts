import { expect, test } from "bun:test"
import { readCachedBalance, visibleBalance, writeCachedBalance, type CachedBalance } from "./balanceCache"

function memory() {
  const bag = new Map<string, string>()
  return {
    getItem: (key: string) => bag.get(key) ?? null,
    setItem: (key: string, value: string) => {
      bag.set(key, value)
    },
  }
}

const who = "0xAbCd00000000000000000000000000000000abcd"
const other = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

test("a cached balance is read back for the same address", () => {
  const source = memory()
  writeCachedBalance({ address: who, balanceMicros: 25_000_000, grantAt: 10 }, source)
  expect(readCachedBalance(who, source)).toEqual({ balanceMicros: 25_000_000, grantAt: 10 })
  expect(readCachedBalance(who.toLowerCase(), source)?.balanceMicros).toBe(25_000_000)
})

test("another address and a broken cache do not show a balance", () => {
  const source = memory()
  writeCachedBalance({ address: who, balanceMicros: 25_000_000, grantAt: null }, source)
  expect(readCachedBalance(other, source)).toBeNull()
  writeCachedBalance({ address: who, balanceMicros: -1, grantAt: null }, source)
  expect(readCachedBalance(who, source)).toEqual({ balanceMicros: 25_000_000, grantAt: null })
  source.setItem("qm.balance", "nope")
  expect(readCachedBalance(who, source)).toBeNull()
})

test("the cached figure shows until the server answers", () => {
  const cached: CachedBalance = { balanceMicros: 40_000_000, grantAt: 5 }
  expect(visibleBalance(false, null, cached.balanceMicros)).toBe(40_000_000)
  expect(visibleBalance(true, 12_000_000, cached.balanceMicros)).toBe(12_000_000)
  expect(visibleBalance(true, 0, cached.balanceMicros)).toBe(0)
  expect(visibleBalance(true, null, cached.balanceMicros)).toBeNull()
  expect(visibleBalance(false, null, null)).toBeNull()
})
