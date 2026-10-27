import { expect, test } from "bun:test"
import { apiBase, feedsUrl, handleKey, holdLine, marketLines, parseFeedFrame, parseMarketStats, renderFeeds, signedMove, sourceLine, stateUrl, venueLine, type MarketStats } from "./dashboard"
import { feedsNow } from "./feeds"

const now = 10_000

function frame() {
  return feedsNow(
    {
      active: "binance",
      anchor: "67420.12",
      venues: [
        { venue: "binance", price: "67420.12", at: 9_920, feed: "binance vision book", up: true },
        { venue: "bybit", price: "67419.80", at: 9_600, feed: "bybit book", up: true },
        { venue: "okx", price: "67421.10", at: 5_000, feed: "okx bbo", up: true },
        { venue: "coinbase", price: null, at: 0, feed: null, up: true },
        { venue: "kraken", price: null, at: 0, feed: null, up: false },
        { venue: "bitstamp", price: "67500.00", at: 9_800, feed: "bitstamp book", up: true },
      ],
    },
    { configured: "binance", live: "live", handoff: null, now },
  )
}

test("the page names the live source, a ready backup, and a far backup", () => {
  const page = renderFeeds(frame(), { selected: 1, help: false, quiet: false }, now, "http://127.0.0.1:3001/api/feeds")
  expect(page).toContain("Binance BTCUSDT   live   67420.12   80ms")
  expect(page).toContain("configured binance   handoff none")
  expect(page).toContain("bybit     ready")
  expect(page).toContain("0.32")
  expect(page).toContain("bitstamp  far")
  expect(page).toContain("79.88")
  expect(page).toContain("fresh and within $25")
  expect(sourceLine(frame(), now)).toContain("80ms")
})

test("a handoff names the drop and when buy-in resumes", () => {
  const body = frame()
  body.handoff = { from: "binance", to: "bybit", resumeAt: now + 4_200 }
  expect(holdLine(body, now)).toBe("configured binance   handoff binance → bybit   buy-in resumes in 4.2s")
  body.handoff = { from: "binance", to: null, resumeAt: null }
  expect(holdLine(body, now)).toBe("configured binance   handoff binance dropped, waiting")
})

test("a missing API prints the waiting page", () => {
  const page = renderFeeds(null, { selected: 0, help: false, quiet: true }, now, "http://127.0.0.1:3001/api/feeds")
  expect(page).toContain("Waiting for the API on 127.0.0.1:3001.")
  expect(page).toContain("api quiet")
  expect(page).toContain("The API keeps going")
})

test("a narrow row drops the gap and the feed name", () => {
  const bitstamp = frame().venues[5]!
  expect(venueLine(bitstamp, false, true, now)).toContain("bitstamp book")
  expect(venueLine(bitstamp, false, true, now)).toContain("79.88")
  const narrow = venueLine(bitstamp, false, false, now)
  expect(narrow).not.toContain("bitstamp book")
  expect(narrow).not.toContain("79.88")
  expect(narrow).toContain("far")
})

test("j and k move the selection and q quits", () => {
  const start = { selected: 0, help: false }
  expect(handleKey(start, "j", 6).state.selected).toBe(1)
  expect(handleKey(start, "k", 6).state.selected).toBe(0)
  expect(handleKey({ selected: 5, help: false }, "j", 6).state.selected).toBe(5)
  expect(handleKey(start, "?", 6).state.help).toBe(true)
  expect(handleKey(start, "q", 6).quit).toBe(true)
})

test("the page follows API_URL and prints the book beside each venue ping", () => {
  expect(apiBase("http://quick-market:3001/")).toBe("http://quick-market:3001")
  expect(apiBase("http://127.0.0.1:3001/api/session")).toBe("http://127.0.0.1:3001")
  expect(feedsUrl("http://quick-market:3001")).toBe("http://quick-market:3001/api/feeds")
  expect(stateUrl("http://quick-market:3001")).toBe("http://quick-market:3001/api/state")
  const stats: MarketStats = {
    phase: "buy-in",
    windowEndsAt: now + 3_200,
    join: {
      up: { poolMicros: 33_720_000, players: 28 },
      down: { poolMicros: 51_970_000, players: 42 },
    },
    live: {
      strike: "67400.00",
      settlesAt: now + 1_800,
      up: { poolMicros: 84_370_000, players: 67 },
      down: { poolMicros: 74_210_000, players: 59 },
    },
  }
  expect(signedMove("67400.00", "67420.12")).toBe("+$20.12")
  expect(signedMove("67420.12", "67400.00")).toBe("−$20.12")
  expect(signedMove("67420.12", "67420.124")).toBe("=$0.00")
  expect(marketLines(stats, "67420.12", now)[0]).toBe("buy-in 3.2s   up $33.72 · 28   down $51.97 · 42")
  expect(marketLines(stats, "67420.12", now)[1]).toContain("strike 67400.00   +$20.12")
  const closed = marketLines({ ...stats, join: null, live: null }, null, now)
  expect(closed).toEqual(["buy-in closed   resumes in 3.2s"])
  const page = renderFeeds(frame(), { selected: 1, help: false, quiet: false }, now, "http://127.0.0.1:3001/api/feeds", stats)
  expect(page).toContain("buy-in 3.2s")
  expect(page).toContain("ping")
  expect(page).toContain("80ms")
  expect(parseMarketStats({ board: { phase: "buy-in", windowEndsAt: now, join: null, live: null } })).toEqual({
    phase: "buy-in",
    windowEndsAt: now,
    join: null,
    live: null,
  })
  expect(parseMarketStats({ ok: true })).toBeNull()
})

test("parseFeedFrame accepts the server payload and rejects a partial one", () => {
  const body = frame()
  expect(parseFeedFrame(JSON.parse(JSON.stringify(body)))).toEqual(body)
  expect(parseFeedFrame({ ok: true })).toBeNull()
  expect(parseFeedFrame({ ...body, venues: body.venues.slice(0, 2) })).toBeNull()
  const { switches: _omit, ...withoutLog } = body
  expect(parseFeedFrame(withoutLog)?.switches).toEqual([])
})

test("the switch log shows five rows on a tall screen and the newest on a short one", () => {
  const body = frame()
  body.switches = [5, 4, 3, 2, 1].map((n) => ({
    at: Date.UTC(2026, 0, 1, 19, 0, n),
    from: "binance" as const,
    to: n % 2 === 0 ? null : ("bybit" as const),
    reason: `reason ${n}`,
  }))
  const tall = renderFeeds(body, { selected: 0, help: false, quiet: false }, now, "http://127.0.0.1:3001/api/feeds", null, 24)
  expect(tall).toContain("19:00:05Z  binance → bybit  reason 5")
  expect(tall).toContain("19:00:01Z  binance → bybit  reason 1")
  expect(tall).toContain("swing")
  const short = renderFeeds(body, { selected: 0, help: false, quiet: false }, now, "http://127.0.0.1:3001/api/feeds", null, 16)
  expect(short).toContain("reason 5")
  expect(short).not.toContain("reason 1")
  expect(renderFeeds(frame(), { selected: 0, help: false, quiet: false }, now, "http://127.0.0.1:3001/api/feeds")).toContain("switches  none")
})
