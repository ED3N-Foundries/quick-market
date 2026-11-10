import { expect, test } from "bun:test"
import type { PublicConfig } from "../../shared/market"
import { runtimeChain } from "./runtimeConfig"

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

test("inconsistent runtime chain identity is rejected", () => {
  expect(() => runtimeChain({ ...baseConfig, chainId: 8453 })).toThrow("inconsistent")
})
