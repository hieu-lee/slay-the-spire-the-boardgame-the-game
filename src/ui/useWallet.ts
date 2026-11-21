import { useEffect, useState, useSyncExternalStore } from 'react'
import { onPackPreferenceChange, playWithPacks } from '../pack-preference.ts'
import { onProfileChange, PROFILE_KEY } from '../profile.ts'
import { currentWalletKey, savedWallet, WALLET_EVENT } from '../wallet-storage.ts'
import type { Wallet } from '../wallet.ts'

/**
 * The signed-in account's wallet, kept current across this tab's changes, other
 * tabs' changes, and logging in or out (here or in another tab).
 */
export function useWallet(): Wallet {
  const [wallet, setWallet] = useState(savedWallet)
  useEffect(() => {
    const refresh = () => setWallet(savedWallet())
    const storage = (event: StorageEvent) => {
      if (event.key === null || event.key === PROFILE_KEY || event.key === currentWalletKey()) refresh()
    }
    const stopProfile = onProfileChange(refresh)
    window.addEventListener(WALLET_EVENT, refresh)
    window.addEventListener('storage', storage)
    return () => {
      stopProfile()
      window.removeEventListener(WALLET_EVENT, refresh)
      window.removeEventListener('storage', storage)
    }
  }, [])
  return wallet
}

/** Whether the account's bought packs join new runs (the Shop's switch); re-renders when it changes. */
export const usePlayWithPacks = (): boolean => useSyncExternalStore(onPackPreferenceChange, playWithPacks)
