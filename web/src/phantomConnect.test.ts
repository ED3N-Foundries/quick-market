import { expect, test } from "bun:test"
import { connectKind, phantomInjected } from "./phantomConnect"

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
