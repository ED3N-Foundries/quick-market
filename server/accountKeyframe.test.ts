import { beforeEach, expect, test } from "bun:test"
import { MINT_CONFIRMATIONS } from "../shared/mint"
import { marketPreferences } from "../shared/market"
import { tickerFor } from "../shared/source"
import type { ServerStreamMessage } from "../shared/stream"
import { withChain } from "./activeChain"
import { accountIsDirty, markAccountDirty } from "./accountDirty"
import { pumpAccountKeyframe, pushAccountNow, resetAccountKeyframe } from "./accountKeyframe"
import { addPushSession, type AccountNotice, type PushSession } from "./accountPush"
import { useDatabase } from "./db"
import { startGrant } from "./grant"
import { hub, type MarketSocket } from "./hub"
import { advance, credit, notePrint, placeBuyIn, placeBuyIns, resetRuntime, youFor, type Print } from "./rounds"
import { MarketStream } from "./stream"

const USDC = 1_000_000
const T = 10_000_000_000_000
const WINDOW = 10_000
const MARKET_ID = T / WINDOW
const chain = "base-sepolia" as const

function address(n: number) {
  return `0x${n.toString(16).padStart(40, "0")}`
}

function print(price: string, at: number): Print {
  return { price, exchangeTs: at, receivedAt: at, source: "binance" }
}

function openFeed() {
  notePrint(print("100", T - 20))
  advance(T + 10)
}

function socket(
  who: string | null,
  sent: ServerStreamMessage[],
  send: MarketSocket["send"] = (raw) => {
    sent.push(JSON.parse(String(raw)) as ServerStreamMessage)
    return 1
  },
): MarketSocket {
  const peer = {
    data: { address: who, chain },
    send,
    getBufferedAmount: () => 0,
    close() {},
  } as unknown as MarketSocket
  hub.add(peer)
  return peer
}

function session(id: string, addresses: readonly string[], sent: AccountNotice[], notify: PushSession["notify"] = (body) => {
  sent.push(body)
  return true
}): () => void {
  const fps = new Map<string, string>()
  return addPushSession({
    id,
    chain,
    addresses: () => addresses,
    fingerprint: (addr) => fps.get(addr),
    remember: (addr, fp) => {
      fps.set(addr, fp)
    },
    notify,
  })
}

beforeEach(() => {
  marketPreferences.chain = chain
  process.env.WINDOW_SECONDS = "10"
  process.env.MARKET_SECONDS = "10"
  process.env.BOT_COUNT = "0"
  process.env.FEE_BPS = "25"
  process.env.PRICE_SOURCE = "binance"
  resetRuntime()
  useDatabase(":memory:")
  resetAccountKeyframe()
})

test("two sockets on one address receive the buy-in, and other sockets receive nothing", () => {
  const who = address(1)
  const other = address(2)
  const mineA: ServerStreamMessage[] = []
  const mineB: ServerStreamMessage[] = []
  const theirs: ServerStreamMessage[] = []
  const anon: ServerStreamMessage[] = []
  const a = socket(who, mineA)
  const b = socket(who, mineB)
  const c = socket(other, theirs)
  const d = socket(null, anon)
  try {
    openFeed()
    credit(who, 10_000 * USDC)
    const placed = placeBuyIn({ address: who, side: "up", stakeMicros: USDC, roundId: MARKET_ID, now: T + 100 })
    expect(placed.ok).toBe(true)
    pumpAccountKeyframe(chain, 1_000)
    const frame = {
      type: "account",
      you: {
        address: who,
        balanceMicros: 10_000 * USDC - USDC,
        openBuyIns: [{ roundId: MARKET_ID, side: "up", stakeMicros: USDC }],
      },
    }
    expect(mineA).toHaveLength(1)
    expect(mineB).toHaveLength(1)
    expect(mineA[0]).toMatchObject(frame)
    expect(mineB[0]).toMatchObject(frame)
    expect(mineA[0] && "results" in mineA[0]).toBe(false)
    expect(mineA[0] && "seq" in mineA[0]).toBe(false)
    expect(theirs).toEqual([])
    expect(anon).toEqual([])
  } finally {
    hub.remove(a)
    hub.remove(b)
    hub.remove(c)
    hub.remove(d)
  }
})

test("the same fingerprint produces no second frame", () => {
  const who = address(3)
  const sent: ServerStreamMessage[] = []
  const peer = socket(who, sent)
  try {
    credit(who, USDC)
    pumpAccountKeyframe(chain, 1_000)
    expect(sent).toHaveLength(1)
    credit(who, USDC)
    pumpAccountKeyframe(chain, 1_500)
    expect(sent).toHaveLength(1)
    expect(accountIsDirty(chain, who)).toBe(true)
    pumpAccountKeyframe(chain, 2_000)
    expect(sent).toHaveLength(2)
    expect(sent[1]).toMatchObject({ type: "account", you: { balanceMicros: 2 * USDC } })
    markAccountDirty(chain, who)
    pumpAccountKeyframe(chain, 3_000)
    expect(sent).toHaveLength(2)
    expect(accountIsDirty(chain, who)).toBe(false)
  } finally {
    hub.remove(peer)
  }
})

test("a grant hash is pushed without waiting for the keyframe", () => {
  const who = address(7)
  const sent: ServerStreamMessage[] = []
  const peer = socket(who, sent)
  try {
    credit(who, USDC)
    markAccountDirty(chain, who)
    pushAccountNow(chain, who, 1_000)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ type: "account", you: { address: who, balanceMicros: USDC } })
    expect(accountIsDirty(chain, who)).toBe(false)
    pumpAccountKeyframe(chain, 1_100)
    expect(sent).toHaveLength(1)
  } finally {
    hub.remove(peer)
  }
})

test("a grant meter bump, then a credit, arrives as pending and then as the cleared balance", async () => {
  const who = address(4)
  const sent: ServerStreamMessage[] = []
  const peer = socket(who, sent)
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const hash = `0x${"ab".repeat(32)}`
  try {
    const started = startGrant({
      address: who,
      now: 0,
      chainKey: chain,
      amount: 100 * USDC,
      intervalMs: 60_000,
      mint: async (_amount, report) => {
        report({ txHash: hash, seen: 2 })
        await gate
      },
    })
    expect(started.claimed).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    pumpAccountKeyframe(chain, 1_000)
    expect(sent).toEqual([
      expect.objectContaining({
        type: "account",
        you: expect.objectContaining({
          balanceMicros: 0,
          grantPending: { startedAt: 0, txHash: hash, seen: 2, confirmations: MINT_CONFIRMATIONS },
        }),
      }),
    ])
    release()
    await started.done
    pumpAccountKeyframe(chain, 2_000)
    expect(sent[1]).toMatchObject({
      type: "account",
      you: { balanceMicros: 100 * USDC, grantAt: 0, grantPending: null },
    })
  } finally {
    release()
    hub.remove(peer)
  }
})

test("an MCP session bound to the address gets one notification", () => {
  const who = address(5)
  const bound: AccountNotice[] = []
  const other: AccountNotice[] = []
  const closeBound = session("bound", [who], bound)
  const closeOther = session("other", [address(6)], other)
  try {
    credit(who, 4 * USDC)
    pumpAccountKeyframe(chain, 1_000)
    const you = youFor(who)
    expect(you).not.toBeNull()
    expect(bound).toHaveLength(1)
    expect(bound[0]?.yous).toEqual([you])
    expect(other).toEqual([])
  } finally {
    closeBound()
    closeOther()
  }
})

test("more than 32 dirty addresses send 32 and keep the remainder dirty", () => {
  const addresses = Array.from({ length: 33 }, (_, n) => address(100 + n))
  const sent: AccountNotice[] = []
  const close = session("swarm", addresses, sent)
  try {
    for (const who of addresses) credit(who, USDC)
    pumpAccountKeyframe(chain, 1_000)
    expect(sent).toHaveLength(1)
    const yous = sent[0]?.yous ?? []
    expect(yous).toHaveLength(32)
    const left = addresses.filter((who) => accountIsDirty(chain, who))
    expect(left).toHaveLength(1)
    expect(yous.map((you) => you.address)).not.toContain(left[0])
    for (const you of yous) expect(accountIsDirty(chain, you.address)).toBe(false)
  } finally {
    close()
  }
})

test("a failed send leaves the address dirty", () => {
  const who = address(7)
  const sent: ServerStreamMessage[] = []
  let open = false
  const peer = socket(who, sent, (raw) => {
    if (!open) return 0
    sent.push(JSON.parse(String(raw)) as ServerStreamMessage)
    return 1
  })
  try {
    credit(who, USDC)
    pumpAccountKeyframe(chain, 1_000)
    expect(sent).toEqual([])
    expect(accountIsDirty(chain, who)).toBe(true)
    open = true
    pumpAccountKeyframe(chain, 2_000)
    expect(sent).toHaveLength(1)
    expect(accountIsDirty(chain, who)).toBe(false)
  } finally {
    hub.remove(peer)
  }
})

test("an account keyframe stays off the public sequence", () => {
  const who = address(8)
  const sent: ServerStreamMessage[] = []
  const peer = socket(who, sent)
  const market = new MarketStream({
    board: () => ({
      blockStart: 0,
      blockEnd: 10_000,
      windowEndsAt: 10_000,
      phase: "buy-in",
      join: null,
      live: null,
      bands: [],
    }),
    tape: () => [],
    feed: () => "live",
    ticker: () => tickerFor("binance"),
    handoff: () => null,
    youFor: () => null,
    accountResults: () => [],
    nearFunding: () => ({ cooling: false, retryAfterMs: 0, untilMs: null, reason: null }),
  })
  try {
    market.snapshot(peer)
    credit(who, USDC)
    pumpAccountKeyframe(chain, 5_000)
    withChain(chain, () => market.tick("100", 1, 6, "live"))
    const account = sent.find((message) => message.type === "account")
    const tick = sent.find((message) => message.type === "tick")
    expect(account && !("seq" in account)).toBe(true)
    expect(tick && "seq" in tick && tick.seq).toBe(1)
  } finally {
    hub.remove(peer)
  }
})

test("a batch buy-in reaches each accepted account", () => {
  const up = address(9)
  const down = address(10)
  const upSent: ServerStreamMessage[] = []
  const downSent: ServerStreamMessage[] = []
  const upPeer = socket(up, upSent)
  const downPeer = socket(down, downSent)
  try {
    openFeed()
    credit(up, 5 * USDC)
    credit(down, 5 * USDC)
    const batch = placeBuyIns({
      now: T + 100,
      roundId: MARKET_ID,
      orders: [
        { address: up, side: "up", stakeMicros: USDC },
        { address: down, side: "down", stakeMicros: 2 * USDC },
        { address: address(11), side: "up", stakeMicros: USDC },
      ],
    })
    expect(batch.ok).toBe(true)
    pumpAccountKeyframe(chain, 1_000)
    expect(upSent.map((message) => message.type === "account" && message.you?.openBuyIns)).toEqual([
      [{ roundId: MARKET_ID, side: "up", stakeMicros: USDC }],
    ])
    expect(downSent.map((message) => message.type === "account" && message.you?.balanceMicros)).toEqual([5 * USDC - 2 * USDC])
  } finally {
    hub.remove(upPeer)
    hub.remove(downPeer)
  }
})
