export type StoredSession = { token: string; address: string; chainId: number }

export type DepositResult = { ok: true; hash: string; pending: boolean } | { ok: false; message: string }

export type DepositCheck = {
  micros: number
  serverReachable: boolean
  signedIn: boolean
  sameAccount: boolean
  sameChain: boolean
  chainName: string
  usdcBalance: bigint | null
  ethBalance: bigint | null
  gasWei: bigint | null
  moneyLabel?: string
}

export function matchingSession(
  stored: StoredSession | null,
  connected: string | null,
  chainId: number,
): StoredSession | null {
  if (!stored || !connected || !stored.token) return null
  if (stored.chainId !== chainId || stored.address !== connected.toLowerCase()) return null
  return stored
}

/** A reason to stop before Phantom opens. Null means the transfer can be requested. */
export function depositRefusal(check: DepositCheck): string | null {
  if (!Number.isSafeInteger(check.micros) || check.micros <= 0) return "Amount is invalid"
  if (!check.serverReachable) return "Market server is not running."
  if (!check.signedIn || !check.sameAccount) return "Sign in with this wallet before depositing."
  if (!check.sameChain) return "This page and the server are on different chains."
  if (check.usdcBalance === null || check.ethBalance === null) return "Wallet is not ready"
  if (check.usdcBalance < BigInt(check.micros)) {
    return `This wallet does not have enough ${check.moneyLabel ?? "USDC"} on ${check.chainName}.`
  }
  if (check.ethBalance === 0n || (check.gasWei !== null && check.ethBalance < check.gasWei)) {
    return `This wallet needs ${check.chainName} ETH for gas.`
  }
  return null
}

export function isCallRevert(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : ""
  return message.includes("execution reverted") || message.includes("exceeds balance") || message.includes("contractfunctionreverted")
}

export function isUnrecognizedChain(error: unknown): boolean {
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current)
    const record = current as { code?: unknown; message?: unknown; cause?: unknown }
    if (record.code === 4902 || record.code === "4902") return true
    const message = typeof record.message === "string" ? record.message.toLowerCase() : ""
    if (message.includes("unrecognized chain") || message.includes("chain has not been added")) return true
    current = record.cause
  }
  return false
}

export function walletFaultMessage(error: unknown, chainName: string, moneyLabel = "USDC"): string {
  const code = errorCode(error)
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : ""
  const lower = message.toLowerCase()
  if (code === 4001 || lower.includes("user rejected") || lower.includes("user denied")) return "Deposit cancelled"
  if (lower.includes("insufficient funds") || lower.includes("gas required exceeds")) {
    return `This wallet needs ${chainName} ETH for gas.`
  }
  if (lower.includes("exceeds balance") || (lower.includes("insufficient") && lower.includes("usdc"))) {
    return `This wallet does not have enough ${moneyLabel} on ${chainName}.`
  }
  const brief = message.split("\n")[0]?.trim() ?? ""
  if (!brief || brief.length > 160) return "Deposit failed"
  return brief
}

function errorCode(error: unknown): number | null {
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current)
    const record = current as { code?: unknown; cause?: unknown }
    if (typeof record.code === "number") return record.code
    current = record.cause
  }
  return null
}
