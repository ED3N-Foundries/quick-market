import { expect, test } from "bun:test"
import { failureText, pinHostForFailure, readFrame, resetFeedPins } from "./feedSocket"

test("readFrame waits for a split header and then returns the text", () => {
  const payload = Buffer.from("hi")
  const frame = Buffer.concat([Buffer.from([0x81, payload.length]), payload])
  expect(readFrame(frame.subarray(0, 1))).toBeNull()
  const got = readFrame(frame)
  expect(got?.opcode).toBe(1)
  expect(got?.fin).toBe(true)
  expect(got?.payload.toString()).toBe("hi")
  expect(got?.size).toBe(frame.length)
})

test("readFrame reads a 16-bit payload length", () => {
  const payload = Buffer.alloc(200, 0x61)
  const header = Buffer.alloc(4)
  header[0] = 0x81
  header[1] = 126
  header.writeUInt16BE(200, 2)
  const got = readFrame(Buffer.concat([header, payload]))
  expect(got?.payload.toString()).toBe("a".repeat(200))
  expect(got?.size).toBe(204)
})

test("only a certificate or TLS validation error pins a host", () => {
  expect(pinHostForFailure("CERT_HAS_EXPIRED")).toBe(true)
  expect(pinHostForFailure("certificate has expired")).toBe(true)
  expect(pinHostForFailure("Hostname/IP does not match certificate's altnames")).toBe(true)
  expect(pinHostForFailure("self-signed certificate in certificate chain")).toBe(true)
  expect(pinHostForFailure("unable to verify the first certificate")).toBe(true)
  expect(pinHostForFailure("TLS handshake timeout")).toBe(false)
  expect(pinHostForFailure("getaddrinfo ENOTFOUND stream.binance.com")).toBe(false)
  expect(pinHostForFailure("ECONNREFUSED")).toBe(false)
  expect(pinHostForFailure("socket hang up")).toBe(false)
})

test("resetFeedPins clears the fallback set", () => {
  resetFeedPins()
  expect(() => resetFeedPins()).not.toThrow()
})

test("an error event exposes a certificate reason but leaves ordinary failures alone", () => {
  expect(pinHostForFailure(failureText({ error: new Error("certificate has expired") }))).toBe(true)
  expect(pinHostForFailure(failureText({ error: { message: "CERT_HAS_EXPIRED" } }))).toBe(true)
  expect(pinHostForFailure(failureText({ message: "getaddrinfo ENOTFOUND stream.binance.com", code: 1006 }))).toBe(false)
  expect(pinHostForFailure(failureText({ reason: "socket hang up" }))).toBe(false)
  expect(failureText(null)).toBe("")
})
