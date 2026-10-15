import { expect, test } from "bun:test"
import { privateKeyToAccount } from "viem/accounts"
import { planTreasury } from "./treasury"

const generated = `0x${"ab".repeat(32)}` as `0x${string}`
const existing = `0x${"cd".repeat(32)}` as `0x${string}`
const fromEnv = `0x${"11".repeat(32)}` as `0x${string}`

test("planTreasury fills an empty treasury line and leaves the rest", () => {
  const source = "CHAIN=base-sepolia\nTREASURY_PRIVATE_KEY=\nRPC_URL=\n"
  const plan = planTreasury(source, undefined, generated)
  expect(plan).toEqual({
    action: "write",
    text: `CHAIN=base-sepolia\nTREASURY_PRIVATE_KEY=${generated}\nRPC_URL=\n`,
    address: privateKeyToAccount(generated).address,
  })
})

test("planTreasury appends the key when the line is missing", () => {
  const plan = planTreasury("CHAIN=base-sepolia\n", undefined, generated)
  expect(plan).toEqual({
    action: "write",
    text: `CHAIN=base-sepolia\nTREASURY_PRIVATE_KEY=${generated}\n`,
    address: privateKeyToAccount(generated).address,
  })
})

test("planTreasury keeps an existing key", () => {
  const source = `FEE_BPS=0\nTREASURY_PRIVATE_KEY=${existing}\n`
  const plan = planTreasury(source, undefined, generated)
  expect(plan).toEqual({ action: "keep", address: privateKeyToAccount(existing).address })
})

test("planTreasury keeps the file key when the environment repeats it", () => {
  const source = `TREASURY_PRIVATE_KEY=${existing}\n`
  const plan = planTreasury(source, existing.toUpperCase().replace("0X", "0x"), generated)
  expect(plan).toEqual({ action: "keep", address: privateKeyToAccount(existing).address })
})

test("planTreasury refuses an environment key that is not in the file", () => {
  const plan = planTreasury("TREASURY_PRIVATE_KEY=\n", fromEnv, generated)
  expect(plan).toEqual({ action: "refuse", address: privateKeyToAccount(fromEnv).address })
  expect(JSON.stringify(plan)).not.toContain(generated)
})

test("planTreasury does not overwrite a damaged key", () => {
  expect(planTreasury("TREASURY_PRIVATE_KEY=nope\n", undefined, generated)).toEqual({ action: "invalid" })
  expect(planTreasury("TREASURY_PRIVATE_KEY=\n", "nope", generated)).toEqual({ action: "invalid" })
})
