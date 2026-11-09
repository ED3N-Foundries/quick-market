import { expect, test } from "bun:test"
import { generateNearSecret } from "../shared/nearKey"
import { loadEnv, parseTokenAccount, parseTreasuryKey } from "./env"

const hex = "ab".repeat(32)

test("a missing treasury key stays empty and a bare hex key is normalized", () => {
  expect(loadEnv({}).treasuryPrivateKey).toBe("")
  expect(loadEnv({ TREASURY_PRIVATE_KEY: "  " }).treasuryPrivateKey).toBe("")
  expect(loadEnv({ TREASURY_PRIVATE_KEY: hex }).treasuryPrivateKey).toBe(`0x${hex}`)
  expect(loadEnv({ TREASURY_PRIVATE_KEY: `0x${hex}` }).treasuryPrivateKey).toBe(`0x${hex}`)
})

test("a malformed treasury key is rejected", () => {
  expect(() => loadEnv({ TREASURY_PRIVATE_KEY: "nope" })).toThrow("32-byte")
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

test("deployment defaults fill blank process settings", () => {
  const env = loadEnv({})
  expect(env.port).toBe(3001)
  expect(env.apiUrl).toBe("http://127.0.0.1:3001")
  expect(env.agentSecret).toBe("")
  expect(env.rpcUrl).toBe("")
  expect(env.usdcAddress).toBe("")
  expect(env.swarmPin).toBeNull()
  expect(env.dbPath.endsWith("data/quick-market.sqlite")).toBe(true)
})

test("swarm pin and port coerce from strings", () => {
  expect(loadEnv({ SWARM_PIN: "30", PORT: "4000" })).toMatchObject({ swarmPin: 30, port: 4000 })
  expect(loadEnv({ SWARM_PIN: "" }).swarmPin).toBeNull()
  expect(() => loadEnv({ SWARM_PIN: "soon" })).toThrow("swarmPin")
  expect(() => loadEnv({ USDC_ADDRESS: "0x123" })).toThrow("USDC_ADDRESS")
})
