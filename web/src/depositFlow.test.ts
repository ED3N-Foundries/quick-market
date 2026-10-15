import { expect, test } from "bun:test"
import {
  depositRefusal,
  isCallRevert,
  isUnrecognizedChain,
  matchingSession,
  walletFaultMessage,
  type DepositCheck,
} from "./depositFlow"

const ready: DepositCheck = {
  micros: 10_000_000,
  serverReachable: true,
  signedIn: true,
  sameAccount: true,
  sameChain: true,
  chainName: "Base Sepolia",
  usdcBalance: 50_000_000n,
  ethBalance: 10n ** 15n,
  gasWei: 10n ** 12n,
}

test("matchingSession drops a token for a different account", () => {
  const stored = { token: "t", address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", chainId: 84532 }
  expect(matchingSession(stored, "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa", 84532)?.token).toBe("t")
  expect(matchingSession(stored, "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", 84532)).toBeNull()
  expect(matchingSession(stored, stored.address, 8453)).toBeNull()
  expect(matchingSession(null, stored.address, 84532)).toBeNull()
})

test("depositRefusal blocks a short wallet before Phantom opens", () => {
  expect(depositRefusal(ready)).toBeNull()
  expect(depositRefusal({ ...ready, serverReachable: false })).toBe("Market server is not running.")
  expect(depositRefusal({ ...ready, sameAccount: false })).toBe("Sign in with this wallet before depositing.")
  expect(depositRefusal({ ...ready, usdcBalance: 1n })).toBe("This wallet does not have enough USDC on Base Sepolia.")
  expect(depositRefusal({ ...ready, ethBalance: 0n })).toBe("This wallet needs Base Sepolia ETH for gas.")
  expect(depositRefusal({ ...ready, ethBalance: 1n, gasWei: 50n })).toBe("This wallet needs Base Sepolia ETH for gas.")
})

test("walletFaultMessage keeps a rejection and a short reason", () => {
  expect(walletFaultMessage(new Error("User rejected the request."), "Base Sepolia")).toBe("Deposit cancelled")
  expect(walletFaultMessage(Object.assign(new Error("nope"), { code: 4001 }), "Base Sepolia")).toBe("Deposit cancelled")
  expect(walletFaultMessage(new Error("insufficient funds for gas * price + value"), "Base Sepolia")).toBe(
    "This wallet needs Base Sepolia ETH for gas.",
  )
})

test("isCallRevert distinguishes a token revert from an RPC miss", () => {
  expect(isCallRevert(new Error("execution reverted: ERC20: transfer amount exceeds balance"))).toBe(true)
  expect(isCallRevert(new Error("HTTP request failed."))).toBe(false)
})

test("isUnrecognizedChain reads Phantom 4902", () => {
  expect(isUnrecognizedChain({ code: 4902, message: "Unrecognized chain ID" })).toBe(true)
  expect(isUnrecognizedChain({ cause: { code: 4902 } })).toBe(true)
  expect(isUnrecognizedChain(new Error("User rejected the request."))).toBe(false)
})
