import { expect, test } from "bun:test"
import { authorizedAccount, connectKind, isUnauthorized, phantomInjected } from "./phantomConnect"

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

test("isUnauthorized sees Phantom 4100 and a rejection is separate", () => {
  expect(isUnauthorized({ code: 4100, message: "nope" })).toBe(true)
  expect(isUnauthorized({ cause: { code: 4100 } })).toBe(true)
  expect(
    isUnauthorized(new Error("The requested method and/or account has not been authorized by the user. Version: viem@2.57.7")),
  ).toBe(true)
  expect(isUnauthorized({ code: 4001, message: "User rejected the request." })).toBe(false)
  expect(isUnauthorized(new Error("User rejected the request."))).toBe(false)
})
