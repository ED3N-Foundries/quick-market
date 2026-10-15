import { ConnectButton, getDefaultConfig, RainbowKitProvider, useConnectModal } from "@rainbow-me/rainbowkit"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createContext, useContext, useEffect, useState, type ReactNode } from "react"
import { getPublicClient } from "wagmi/actions"
import { useAccount, useChainId, useSignMessage, useSwitchChain, useWriteContract, WagmiProvider } from "wagmi"
import { base, baseSepolia } from "wagmi/chains"
import { chainFromEnv, type ChainConfig } from "../../shared/chain"
import { loginMessage } from "../../shared/login"
import { usdcAbi } from "../../shared/usdc"
import { parseAmountMicros } from "./format"

const SESSION_KEY = "qm.session"

type StoredSession = { token: string; address: string; chainId: number }

export type WalletSession = {
  projectReady: boolean
  chainError: string | null
  pageChain: ChainConfig | null
  address: string | null
  chainId: number | undefined
  token: string | null
  signing: boolean
  signError: string | null
  connect: () => void
  switchChain: () => void
  signIn: () => void
  expire: () => void
  deposit: (amount: string, treasury: string, usdc: string, chainId: number) => Promise<string | null>
}

const missing: WalletSession = {
  projectReady: false,
  chainError: null,
  pageChain: null,
  address: null,
  chainId: undefined,
  token: null,
  signing: false,
  signError: null,
  connect: () => {},
  switchChain: () => {},
  signIn: () => {},
  expire: () => {},
  deposit: async () => "Set WALLETCONNECT_PROJECT_ID to connect a wallet.",
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
const projectId = import.meta.env.WALLETCONNECT_PROJECT_ID
const selected = read.chain?.id === base.id ? base : baseSepolia

export const wagmiConfig =
  read.chain && projectId
    ? getDefaultConfig({
        appName: "Quick Market",
        projectId,
        chains: [selected],
        ssr: false,
      })
    : null

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

function Bridge({ children }: { children: ReactNode }) {
  const expected = read.chain!.id
  const { address, status } = useAccount()
  const walletChainId = useChainId()
  const { signMessageAsync } = useSignMessage()
  const { switchChainAsync } = useSwitchChain()
  const { openConnectModal } = useConnectModal()
  const { writeContractAsync } = useWriteContract()
  const [token, setToken] = useState<string | null>(null)
  const [signing, setSigning] = useState(false)
  const [signError, setSignError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (status === "connecting" || status === "reconnecting") return
    if (status !== "connected" || !address) {
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
    const lower = address.toLowerCase()
    const stored = readStored(expected)
    if (stored && stored.address === lower) {
      setToken(stored.token)
      setSignError(null)
      return
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

  const session: WalletSession = {
    projectReady: true,
    chainError: null,
    pageChain: read.chain,
    address: address ?? null,
    chainId: walletChainId,
    token,
    signing,
    signError,
    connect: () => openConnectModal?.(),
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
      if (micros === null || micros <= 0) return "Amount is invalid"
      if (!treasury || !usdc || !wagmiConfig) return "Treasury is not ready"
      try {
        if (chainId !== selected.id) return "This page and the server are on different chains."
        if (walletChainId !== selected.id) await switchChainAsync({ chainId: selected.id })
        const client = getPublicClient(wagmiConfig, { chainId: selected.id })
        if (!client) return "Wallet is not ready"
        const hash = await writeContractAsync({
          address: usdc as `0x${string}`,
          abi: usdcAbi,
          functionName: "transfer",
          args: [treasury as `0x${string}`, BigInt(micros)],
          chainId: selected.id,
        })
        const receipt = await client.waitForTransactionReceipt({ hash })
        if (receipt.status !== "success") return "Deposit failed"
        return null
      } catch (error) {
        const message = error instanceof Error ? error.message : "Deposit failed"
        if (message.toLowerCase().includes("user rejected")) return "Deposit cancelled"
        return "Deposit failed"
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
      deposit: async () => read.error ?? "Set WALLETCONNECT_PROJECT_ID to connect a wallet.",
    }
    return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
  }
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider>
          <Bridge>{children}</Bridge>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  )
}

export function useSession() {
  return useContext(SessionContext)
}

export { ConnectButton }
