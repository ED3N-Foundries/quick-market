import { expect, test } from "bun:test"
import { LAG_MAX_BYTES, lagEcho } from "./lag"

test("a lag probe is echoed with both server stamps", () => {
  expect(lagEcho('{"type":"lag","t":123}', 1_000, 1_005)).toBe(
    JSON.stringify({ type: "lag", t: 123, serverRecv: 1_000, serverNow: 1_005 }),
  )
})

test("junk and oversized text get no reply", () => {
  expect(lagEcho("nope", 1, 1)).toBeNull()
  expect(lagEcho('{"type":"tick"}', 1, 1)).toBeNull()
  expect(lagEcho('{"type":"lag"}', 1, 1)).toBeNull()
  expect(lagEcho('{"type":"lag","t":"now"}', 1, 1)).toBeNull()
  expect(lagEcho("x".repeat(LAG_MAX_BYTES + 1), 1, 1)).toBeNull()
})
