import { expect, test } from "bun:test"
import { brand } from "./config"

test("phthalo green is the backdrop and the type is white", () => {
  expect(brand.backdrop).toBe("#123524")
  expect(Number.parseInt(brand.backdrop.slice(1, 3), 16)).toBe(18)
  expect(Number.parseInt(brand.backdrop.slice(3, 5), 16)).toBe(53)
  expect(Number.parseInt(brand.backdrop.slice(5, 7), 16)).toBe(36)
  expect(brand.text).toBe("#ffffff")
})

test("the marks use the regular wordmark face and the brand lines", () => {
  expect(brand.font.family).toBe("Iowan Old Style")
  expect(brand.font.weight).toBe(400)
  expect(brand.font.style).toBe("normal")
  expect(brand.font.letterSpacing).toBe("-0.03em")
  expect(brand.font.boldLocal[0]).toBe("Iowan Old Style Bold")
  expect(brand.favicon.text).toBe("qm")
  expect(brand.avatar.text).toBe("qmkt.app")
  expect(brand.tagline).toBe("trade next, now.")
  expect(brand.origin).toBe("https://qmkt.app")
  expect(brand.banner.safeWidth).toBe(0.34)
  expect(brand.og.safeWidth).toBe(0.55)
  expect(brand.banner.safeWidth).toBeLessThan(brand.og.safeWidth)
})
