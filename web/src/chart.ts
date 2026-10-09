import { HALF_FLOOR, contentHalf, halfSpan, shownHalf, type PricePoint } from "./scale"

export type TapePoint = PricePoint

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

export type TapeSample = { price: number; at: number; previous: number | null }

export type TapeChart = {
  reset(points: TapePoint[]): void
  push(t: number, price: number): void
  destroy(): void
  subscribe(listener: () => void): () => void
  getScale(): ChartScale | null
  sample(t: number): TapeSample | null
}

type View = { follow: boolean; start: number; end: number }

const UP = "#2fce86"
const DOWN = "#ff5a4f"
const PUSH = "#4c8dff"
const UP_FILL = "rgba(47, 206, 134, 0.22)"
const DOWN_FILL = "rgba(255, 90, 79, 0.2)"
const NEUTRAL = "rgba(243,240,232,0.7)"
const STRIKE = "rgba(243,240,232,0.55)"
const PUSH_EPS = 1e-8

export function priceTone(price: number, baseline: number): "up" | "down" | "push" {
  if (Math.abs(price - baseline) <= PUSH_EPS) return "push"
  return price > baseline ? "up" : "down"
}
const PAD = { l: 12, r: 68, t: 16, b: 22 }
const TAPE_MS = 15 * 60 * 1000
const EASE_MS = 1_000

export function mountChart(
  canvas: HTMLCanvasElement,
  options: {
    getNow: () => number
    getView: () => View
    getClock: () => { blockStart: number; blockEnd: number } | null
    getMarkets: () => MarketSpan[]
    getBaseline: () => number | null
    extendLive: () => boolean
  },
): TapeChart {
  let points: TapePoint[] = []
  let running = true
  let raf = 0
  let scale: ChartScale | null = null
  let shown = HALF_FLOOR
  let scaled = false
  let lastBaseline: number | null = null
  let lastViewStart = 0
  let lastEaseAt = 0
  const listeners = new Set<() => void>()

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

  function publish(next: ChartScale) {
    scale = next
    for (const listener of listeners) listener()
  }

  function easeHalf(target: number, content: number, baseline: number | null, viewStart: number, viewEnd: number) {
    const stamp = performance.now()
    const dt = lastEaseAt ? stamp - lastEaseAt : 0
    lastEaseAt = stamp
    const span = Math.max(1, viewEnd - viewStart)
    const jumped = scaled && Math.abs(viewStart - lastViewStart) > span * 0.2
    const baselineChanged = scaled && baseline !== lastBaseline
    const k = 1 - Math.exp(-Math.max(0, dt) / EASE_MS)
    const next = shownHalf(shown, target, content, k, !scaled || jumped || baselineChanged)
    shown = next
    scaled = true
    lastBaseline = baseline
    lastViewStart = viewStart
    return next
  }

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
    let anchor: TapePoint | null = null
    for (const point of points) {
      if (point.t < viewStart) {
        anchor = point
        continue
      }
      if (anchor) {
        visible.push(anchor)
        anchor = null
      }
      if (point.t > viewEnd) break
      visible.push(point)
    }
    if (anchor) visible.push(anchor)

    const rawBaseline = options.getBaseline()
    const baseline = rawBaseline != null && Number.isFinite(rawBaseline) ? rawBaseline : null
    const lastReal = visible[visible.length - 1] ?? null
    const center = baseline ?? lastReal?.price ?? 0
    const half = easeHalf(halfSpan(visible, center, now), contentHalf(visible, center, now), baseline, viewStart, viewEnd)
    const min = center - half
    const max = center + half
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

    ctx.save()
    ctx.beginPath()
    ctx.rect(PAD.l, PAD.t, plotW, plotH)
    ctx.clip()

    const liveHead = options.extendLive() && !!lastReal && now > lastReal.t && now >= viewStart && now <= viewEnd
    const series = stepped(visible, liveHead && lastReal ? { t: Math.min(now, viewEnd), price: lastReal.price } : null)

    if (!series.length) {
      ctx.fillStyle = "rgba(243,240,232,0.45)"
      ctx.font = "13px ui-sans-serif, system-ui, sans-serif"
      ctx.fillText("Waiting for the price", PAD.l, PAD.t + 18)
    } else {
      const path = series.map((point) => ({ ...point, x: xAt(point.t), y: yAt(point.price) }))
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
    }

    if (options.extendLive() && now >= viewStart && now <= viewEnd) {
      ctx.strokeStyle = "rgba(243,240,232,0.28)"
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(xAt(now), PAD.t)
      ctx.lineTo(xAt(now), PAD.t + plotH)
      ctx.stroke()
    }

    const last = series.length ? series[series.length - 1] : null
    if (last) {
      const market = marketAt(markets, last.t)
      const tone = market?.strike == null ? null : priceTone(last.price, market.strike)
      const color = tone === "push" ? PUSH : tone === "up" ? UP : tone === "down" ? DOWN : NEUTRAL
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.arc(xAt(last.t), yAt(last.price), 3.5, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.restore()

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
      listeners.clear()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getScale() {
      return scale
    },
    sample(t) {
      const index = latestIndex(points, t)
      if (index < 0) return null
      const point = points[index]
      if (!point) return null
      const previous = index > 0 ? (points[index - 1]?.price ?? null) : null
      return { price: point.price, at: point.t, previous }
    },
  }
}

function stepped(points: TapePoint[], head: TapePoint | null): TapePoint[] {
  if (!points.length) return []
  const out: TapePoint[] = []
  for (let i = 0; i < points.length; i++) {
    const point = points[i]
    if (!point) continue
    const previous = out[out.length - 1]
    if (previous && point.price !== previous.price) out.push({ t: point.t, price: previous.price })
    out.push(point)
  }
  const last = out[out.length - 1]
  if (head && last && head.t > last.t) out.push(head)
  return out
}

function latestIndex(points: TapePoint[], t: number): number {
  let lo = 0
  let hi = points.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const point = points[mid]
    if (!point) break
    if (point.t <= t) {
      found = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return found
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
  if (a.t === b.t && a.price === b.price) return
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
  const market = marketAt(markets, a.t === b.t ? a.t : (a.t + b.t) / 2)
  if (!market || market.strike === null) {
    ctx.strokeStyle = NEUTRAL
    trace(ctx, a, b)
    return
  }
  if (priceTone(a.price, market.strike) === "push" && priceTone(b.price, market.strike) === "push") {
    ctx.strokeStyle = PUSH
    ctx.setLineDash([5, 4])
    trace(ctx, a, b)
    ctx.setLineDash([])
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
  if (a.t === b.t) return
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
  if (priceTone(a.price, strike) === "push" && priceTone(b.price, strike) === "push") return
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
