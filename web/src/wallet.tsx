import { AddressType, PhantomProvider, useModal, usePhantom } from "@phantom/react-sdk"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react"
import { getPublicClient } from "wagmi/actions"
import {
  createConfig,
  http,
  useAccount,
  useChainId,
  useConnect,
  useDisconnect,
  useSignMessage,
  useSwitchChain,
  useWriteContract,
  WagmiProvider,
} from "wagmi"
import { base, baseSepolia } from "wagmi/chains"
import { chainFromEnv, type ChainConfig } from "../../shared/chain"
import { loginMessage } from "../../shared/login"
import { usdcAbi } from "../../shared/usdc"
import {
  depositRefusal,
  isCallRevert,
  matchingSession,
  walletFaultMessage,
  type DepositResult,
  type StoredSession,
} from "./depositFlow"
import { extractAccountLabel, parseAmountMicros } from "./format"
import { bindPhantomSdk, phantomConnector } from "./phantomConnector"

const SESSION_KEY = "qm.session"

export type WalletSession = {
  chainError: string | null
  pageChain: ChainConfig | null
  address: string | null
  label: string | null
  chainId: number | undefined
  token: string | null
  signing: boolean
  signError: string | null
  connect: () => void
  disconnect: () => void
  switchChain: () => void
  signIn: () => void
  expire: () => void
  deposit: (amount: string, treasury: string, usdc: string, chainId: number) => Promise<DepositResult>
}

const missing: WalletSession = {
  chainError: null,
  pageChain: null,
  address: null,
  label: null,
  chainId: undefined,
  token: null,
  signing: false,
  signError: null,
  connect: () => {},
  disconnect: () => {},
  switchChain: () => {},
  signIn: () => {},
  expire: () => {},
  deposit: async () => ({ ok: false, message: "Chain is invalid" }),
}

const SessionContext = createContext<WalletSession>(missing)

function readChain(): { chain: ChainConfig | null; error: string | null } {
  try {
    return { chain: chainFromEnv(import.meta.env.CHAIN), error: null }
  } catch (error) {
    return { chain: null, error: error instanceof Error ? error.message : "Chain is invalid" }
  }
}

const read = readChain()
const selected = read.chain?.id === base.id ? base : baseSepolia

const phantomConfig = {
  providers: ["injected" as const],
  addressTypes: [AddressType.ethereum] as [typeof AddressType.ethereum],
}

const phantomTheme = {
  background: "#12141a" as const,
  text: "#f3f0e8" as const,
  secondary: "#8f8a80" as const,
  brand: "#e2b340" as const,
  error: "#ff5a4f" as const,
  success: "#2fce86" as const,
  borderRadius: "16px",
  overlay: "rgba(9, 10, 12, 0.8)",
}

export const wagmiConfig = !read.chain
  ? null
  : read.chain.id === base.id
    ? createConfig({
        chains: [base],
        connectors: [phantomConnector()],
        transports: { [base.id]: http(read.chain.rpc) },
        multiInjectedProviderDiscovery: false,
      })
    : createConfig({
        chains: [baseSepolia],
        connectors: [phantomConnector()],
        transports: { [baseSepolia.id]: http(read.chain.rpc) },
        multiInjectedProviderDiscovery: false,
      })

const queryClient = new QueryClient()

function readStored(chainId: number): StoredSession | null {
  const raw = sessionStorage.getItem(SESSION_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as StoredSession
    if (parsed.chainId !== chainId || !parsed.token || !parsed.address) return null
    return parsed
  } catch {
    return null
  }
}

function readStandardAccounts(): unknown[] {
  if (typeof navigator === "undefined") return []
  try {
    const nav = navigator as unknown as { wallets?: { get?: () => unknown[] } }
    const wallets = nav.wallets?.get?.()
    if (!Array.isArray(wallets)) return []
    return wallets.flatMap((wallet) => {
      if (!wallet || typeof wallet !== "object") return []
      const accounts = (wallet as { accounts?: unknown }).accounts
      return Array.isArray(accounts) ? accounts : []
    })
  } catch {
    return []
  }
}

function Bridge({ children }: { children: ReactNode }) {
  const expected = read.chain!.id
  const { address, status } = useAccount()
  const walletChainId = useChainId()
  const { signMessageAsync } = useSignMessage()
  const { switchChainAsync } = useSwitchChain()
  const { connectAsync, connectors } = useConnect()
  const { disconnectAsync } = useDisconnect()
  const { writeContractAsync } = useWriteContract()
  const { sdk, isConnected, isLoading, addresses, user } = usePhantom()
  const { open } = useModal()
  const [token, setToken] = useState<string | null>(null)
  const [signing, setSigning] = useState(false)
  const [signError, setSignError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const pendingModal = useRef(false)
  const syncAttempts = useRef(0)
  const syncing = useRef(false)
  const hadAccount = useRef(false)

  useEffect(() => {
    bindPhantomSdk(sdk)
  }, [sdk])

  useEffect(() => {
    if (isLoading || !pendingModal.current) return
    pendingModal.current = false
    open()
  }, [isLoading, open])

  useEffect(() => {
    const connector = connectors.find((item) => item.id === "phantom")
    if (!sdk || isLoading || !connector || syncing.current) return
    if (!isConnected) {
      syncAttempts.current = 0
      if (status !== "connected") return
      syncing.current = true
      void disconnectAsync()
        .catch(() => {})
        .finally(() => {
          syncing.current = false
        })
      return
    }
    if (status !== "disconnected" || syncAttempts.current >= 2) return
    syncAttempts.current += 1
    syncing.current = true
    void connectAsync({ connector })
      .catch(() => {})
      .finally(() => {
        syncing.current = false
      })
  }, [connectAsync, connectors, disconnectAsync, isConnected, isLoading, sdk, status])

  useEffect(() => {
    if (status === "connecting" || status === "reconnecting") return
    if (status !== "connected" || !address) {
      if (!hadAccount.current) return
      hadAccount.current = false
      const stored = sessionStorage.getItem(SESSION_KEY)
      sessionStorage.removeItem(SESSION_KEY)
      if (stored) {
        try {
          const parsed = JSON.parse(stored) as StoredSession
          void fetch("/api/session", { method: "DELETE", headers: { authorization: `Bearer ${parsed.token}` } })
        } catch {
          // The stored session is unusable.
        }
      }
      setToken(null)
      return
    }
    hadAccount.current = true
    const lower = address.toLowerCase()
    const stored = readStored(expected)
    if (stored && stored.address === lower) {
      setToken(stored.token)
      setSignError(null)
      return
    }
    setToken(null)
    if (stored && stored.address !== lower) {
      sessionStorage.removeItem(SESSION_KEY)
      void fetch("/api/session", { method: "DELETE", headers: { authorization: `Bearer ${stored.token}` } })
    }
    let cancel = false
    setSigning(true)
    setSignError(null)
    const issued = Date.now()
    signMessageAsync({ message: loginMessage(expected, lower, issued) })
      .then(async (signature) => {
        const response = await fetch("/api/session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ address: lower, signature, issued }),
        })
        const body = await response.json()
        if (!response.ok) throw new Error(body.error ?? "Sign-in failed")
        sessionStorage.setItem(SESSION_KEY, JSON.stringify({ token: body.token, address: lower, chainId: expected }))
        if (!cancel) setToken(body.token)
      })
      .catch((error: unknown) => {
        if (cancel) return
        const message = error instanceof Error ? error.message : "Sign-in failed"
        setSignError(message.includes("User rejected") ? "Sign in to trade" : message)
      })
      .finally(() => {
        if (!cancel) setSigning(false)
      })
    return () => {
      cancel = true
    }
  }, [address, attempt, expected, signMessageAsync, status])

  const label = extractAccountLabel(address, {
    addresses: addresses?.length ? addresses : sdk?.getAddresses?.(),
    user,
    phantom: typeof window !== "undefined" ? window.phantom : undefined,
    accounts: readStandardAccounts(),
  })

  const chainName = read.chain?.name ?? "Base Sepolia"
  const signedIn = matchingSession(readStored(expected), address ?? null, expected)
  const activeToken = signedIn && signedIn.token === token ? token : null

  const session: WalletSession = {
    chainError: null,
    pageChain: read.chain,
    address: address ?? null,
    label,
    chainId: walletChainId,
    token: activeToken,
    signing,
    signError,
    connect: () => {
      if (isLoading || !sdk) {
        pendingModal.current = true
        return
      }
      open()
    },
    disconnect: () => {
      void (async () => {
        try {
          if (sdk?.isConnected()) await sdk.disconnect()
        } finally {
          await disconnectAsync().catch(() => {})
        }
      })()
    },
    switchChain: () => {
      void switchChainAsync({ chainId: selected.id }).catch(() => {})
    },
    signIn: () => setAttempt((value) => value + 1),
    expire: () => {
      sessionStorage.removeItem(SESSION_KEY)
      setToken(null)
      setAttempt((value) => value + 1)
    },
    deposit: async (amount, treasury, usdc, chainId) => {
      const micros = parseAmountMicros(amount)
      const account = address
      if (micros === null || micros <= 0) return { ok: false, message: "Amount is invalid" }
      if (!account || !activeToken || !matchingSession(readStored(expected), account, expected)) {
        return { ok: false, message: "Sign in with this wallet before depositing." }
      }
      if (!treasury || !usdc || !wagmiConfig) return { ok: false, message: "Treasury is not ready" }
      if (chainId !== selected.id) return { ok: false, message: "This page and the server are on different chains." }
      let serverReachable = false
      try {
        const response = await fetch("/api/state", { headers: { authorization: `Bearer ${activeToken}` } })
        if (response.status === 401) return { ok: false, message: "Sign in with this wallet before depositing." }
        serverReachable = response.ok
      } catch {
        serverReachable = false
      }
      if (!serverReachable) return { ok: false, message: "Market server is not running." }
      try {
        if (walletChainId !== selected.id) await switchChainAsync({ chainId: selected.id })
        const client = getPublicClient(wagmiConfig, { chainId: selected.id })
        if (!client) return { ok: false, message: "Wallet is not ready" }
        const tokenAddress = usdc as `0x${string}`
        const to = treasury as `0x${string}`
        const value = BigInt(micros)
        const [usdcBalance, ethBalance] = await Promise.all([
          client.readContract({ address: tokenAddress, abi: usdcAbi, functionName: "balanceOf", args: [account] }),
          client.getBalance({ address: account }),
        ])
        let gasWei: bigint | null = null
        try {
          const simulated = await client.simulateContract({
            address: tokenAddress,
            abi: usdcAbi,
            functionName: "transfer",
            args: [to, value],
            account,
          })
          const fees = await client.estimateFeesPerGas()
          const perGas = fees.maxFeePerGas ?? fees.gasPrice ?? 0n
          gasWei = (simulated.request.gas ?? 80_000n) * perGas
        } catch (error) {
          const blocked = depositRefusal({
            micros,
            serverReachable: true,
            signedIn: true,
            sameAccount: true,
            sameChain: true,
            chainName,
            usdcBalance,
            ethBalance,
            gasWei: null,
          })
          if (blocked) return { ok: false, message: blocked }
          if (isCallRevert(error)) return { ok: false, message: walletFaultMessage(error, chainName) }
        }
        const blocked = depositRefusal({
          micros,
          serverReachable: true,
          signedIn: true,
          sameAccount: true,
          sameChain: true,
          chainName,
          usdcBalance,
          ethBalance,
          gasWei,
        })
        if (blocked) return { ok: false, message: blocked }
        let hash: `0x${string}` | null = null
        try {
          hash = await writeContractAsync({
            address: tokenAddress,
            abi: usdcAbi,
            functionName: "transfer",
            args: [to, value],
            chainId: selected.id,
          })
          const receipt = await client.waitForTransactionReceipt({ hash, timeout: 60_000 })
          if (receipt.status !== "success") return { ok: false, message: "Deposit failed" }
          return { ok: true, hash, pending: false }
        } catch (error) {
          if (hash) return { ok: true, hash, pending: true }
          return { ok: false, message: walletFaultMessage(error, chainName) }
        }
      } catch (error) {
        return { ok: false, message: walletFaultMessage(error, chainName) }
      }
    },
  }

  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>
}

export function WalletProviders({ children }: { children: ReactNode }) {
  if (!wagmiConfig || !read.chain) {
    const value: WalletSession = {
      ...missing,
      chainError: read.error,
      pageChain: read.chain,
      deposit: async () => ({ ok: false, message: read.error ?? "Chain is invalid" }),
    }
    return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
  }
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <PhantomProvider config={phantomConfig} theme={phantomTheme} appName="Quick Market">
          <Bridge>{children}</Bridge>
        </PhantomProvider>
      </QueryClientProvider>
    </WagmiProvider>
  )
}

export function useSession() {
  return useContext(SessionContext)
}
