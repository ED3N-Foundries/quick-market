export type TapePoint = { t: number; price: number }

export type MarketSpan = {
  id: number
  betsOpen: number
  strikeAt: number
  settlesAt: number
  strike: number | null
}

export type ChartScale = {
  viewStart: number
  viewEnd: number
  plotLeft: number
  plotTop: number
  plotWidth: number
  plotHeight: number
  width: number
  height: number
  yMin: number
  yMax: number
  ticks: { price: number; y: number; label: string }[]
}

export type TapeChart = {
  reset(points: TapePoint[]): void
  push(t: number, price: number): void
  destroy(): void
}

type View = { follow: boolean; start: number; end: number }

const UP = "#2fce86"
const DOWN = "#ff5a4f"
const UP_FILL = "rgba(47, 206, 134, 0.22)"
const DOWN_FILL = "rgba(255, 90, 79, 0.2)"
const NEUTRAL = "rgba(243,240,232,0.7)"
const STRIKE = "rgba(243,240,232,0.55)"
const PAD = { l: 12, r: 68, t: 16, b: 22 }
const TAPE_MS = 15 * 60 * 1000

let scale: ChartScale | null = null
const listeners = new Set<() => void>()

export function subscribeScale(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getScale() {
  return scale
}

function publish(next: ChartScale) {
  scale = next
  for (const listener of listeners) listener()
}

export function mountChart(
  canvas: HTMLCanvasElement,
  options: {
    getNow: () => number
    getView: () => View
    getClock: () => { blockStart: number; blockEnd: number } | null
    getMarkets: () => MarketSpan[]
  },
): TapeChart {
  let points: TapePoint[] = []
  let running = true
  let raf = 0

  const resize = () => {
    const rect = canvas.getBoundingClientRect()
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const width = Math.max(1, Math.floor(rect.width * dpr))
    const height = Math.max(1, Math.floor(rect.height * dpr))
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
    }
  }

  const observer = new ResizeObserver(resize)
  observer.observe(canvas)
  resize()

  const frame = () => {
    if (!running) return
    draw()
    raf = requestAnimationFrame(frame)
  }
  raf = requestAnimationFrame(frame)

  function draw() {
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const width = canvas.width / dpr
    const height = canvas.height / dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)

    const plotW = Math.max(1, width - PAD.l - PAD.r)
    const plotH = Math.max(1, height - PAD.t - PAD.b)
    const now = options.getNow()
    const clock = options.getClock()
    const view = options.getView()
    const viewStart = view.follow ? (clock?.blockStart ?? now - 10_000) : view.start
    const viewEnd = view.follow ? (clock?.blockEnd ?? now) : view.end
    const span = Math.max(1, viewEnd - viewStart)
    const xAt = (t: number) => PAD.l + ((t - viewStart) / span) * plotW
    const markets = options.getMarkets().filter((market) => market.settlesAt > viewStart && market.betsOpen < viewEnd)

    const visible: TapePoint[] = []
    let previous: TapePoint | null = null
    for (const point of points) {
      if (point.t < viewStart) {
        previous = point
        continue
      }
      if (previous) {
        visible.push(previous)
        previous = null
      }
      if (point.t > viewEnd) break
      visible.push(point)
    }

    let min = Infinity
    let max = -Infinity
    for (const point of visible) {
      min = Math.min(min, point.price)
      max = Math.max(max, point.price)
    }
    for (const market of markets) {
      if (market.strike === null) continue
      if (market.settlesAt < viewStart || market.strikeAt > viewEnd) continue
      min = Math.min(min, market.strike)
      max = Math.max(max, market.strike)
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      min = 0
      max = 1
    }
    const mid = (min + max) / 2
    const raw = Math.max(max - min, 0)
    const priceSpan = raw > 0 ? raw : Math.max(Math.abs(mid) * 0.00001, 0.01)
    const yPad = priceSpan * 0.12
    min = mid - priceSpan / 2 - yPad
    max = mid + priceSpan / 2 + yPad
    const yAt = (price: number) => PAD.t + ((max - price) / (max - min)) * plotH
    const ticks = priceTicks(min, max).map((tick) => ({ ...tick, y: yAt(tick.price) }))

    publish({
      viewStart,
      viewEnd,
      plotLeft: PAD.l,
      plotTop: PAD.t,
      plotWidth: plotW,
      plotHeight: plotH,
      width,
      height,
      yMin: min,
      yMax: max,
      ticks,
    })

    ctx.strokeStyle = "rgba(243,240,232,0.08)"
    ctx.lineWidth = 1
    for (const tick of ticks) {
      ctx.beginPath()
      ctx.moveTo(PAD.l, tick.y)
      ctx.lineTo(PAD.l + plotW, tick.y)
      ctx.stroke()
    }

    if (!visible.length) {
      ctx.fillStyle = "rgba(243,240,232,0.45)"
      ctx.font = "13px ui-sans-serif, system-ui, sans-serif"
      ctx.fillText("Waiting for the price", PAD.l, PAD.t + 18)
    } else {
      const path = visible.map((point) => ({ ...point, x: xAt(point.t), y: yAt(point.price) }))
      for (const market of markets) {
        if (market.strike === null) continue
        const x0 = xAt(Math.max(market.strikeAt, viewStart))
        const x1 = xAt(Math.min(market.settlesAt, viewEnd))
        if (x1 <= x0) continue
        const strikeY = yAt(market.strike)
        ctx.save()
        ctx.beginPath()
        ctx.rect(x0, PAD.t, x1 - x0, plotH)
        ctx.clip()
        for (let i = 1; i < path.length; i++) {
          const a = path[i - 1]
          const b = path[i]
          if (!a || !b) continue
          if (b.t < market.strikeAt || a.t > market.settlesAt) continue
          fillSegment(ctx, a, b, market.strike, strikeY)
        }
        ctx.restore()
        ctx.save()
        ctx.setLineDash([4, 5])
        ctx.strokeStyle = STRIKE
        ctx.beginPath()
        ctx.moveTo(x0, strikeY)
        ctx.lineTo(x1, strikeY)
        ctx.stroke()
        ctx.restore()
      }

      ctx.lineWidth = 1.75
      ctx.lineJoin = "round"
      ctx.lineCap = "round"
      for (let i = 1; i < path.length; i++) {
        const a = path[i - 1]
        const b = path[i]
        if (a && b) strokePair(ctx, a, b, markets)
      }

      const last = path[path.length - 1]
      if (last) {
        const market = marketAt(markets, last.t)
        const color = market?.strike == null ? NEUTRAL : last.price >= market.strike ? UP : DOWN
        ctx.fillStyle = color
        ctx.beginPath()
        ctx.arc(last.x, last.y, 3.5, 0, Math.PI * 2)
        ctx.fill()
      }
    }

    if (now >= viewStart && now <= viewEnd) {
      ctx.strokeStyle = "rgba(243,240,232,0.28)"
      ctx.beginPath()
      ctx.moveTo(xAt(now), PAD.t)
      ctx.lineTo(xAt(now), PAD.t + plotH)
      ctx.stroke()
    }

    ctx.fillStyle = "rgba(243,240,232,0.45)"
    ctx.font = "11px ui-sans-serif, system-ui, sans-serif"
    ctx.textAlign = "left"
    ctx.fillText(clockLabel(viewStart), PAD.l, height - 6)
    ctx.textAlign = "right"
    ctx.fillText(clockLabel(viewEnd), PAD.l + plotW, height - 6)
  }

  return {
    reset(next) {
      points = next.filter((point) => Number.isFinite(point.t) && Number.isFinite(point.price))
    },
    push(t, price) {
      if (!Number.isFinite(t) || !Number.isFinite(price)) return
      const last = points[points.length - 1]
      if (last && t < last.t) return
      if (last && t === last.t) {
        last.price = price
        return
      }
      points.push({ t, price })
      const cutoff = t - TAPE_MS
      if (points.length > 20_000 || (points[0] && points[0].t < cutoff)) {
        const index = points.findIndex((point) => point.t >= cutoff)
        if (index > 0) points.splice(0, index)
      }
    },
    destroy() {
      running = false
      cancelAnimationFrame(raf)
      observer.disconnect()
    },
  }
}

function priceTicks(min: number, max: number): { price: number; label: string }[] {
  const span = max - min
  if (!(span > 0)) return []
  const raw = span / 4
  const mag = 10 ** Math.floor(Math.log10(raw))
  const err = raw / mag
  const step = (err >= 5 ? 5 : err >= 2 ? 2 : 1) * mag
  if (!(step > 0)) return []
  const digits = step >= 0.01 ? 2 : 4
  const start = Math.ceil(min / step) * step
  const ticks: { price: number; label: string }[] = []
  for (let i = 0; i < 8; i++) {
    const price = start + i * step
    if (price > max + step * 0.001) break
    if (price < min) continue
    ticks.push({
      price,
      label: price.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits }),
    })
  }
  return ticks
}

type XY = TapePoint & { x: number; y: number }

function marketAt(markets: MarketSpan[], t: number): MarketSpan | null {
  for (const market of markets) {
    if (market.strike === null) continue
    if (t >= market.strikeAt && t < market.settlesAt) return market
  }
  return null
}

function strokePair(ctx: CanvasRenderingContext2D, a: XY, b: XY, markets: MarketSpan[]) {
  const cuts: number[] = []
  for (const market of markets) {
    if (market.strikeAt > a.t && market.strikeAt < b.t) cuts.push(market.strikeAt)
    if (market.settlesAt > a.t && market.settlesAt < b.t) cuts.push(market.settlesAt)
  }
  cuts.sort((left, right) => left - right)
  const cut = cuts[0]
  if (cut !== undefined) {
    const mid = splitAt(a, b, cut)
    if (mid) {
      strokePair(ctx, a, mid, markets)
      strokePair(ctx, mid, b, markets)
      return
    }
  }
  const market = marketAt(markets, (a.t + b.t) / 2)
  if (!market || market.strike === null) {
    ctx.strokeStyle = NEUTRAL
    trace(ctx, a, b)
    return
  }
  if ((a.price - market.strike) * (b.price - market.strike) < 0) {
    const ratio = (market.strike - a.price) / (b.price - a.price)
    const mid: XY = {
      t: a.t + (b.t - a.t) * ratio,
      price: market.strike,
      x: a.x + (b.x - a.x) * ratio,
      y: a.y + (b.y - a.y) * ratio,
    }
    strokePair(ctx, a, mid, markets)
    strokePair(ctx, mid, b, markets)
    return
  }
  ctx.strokeStyle = a.price >= market.strike && b.price >= market.strike ? UP : DOWN
  trace(ctx, a, b)
}

function trace(ctx: CanvasRenderingContext2D, a: XY, b: XY) {
  ctx.beginPath()
  ctx.moveTo(a.x, a.y)
  ctx.lineTo(b.x, b.y)
  ctx.stroke()
}

function splitAt(a: XY, b: XY, t: number): XY | null {
  if (!(t > a.t && t < b.t)) return null
  const ratio = (t - a.t) / (b.t - a.t)
  return {
    t,
    price: a.price + (b.price - a.price) * ratio,
    x: a.x + (b.x - a.x) * ratio,
    y: a.y + (b.y - a.y) * ratio,
  }
}

function fillSegment(ctx: CanvasRenderingContext2D, a: XY, b: XY, strike: number, strikeY: number) {
  if ((a.price - strike) * (b.price - strike) < 0) {
    const ratio = (strike - a.price) / (b.price - a.price)
    const mid: XY = {
      t: a.t + (b.t - a.t) * ratio,
      price: strike,
      x: a.x + (b.x - a.x) * ratio,
      y: strikeY,
    }
    fillSegment(ctx, a, mid, strike, strikeY)
    fillSegment(ctx, mid, b, strike, strikeY)
    return
  }
  if (a.price === strike && b.price === strike) return
  ctx.fillStyle = a.price >= strike && b.price >= strike ? UP_FILL : DOWN_FILL
  ctx.beginPath()
  ctx.moveTo(a.x, a.y)
  ctx.lineTo(b.x, b.y)
  ctx.lineTo(b.x, strikeY)
  ctx.lineTo(a.x, strikeY)
  ctx.closePath()
  ctx.fill()
}

function clockLabel(ms: number) {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })
}
