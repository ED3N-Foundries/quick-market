import { isMobileDevice } from "@phantom/browser-sdk"
import type { IEthereumChain } from "@phantom/chain-interfaces"
import { AddressType, PhantomProvider, useConnect as usePhantomConnect, usePhantom } from "@phantom/react-sdk"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react"
import { getPublicClient } from "wagmi/actions"
import { getAddress, type Address } from "viem"
import {
  createConfig,
  http,
  useAccount,
  useChainId,
  useConnect,
  useDisconnect,
  useWriteContract,
  WagmiProvider,
} from "wagmi"
import { base, baseSepolia } from "wagmi/chains"
import { chainFromEnv, tokenLabel, type ChainConfig } from "../../shared/chain"
import { marketPreferences } from "../../shared/market"
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
import {
  authorizedAccount,
  connectKind,
  isUnauthorized,
  loginAction,
  type LoginPhase,
  phantomBrowseUrl,
  phantomEthereumProvider,
  phantomInjected,
  providerFault,
  requestPhantomAccounts,
  swallowedConnectError,
  switchFault,
  takeLoginQuery,
} from "./phantomConnect"
import { bindPhantomSdk, phantomConnector } from "./phantomConnector"
import type { GrantPending, You } from "./types"

const SESSION_KEY = "qm.session"

function sessionYou(value: unknown): You | null {
  if (!value || typeof value !== "object") return null
  const row = value as Partial<You>
  const balanceMicros = row.balanceMicros
  if (typeof row.address !== "string" || typeof balanceMicros !== "number" || !Number.isSafeInteger(balanceMicros) || !Array.isArray(row.openBuyIns)) {
    return null
  }
  const pending = row.grantPending
  let grantPending: GrantPending | null = null
  if (pending && typeof pending === "object") {
    const startedAt = pending.startedAt
    const confirmations = pending.confirmations
    if (typeof startedAt === "number" && Number.isSafeInteger(startedAt)) {
      grantPending = {
        startedAt,
        txHash: typeof pending.txHash === "string" ? pending.txHash : null,
        confirmations: typeof confirmations === "number" && Number.isSafeInteger(confirmations) ? confirmations : 3,
      }
    }
  }
  return {
    address: row.address,
    balanceMicros,
    grantAt: typeof row.grantAt === "number" ? row.grantAt : null,
    grantPending,
    openBuyIns: row.openBuyIns,
  }
}

export type WalletSession = {
  chainError: string | null
  pageChain: ChainConfig | null
  address: string | null
  label: string | null
  chainId: number | undefined
  token: string | null
  signedYou: You | null
  signing: boolean
  loginPhase: LoginPhase | null
  signError: string | null
  login: () => void
  connectMode: "modal" | "deeplink"
  connectError: string | null
  disconnect: () => void
  switchChain: () => void
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
  signedYou: null,
  signing: false,
  loginPhase: null,
  signError: null,
  login: () => {},
  connectMode: "modal",
  connectError: null,
  disconnect: () => {},
  switchChain: () => {},
  expire: () => {},
  deposit: async () => ({ ok: false, message: "Chain is invalid" }),
}

const SessionContext = createContext<WalletSession>(missing)

function readChain(): { chain: ChainConfig | null; error: string | null } {
  try {
    return { chain: chainFromEnv(marketPreferences.chain, import.meta.env.USDC_ADDRESS), error: null }
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

function chainNumber(value: number | string): number {
  if (typeof value === "number") return value
  return value.startsWith("0x") ? Number.parseInt(value, 16) : Number(value)
}

function ethereumAccounts(value: readonly { addressType?: string; address?: string }[] | null | undefined): string[] {
  if (!value) return []
  return value.flatMap((item) => (item.addressType === AddressType.ethereum && item.address ? [item.address] : []))
}

function missedChain(): { code: number; message: string } {
  return { code: 4902, message: "Unrecognized chain ID" }
}

function Bridge({ children }: { children: ReactNode }) {
  const expected = read.chain!.id
  const { status } = useAccount()
  const wagmiChainId = useChainId()
  const { connectAsync, connectors } = useConnect()
  const { disconnectAsync } = useDisconnect()
  const { writeContractAsync } = useWriteContract()
  const { sdk, isConnected, isLoading, addresses, user } = usePhantom()
  const { connect: connectPhantom } = usePhantomConnect()
  const [token, setToken] = useState<string | null>(null)
  const [signedYou, setSignedYou] = useState<You | null>(null)
  const [signing, setSigning] = useState(false)
  const [loginPhase, setLoginPhase] = useState<LoginPhase | null>(null)
  const [signError, setSignError] = useState<string | null>(null)
  const [connectError, setConnectError] = useState<string | null>(null)
  const [walletChainId, setWalletChainId] = useState<number | undefined>(undefined)
  const pendingLogin = useRef(false)
  const busy = useRef(false)
  const hadAccount = useRef(false)
  const signEpoch = useRef(0)
  const loginRef = useRef<() => void>(() => {})
  const sdkRef = useRef(sdk)
  const listed = isConnected ? (addresses?.length ? addresses : (sdk?.getAddresses?.() ?? [])) : []
  const address = authorizedAccount(
    listed.filter((item) => item.addressType === AddressType.ethereum).map((item) => item.address),
    null,
  )
  const addressRef = useRef(address)
  sdkRef.current = sdk
  addressRef.current = address

  useEffect(() => {
    bindPhantomSdk(sdk)
  }, [sdk])

  // Strip login=1 before the continuation effect runs, so a refresh does not prompt again.
  useEffect(() => {
    try {
      const { continueLogin, clean } = takeLoginQuery(window.location.href)
      if (!continueLogin) return
      const next = new URL(clean)
      window.history.replaceState(window.history.state, "", `${next.pathname}${next.search}${next.hash}`)
      pendingLogin.current = true
    } catch {
      // A malformed page URL cannot continue the Phantom hop.
    }
  }, [])

  useEffect(() => {
    if (isLoading || !sdk || !pendingLogin.current) return
    pendingLogin.current = false
    loginRef.current()
  }, [isLoading, sdk])

  useEffect(() => {
    if (!isConnected || !sdk) {
      setWalletChainId(undefined)
      return
    }
    // useEthereum() is a stub until a provider exists, and it stays stale across await connect().
    let ethereum: IEthereumChain
    try {
      ethereum = sdk.ethereum
    } catch {
      return
    }
    let cancel = false
    const apply = (value: number | string) => {
      const id = chainNumber(value)
      if (!cancel && Number.isInteger(id)) setWalletChainId(id)
    }
    // Login waits out autoConnect, then signs. Read the chain once that RPC is done.
    if (!busy.current && !isLoading) void ethereum.getChainId().then(apply).catch(() => {})
    ethereum.on("chainChanged", apply)
    return () => {
      cancel = true
      ethereum.off("chainChanged", apply)
    }
  }, [isConnected, isLoading, sdk, signing])

  // Address changes do not sign. A restored session only fills the token.
  useEffect(() => {
    if (!address) {
      if (!hadAccount.current) return
      hadAccount.current = false
      signEpoch.current += 1
      busy.current = false
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
      setSignedYou(null)
      setSignError(null)
      setConnectError(null)
      setSigning(false)
      setLoginPhase(null)
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
    setSignedYou(null)
    if (stored && stored.address !== lower) {
      sessionStorage.removeItem(SESSION_KEY)
      void fetch("/api/session", { method: "DELETE", headers: { authorization: `Bearer ${stored.token}` } })
    }
  }, [address, expected])

  const label = extractAccountLabel(address, {
    addresses: addresses?.length ? addresses : sdk?.getAddresses?.(),
    user,
    phantom: typeof window !== "undefined" ? window.phantom : undefined,
    accounts: readStandardAccounts(),
  })

  const chainName = read.chain?.name ?? "Base Sepolia"
  const asset = read.chain ? tokenLabel(read.chain) : "USDC"
  const signedIn = matchingSession(readStored(expected), address ?? null, expected)
  const activeToken = signedIn && (token === null || token === signedIn.token) ? signedIn.token : null

  const connectMode = connectKind({
    mobile: isMobileDevice(),
    injected: phantomInjected(window),
  })

  const liveEthereum = (): IEthereumChain => {
    const current = sdkRef.current
    if (!current) throw new Error("Phantom is not ready")
    return current.ethereum
  }

  const signInNow = (forceConnect: boolean) => {
    if (busy.current) return
    busy.current = true
    const epoch = ++signEpoch.current
    const stale = () => signEpoch.current !== epoch
    setSigning(true)
    setSignedYou(null)
    setLoginPhase(forceConnect || !sdkRef.current?.isConnected() ? "phantom" : "sign")
    setSignError(null)
    setConnectError(null)
    void (async () => {
      let faultSource = "Phantom eth_requestAccounts"
      const askPhantom = async () => {
        faultSource = "Phantom eth_requestAccounts"
        const provider = phantomEthereumProvider(window)
        if (!provider) throw new Error("Ethereum provider not found on window.phantom.")
        return requestPhantomAccounts(provider)
      }
      try {
        const current = sdkRef.current
        if (!current) throw new Error("Phantom is not ready")
        let exact: string | null = null
        if (forceConnect || !current.isConnected()) {
          setLoginPhase("phantom")
          const granted = await askPhantom()
          if (stale()) return
          let fromSdk: string[] = []
          try {
            const result = await connectPhantom({ provider: "injected" })
            if (stale()) return
            fromSdk = ethereumAccounts(result.addresses)
          } catch (error) {
            if (!swallowedConnectError(error) || granted.length === 0) throw error
          }
          exact = authorizedAccount(fromSdk.length > 0 ? fromSdk : granted, addressRef.current)
        } else {
          exact = authorizedAccount(ethereumAccounts(current.getAddresses()), addressRef.current)
        }
        if (stale()) return
        let ethereum = liveEthereum()
        if (!exact) {
          setLoginPhase("phantom")
          const granted = await askPhantom()
          if (stale()) return
          exact = authorizedAccount(granted, addressRef.current)
        }
        if (!exact) throw new Error("No Ethereum account")
        const signWith = async (account: string) => {
          setLoginPhase("sign")
          faultSource = "Phantom personal_sign"
          const issued = Date.now()
          const signature = await ethereum.signPersonalMessage(loginMessage(expected, account.toLowerCase(), issued), account)
          return { signature, issued, account }
        }
        let signed: { signature: string; issued: number; account: string }
        try {
          signed = await signWith(exact)
        } catch (error) {
          if (stale() || !isUnauthorized(error)) throw error
          setLoginPhase("phantom")
          const granted = await askPhantom()
          if (stale()) return
          const next = authorizedAccount(granted, exact)
          if (!next) throw new Error("No Ethereum account")
          ethereum = liveEthereum()
          signed = await signWith(next)
        }
        if (stale()) return
        const lower = signed.account.toLowerCase()
        const shown = addressRef.current
        if (shown && shown.toLowerCase() !== lower) return
        setLoginPhase("session")
        faultSource = "Quick Market"
        const response = await fetch("/api/session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ address: lower, signature: signed.signature, issued: signed.issued }),
        })
        const body = (await response.json()) as { token?: string; error?: string; you?: unknown }
        if (!response.ok || !body.token) throw new Error(body.error ?? "Sign-in failed")
        sessionStorage.setItem(SESSION_KEY, JSON.stringify({ token: body.token, address: lower, chainId: expected }))
        if (!stale()) {
          setSignedYou(sessionYou(body.you))
          setToken(body.token)
        }
      } catch (error: unknown) {
        if (!stale()) setSignError(providerFault(error, faultSource))
      } finally {
        if (!stale()) {
          busy.current = false
          setSigning(false)
          setLoginPhase(null)
        }
      }
    })()
  }

  const beginLogin = () => {
    if (busy.current) return
    const action = loginAction({
      mobile: isMobileDevice(),
      injected: phantomInjected(window),
      connected: Boolean(sdkRef.current?.isConnected()),
      sessionMatches: matchingSession(readStored(expected), addressRef.current, expected) !== null,
    })
    if (action === "done") {
      setSigning(false)
      setLoginPhase(null)
      return
    }
    if (action === "browse") {
      try {
        window.location.assign(phantomBrowseUrl(window.location.href, window.location.origin))
      } catch (error) {
        setConnectError(error instanceof Error ? error.message : "Phantom needs an https link to this page.")
      }
      return
    }
    // autoConnect is still using eth_accounts. Wait, then run this same login once.
    if (isLoading || !sdkRef.current) {
      pendingLogin.current = true
      setSigning(true)
      setLoginPhase("phantom")
      setSignError(null)
      setConnectError(null)
      return
    }
    signInNow(action === "connect-and-sign")
  }
  loginRef.current = beginLogin

  const session: WalletSession = {
    chainError: null,
    pageChain: read.chain,
    address: address ?? null,
    label,
    chainId: walletChainId,
    token: activeToken,
    signedYou,
    signing,
    loginPhase,
    signError,
    connectMode,
    connectError,
    login: () => loginRef.current(),
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
      const current = sdkRef.current
      if (!current?.isConnected()) {
        setConnectError("Phantom is not ready")
        return
      }
      setConnectError(null)
      void (async () => {
        try {
          const ethereum = current.ethereum
          await ethereum.switchChain(selected.id)
          const id = chainNumber(await ethereum.getChainId())
          if (Number.isInteger(id)) setWalletChainId(id)
          if (id !== selected.id) setConnectError(switchFault(selected.id, missedChain()))
        } catch (error) {
          setConnectError(switchFault(selected.id, error))
        }
      })()
    },
    expire: () => {
      sessionStorage.removeItem(SESSION_KEY)
      setToken(null)
      signEpoch.current += 1
      busy.current = false
      setSigning(false)
      setLoginPhase(null)
      beginLogin()
    },
    deposit: async (amount, treasury, usdc, chainId) => {
      const micros = parseAmountMicros(amount)
      const shown = address
      if (micros === null || micros <= 0) return { ok: false, message: "Amount is invalid" }
      if (!shown || !activeToken || !matchingSession(readStored(expected), shown, expected)) {
        return { ok: false, message: "Sign in with this wallet before depositing." }
      }
      let account: Address
      try {
        account = getAddress(shown)
      } catch {
        return { ok: false, message: "Wallet is not ready" }
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
        const ethereum = liveEthereum()
        let chainNow = chainNumber(await ethereum.getChainId())
        if (chainNow !== selected.id) {
          try {
            await ethereum.switchChain(selected.id)
          } catch (error) {
            return { ok: false, message: switchFault(selected.id, error) }
          }
          chainNow = chainNumber(await ethereum.getChainId())
          if (Number.isInteger(chainNow)) setWalletChainId(chainNow)
          if (chainNow !== selected.id) return { ok: false, message: switchFault(selected.id, missedChain()) }
        }
        const connector = connectors.find((item) => item.id === "phantom")
        if (!connector) return { ok: false, message: "Wallet is not ready" }
        if (!(status === "connected" && wagmiChainId === selected.id)) {
          if (status === "connected") await disconnectAsync()
          const linked = await connectAsync({ connector })
          if (linked.chainId !== selected.id) return { ok: false, message: switchFault(selected.id, missedChain()) }
        }
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
            moneyLabel: asset,
          })
          if (blocked) return { ok: false, message: blocked }
          if (isCallRevert(error)) return { ok: false, message: walletFaultMessage(error, chainName, asset) }
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
          moneyLabel: asset,
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
          return { ok: false, message: walletFaultMessage(error, chainName, asset) }
        }
      } catch (error) {
        return { ok: false, message: walletFaultMessage(error, chainName, asset) }
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
    <WagmiProvider config={wagmiConfig} reconnectOnMount={false}>
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
