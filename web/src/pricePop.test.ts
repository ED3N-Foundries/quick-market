import { expect, test } from "bun:test"
import { placePricePops, pricePopText, type PopRect } from "./pricePop"

function box(left: number, top: number, width: number, height: number): PopRect {
  return { left, top, right: left + width, bottom: top + height, width, height }
}

test("a win shows the gain and a loss shows the stake", () => {
  expect(pricePopText("credit", 8_500_000, true)).toBe("+$8.50")
  expect(pricePopText("debit", 10_000_000, false)).toBe("−$10.00")
  expect(pricePopText("push", 10_000_000, false)).toBe("=$0.00")
  expect(pricePopText("void", 10_000_000, false)).toBe("=$0.00")
  expect(pricePopText("credit", 10_000_000, false)).toBe("=$0.00")
})

test("the pop sits on the right of the balance, centered on the digits", () => {
  const placed = placePricePops(box(420, 640, 168, 43), [{ width: 83, height: 33 }], { width: 1200, height: 800 })
  expect(placed).toEqual([{ left: 596, top: 645, side: "right" }])
})

test("a narrow balance still keeps the pop on its right", () => {
  const placed = placePricePops(box(29, 520, 140, 43), [{ width: 83, height: 33 }], { width: 390, height: 800 })
  expect(placed).toEqual([{ left: 177, top: 525, side: "right" }])
})

test("a balance against the right edge lifts the pop above the digits", () => {
  const placed = placePricePops(box(300, 500, 70, 43), [{ width: 83, height: 33 }], { width: 390, height: 800 })
  expect(placed).toEqual([{ left: 287, top: 459, side: "above" }])
})

test("a balance against the top drops the pop below when the right side is blocked", () => {
  const placed = placePricePops(box(300, 4, 70, 28), [{ width: 83, height: 33 }], { width: 390, height: 800 })
  expect(placed).toEqual([{ left: 287, top: 40, side: "below" }])
})

test("a wide pop on a narrow screen stays on the balance and inside the viewport", () => {
  const placed = placePricePops(box(200, 400, 160, 43), [{ width: 200, height: 28 }], { width: 390, height: 800 })
  expect(placed[0]).toEqual({ left: 160, top: 364, side: "above" })
  expect((placed[0]?.left ?? 0) + 200).toBeLessThanOrEqual(382)
})

test("two pops stack to the right of the balance with the first one nearest it", () => {
  const placed = placePricePops(box(40, 200, 150, 43), [
    { width: 70, height: 28 },
    { width: 160, height: 40 },
  ], { width: 800, height: 700 })
  expect(placed.map((pop) => pop.side)).toEqual(["right", "right"])
  expect(placed[0]).toEqual({ left: 198, top: 207.5, side: "right" })
  expect(placed[1]).toEqual({ left: 198, top: 241.5, side: "right" })
})

test("a balance in the corner uses the left side when the other sides are blocked", () => {
  const placed = placePricePops(box(320, 10, 60, 40), [{ width: 70, height: 28 }], { width: 390, height: 80 })
  expect(placed).toEqual([{ left: 242, top: 16, side: "left" }])
})
