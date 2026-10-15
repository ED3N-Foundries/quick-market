import { AddressType } from "@phantom/react-sdk"
import type { IEthereumChain } from "@phantom/chain-interfaces"
import { getAddress, type Address } from "viem"
import { createConnector, type CreateConnectorFn } from "wagmi"

// Deeplink counts as an embedded provider and the SDK requires a Portal appId for it.
// Injected Phantom works without one. New Portal apps are paused, and embedded EVM is not live.
type PhantomSdk = {
  isConnected(): boolean
  connect(options: { provider: "injected" }): Promise<unknown>
  disconnect(): Promise<void>
  getAddresses(): { addressType: string; address: string }[]
  ethereum: IEthereumChain
  on(event: "disconnect", callback: () => void): void
  off(event: "disconnect", callback: () => void): void
}

let boundSdk: PhantomSdk | null = null
let arm: (() => void) | null = null

export function bindPhantomSdk(sdk: PhantomSdk | null) {
  boundSdk = sdk
  arm?.()
}

function chainNumber(value: number | string): number {
  if (typeof value === "number") return value
  return value.startsWith("0x") ? Number.parseInt(value, 16) : Number(value)
}

function accountsOf(sdk: PhantomSdk): readonly Address[] {
  return sdk
    .getAddresses()
    .filter((item) => item.addressType === AddressType.ethereum)
    .map((item) => getAddress(item.address))
}

export function phantomConnector() {
  return createConnector(((config) => {
    let stopEthereum: (() => void) | null = null
    let stopSdk: (() => void) | null = null

    const onAccountsChanged = (accounts: string[]) => {
      if (accounts.length === 0) config.emitter.emit("disconnect")
      else config.emitter.emit("change", { accounts: accounts.map((account) => getAddress(account)) })
    }

    const onChainChanged = (chainId: string | number) => {
      const id = chainNumber(chainId)
      if (Number.isInteger(id)) config.emitter.emit("change", { chainId: id })
    }

    const listenEthereum = () => {
      if (stopEthereum || !boundSdk?.isConnected()) return
      let ethereum: IEthereumChain
      try {
        ethereum = boundSdk.ethereum
      } catch {
        return
      }
      ethereum.on("accountsChanged", onAccountsChanged)
      ethereum.on("chainChanged", onChainChanged)
      stopEthereum = () => {
        ethereum.off("accountsChanged", onAccountsChanged)
        ethereum.off("chainChanged", onChainChanged)
        stopEthereum = null
      }
    }

    const onSdkDisconnect = () => {
      stopEthereum?.()
      config.emitter.emit("disconnect")
    }

    arm = () => {
      if (!boundSdk) return
      if (!stopSdk) {
        boundSdk.on("disconnect", onSdkDisconnect)
        stopSdk = () => {
          boundSdk?.off("disconnect", onSdkDisconnect)
          stopSdk = null
        }
      }
      listenEthereum()
    }

    return {
      id: "phantom",
      name: "Phantom",
      type: "phantom",
      async setup() {
        arm?.()
      },
      async connect(parameters) {
        const sdk = boundSdk
        if (!sdk) throw new Error("Phantom is not ready")
        if (!sdk.isConnected()) await sdk.connect({ provider: "injected" })
        listenEthereum()
        const accounts = accountsOf(sdk)
        if (accounts.length === 0) throw new Error("No Ethereum account")
        let chainId = chainNumber(await sdk.ethereum.getChainId())
        if (parameters?.chainId && parameters.chainId !== chainId) {
          const chain = config.chains.find((item) => item.id === parameters.chainId)
          if (!chain) throw new Error(`Chain ${parameters.chainId} is not configured`)
          await sdk.ethereum.switchChain(parameters.chainId)
          config.emitter.emit("change", { chainId: parameters.chainId })
          chainId = chain.id
        }
        if (parameters?.withCapabilities) {
          return {
            accounts: accounts.map((address) => ({ address, capabilities: {} as Record<string, unknown> })),
            chainId,
          }
        }
        return { accounts, chainId }
      },
      async disconnect() {
        stopEthereum?.()
        if (boundSdk?.isConnected()) await boundSdk.disconnect()
      },
      async getAccounts() {
        if (!boundSdk?.isConnected()) return []
        return accountsOf(boundSdk)
      },
      async getChainId() {
        const sdk = boundSdk
        if (!sdk?.isConnected()) throw new Error("Phantom is not connected")
        return chainNumber(await sdk.ethereum.getChainId())
      },
      async getProvider() {
        const sdk = boundSdk
        if (!sdk?.isConnected()) throw new Error("Phantom is not connected")
        return sdk.ethereum
      },
      async isAuthorized() {
        return Boolean(boundSdk?.isConnected())
      },
      async switchChain({ chainId }) {
        const sdk = boundSdk
        if (!sdk?.isConnected()) throw new Error("Phantom is not connected")
        const chain = config.chains.find((item) => item.id === chainId)
        if (!chain) throw new Error(`Chain ${chainId} is not configured`)
        await sdk.ethereum.switchChain(chainId)
        config.emitter.emit("change", { chainId })
        return chain
      },
      onAccountsChanged,
      onChainChanged,
      onDisconnect() {
        config.emitter.emit("disconnect")
      },
    }
  }) as CreateConnectorFn)
}
