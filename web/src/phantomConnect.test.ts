import { expect, test } from "bun:test"
import { CHAINS } from "../../shared/chain"
import {
  authorizedAccount,
  connectKind,
  isUnauthorized,
  grantWaitStatus,
  loginAction,
  loginStatus,
  loginStepState,
  loginSteps,
  phantomBrowseUrl,
  phantomInjected,
  shouldAddChain,
  switchFault,
  takeLoginQuery,
  TESTNET_MODE,
} from "./phantomConnect"

test("desktop and an injected Phantom open the modal", () => {
  expect(connectKind({ mobile: false, injected: false })).toBe("modal")
  expect(connectKind({ mobile: false, injected: true })).toBe("modal")
  expect(connectKind({ mobile: true, injected: true })).toBe("modal")
})

test("mobile without Phantom opens the browse link", () => {
  expect(connectKind({ mobile: true, injected: false })).toBe("deeplink")
})

test("phantomInjected sees the extension and the in-app browser", () => {
  expect(phantomInjected(undefined)).toBe(false)
  expect(phantomInjected({})).toBe(false)
  expect(phantomInjected({ phantom: { ethereum: {} } })).toBe(true)
  expect(phantomInjected({ ethereum: { isPhantom: true } })).toBe(true)
})

test("authorizedAccount keeps Phantom's exact string for the address on screen", () => {
  const granted = ["0xa1dcde9f8da49c9fb60a378c00a166a68b184afe"]
  expect(authorizedAccount(granted, "0xA1DCdE9F8dA49C9Fb60A378C00A166A68b184AFE")).toBe(granted[0])
})

test("authorizedAccount uses the first granted account when the shown one is absent", () => {
  expect(authorizedAccount(["0xabc", "0xdef"], "0x111")).toBe("0xabc")
})

test("authorizedAccount is empty when Phantom granted nothing", () => {
  expect(authorizedAccount([], "0xabc")).toBe(null)
  expect(authorizedAccount([""], null)).toBe(null)
})

test("mobile without Phantom browses, and a press on an open page connects then signs", () => {
  expect(loginAction({ mobile: true, injected: false, connected: false, sessionMatches: false })).toBe("browse")
  expect(loginAction({ mobile: false, injected: false, connected: false, sessionMatches: false })).toBe("connect-and-sign")
  expect(loginAction({ mobile: true, injected: true, connected: false, sessionMatches: false })).toBe("connect-and-sign")
  expect(loginAction({ mobile: false, injected: true, connected: true, sessionMatches: false })).toBe("sign")
})

test("sign-in status names Phantom, then the signature, then the grant", () => {
  expect(loginStatus("phantom", true)).toBe("Waiting for Phantom")
  expect(loginStatus("sign", false)).toBe("Approve the sign-in in Phantom")
  expect(loginStatus("session", true)).toBe("Signed. Adding your balance on Base Sepolia. This can take a bit.")
  expect(loginStatus("session", false)).toBe("Confirming sign-in")
  expect(loginSteps(true)).toEqual(["Phantom", "Approve", "Balance"])
  expect(loginSteps(false)).toEqual(["Phantom", "Approve", "Confirm"])
  expect(loginStepState(0, "phantom")).toBe("now")
  expect(loginStepState(1, "phantom")).toBe("later")
  expect(loginStepState(0, "sign")).toBe("done")
  expect(loginStepState(1, "sign")).toBe("now")
  expect(loginStepState(2, "session")).toBe("now")
  expect(loginStepState(1, "session")).toBe("done")
  expect(grantWaitStatus()).toBe("Minting the grant on Base Sepolia. This can take a bit.")
  expect(grantWaitStatus({ seen: 0, needed: 3 })).toBe("Waiting on 3 confirmations")
  expect(grantWaitStatus({ seen: 2, needed: 3 })).toBe("Waiting on 1 confirmation")
  expect(grantWaitStatus({ seen: 3, needed: 3 })).toBe("Confirmations in. Crediting the balance.")
})

test("a matching session does not prompt again", () => {
  expect(loginAction({ mobile: true, injected: false, connected: false, sessionMatches: true })).toBe("done")
  expect(loginAction({ mobile: false, injected: true, connected: true, sessionMatches: true })).toBe("done")
})

test("browse url uses phantom.com and carries login", () => {
  const url = phantomBrowseUrl("https://market.example/trade?x=1", "https://market.example")
  expect(url.startsWith("https://phantom.com/ul/browse/")).toBe(true)
  const encoded = url.slice("https://phantom.com/ul/browse/".length).split("?")[0] ?? ""
  const target = new URL(decodeURIComponent(encoded))
  expect(target.origin).toBe("https://market.example")
  expect(target.pathname).toBe("/trade")
  expect(target.searchParams.get("x")).toBe("1")
  expect(target.searchParams.get("login")).toBe("1")
  expect(url).toContain(`ref=${encodeURIComponent("https://market.example")}`)
  expect(() => phantomBrowseUrl("file:///tmp/market", "https://market.example")).toThrow()
})

test("login query is removed once", () => {
  const first = takeLoginQuery("https://market.example/trade?login=1&x=1")
  expect(first.continueLogin).toBe(true)
  expect(new URL(first.clean).searchParams.has("login")).toBe(false)
  expect(new URL(first.clean).searchParams.get("x")).toBe("1")
  expect(takeLoginQuery(first.clean).continueLogin).toBe(false)
})

test("a Base Sepolia switch failure tells the user to turn on Testnet Mode and does not add the chain", () => {
  const fault = switchFault(CHAINS["base-sepolia"].id, { code: 4902, message: "Unrecognized chain ID" })
  expect(fault).toBe(TESTNET_MODE)
  expect(fault.toLowerCase()).not.toContain("add")
  expect(shouldAddChain(CHAINS.base.id)).toBe(false)
  expect(shouldAddChain(CHAINS["base-sepolia"].id)).toBe(false)
  expect(switchFault(CHAINS.base.id, { code: 4902, message: "Unrecognized chain ID" })).toBe(
    "This network is not available in Phantom.",
  )
  expect(switchFault(CHAINS["base-sepolia"].id, { code: 4001, message: "User rejected the request." })).toBe(
    "Switch cancelled",
  )
})

test("isUnauthorized sees Phantom 4100 and a rejection is separate", () => {
  expect(isUnauthorized({ code: 4100, message: "nope" })).toBe(true)
  expect(isUnauthorized({ cause: { code: 4100 } })).toBe(true)
  expect(
    isUnauthorized(new Error("The requested method and/or account has not been authorized by the user. Version: viem@2.57.7")),
  ).toBe(true)
  expect(isUnauthorized({ code: 4001, message: "User rejected the request." })).toBe(false)
  expect(isUnauthorized(new Error("User rejected the request."))).toBe(false)
})
