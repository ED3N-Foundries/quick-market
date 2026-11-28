/**
 * NEAR Testnet credits grants on the ledger and does not mint.
 * Withdrawals and the deposit door are off. Base Sepolia ignores this flag.
 * Clear it only after a catch-up mint covers the NEAR ledger.
 */
export const NEAR_WITHDRAWALS_PAUSED = "withdrawals_paused"

export function nearLedgerOnly(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.NEAR_LEDGER_ONLY?.trim().toLowerCase()
  return raw === "1" || raw === "true" || raw === "yes"
}
