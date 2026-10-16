import { expect, test } from "bun:test"
import { USDC, swarmConfig } from "./config"
import { decideWallet, decideWindow, freshGate, type PrintPoint, type WalletMind } from "./decide"
import { personaFor, type Persona } from "./persona"

const persona = swarmConfig.persona
const stake = swarmConfig.stake
const WINDOW = 5_000

function rising(now: number): PrintPoint[] {
  return Array.from({ length: 12 }, (_, index) => ({ t: now - (11 - index) * 1_000, price: 100 + index * 0.4 }))
}

function twitch(now: number): PrintPoint[] {
  const points = Array.from({ length: 90 }, (_, index) => ({ t: now - (89 - index) * 1_000, price: 100 }))
  points[points.length - 2] = { t: now - 1_000, price: 102 }
  points[points.length - 1] = { t: now, price: 100 }
  return points
}

function mind(index: number, over: Partial<Persona>, bankroll = 80 * USDC): WalletMind {
  const base = personaFor(index, persona)
  return {
    index,
    address: `0x${index.toString(16).padStart(40, "0")}`,
    persona: { ...base, bankrollShare: 0.08, ...over },
    bankroll,
    gate: { ...freshGate(index, 0, base, persona), readyWindow: 0, burstLeft: 0, refractory: false },
    paused: false,
  }
}

test("a rising tape and a cheap up pool splits tape and fade", () => {
  const now = 10_000_000
  const tape = mind(1, { mind: "tape", second: null, secondWeight: 0, momentum: 1, noise: 0, edge: 0.02, lookbackMs: 8_000 })
  const fade = mind(2, { mind: "fade", second: null, secondWeight: 0, momentum: -1, noise: 0, edge: 0.02, lookbackMs: 8_000 })
  const up = decideWallet({
    wallet: tape,
    windowId: 10,
    now,
    windowMs: WINDOW,
    points: rising(now),
    poolUp: 20 * USDC,
    poolDown: 80 * USDC,
    config: persona,
    stake,
  })
  expect(up.action).toBe("bet")
  if (up.action === "bet") expect(up.side).toBe("up")
  const down = decideWallet({
    wallet: fade,
    windowId: 10,
    now,
    windowMs: WINDOW,
    points: rising(now),
    poolUp: 20 * USDC,
    poolDown: 80 * USDC,
    config: persona,
    stake,
  })
  expect(down.action === "skip" || (down.action === "bet" && down.side === "down")).toBe(true)
})

test("a price mind skips a twitch and bets a pool that is off its number", () => {
  const now = 20_000_000
  const price = mind(3, {
    mind: "price",
    second: null,
    secondWeight: 0,
    noise: 0,
    edge: 0.02,
    slowLookbackMs: 90_000,
    momentum: 0,
  })
  const fair = decideWallet({
    wallet: price,
    windowId: 4,
    now,
    windowMs: WINDOW,
    points: twitch(now),
    poolUp: 50 * USDC,
    poolDown: 50 * USDC,
    config: persona,
    stake,
  })
  expect(fair.action).toBe("skip")
  const cheap = decideWallet({
    wallet: { ...price, gate: { ...price.gate } },
    windowId: 4,
    now,
    windowMs: WINDOW,
    points: twitch(now),
    poolUp: 10 * USDC,
    poolDown: 90 * USDC,
    config: persona,
    stake,
  })
  expect(cheap.action).toBe("bet")
  if (cheap.action === "bet") expect(cheap.side).toBe("up")
})

test("a fair pool on a calm tape is a skip, and two minds can take opposite sides", () => {
  const now = 30_000_000
  const calm = Array.from({ length: 20 }, (_, index) => ({ t: now - (19 - index) * 1_000, price: 100 + (index % 2) * 0.01 }))
  const tape = mind(4, { mind: "tape", second: null, secondWeight: 0, momentum: 0.2, noise: 0, edge: 0.04 })
  const skipped = decideWallet({
    wallet: tape,
    windowId: 8,
    now,
    windowMs: WINDOW,
    points: calm,
    poolUp: 40 * USDC,
    poolDown: 40 * USDC,
    config: persona,
    stake,
  })
  expect(skipped.action).toBe("skip")
  const wallets = [
    mind(11, { mind: "tape", second: null, secondWeight: 0, momentum: 1, noise: 0, edge: 0.02, lookbackMs: 8_000 }),
    mind(12, { mind: "fade", second: null, secondWeight: 0, momentum: -1, noise: 0, edge: 0.02, lookbackMs: 8_000 }),
  ]
  const book = decideWindow({
    roundId: 15,
    now,
    windowMs: WINDOW,
    points: rising(now),
    poolUp: 50 * USDC,
    poolDown: 50 * USDC,
    wallets,
    config: persona,
    stake,
    cap: 800,
  })
  const sides = book.orders.map((order) => order.side).sort()
  expect(sides).toEqual(["down", "up"])
  const again = decideWindow({
    roundId: 15,
    now,
    windowMs: WINDOW,
    points: rising(now),
    poolUp: 50 * USDC,
    poolDown: 50 * USDC,
    wallets,
    config: persona,
    stake,
    cap: 800,
  })
  expect(again.orders).toEqual(book.orders)

  const btc = Array.from({ length: 10 }, (_, index) => ({ t: now - (9 - index) * 1_000, price: 82_100 + index * 0.8 }))
  const seeded = Array.from({ length: 12 }, (_, index) => ({
    ...mind(index + 30, {}, 9 * USDC),
    persona: personaFor(index + 30, persona),
  }))
  const smallBook = decideWindow({
    roundId: 21,
    now,
    windowMs: WINDOW,
    points: btc,
    poolUp: 0,
    poolDown: 0,
    wallets: seeded,
    config: persona,
    stake,
    cap: 800,
  })
  expect(smallBook.orders.length).toBeGreaterThan(1)
  expect(smallBook.orders.every((order) => order.stakeMicros % USDC !== 0)).toBe(true)
  expect(new Set(smallBook.orders.map((order) => order.side)).size).toBe(2)
})

test("one wallet bets in flurries and a moving tape still leaves most wallets out", () => {
  const start = 40_000_000
  let gate = freshGate(7, 0, personaFor(7, persona), persona)
  gate = { ...gate, readyWindow: 0 }
  const wallet = mind(7, { mind: "tape", second: null, secondWeight: 0, momentum: 1, noise: 0.05, edge: 0.01, tempoWindows: 6, burstWindows: 3 })
  const bets: number[] = []
  for (let windowId = 0; windowId < 720; windowId++) {
    const now = start + windowId * WINDOW
    const decision = decideWallet({
      wallet: { ...wallet, gate },
      windowId,
      now,
      windowMs: WINDOW,
      points: rising(now),
      poolUp: 30 * USDC,
      poolDown: 70 * USDC,
      config: persona,
      stake,
    })
    gate = decision.gate
    if (decision.action === "bet") bets.push(windowId)
  }
  expect(bets.length).toBeGreaterThan(5)
  expect(bets.length).toBeLessThan(720 * 0.45)
  const gaps = bets.slice(1).map((windowId, index) => windowId - bets[index]!)
  expect(gaps.some((gap) => gap <= 3)).toBe(true)
  expect(gaps.some((gap) => gap >= 8)).toBe(true)

  const moving = passRate(rising, 80)
  const quiet = passRate((now) => Array.from({ length: 30 }, (_, index) => ({ t: now - (29 - index) * 1_000, price: 100 })), 80)
  expect(moving).toBeGreaterThan(quiet)
  expect(moving).toBeGreaterThan(0.05)
  expect(moving).toBeLessThan(0.2)
  expect(quiet).toBeLessThan(0.05)
})

function passRate(tape: (now: number) => PrintPoint[], windows: number): number {
  const count = 240
  let gates = Array.from({ length: count }, (_, index) => {
    const person = personaFor(index + 20, persona)
    const gate = freshGate(index + 20, 0, person, persona)
    return { ...gate, readyWindow: index % 6 }
  })
  let last = 0
  for (let windowId = 0; windowId < windows; windowId++) {
    const now = 80_000_000 + windowId * WINDOW
    const wallets = gates.map((gate, index) => ({
      ...mind(index + 20, {}, 100 * USDC),
      gate,
      persona: personaFor(index + 20, persona),
    }))
    const book = decideWindow({
      roundId: 100 + windowId,
      now,
      windowMs: WINDOW,
      points: tape(now),
      poolUp: 40 * USDC,
      poolDown: 60 * USDC,
      wallets,
      config: persona,
      stake,
      cap: 800,
    })
    gates = wallets.map((wallet) => book.gates.get(wallet.address) ?? wallet.gate)
    if (windowId === windows - 1) last = book.orders.length / count
  }
  return last
}
