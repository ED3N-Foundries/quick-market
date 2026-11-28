import { expect, test } from "bun:test"
import type { PublicConfig } from "../../shared/market"
import { chosenMarket, runtimeChain, withChainQuery } from "./runtimeConfig"

const baseConfig: PublicConfig = {
  windowSeconds: 10,
  marketSeconds: 10,
  viewSeconds: 5,
  feeBps: 0,
  minStakeMicros: 1_000_000,
  source: "binance",
  chainId: 84532,
  chainKey: "base-sepolia",
  chainName: "Base Sepolia",
  usdc: "0x70fc13976d62ab1097ce86a5864f769991a8e0ea",
  treasury: "0x826020c36F4e1b6320e5E3dCade1a888E9fbDeF6",
  moneyLabel: "quick-market USDC",
  tokenKind: "qm",
  tokenLabel: "QM USDC",
  grantMicros: 100_000_000,
  grantIntervalMs: 120_000,
  confirmations: 1,
  ledgerOnly: false,
}

test("runtime config selects the existing Base Sepolia token", () => {
  const chain = runtimeChain(baseConfig)
  expect(chain.key).toBe("base-sepolia")
  expect(chain.id).toBe(84532)
  expect(chain.usdc).toBe(baseConfig.usdc)
})

test("runtime config can select dormant NEAR support with the same bundle", () => {
  const chain = runtimeChain({
    ...baseConfig,
    chainId: 0,
    chainKey: "near-testnet",
    chainName: "NEAR Testnet",
    usdc: "qm.testnet",
    treasury: "treasury.testnet",
    moneyLabel: "quick-market",
    tokenLabel: "QM",
  })
  expect(chain.family).toBe("near")
  expect(chain.key).toBe("near-testnet")
})

test("a fresh visit opens Near when both markets are on", () => {
  const near = { ...baseConfig, chainId: 0, chainKey: "near-testnet" as const, chainName: "NEAR Testnet", usdc: "qm.testnet", treasury: "treasury.testnet" }
  const markets = [baseConfig, near]
  expect(chosenMarket(markets, null, "near-testnet")?.chainKey).toBe("near-testnet")
  expect(chosenMarket(markets, "base-sepolia", "near-testnet")?.chainKey).toBe("base-sepolia")
  expect(chosenMarket(markets, "near-testnet", "base-sepolia")?.chainKey).toBe("near-testnet")
  expect(chosenMarket([baseConfig], "near-testnet", "base-sepolia")?.chainKey).toBe("base-sepolia")
  expect(withChainQuery("/api/state", "near-testnet")).toBe("/api/state?chain=near-testnet")
  expect(withChainQuery("/api/rounds?limit=10&mine=1", "base-sepolia")).toBe("/api/rounds?limit=10&mine=1&chain=base-sepolia")
  expect(withChainQuery("/ws", "near-testnet")).toBe("/ws?chain=near-testnet")
})

test("inconsistent runtime chain identity is rejected", () => {
  expect(() => runtimeChain({ ...baseConfig, chainId: 8453 })).toThrow("inconsistent")
})
