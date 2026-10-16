import { clamp, lerp } from "math"
import { mulberry32, type Mulberry32 } from "math/random"
import { easing } from "math/time"
import { USDC, type PersonaConfig, type StakeConfig } from "./config"
import type { Persona } from "./persona"
import { shapeStake } from "./stake"

export type Side = "up" | "down"
export type SkipReason = "waiting" | "refractory" | "flat" | "no edge"

export type PrintPoint = {
  t: number
  price: number
}

export type GateState = {
  readyWindow: number
  burstLeft: number
  refractory: boolean
  results: boolean[]
  edgeNudge: number
  tempoNudge: number
  bias: number
  rngA: number
}

export type WalletMind = {
  index: number
  address: string
  persona: Persona
  bankroll: number
  gate: GateState
  paused: boolean
}

export type Order = {
  address: string
  side: Side
  stakeMicros: number
  pUp: number
}

export type Skip = {
  address: string
  reason: SkipReason
}

export function freshGate(index: number, windowId: number, persona: Persona, config: PersonaConfig): GateState {
  const rng = mulberry32.create(Math.imul(index + 1, 0x27d4eb2d) >>> 0)
  const gap = drawGap(persona, 1, rng, config)
  return {
    readyWindow: windowId + gap,
    burstLeft: 0,
    refractory: false,
    results: [],
    edgeNudge: 0,
    tempoNudge: 0,
    bias: 0,
    rngA: rng.a,
  }
}

function drawGap(persona: Persona, scale: number, rng: Mulberry32, _config: PersonaConfig): number {
  const tempo = Math.max(1, persona.tempoWindows)
  const drawn = lerp(tempo * 2.4, Math.max(1, tempo * 0.55), easing.expoOut(mulberry32.sample(rng)))
  return clamp(Math.round(drawn * scale), 1, 96)
}

export function tapeActivity(points: readonly PrintPoint[], now: number, lookbackMs: number): { ret: number; vol: number; activity: number } {
  const from = now - lookbackMs
  const window = points.filter((point) => point.t >= from && point.t <= now)
  if (window.length < 2) return { ret: 0, vol: 0, activity: 0 }
  const first = window[0]!.price
  const last = window[window.length - 1]!.price
  const ret = first === 0 ? 0 : (last - first) / first
  let vol = 0
  for (let i = 1; i < window.length; i++) {
    const prev = window[i - 1]!.price
    if (prev !== 0) vol += Math.abs(window[i]!.price - prev) / prev
  }
  vol /= window.length - 1
  const activity = Math.abs(ret) / (Math.abs(ret) + Math.max(vol, 1e-6))
  return { ret, vol, activity }
}

function regime(activity: number, config: PersonaConfig): "moving" | "flat" | "calm" {
  if (activity >= config.movingBand) return "moving"
  if (activity <= config.flatBand) return "flat"
  return "calm"
}

function sigmoid(value: number): number {
  if (value > 30) return 1
  if (value < -30) return 0
  return 1 / (1 + Math.exp(-value))
}

function belief(persona: Persona, points: readonly PrintPoint[], now: number, rng: Mulberry32, _config: PersonaConfig): number {
  const noise = (mulberry32.sample(rng) - 0.5) * persona.noise
  if (persona.mind === "restless") return clamp(0.5 + noise, 0.02, 0.98)
  if (persona.mind === "price") {
    const slow = tapeActivity(points, now, persona.slowLookbackMs)
    const slowSignal = slow.vol > 0 ? clamp((slow.ret / Math.max(slow.vol, 1e-6)) * slow.activity * 0.015, -0.06, 0.06) : 0
    return clamp(0.5 + slowSignal + noise * 0.15, 0.05, 0.95)
  }
  const move = tapeActivity(points, now, persona.lookbackMs)
  const vol = Math.max(move.vol, 1e-6)
  const sign = persona.mind === "fade" ? -1 : 1
  const signal = clamp((move.ret / vol) * move.activity, -8, 8)
  const z = sign * Math.abs(persona.momentum) * signal * 0.6 + noise
  return clamp(sigmoid(z), 0.02, 0.98)
}

export type MindDecision =
  | { action: "bet"; side: Side; stakeMicros: number; pUp: number; gate: GateState }
  | { action: "skip"; reason: SkipReason; pUp: number; gate: GateState }

type Ungated = Omit<Extract<MindDecision, { action: "bet" }>, "gate"> | Omit<Extract<MindDecision, { action: "skip" }>, "gate">

export function decideWallet(input: {
  wallet: WalletMind
  windowId: number
  now: number
  windowMs: number
  points: readonly PrintPoint[]
  poolUp: number
  poolDown: number
  config: PersonaConfig
  stake: StakeConfig
}): MindDecision {
  const persona = input.wallet.persona
  const gate: GateState = {
    ...input.wallet.gate,
    results: input.wallet.gate.results.slice(-input.config.memory),
  }
  const rng = { a: gate.rngA }
  const finish = (decision: Ungated): MindDecision => {
    gate.rngA = rng.a
    return { ...decision, gate } as MindDecision
  }
  if (input.wallet.paused || input.wallet.bankroll < USDC) {
    return finish({ action: "skip", reason: "waiting", pUp: 0.5 })
  }

  const look = tapeActivity(input.points, input.now, Math.max(persona.lookbackMs, input.windowMs * 4))
  const state = regime(look.activity, input.config)
  let scale = 1
  if (state === "moving") scale = input.config.hotScale
  if (state === "flat") scale = input.config.flatScale
  scale = clamp(scale * (1 + gate.tempoNudge), input.config.scaleMin, input.config.scaleMax)

  const due = input.windowId >= gate.readyWindow
  const inBurst = gate.burstLeft > 0
  if (gate.refractory && !due && !inBurst) return finish({ action: "skip", reason: "refractory", pUp: 0.5 })
  if (inBurst) {
    const fire = mulberry32.sample(rng) < input.config.burstFire
    gate.burstLeft -= 1
    if (!fire) {
      if (gate.burstLeft === 0) armRefractory(gate, persona, scale, rng, input.config, input.windowId)
      return finish({ action: "skip", reason: "waiting", pUp: 0.5 })
    }
  } else if (!due) {
    return finish({ action: "skip", reason: gate.refractory ? "refractory" : "waiting", pUp: 0.5 })
  } else if (mulberry32.sample(rng) > input.config.gateFire) {
    gate.readyWindow = input.windowId + 1
    return finish({ action: "skip", reason: "waiting", pUp: 0.5 })
  }

  let pUp = belief(persona, input.points, input.now, rng, input.config)
  if (persona.second && persona.secondWeight > 0) {
    const other = belief({ ...persona, mind: persona.second, noise: persona.noise * 0.4 }, input.points, input.now, rng, input.config)
    pUp = lerp(pUp, other, persona.secondWeight)
  }
  pUp = clamp(pUp + gate.bias, 0.02, 0.98)
  const implied = input.poolUp + input.poolDown === 0 ? 0.5 : input.poolUp / (input.poolUp + input.poolDown)
  const poolLean = Math.abs(implied - 0.5)
  if (Math.abs(pUp - 0.5) < input.config.herdBand && poolLean >= input.config.herdBand) {
    const lean = implied > 0.5 ? 1 : 0
    pUp = lerp(pUp, lean, input.config.herdWeight)
  }
  if (state === "flat" && (persona.mind === "tape" || persona.mind === "fade") && Math.abs(pUp - 0.5) < 0.08) {
    armQuiet(gate, persona, scale, rng, input.config, input.windowId)
    return finish({ action: "skip", reason: "flat", pUp })
  }

  const edge = input.config.memoryStep === 0 ? persona.edge : persona.edge + gate.edgeNudge
  let side: Side | null = null
  if (pUp > implied + edge) side = "up"
  else if (pUp < implied - edge) side = "down"
  if (!side) {
    armQuiet(gate, persona, scale, rng, input.config, input.windowId)
    return finish({ action: "skip", reason: "no edge", pUp })
  }
  const price = side === "up" ? implied : 1 - implied
  const prob = side === "up" ? pUp : 1 - pUp
  const advantage = prob - price
  const odds = (1 - price) / Math.max(price, 0.05)
  const fraction = clamp(advantage / Math.max(odds, 0.05), 0, 1)
  const smallFloor = Math.min(input.stake.smallMax * USDC, Math.floor(input.wallet.bankroll * 0.5))
  const shareCap = Math.min(
    input.wallet.bankroll,
    Math.max(Math.floor(input.wallet.bankroll * persona.bankrollShare), smallFloor, USDC),
  )
  const minKelly = Math.min(shareCap, Math.round(USDC * (1.5 + persona.kelly * 5)))
  const kelly = Math.min(shareCap, Math.max(minKelly, Math.floor(shareCap * persona.kelly * Math.max(fraction, 0.25))))
  const stakeMicros = shapeStake(kelly, persona, (rng.a ^ input.windowId) >>> 0, input.wallet.bankroll, input.stake)
  if (stakeMicros === null) {
    armQuiet(gate, persona, scale, rng, input.config, input.windowId)
    return finish({ action: "skip", reason: "no edge", pUp })
  }
  if (!inBurst) gate.burstLeft = Math.max(0, persona.burstWindows - 1)
  gate.refractory = false
  gate.readyWindow = input.windowId + 1
  if (gate.burstLeft === 0) armRefractory(gate, persona, scale, rng, input.config, input.windowId)
  return finish({ action: "bet", side, stakeMicros, pUp })
}

function armQuiet(gate: GateState, persona: Persona, scale: number, rng: Mulberry32, config: PersonaConfig, windowId: number) {
  gate.refractory = false
  const step = Math.max(1, Math.round(drawGap(persona, Math.min(scale, 1.6), rng, config) * 0.25))
  gate.readyWindow = windowId + step
}

function armRefractory(gate: GateState, persona: Persona, scale: number, rng: Mulberry32, config: PersonaConfig, windowId: number) {
  gate.refractory = true
  gate.burstLeft = 0
  gate.readyWindow = windowId + Math.max(1, drawGap(persona, scale, rng, config))
}

export function noteResult(gate: GateState, won: boolean, persona: Persona, config: PersonaConfig): GateState {
  const results = [...gate.results, won].slice(-config.memory)
  let edgeNudge = gate.edgeNudge
  let tempoNudge = gate.tempoNudge
  let bias = gate.bias
  const step = config.memoryStep
  if (!won) {
    edgeNudge = clamp(edgeNudge + step, -0.02, 0.03)
    tempoNudge = clamp(tempoNudge + step * 4, -0.2, 0.5)
  } else if ((gate.rngA & 255) / 255 < config.looseRate) {
    edgeNudge = clamp(edgeNudge - step * 0.5, -0.02, 0.03)
    tempoNudge = clamp(tempoNudge - step, -0.2, 0.5)
  }
  bias = clamp(bias + (won ? step * 0.25 : -step * 0.25) * (persona.mind === "fade" ? -1 : 1), -0.02, 0.02)
  return { ...gate, results, edgeNudge, tempoNudge, bias }
}

export function decideWindow(input: {
  roundId: number
  now: number
  windowMs: number
  points: readonly PrintPoint[]
  poolUp: number
  poolDown: number
  wallets: readonly WalletMind[]
  config: PersonaConfig
  stake: StakeConfig
  cap: number
}): { orders: Order[]; skips: Skip[]; gates: Map<string, GateState> } {
  const rng = mulberry32.create(input.roundId >>> 0)
  const wallets = input.wallets.slice()
  for (let i = wallets.length - 1; i > 0; i--) {
    const j = Math.floor(mulberry32.sample(rng) * (i + 1))
    const swap = wallets[i]!
    wallets[i] = wallets[j]!
    wallets[j] = swap
  }
  let up = input.poolUp
  let down = input.poolDown
  const orders: Order[] = []
  const skips: Skip[] = []
  const gates = new Map<string, GateState>()
  for (const wallet of wallets) {
    if (orders.length >= input.cap) {
      skips.push({ address: wallet.address, reason: "waiting" })
      gates.set(wallet.address, wallet.gate)
      continue
    }
    const decision = decideWallet({
      wallet,
      windowId: input.roundId,
      now: input.now,
      windowMs: input.windowMs,
      points: input.points,
      poolUp: up,
      poolDown: down,
      config: input.config,
      stake: input.stake,
    })
    gates.set(wallet.address, decision.gate)
    if (decision.action === "skip") {
      skips.push({ address: wallet.address, reason: decision.reason })
      continue
    }
    orders.push({
      address: wallet.address,
      side: decision.side,
      stakeMicros: decision.stakeMicros,
      pUp: decision.pUp,
    })
    if (decision.side === "up") up += decision.stakeMicros
    else down += decision.stakeMicros
  }
  return { orders, skips, gates }
}
