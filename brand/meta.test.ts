import { expect, test } from "bun:test"
import { brand } from "./config"
import { brandHead } from "./meta"

test("the head tags point share cards at the open graph image", () => {
  const head = brandHead()
  expect(head).toContain(`content="${brand.tagline}"`)
  expect(head).toContain('content="summary_large_image"')
  expect(head).toContain("https://qmkt.app/og.png")
  expect(head).toContain('content="https://qmkt.app/"')
  expect(head).toContain('property="og:image:width" content="2400"')
  expect(head).toContain('property="og:image:height" content="1260"')
  expect(head).toContain('href="/favicon.ico"')
  expect(head).toContain('href="/favicon-32.png"')
  expect(head).toContain('href="/apple-touch-icon.png"')
  expect(head).not.toContain("theme-color")
})
