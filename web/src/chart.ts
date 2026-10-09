export type TapePoint = { t: number; price: number }

export type TapeChart = {
  reset(points: TapePoint[]): void
  push(t: number, price: number): void
  setRound(start: number, end: number, strike: number | null): void
  destroy(): void
}

const UP = "#2fce86"
const DOWN = "#ff5a4f"
const UP_FILL = "rgba(47, 206, 134, 0.22)"
const DOWN_FILL = "rgba(255, 90, 79, 0.2)"
const NEUTRAL = "rgba(243, 240, 232, 0.7)"
const STRIKE = "rgba(243, 240, 232, 0.9)"

type XY = TapePoint & { x: number; y: number }

export function mountChart(canvas: HTMLCanvasElement, getNow: () => number): TapeChart {
  let points: TapePoint[] = []
  let start = 0
  let end = 0
  let strike: number | null = null
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

    const pad = { l: 12, r: 78, t: 18, b: 26 }
    const plotW = Math.max(1, width - pad.l - pad.r)
    const plotH = Math.max(1, height - pad.t - pad.b)
    const now = getNow()
    const viewStart = start > 0 ? start - 1500 : now - 10_000
    const viewEnd = end > start ? end : now + 1000
    const span = Math.max(1, viewEnd - viewStart)
    const xAt = (t: number) => pad.l + ((t - viewStart) / span) * plotW

    ctx.fillStyle = "rgba(255,255,255,0.025)"
    if (start > 0) ctx.fillRect(xAt(viewStart), pad.t, Math.max(0, xAt(start) - xAt(viewStart)), plotH)

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

    if (!visible.length) {
      ctx.fillStyle = "rgba(243,240,232,0.45)"
      ctx.font = "13px ui-sans-serif, system-ui, sans-serif"
      ctx.fillText("Waiting for the price", pad.l, pad.t + 18)
      return
    }

    let min = Infinity
    let max = -Infinity
    for (const point of visible) {
      min = Math.min(min, point.price)
      max = Math.max(max, point.price)
    }
    if (strike !== null) {
      min = Math.min(min, strike)
      max = Math.max(max, strike)
    }
    const mid = (min + max) / 2
    const floorSpan = Math.max(Math.abs(mid) * 0.00012, 8)
    const priceSpan = Math.max(max - min, floorSpan)
    min = mid - priceSpan / 2
    max = mid + priceSpan / 2
    const yPad = priceSpan * 0.16
    min -= yPad
    max += yPad
    const yAt = (price: number) => pad.t + ((max - price) / (max - min)) * plotH

    const path: XY[] = visible.map((point) => ({ ...point, x: xAt(point.t), y: yAt(point.price) }))
    const strikeY = strike === null ? null : yAt(strike)

    if (strike !== null && strikeY !== null && start > 0) {
      ctx.save()
      ctx.beginPath()
      ctx.rect(xAt(start), pad.t, Math.max(0, xAt(Math.min(end, viewEnd)) - xAt(start)), plotH)
      ctx.clip()
      for (let i = 1; i < path.length; i++) {
        const a = path[i - 1]
        const b = path[i]
        if (!a || !b) continue
        fillSegment(ctx, a, b, strike, strikeY)
      }
      ctx.restore()

      ctx.save()
      ctx.setLineDash([4, 5])
      ctx.strokeStyle = STRIKE
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(pad.l, strikeY)
      ctx.lineTo(pad.l + plotW, strikeY)
      ctx.stroke()
      ctx.restore()

      ctx.fillStyle = "rgba(243,240,232,0.72)"
      ctx.font = "12px ui-sans-serif, system-ui, sans-serif"
      ctx.textAlign = "left"
      ctx.fillText("Open", pad.l + 6, strikeY - 6)
    }

    ctx.lineWidth = 1.75
    ctx.lineJoin = "round"
    ctx.lineCap = "round"
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1]
      const b = path[i]
      if (!a || !b) continue
      strokeSegment(ctx, a, b, start, end, strike, strikeY)
    }

    const last = path[path.length - 1]
    if (last) {
      const color = strike === null ? NEUTRAL : last.price >= strike ? UP : DOWN
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.arc(last.x, last.y, 3.5, 0, Math.PI * 2)
      ctx.fill()
      ctx.font = "12px ui-monospace, ui-sans-serif, monospace"
      ctx.textAlign = "left"
      ctx.fillText(last.price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }), pad.l + plotW + 8, last.y + 4)
    }

    if (now >= viewStart && now <= viewEnd) {
      ctx.strokeStyle = "rgba(243,240,232,0.28)"
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(xAt(now), pad.t)
      ctx.lineTo(xAt(now), pad.t + plotH)
      ctx.stroke()
    }

    ctx.fillStyle = "rgba(243,240,232,0.45)"
    ctx.font = "11px ui-sans-serif, system-ui, sans-serif"
    ctx.textAlign = "left"
    if (start > 0) {
      ctx.fillText(clock(start), xAt(start), height - 8)
      ctx.textAlign = "right"
      ctx.fillText(clock(end), xAt(end), height - 8)
    }
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
      const cutoff = t - 60_000
      if (points.length > 4000 || (points[0] && points[0].t < cutoff)) {
        const index = points.findIndex((point) => point.t >= cutoff)
        if (index > 0) points.splice(0, index)
      }
    },
    setRound(nextStart, nextEnd, nextStrike) {
      start = nextStart
      end = nextEnd
      strike = nextStrike
    },
    destroy() {
      running = false
      cancelAnimationFrame(raf)
      observer.disconnect()
    },
  }
}

function strokeSegment(
  ctx: CanvasRenderingContext2D,
  a: XY,
  b: XY,
  start: number,
  end: number,
  strike: number | null,
  strikeY: number | null,
) {
  const atStart = splitAt(a, b, start)
  if (atStart) {
    strokeSegment(ctx, a, atStart, start, end, strike, strikeY)
    strokeSegment(ctx, atStart, b, start, end, strike, strikeY)
    return
  }
  const inRound = start > 0 && a.t >= start && b.t <= end + 1
  if (!inRound || strike === null || strikeY === null) {
    ctx.strokeStyle = NEUTRAL
    trace(ctx, a, b)
    return
  }
  if ((a.price - strike) * (b.price - strike) < 0) {
    const ratio = (strike - a.price) / (b.price - a.price)
    const mid: XY = {
      t: a.t + (b.t - a.t) * ratio,
      price: strike,
      x: a.x + (b.x - a.x) * ratio,
      y: strikeY,
    }
    strokeSegment(ctx, a, mid, start, end, strike, strikeY)
    strokeSegment(ctx, mid, b, start, end, strike, strikeY)
    return
  }
  ctx.strokeStyle = a.price >= strike && b.price >= strike ? UP : DOWN
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
  const crosses = (a.price - strike) * (b.price - strike) < 0
  if (crosses) {
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

function clock(ms: number) {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })
}
