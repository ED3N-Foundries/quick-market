import { formatPrice } from "./format"
import { HALF_FLOOR, contentHalf, halfSpan, openPrice, shownHalf, type PricePoint } from "./scale"

export type TapePoint = PricePoint & { text?: string }

export type ChartStrike = { price: number; text: string }

/** The price the chart is built around. A locked strike is the market open.
 *  Until that open prints, `fallback` is the price the stage stays centered on.
 */
export function priceInUse(strike: number | null, fallback: number | null): number | null {
  if (strike != null && Number.isFinite(strike)) return strike
  if (fallback != null && Number.isFinite(fallback)) return fallback
  return null
}

/** Baseline for one stage. A strike wins. Otherwise the price already printing
 *  when `viewStart` opened, so later prints do not move the hills.
 */
export function stageBaseline(strike: number | null, points: PricePoint[], viewStart: number): number | null {
  return priceInUse(strike, openPrice(points, viewStart))
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
  push(t: number, price: number, text?: string): void
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
const PUSH_EPS = 1e-8

export function priceTone(price: number, baseline: number): "up" | "down" | "push" {
  if (Math.abs(price - baseline) <= PUSH_EPS) return "push"
  return price > baseline ? "up" : "down"
}
const PAD = { l: 12, r: 68, t: 16, b: 22 }
const TAPE_MS = 15 * 60 * 1000

export function mountChart(
  canvas: HTMLCanvasElement,
  options: {
    getNow: () => number
    getView: () => View
    getClock: () => { blockStart: number; blockEnd: number } | null
    getStrike: () => ChartStrike | null
    extendLive: () => boolean
  },
): TapeChart {
  let points: TapePoint[] = []
  let running = true
  let raf = 0
  let scale: ChartScale | null = null
  let shown = HALF_FLOOR
  let scaled = false
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

  function snapHalf(target: number, content: number) {
    const next = shownHalf(shown, target, content, !scaled)
    shown = next
    scaled = true
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
    const series = tapeInView(points, viewStart, viewEnd, now, options.extendLive(), view.follow)
    const strike = options.getStrike()
    const head = series.length ? series[series.length - 1] : null
    const baseline = stageBaseline(strike?.price ?? null, points, viewStart)
    const center = baseline ?? 0
    const half = snapHalf(halfSpan(series, center), contentHalf(series, center))
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

    const path = series.map((point) => ({ ...point, x: xAt(point.t), y: yAt(point.price) }))
    if (!series.length) {
      ctx.fillStyle = "rgba(243,240,232,0.45)"
      ctx.font = "13px ui-sans-serif, system-ui, sans-serif"
      ctx.fillText("Waiting for the price", PAD.l, PAD.t + 18)
    } else if (baseline != null) {
      const baselineY = yAt(baseline)
      for (let i = 1; i < path.length; i++) {
        const a = path[i - 1]
        const b = path[i]
        if (a && b) fillSegment(ctx, a, b, baseline, baselineY)
      }
    }

    if (baseline != null) drawHorizon(ctx, PAD.l, PAD.l + plotW, yAt(baseline), null, PAD.t, plotH)

    if (series.length) {
      ctx.lineWidth = 1.75
      ctx.lineJoin = "round"
      ctx.lineCap = "round"
      ctx.setLineDash([])
      for (let i = 1; i < path.length; i++) {
        const a = path[i - 1]
        const b = path[i]
        if (a && b && baseline != null) strokePair(ctx, a, b, baseline)
        else if (a && b) {
          ctx.strokeStyle = NEUTRAL
          trace(ctx, a, b)
        }
      }
    }

    if (options.extendLive() && now >= viewStart && now <= viewEnd) {
      ctx.strokeStyle = "rgba(243,240,232,0.28)"
      ctx.lineWidth = 1
      ctx.setLineDash([])
      ctx.beginPath()
      ctx.moveTo(xAt(now), PAD.t)
      ctx.lineTo(xAt(now), PAD.t + plotH)
      ctx.stroke()
    }

    const last = series.length ? series[series.length - 1] : null
    if (last) {
      const tone = baseline == null ? null : priceTone(last.price, baseline)
      const color = tone === "push" ? PUSH : tone === "up" ? UP : tone === "down" ? DOWN : NEUTRAL
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.arc(xAt(last.t), yAt(last.price), 3.5, 0, Math.PI * 2)
      ctx.fill()
    }
    if (baseline != null) drawHorizon(ctx, PAD.l, PAD.l + plotW, yAt(baseline), horizonLabel(strike, points, head?.t ?? viewEnd), PAD.t, plotH, true)
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
    push(t, price, text?: string) {
      if (!Number.isFinite(t) || !Number.isFinite(price)) return
      const last = points[points.length - 1]
      if (last && t < last.t) return
      if (last && t === last.t) {
        last.price = price
        if (text) last.text = text
        return
      }
      points.push(text ? { t, price, text } : { t, price })
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

/** Step series for one view. A print from before the window is held at the left edge.
 *  While now is inside the view, the live head runs to now. A follow view that
 *  now has passed holds the last price to the right edge. A view still in the
 *  future is not filled across.
 */
export function tapeInView(
  points: TapePoint[],
  viewStart: number,
  viewEnd: number,
  now: number,
  extendLive: boolean,
  follow: boolean,
): TapePoint[] {
  const visible: TapePoint[] = []
  let anchor: TapePoint | null = null
  for (const point of points) {
    if (point.t < viewStart) {
      anchor = point
      continue
    }
    if (anchor) {
      visible.push({ t: viewStart, price: anchor.price })
      anchor = null
    }
    if (point.t > viewEnd) break
    visible.push(point)
  }
  if (anchor) visible.push({ t: viewStart, price: anchor.price })

  const last = visible[visible.length - 1] ?? null
  let head: TapePoint | null = null
  if (extendLive && last && now > last.t) {
    if (now >= viewStart && now <= viewEnd) head = { t: now, price: last.price }
    else if (follow && now > viewEnd) head = { t: viewEnd, price: last.price }
  }
  return stepped(visible, head)
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

function strokePair(ctx: CanvasRenderingContext2D, a: XY, b: XY, baseline: number) {
  if (a.t === b.t && a.price === b.price) return
  if (priceTone(a.price, baseline) === "push" && priceTone(b.price, baseline) === "push") {
    ctx.strokeStyle = PUSH
    ctx.setLineDash([5, 4])
    trace(ctx, a, b)
    ctx.setLineDash([])
    return
  }
  if ((a.price - baseline) * (b.price - baseline) < 0) {
    const ratio = (baseline - a.price) / (b.price - a.price)
    const mid: XY = {
      t: a.t + (b.t - a.t) * ratio,
      price: baseline,
      x: a.x + (b.x - a.x) * ratio,
      y: a.y + (b.y - a.y) * ratio,
    }
    strokePair(ctx, a, mid, baseline)
    strokePair(ctx, mid, b, baseline)
    return
  }
  ctx.setLineDash([])
  ctx.strokeStyle = a.price >= baseline && b.price >= baseline ? UP : DOWN
  trace(ctx, a, b)
}

function trace(ctx: CanvasRenderingContext2D, a: XY, b: XY) {
  ctx.beginPath()
  ctx.moveTo(a.x, a.y)
  ctx.lineTo(b.x, b.y)
  ctx.stroke()
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

function latestText(points: TapePoint[], at: number): string | null {
  let carried: string | null = null
  for (const point of points) {
    if (!Number.isFinite(point.t) || !Number.isFinite(point.price)) continue
    if (point.t > at) break
    if (point.text) carried = point.text
  }
  return carried
}

function horizonLabel(strike: ChartStrike | null, points: TapePoint[], at: number): string | null {
  const text = strike?.text ?? latestText(points, at)
  if (!text || !/^\d+(\.\d+)?$/.test(text.trim())) return null
  return formatPrice(text)
}

function drawHorizon(
  ctx: CanvasRenderingContext2D,
  x0: number,
  x1: number,
  y: number,
  label: string | null,
  plotTop: number,
  plotH: number,
  labelOnly = false,
) {
  ctx.save()
  if (!labelOnly) {
    ctx.strokeStyle = "rgba(243,240,232,0.85)"
    ctx.lineWidth = 1
    ctx.setLineDash([])
    ctx.beginPath()
    ctx.moveTo(x0, y)
    ctx.lineTo(x1, y)
    ctx.stroke()
  }
  if (label) {
    ctx.font = "11px ui-sans-serif, system-ui, sans-serif"
    ctx.textAlign = "left"
    ctx.textBaseline = "middle"
    const padX = 5
    const boxW = ctx.measureText(label).width + padX * 2
    const boxH = 16
    const left = x0 + 8
    const top = Math.min(plotTop + plotH - boxH - 2, Math.max(plotTop + 2, y - boxH / 2))
    ctx.fillStyle = "rgba(9,10,12,0.88)"
    roundRect(ctx, left, top, boxW, boxH, 4)
    ctx.fill()
    ctx.fillStyle = "rgba(243,240,232,0.95)"
    ctx.fillText(label, left + padX, top + boxH / 2)
  }
  ctx.restore()
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

function clockLabel(ms: number) {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })
}
