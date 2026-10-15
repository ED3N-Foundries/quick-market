import { expect, test } from "bun:test"
import { readFrame } from "./feedSocket"

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
