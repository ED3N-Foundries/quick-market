import { expect, test } from "bun:test"
import { marketPreferences } from "../shared/market"
import { generateNearSecret } from "../shared/nearKey"
import { enabledMarketKeys, loadEnv, nearTreasuryId, nearTreasurySecret, parseNearTreasuryKey, parseTokenAccount, parseTreasuryKey, rpcFor } from "./env"

const hex = "ab".repeat(32)

test("a missing treasury key stays empty and a bare hex key is normalized", () => {
  const previous = marketPreferences.chain
  marketPreferences.chain = "base"
  try {
    expect(loadEnv({}).treasuryPrivateKey).toBe("")
    expect(loadEnv({ TREASURY_PRIVATE_KEY: "  " }).treasuryPrivateKey).toBe("")
    expect(loadEnv({ TREASURY_PRIVATE_KEY: hex }).treasuryPrivateKey).toBe(`0x${hex}`)
    expect(loadEnv({ TREASURY_PRIVATE_KEY: `0x${hex}` }).treasuryPrivateKey).toBe(`0x${hex}`)
  } finally {
    marketPreferences.chain = previous
  }
})

test("a malformed treasury key is rejected", () => {
  const previous = marketPreferences.chain
  marketPreferences.chain = "base"
  try {
    expect(() => loadEnv({ TREASURY_PRIVATE_KEY: "nope" })).toThrow("32-byte")
  } finally {
    marketPreferences.chain = previous
  }
})

test("a NEAR launch accepts an ed25519 secret and rejects an EVM key", async () => {
  const made = await generateNearSecret()
  expect(parseTreasuryKey("", "near-testnet")).toBe("")
  expect(parseTreasuryKey(made.secretKey, "near-testnet")).toBe(made.secretKey)
  expect(() => parseTreasuryKey(`0x${"ab".repeat(32)}`, "near-testnet")).toThrow("ed25519")
  expect(() => parseTreasuryKey("nope", "near-testnet")).toThrow("ed25519")
  expect(parseTokenAccount("")).toBe("")
  expect(parseTokenAccount(made.account)).toBe(made.account)
  expect(() => parseTokenAccount("not an account")).toThrow("TOKEN_ACCOUNT")
})

test("each market turns on only from its own keys", async () => {
  const made = await generateNearSecret()
  const usdc = `0x${"cd".repeat(20)}`
  const base = loadEnv({ TREASURY_PRIVATE_KEY: `0x${hex}`, USDC_ADDRESS: usdc })
  expect(enabledMarketKeys(base)).toEqual(["base-sepolia"])
  expect(nearTreasurySecret(base)).toBe("")
  const near = loadEnv({ NEAR_TREASURY_PRIVATE_KEY: made.secretKey, TOKEN_ACCOUNT: made.account })
  expect(enabledMarketKeys(near)).toEqual(["near-testnet"])
  expect(nearTreasurySecret(near)).toBe(made.secretKey)
  const both = loadEnv({
    TREASURY_PRIVATE_KEY: `0x${hex}`,
    USDC_ADDRESS: usdc,
    NEAR_TREASURY_PRIVATE_KEY: made.secretKey,
    TOKEN_ACCOUNT: made.account,
  })
  expect(enabledMarketKeys(both)).toEqual(["base-sepolia", "near-testnet"])
  expect(parseNearTreasuryKey("")).toBe("")
  expect(() => parseNearTreasuryKey(`0x${hex}`)).toThrow("NEAR_TREASURY_PRIVATE_KEY")
  expect(rpcFor("near-testnet", { ...both, rpcUrl: "https://sepolia.base.org" })).toBe("https://rpc.testnet.near.org")
  expect(rpcFor("base-sepolia", { ...both, rpcUrl: "https://rpc.testnet.near.org" })).not.toContain("near")
})

test("a named NEAR treasury overrides the derived implicit account", async () => {
  const made = await generateNearSecret()
  const named = loadEnv({ NEAR_TREASURY_PRIVATE_KEY: made.secretKey, NEAR_TREASURY_ACCOUNT: "qm.testnet" })
  expect(await nearTreasuryId(named)).toBe("qm.testnet")
  expect(await nearTreasuryId(loadEnv({ NEAR_TREASURY_PRIVATE_KEY: made.secretKey }))).toBe(made.account)
  expect(() => loadEnv({ NEAR_TREASURY_ACCOUNT: "not an account" })).toThrow("NEAR_TREASURY_ACCOUNT")
})

test("deployment defaults fill blank process settings", () => {
  const env = loadEnv({})
  expect(env.port).toBe(3001)
  expect(env.apiUrl).toBe("http://127.0.0.1:3001")
  expect(env.rpcUrl).toBe("")
  expect(env.usdcAddress).toBe("")
  expect(env.dbPath.endsWith("data/quick-market.sqlite")).toBe(true)
})

test("port coerces from a string", () => {
  expect(loadEnv({ PORT: "4000" })).toMatchObject({ port: 4000 })
  expect(() => loadEnv({ USDC_ADDRESS: "0x123" })).toThrow("USDC_ADDRESS")
})
