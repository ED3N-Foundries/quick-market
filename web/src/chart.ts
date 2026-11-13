import { RENDER_MS } from "../../shared/market"
import { formatClock, formatPrice } from "./format"
import { HALF_FLOOR, contentHalf, halfSpan, openPrice, shownHalf, type PricePoint } from "./scale"

export type TapePoint = PricePoint & { text?: string }

export type ChartStrike = { price: number; text: string; peg?: boolean; at?: number; openAt?: number }

/** The price the chart is built around. A locked strike is the market open.
 *  Until that open prints, `fallback` is the price the stage stays centered on.
 */
export function priceInUse(strike: number | null, fallback: number | null): number | null {
  if (strike != null && Number.isFinite(strike)) return strike
  if (fallback != null && Number.isFinite(fallback)) return fallback
  return null
}

export type ScaleFrame = {
  center: number | null
  /** Ink for prints before the strike. Null once the view starts at the strike. */
  before: number | null
  /** Ink for prints at or after the strike. Null until a strike exists. */
  after: number | null
}

/** Vertical frame for one view.
 *  With no strike, the center is the print already in force at `viewStart`.
 *  With a strike, the center is the strike immediately. Prints before `strike.at`
 *  keep the open pin as their ink, so that tape does not flip when the window closes.
 */
export function scaleFrame(
  strike: { price: number; at: number; openAt: number } | null,
  points: PricePoint[],
  viewStart: number,
): ScaleFrame {
  if (!strike || !Number.isFinite(strike.price)) {
    const open = openPrice(points, viewStart)
    return { center: open, before: open, after: null }
  }
  if (viewStart >= strike.at) return { center: strike.price, before: null, after: strike.price }
  const pin = openPrice(points, strike.openAt)
  if (pin == null) return { center: strike.price, before: null, after: strike.price }
  return { center: strike.price, before: pin, after: strike.price }
}

/** Prints that set a pegged ride's zoom. The strike is included so a flat ride
 *  stays on the floor. Prints at or before the strike, including a step corner
 *  that repeats the old price at `at`, do not count.
 */
export function ridePoints(series: PricePoint[], at: number, strikePrice: number): PricePoint[] {
  const ride: PricePoint[] = []
  for (const point of series) {
    if (point.t > at && Number.isFinite(point.price)) ride.push(point)
  }
  ride.push({ t: at, price: strikePrice })
  return ride
}

/** Point where a segment crosses `at`. Null when `at` is not strictly inside it. */
export function crossTime(
  a: { t: number; price: number },
  b: { t: number; price: number },
  at: number,
): { t: number; price: number } | null {
  if (!(a.t < at && b.t > at)) return null
  const ratio = (at - a.t) / (b.t - a.t)
  if (!Number.isFinite(ratio)) return null
  return { t: at, price: a.price + (b.price - a.price) * ratio }
}

/** Baseline for one piece. A piece that starts at the strike uses the strike. */
export function pieceBaseline(
  t0: number,
  t1: number,
  at: number | null,
  before: number | null,
  after: number | null,
): number | null {
  if (after == null) return before
  if (at == null || t0 >= at) return after
  if (t1 <= at) return before
  return before
}

/** Canvas Y for a price. A higher price is a smaller Y. */
export function priceY(
  price: number,
  scale: { yMin: number; yMax: number; plotTop: number; plotHeight: number },
): number {
  const span = scale.yMax - scale.yMin
  if (!(span > 0)) return scale.plotTop + scale.plotHeight / 2
  return scale.plotTop + ((scale.yMax - price) / span) * scale.plotHeight
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
  /** Live head, when the series has one. Null until a print is on screen. */
  head: { price: number; y: number } | null
}

export type TapeSample = { price: number; at: number; previous: number | null }

export type TapeChart = {
  reset(points: TapePoint[]): void
  merge(points: TapePoint[]): void
  needsBefore(t: number): boolean
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
const GOLD = "#e2b340"
const UP_FILL = "rgba(47, 206, 134, 0.22)"
const DOWN_FILL = "rgba(255, 90, 79, 0.2)"
const NEUTRAL = "rgba(243,240,232,0.7)"
const PUSH_EPS = 1e-8
const PULSE_MS = 1200
const WASH_FAINT = 0.05
const WASH_STRONG = 0.14

export function priceTone(price: number, baseline: number): "up" | "down" | "push" {
  if (Math.abs(price - baseline) <= PUSH_EPS) return "push"
  return price > baseline ? "up" : "down"
}

/** True when `price` is strictly on `side` of the strike. A push is not in the money. */
export function inTheMoney(side: "up" | "down", price: number, strike: number): boolean {
  return priceTone(price, strike) === side
}

/** Dashed level from the live head to the buy-in edge. A pegged ride, a paused
 *  feed, a scrub, and the last quarter-second before the edge do not get one.
 */
export function showLockLevel(input: {
  follow: boolean
  live: boolean
  pegged: boolean
  headTime: number
  viewEnd: number
}): boolean {
  return input.follow && input.live && !input.pegged && input.viewEnd - input.headTime > 250
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
    getAim?: () => "up" | "down" | null
    extendLive: () => boolean
    onHead?: (text: string | null) => void
    getLocale?: () => string
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

  const motion = window.matchMedia("(prefers-reduced-motion: reduce)")
  let reducedMotion = motion.matches
  const onMotion = () => {
    reducedMotion = motion.matches
  }
  motion.addEventListener("change", onMotion)

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
    const live = options.extendLive()
    const series = live
      ? glideSeries(points, viewStart, viewEnd, now, RENDER_MS, view.follow)
      : tapeInView(points, viewStart, viewEnd, now, false, view.follow)
    if (live && options.onHead) {
      const shown = glideHead(points, now - RENDER_MS)
      options.onHead(shown ? (shown.text ?? shown.price.toFixed(4)) : null)
    }
    const strike = options.getStrike()
    const aim = options.getAim?.() ?? null
    const timed =
      strike && Number.isFinite(strike.price) && Number.isFinite(strike.at) && Number.isFinite(strike.openAt)
        ? { price: strike.price, at: strike.at as number, openAt: strike.openAt as number }
        : null
    let frame = scaleFrame(timed, points, viewStart)
    let frameAt: number | null = timed?.at ?? null
    if (strike && Number.isFinite(strike.price) && !timed) {
      frame = { center: strike.price, before: null, after: strike.price }
      frameAt = null
    }
    const head = series.length ? series[series.length - 1] : null
    const center = frame.center ?? frame.after ?? 0
    const zoom = strike?.peg && frame.after != null && frameAt != null ? ridePoints(series, frameAt, frame.after) : series
    const half = snapHalf(halfSpan(zoom, center), contentHalf(zoom, center))
    const min = center - half
    const max = center + half
    const yAt = (price: number) => priceY(price, { yMin: min, yMax: max, plotTop: PAD.t, plotHeight: plotH })
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
      head: head ? { price: head.price, y: yAt(head.price) } : null,
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
    const plotRight = PAD.l + plotW
    const horizons = horizonSpans(frame, frameAt, viewStart, viewEnd, PAD.l, plotRight, xAt)
    const washPrice = aim ? (strike && Number.isFinite(strike.price) ? strike.price : frame.before) : null
    if (washPrice != null) {
      const y = yAt(washPrice)
      const top = aim === "up" ? PAD.t : y
      const heightOf = (aim === "up" ? y : PAD.t + plotH) - top
      if (heightOf > 0) {
        const phase = pulsePhase(performance.now(), reducedMotion)
        const alpha = reducedMotion ? (WASH_FAINT + WASH_STRONG) / 2 : WASH_FAINT + (WASH_STRONG - WASH_FAINT) * phase
        ctx.fillStyle = `rgba(143, 138, 128, ${alpha})`
        ctx.fillRect(PAD.l, top, plotW, heightOf)
      }
    }
    const pieces = inkPieces(path, frame, frameAt)
    if (!series.length) {
      ctx.fillStyle = "rgba(243,240,232,0.45)"
      ctx.font = "13px ui-sans-serif, system-ui, sans-serif"
      ctx.fillText("Waiting for the price", PAD.l, PAD.t + 18)
    } else {
      for (const piece of pieces) {
        if (piece.baseline == null) continue
        fillSegment(ctx, piece.a, piece.b, piece.baseline, yAt(piece.baseline))
      }
    }

    for (const horizon of horizons) drawHorizon(ctx, horizon.x0, horizon.x1, yAt(horizon.price), null, PAD.t, plotH)

    if (pieces.length) {
      ctx.lineWidth = 1.75
      ctx.lineJoin = "round"
      ctx.lineCap = "round"
      ctx.setLineDash([])
      for (const piece of pieces) {
        if (piece.baseline == null) {
          ctx.strokeStyle = NEUTRAL
          trace(ctx, piece.a, piece.b)
        } else strokePair(ctx, piece.a, piece.b, piece.baseline)
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

    if (
      head &&
      showLockLevel({
        follow: view.follow,
        live,
        pegged: !!strike?.peg,
        headTime: head.t,
        viewEnd,
      })
    ) {
      const y = yAt(head.price)
      const x = xAt(head.t)
      ctx.strokeStyle = "rgba(243,240,232,0.45)"
      ctx.lineWidth = 1
      ctx.setLineDash([2, 3])
      ctx.beginPath()
      ctx.moveTo(x, y)
      ctx.lineTo(plotRight, y)
      ctx.stroke()
      ctx.setLineDash([])
      ctx.beginPath()
      ctx.moveTo(plotRight - 1, y - 5)
      ctx.lineTo(plotRight - 1, y + 5)
      ctx.stroke()
    }

    const last = series.length ? series[series.length - 1] : null
    if (last) {
      const x = xAt(last.t)
      const y = yAt(last.price)
      const gold = !!aim && !!strike && Number.isFinite(strike.price) && inTheMoney(aim, last.price, strike.price)
      if (gold) {
        const phase = pulsePhase(performance.now(), reducedMotion)
        ctx.fillStyle = `rgba(226, 179, 64, ${reducedMotion ? 0.35 : 0.18 + 0.45 * phase})`
        ctx.beginPath()
        ctx.arc(x, y, reducedMotion ? 7 : 6 + 3 * phase, 0, Math.PI * 2)
        ctx.fill()
        ctx.fillStyle = GOLD
      } else {
        const headBaseline = pieceBaseline(last.t, last.t, frameAt, frame.before, frame.after)
        const tone = headBaseline == null ? null : priceTone(last.price, headBaseline)
        ctx.fillStyle = tone === "push" ? PUSH : tone === "up" ? UP : tone === "down" ? DOWN : NEUTRAL
      }
      ctx.beginPath()
      ctx.arc(x, y, 3.5, 0, Math.PI * 2)
      ctx.fill()
    }
    const captionAt = head?.t ?? viewEnd
    for (const horizon of horizons) {
      const label = horizon.ride ? strikeCaption(strike, points, captionAt) : strike ? null : strikeCaption(null, points, captionAt)
      if (label) drawHorizon(ctx, horizon.x0, horizon.x1, yAt(horizon.price), label, PAD.t, plotH, true)
    }
    ctx.restore()

    ctx.fillStyle = "rgba(243,240,232,0.45)"
    ctx.font = "11px ui-sans-serif, system-ui, sans-serif"
    ctx.textAlign = "left"
    const locale = options.getLocale?.()
    ctx.fillText(clockLabel(viewStart, locale), PAD.l, height - 6)
    ctx.textAlign = "right"
    ctx.fillText(clockLabel(viewEnd, locale), PAD.l + plotW, height - 6)
  }

  return {
    reset(next) {
      points = next.filter((point) => Number.isFinite(point.t) && Number.isFinite(point.price))
    },
    merge(next) {
      const byTime = new Map<number, TapePoint>()
      for (const point of points) byTime.set(point.t, point)
      for (const point of next) {
        if (Number.isFinite(point.t) && Number.isFinite(point.price)) byTime.set(point.t, point)
      }
      points = [...byTime.values()].sort((left, right) => left.t - right.t)
      const latest = points[points.length - 1]?.t ?? 0
      const cutoff = latest - TAPE_MS
      const first = points.findIndex((point) => point.t >= cutoff)
      if (first > 0) points = points.slice(first)
      if (points.length > 20_000) points = points.slice(points.length - 20_000)
    },
    needsBefore(t) {
      return points.length === 0 || points[0]!.t > t + 1_000
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
      motion.removeEventListener("change", onMotion)
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

/** Price at `t`. A time between two samples is the straight blend. Past the last sample, hold it.
 *  A time before the first sample has no price.
 */
export function glideAt(points: { t: number; price: number }[], t: number): number | null {
  let prev: { t: number; price: number } | null = null
  for (const point of points) {
    if (point.t === t) return point.price
    if (point.t > t) {
      if (!prev || !(point.t > prev.t)) return prev ? prev.price : null
      const span = point.t - prev.t
      return prev.price + ((t - prev.t) / span) * (point.price - prev.price)
    }
    prev = point
  }
  return prev ? prev.price : null
}

/** The price drawn at `renderTime`. `text` is set only when that instant sits on a stored print. */
export function glideHead(points: TapePoint[], renderTime: number): { price: number; text: string | null } | null {
  let prev: TapePoint | null = null
  for (const point of points) {
    if (point.t === renderTime) return { price: point.price, text: point.text ?? null }
    if (point.t > renderTime) {
      if (!prev || !(point.t > prev.t)) return null
      const span = point.t - prev.t
      return {
        price: prev.price + ((renderTime - prev.t) / span) * (point.price - prev.price),
        text: null,
      }
    }
    prev = point
  }
  if (!prev) return null
  return { price: prev.price, text: prev.text ?? null }
}

/** Straight live path. Samples newer than `now - delay` stay buffered.
 *  Released prints stay at their real times. One live vertex sits on the clock,
 *  at the blended price, so the dot and the time line are the same place.
 *  There is no second vertex at the delayed instant. A head still left of the view
 *  runs from the left edge to the clock. A head already past the view holds to the
 *  right edge. The line does not run a slope past the last sample.
 */
export function glideSeries(
  points: TapePoint[],
  viewStart: number,
  viewEnd: number,
  now: number,
  delay: number,
  follow: boolean,
): TapePoint[] {
  if (!points.length || !(viewEnd > viewStart)) return []
  const renderTime = now - Math.max(0, delay)
  const out: TapePoint[] = []
  if (renderTime < viewStart) {
    const held = glideAt(points, renderTime)
    if (held == null) return []
    out.push({ t: viewStart, price: held })
  } else {
    const limit = Math.min(viewEnd, renderTime)
    let started = false
    for (const point of points) {
      if (point.t < viewStart) continue
      if (point.t > limit) break
      if (!started && point.t > viewStart) {
        const left = glideAt(points, viewStart)
        if (left != null) out.push({ t: viewStart, price: left })
      }
      started = true
      out.push(point)
    }
    if (!started) {
      const left = glideAt(points, viewStart)
      if (left != null) out.push({ t: viewStart, price: left })
    }
  }
  const edge = now >= viewStart && now <= viewEnd ? now : follow && now > viewEnd ? viewEnd : null
  const last = out[out.length - 1]
  if (edge != null && last && edge > last.t) {
    const price = edge <= renderTime ? last.price : glideAt(points, renderTime)
    if (price != null) out.push({ t: edge, price })
  }
  return out
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

function pulsePhase(now: number, reduced: boolean): number {
  if (reduced) return 0.5
  return (Math.sin((now / PULSE_MS) * Math.PI * 2) + 1) / 2
}

function horizonSpans(
  frame: ScaleFrame,
  at: number | null,
  viewStart: number,
  viewEnd: number,
  plotLeft: number,
  plotRight: number,
  xAt: (t: number) => number,
): { x0: number; x1: number; price: number; ride: boolean }[] {
  const spans: { x0: number; x1: number; price: number; ride: boolean }[] = []
  if (frame.before != null && (at == null || at > viewStart)) {
    const x1 = at == null || at >= viewEnd ? plotRight : Math.min(plotRight, Math.max(plotLeft, xAt(at)))
    if (x1 > plotLeft) spans.push({ x0: plotLeft, x1, price: frame.before, ride: false })
  }
  if (frame.after != null && (at == null || at < viewEnd)) {
    const x0 = at == null || at <= viewStart ? plotLeft : Math.min(plotRight, Math.max(plotLeft, xAt(at)))
    if (plotRight > x0) spans.push({ x0, x1: plotRight, price: frame.after, ride: true })
  }
  return spans
}

function inkPieces(
  path: XY[],
  frame: ScaleFrame,
  at: number | null,
): { a: XY; b: XY; baseline: number | null }[] {
  const pieces: { a: XY; b: XY; baseline: number | null }[] = []
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]
    const b = path[i]
    if (!a || !b) continue
    if (at != null && frame.before != null && frame.after != null) {
      const mid = crossTime(a, b, at)
      if (mid) {
        const ratio = (at - a.t) / (b.t - a.t)
        const split: XY = {
          ...a,
          t: mid.t,
          price: mid.price,
          x: a.x + (b.x - a.x) * ratio,
          y: a.y + (b.y - a.y) * ratio,
        }
        pieces.push({ a, b: split, baseline: pieceBaseline(a.t, split.t, at, frame.before, frame.after) })
        pieces.push({ a: split, b, baseline: pieceBaseline(split.t, b.t, at, frame.before, frame.after) })
        continue
      }
    }
    pieces.push({ a, b, baseline: pieceBaseline(a.t, b.t, at, frame.before, frame.after) })
  }
  return pieces
}

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

/** Left-edge caption. A pegged strike is labeled on the right instead, so this stays empty. */
export function strikeCaption(strike: ChartStrike | null, points: TapePoint[], at: number): string | null {
  if (strike?.peg) return null
  return horizonLabel(strike, points, at)
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

function clockLabel(ms: number, locale?: string) {
  return formatClock(ms, locale)
}
