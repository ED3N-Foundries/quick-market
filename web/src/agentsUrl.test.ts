import { expect, test } from "bun:test"
import { agentConnectors, connectorUrl, storedSessionToken } from "./agentsUrl"

test("each network has its own connector, and the token stays on that market", () => {
  expect(connectorUrl("https://qmkt.app", "base-sepolia", "abc")).toBe(
    "https://qmkt.app/mcp?chain=base-sepolia&token=abc",
  )
  expect(connectorUrl("https://qmkt.app", "near-testnet", null)).toBe("https://qmkt.app/mcp?chain=near-testnet")
  expect(connectorUrl("https://quickmarket.app", "near-testnet", "def")).toBe(
    "https://quickmarket.app/mcp?chain=near-testnet&token=def",
  )
})

test("a stored sign-in is reused for that market only", () => {
  const store = new Map<string, string>([
    ["qm.session.base-sepolia", JSON.stringify({ token: "base-tok", address: "0xabc", chainId: 84532 })],
    ["qm.session.near-testnet", JSON.stringify({ token: "near-tok", address: "alice.testnet", chainId: 0 })],
    ["qm.session.base", JSON.stringify({ token: "nope", address: "0xabc", chainId: 84532 })],
  ])
  const read = (key: string) => store.get(key) ?? null
  expect(storedSessionToken("base-sepolia", read)).toBe("base-tok")
  expect(storedSessionToken("near-testnet", read)).toBe("near-tok")
  expect(storedSessionToken("base", read)).toBeNull()
  expect(storedSessionToken("base-sepolia", () => "{")).toBeNull()
  expect(storedSessionToken("nope", read)).toBeNull()
})

test("each connected market gets its own link without the other market's token", () => {
  const store = new Map<string, string>([
    ["qm.session.near-testnet", JSON.stringify({ token: "near-tok", address: "alice.testnet", chainId: 0 })],
    ["qm.session.base-sepolia", JSON.stringify({ token: "stale", address: "0xabc", chainId: 84532 })],
  ])
  const read = (key: string) => store.get(key) ?? null
  expect(agentConnectors("https://qmkt.app", { chainKey: "base-sepolia", token: "base-tok" }, read)).toEqual([
    { chainKey: "base-sepolia", url: "https://qmkt.app/mcp?chain=base-sepolia&token=base-tok" },
    { chainKey: "near-testnet", url: "https://qmkt.app/mcp?chain=near-testnet&token=near-tok" },
  ])
  expect(agentConnectors("https://qmkt.app", { chainKey: "base-sepolia", token: "base-tok" }, () => null)).toEqual([
    { chainKey: "base-sepolia", url: "https://qmkt.app/mcp?chain=base-sepolia&token=base-tok" },
  ])
})
