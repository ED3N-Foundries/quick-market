const WINDOW_MS = 2_000
const SNAP_MS = 100
const FORWARD_PER_SEC = 100
const BACK_PER_SEC = 20

export type Clock = {
  samples: { at: number; raw: number }[]
  offset: number
  synced: boolean
  readAt: number
}

export function createClock(): Clock {
  return { samples: [], offset: 0, synced: false, readAt: 0 }
}

/** `raw` is `serverNow - arrival`. The highest raw in the window had the smallest delay. */
function targetOf(samples: { raw: number }[]): number {
  let best = Number.NEGATIVE_INFINITY
  for (const sample of samples) if (sample.raw > best) best = sample.raw
  return best
}

function moveOffset(clock: Clock, target: number, at: number): Clock {
  const dt = Math.max(0, at - clock.readAt)
  let offset = clock.offset
  if (target > offset) {
    const jump = target - offset
    if (jump <= SNAP_MS) offset = target
    else offset = Math.min(target, offset + (FORWARD_PER_SEC * dt) / 1000)
  } else if (target < offset) {
    offset = Math.max(target, offset - (BACK_PER_SEC * dt) / 1000)
  }
  return { ...clock, offset, readAt: at }
}

export function noteClock(clock: Clock, serverNow: number, arrival: number): Clock {
  const raw = serverNow - arrival
  const samples = clock.samples.filter((sample) => arrival - sample.at <= WINDOW_MS)
  // A gap longer than the sample window means the old offset is stale. Snap,
  // the same way the first sample snaps, so sleep and reconnect agree at once.
  const snap = !clock.synced || samples.length === 0
  samples.push({ at: arrival, raw })
  const target = targetOf(samples)
  if (snap) return { samples, offset: target, synced: true, readAt: arrival }
  return moveOffset({ ...clock, samples }, target, arrival)
}

/** Floor to tenths. A finite span paints at most one tenth under its length,
 *  so a 10s buy-in reads 9.9 down to 0.0 and never rounds up to 10.0.
 *  An infinite span only floors, which keeps a real settles countdown. */
export function clockReadout(leftMs: number, spanMs: number): string {
  const left = Number.isFinite(leftMs) ? Math.max(0, leftMs) : 0
  const cap = Number.isFinite(spanMs) && spanMs > 0 ? Math.max(0, spanMs - 100) : Number.POSITIVE_INFINITY
  const shown = Math.min(left, cap)
  const tenths = Math.floor(shown / 100)
  return `${Math.floor(tenths / 10)}.${tenths % 10}`
}

/** Ease toward the best sample still in the window. A late packet does not move time backward. */
export function easeClock(clock: Clock, clientNow: number): Clock {
  if (!clock.synced) return clock
  const samples = clock.samples.filter((sample) => clientNow - sample.at <= WINDOW_MS)
  if (!samples.length) return { ...clock, samples, readAt: clientNow }
  return moveOffset({ ...clock, samples }, targetOf(samples), clientNow)
}
