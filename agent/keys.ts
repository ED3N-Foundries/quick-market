import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"

export type StoredKey = {
  address: string
  privateKey: `0x${string}`
}

export function growKeys(existing: StoredKey[], needed: number, cap: number): StoredKey[] {
  const keys: StoredKey[] = []
  for (const row of existing) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(row.privateKey)) continue
    const account = privateKeyToAccount(row.privateKey)
    keys.push({ address: account.address, privateKey: row.privateKey })
  }
  const target = Math.min(cap, Math.max(keys.length, Math.max(0, Math.floor(needed))))
  while (keys.length < target) {
    const privateKey = generatePrivateKey()
    keys.push({ address: privateKeyToAccount(privateKey).address, privateKey })
  }
  return keys
}
