import { expect, test } from "bun:test"
import { loadEnv } from "./env"

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
