import { expect, test } from "bun:test"
import { pngsToIco } from "./ico"

test("pngsToIco writes a directory that points at each image", () => {
  const small = new Uint8Array([1, 2, 3, 4])
  const large = new Uint8Array([5, 6])
  const ico = pngsToIco([
    { size: 16, png: small },
    { size: 32, png: large },
  ])
  const view = new DataView(ico.buffer)
  expect(view.getUint16(0, true)).toBe(0)
  expect(view.getUint16(2, true)).toBe(1)
  expect(view.getUint16(4, true)).toBe(2)
  expect(ico[6]).toBe(16)
  expect(ico[7]).toBe(16)
  expect(ico[22]).toBe(32)
  expect(ico[23]).toBe(32)
  expect(view.getUint32(18, true)).toBe(38)
  expect(view.getUint32(34, true)).toBe(42)
  expect(Array.from(ico.subarray(38, 42))).toEqual([1, 2, 3, 4])
  expect(Array.from(ico.subarray(42, 44))).toEqual([5, 6])
})
