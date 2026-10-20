import * as z from "zod"
import type { ChainKey, TokenKind } from "./chain"
import type { Assert, Equal } from "./exact"

export const priceSources = ["binance", "bybit", "okx", "coinbase", "kraken", "bitstamp"] as const

export type PriceSource = (typeof priceSources)[number]

/** Product knobs. The hardcoded object wins over the same names in `.env`. */
export type MarketPreferences = {
  chain: ChainKey
  windowSeconds: number
  marketSeconds: number
  viewSeconds: number
  feeBps: number
  priceSource: PriceSource
  minStakeMicros: number
  liveMs: number
  tapeMs: number
  grantMicros: number
  grantIntervalMs: number
}

/** What the browser receives. Chain display fields are derived, not preferences. */
export type PublicConfig = {
  windowSeconds: number
  marketSeconds: number
  viewSeconds: number
  feeBps: number
  minStakeMicros: number
  source: PriceSource
  chainId: number
  chainName: string
  usdc: string
  treasury: string
  moneyLabel: string
  tokenKind: TokenKind
  tokenLabel: string
  grantMicros: number
  grantIntervalMs: number
}

const seconds = z.int().min(1).max(120)
const positive = z.int().positive()

export const marketSchema = z.strictObject({
  chain: z.enum(["base", "base-sepolia"]),
  windowSeconds: seconds,
  marketSeconds: seconds,
  viewSeconds: seconds,
  feeBps: z.int().min(0).max(10_000),
  priceSource: z.enum(priceSources),
  minStakeMicros: positive,
  liveMs: positive,
  tapeMs: positive,
  grantMicros: positive,
  grantIntervalMs: positive,
})

type _market = Assert<Equal<z.infer<typeof marketSchema>, MarketPreferences>>

const hardcoded: MarketPreferences = {
  chain: "base-sepolia",
  windowSeconds: 5,
  marketSeconds: 5,
  viewSeconds: 5,
  feeBps: 0,
  priceSource: "binance",
  minStakeMicros: 1_000_000,
  liveMs: 5_000,
  tapeMs: 15 * 60 * 1000,
  grantMicros: 100_000_000,
  grantIntervalMs: 120_000,
}

export const marketPreferences: MarketPreferences = marketSchema.parse(hardcoded)

/** How often a browser is sent a price. The stored tape is finer than this. */
export const TICK_MS = 100

/** The live line renders this far behind the synced clock. Market ids do not. */
export const RENDER_MS = TICK_MS * 2

type PreferenceEnv = {
  CHAIN?: string
  WINDOW_SECONDS?: string
  MARKET_SECONDS?: string
  VIEW_SECONDS?: string
  FEE_BPS?: string
  PRICE_SOURCE?: string
  GRANT_MICROS?: string
  GRANT_INTERVAL_MS?: string
}

function unset(value: unknown): unknown {
  if (typeof value !== "string") return value
  const trimmed = value.trim()
  return trimmed === "" ? undefined : trimmed
}

const optionalSeconds = z.preprocess(unset, z.coerce.number().int().min(1).max(120).optional())
const optionalPositive = z.preprocess(unset, z.coerce.number().int().positive().optional())

const preferenceEnv = z.object({
  CHAIN: z.preprocess(unset, z.enum(["base", "base-sepolia"]).optional()),
  WINDOW_SECONDS: optionalSeconds,
  MARKET_SECONDS: optionalSeconds,
  VIEW_SECONDS: optionalSeconds,
  FEE_BPS: z.preprocess(unset, z.coerce.number().int().min(0).max(10_000).optional()),
  PRICE_SOURCE: z.preprocess(unset, z.enum(priceSources).optional()),
  GRANT_MICROS: optionalPositive,
  GRANT_INTERVAL_MS: optionalPositive,
})

function ambientPreferences(): PreferenceEnv {
  const proc = (globalThis as { process?: { env?: PreferenceEnv } }).process
  return proc?.env ?? {}
}

/** Coerce preference keys from env, reject invalid ones, then apply the hardcoded object. */
export function loadMarket(env: PreferenceEnv = ambientPreferences()): MarketPreferences {
  const declared = preferenceEnv.parse({
    CHAIN: env.CHAIN,
    WINDOW_SECONDS: env.WINDOW_SECONDS,
    MARKET_SECONDS: env.MARKET_SECONDS,
    VIEW_SECONDS: env.VIEW_SECONDS,
    FEE_BPS: env.FEE_BPS,
    PRICE_SOURCE: env.PRICE_SOURCE,
    GRANT_MICROS: env.GRANT_MICROS,
    GRANT_INTERVAL_MS: env.GRANT_INTERVAL_MS,
  })
  return marketSchema.parse({
    ...{
      chain: declared.CHAIN,
      windowSeconds: declared.WINDOW_SECONDS,
      marketSeconds: declared.MARKET_SECONDS,
      viewSeconds: declared.VIEW_SECONDS,
      feeBps: declared.FEE_BPS,
      priceSource: declared.PRICE_SOURCE,
      grantMicros: declared.GRANT_MICROS,
      grantIntervalMs: declared.GRANT_INTERVAL_MS,
    },
    ...hardcoded,
  })
}
