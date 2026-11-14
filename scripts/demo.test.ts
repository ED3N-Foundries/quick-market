import { expect, test } from "bun:test"
import { agentEnv, demoPorts, healthEnv, marketEnv, nearConfigProblem } from "./demo"

test("demo selects NEAR without changing the market database", () => {
  const env = marketEnv({ CHAIN: "base-sepolia", DB_PATH: "data/custom.sqlite", NODE_ENV: "production" })
  expect(env.CHAIN).toBe("near-testnet")
  expect(env.TREASURY_PRIVATE_KEY).toBe("")
  expect(env.USDC_ADDRESS).toBe("")
  expect(env.DB_PATH).toBe("data/custom.sqlite")
  expect(env.NODE_ENV).toBe("development")
})

test("demo agent uses one small NEAR crowd and its own database", () => {
  const env = agentEnv({ DB_PATH: "data/quick-market.sqlite", AGENT_SPLIT_BASE: "100", AGENT_SPLIT_NEAR: "0" })
  expect(env.CHAIN).toBe("near-testnet")
  expect(env.DB_PATH).toBe("data/quick-market-agent.sqlite")
  expect(env.AGENT_SPLIT_BASE).toBe("0")
  expect(env.AGENT_SPLIT_NEAR).toBe("100")
  expect(env.SWARM_PIN).toBe("30")
  expect(agentEnv({ SWARM_PIN: "12" }).SWARM_PIN).toBe("12")
})

test("demo health targets local services and never inherits a Base RPC", () => {
  const env = healthEnv({ RPC_URL: "https://sepolia.base.org", NEAR_RPC_1: "https://near.example 1000 2000 3000" })
  expect(env.TARGET_URL).toBe("http://127.0.0.1:3001")
  expect(env.INTERNAL_URL).toBe("http://127.0.0.1:3002")
  expect(env.AGENT_URL).toBe("http://127.0.0.1:3011")
  expect(env.RPC_URL).toBe("https://near.example")
  expect(env.DOCKER_SOCK).toBe("")
})

test("demo can move every service away from occupied local ports", () => {
  const env = { DEMO_PORT_OFFSET: "1000" }
  expect(demoPorts(env)).toEqual({ api: 4001, internal: 4002, agent: 4011, health: 4101, web: 6173 })
  expect(marketEnv(env)).toMatchObject({ PORT: "4001", INTERNAL_PORT: "4002", API_URL: "http://127.0.0.1:4001", QM_WEB_PORT: "6173" })
  expect(agentEnv(env)).toMatchObject({ API_URL: "http://127.0.0.1:4001", STATS_PORT: "4011" })
  expect(healthEnv(env)).toMatchObject({ PORT: "4101", TARGET_URL: "http://127.0.0.1:4001", INTERNAL_URL: "http://127.0.0.1:4002" })
  expect(() => demoPorts({ DEMO_PORT_OFFSET: "nope" })).toThrow("DEMO_PORT_OFFSET")
})

test("demo setup error names missing NEAR configuration without exposing values", () => {
  expect(nearConfigProblem({ NEAR_TREASURY_PRIVATE_KEY: "ed25519:key", TOKEN_ACCOUNT: "token.testnet" })).toBeNull()
  expect(nearConfigProblem({})).toContain("NEAR_TREASURY_PRIVATE_KEY and TOKEN_ACCOUNT")
  expect(nearConfigProblem({ NEAR_TREASURY_PRIVATE_KEY: "ed25519:key" })).toContain("TOKEN_ACCOUNT")
  expect(nearConfigProblem({ NEAR_TREASURY_PRIVATE_KEY: "ed25519:key" })).not.toContain("ed25519:key")
})
