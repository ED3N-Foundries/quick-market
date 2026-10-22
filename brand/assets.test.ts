import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const dir = join(import.meta.dir, "../web/public")

function pngSize(file: string) {
  const buf = readFileSync(join(dir, file))
  expect(buf.subarray(1, 4).toString("ascii")).toBe("PNG")
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

test("public icons and cards have the brand sizes", () => {
  expect(pngSize("favicon-32.png")).toEqual({ width: 32, height: 32 })
  expect(pngSize("apple-touch-icon.png")).toEqual({ width: 180, height: 180 })
  expect(pngSize("avatar.png")).toEqual({ width: 1024, height: 1024 })
  expect(pngSize("og.png")).toEqual({ width: 2400, height: 1260 })
  expect(pngSize("banner.png")).toEqual({ width: 3000, height: 1000 })
})

test("favicon.ico contains the 16 and 32 pngs", () => {
  const ico = readFileSync(join(dir, "favicon.ico"))
  expect(ico.readUInt16LE(0)).toBe(0)
  expect(ico.readUInt16LE(2)).toBe(1)
  expect(ico.readUInt16LE(4)).toBe(2)
  expect(ico[6]).toBe(16)
  expect(ico[22]).toBe(32)
  const offset16 = ico.readUInt32LE(18)
  const offset32 = ico.readUInt32LE(34)
  expect(ico.subarray(offset16 + 1, offset16 + 4).toString("ascii")).toBe("PNG")
  expect(ico.subarray(offset32 + 1, offset32 + 4).toString("ascii")).toBe("PNG")
})
