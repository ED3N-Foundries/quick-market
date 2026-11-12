import { expect, test } from "bun:test"
import { connectorUrl } from "./agentsUrl"

test("each network has its own connector, and the token stays on the signed-in one", () => {
  expect(connectorUrl("https://qmkt.app", "base-sepolia", "abc")).toBe(
    "https://qmkt.app/mcp?chain=base-sepolia&token=abc",
  )
  expect(connectorUrl("https://qmkt.app", "near-testnet", null)).toBe("https://qmkt.app/mcp?chain=near-testnet")
  expect(connectorUrl("https://quickmarket.app", "near-testnet", "def")).toBe(
    "https://quickmarket.app/mcp?chain=near-testnet&token=def",
  )
})
