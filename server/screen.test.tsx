/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { FeedsView } from "./screen"
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

function view(width: number, height: number) {
  return (
    <FeedsView
      frame={frame()}
      state={{ selected: 1, help: false }}
      now={now}
      width={width}
      height={height}
      quiet={false}
      host="127.0.0.1:3001"
      onSelect={() => {}}
    />
  )
}

test("a wide screen shows the source, a ready backup, and a far backup", async () => {
  const setup = await testRender(view(120, 24), { width: 120, height: 24 })
  try {
    await setup.renderOnce()
    const painted = setup.captureCharFrame()
    expect(painted).toContain("Binance BTCUSDT")
    expect(painted).toContain("live")
    expect(painted).toContain("67420.12")
    expect(painted).toContain("ready")
    expect(painted).toContain("bybit book")
    expect(painted).toContain("far")
    expect(painted).toContain("79.88")
    expect(painted).toContain("fresh and within $25")
    expect(painted).toContain("ping")
  } finally {
    await setup.dispose()
  }
})

test("a narrow screen drops the gap and the feed name", async () => {
  const setup = await testRender(view(70, 24), { width: 70, height: 24 })
  try {
    await setup.renderOnce()
    const painted = setup.captureCharFrame()
    expect(painted).toContain("ready")
    expect(painted).toContain("far")
    expect(painted).not.toContain("bybit book")
    expect(painted).not.toContain("binance vision book")
    expect(painted).not.toContain("79.88")
  } finally {
    await setup.dispose()
  }
})

test("a quiet API shows the waiting line", async () => {
  const setup = await testRender(
    <FeedsView
      frame={null}
      state={{ selected: 0, help: false }}
      now={now}
      width={80}
      height={16}
      quiet
      host="127.0.0.1:3001"
      onSelect={() => {}}
    />,
    { width: 80, height: 16 },
  )
  try {
    await setup.renderOnce()
    const painted = setup.captureCharFrame()
    expect(painted).toContain("Waiting for the API on 127.0.0.1:3001.")
    expect(painted).toContain("api quiet")
    expect(painted).toContain("The API keeps going")
  } finally {
    await setup.dispose()
  }
})
