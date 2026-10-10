// The Shop currency on screen: its icon, an amount, and the "+N coins" moment a
// fallen boss pays out. Coins are the profile's, not the run's — gold stays the
// in-run currency and keeps its own icon.
import { useEffect, useState } from 'react'
import { assetPath } from '../game/assets.ts'

const COIN_ICON = 'icons/coin.svg'

export function CoinIcon({ size = 20, className }: { size?: number; className?: string }) {
  return <img className={`coin-icon${className ? ` ${className}` : ''}`} src={assetPath(COIN_ICON)} width={size} height={size}
    alt="" aria-hidden="true" draggable={false} />
}

const NUMBER = new Intl.NumberFormat('en-US')
export const formatCoins = (coins: number): string => NUMBER.format(coins)

/** "1,284 coins", with the icon in front and the unit kept for screen readers. */
export function CoinAmount({ coins, size = 20, className }: { coins: number; size?: number; className?: string }) {
  return <span className={`coin-amount${className ? ` ${className}` : ''}`}>
    <CoinIcon size={size} />
    <span className="coin-amount__value">{formatCoins(coins)}</span>
    <span className="visually-hidden"> {coins === 1 ? 'coin' : 'coins'}</span>
  </span>
}

/** `pending`: a boss's bounty, claimed only when the run's result is recorded; `total` is then the run's pending sum. */
export type CoinGain = { coins: number; total: number; id: number; pending?: boolean; source?: 'pastRuns' }

/**
 * A boss's bounty (pending until the run is recorded), or the coins a recorded
 * run paid into the wallet, announced over the current screen. It never takes
 * the pointer and leaves on its own. An `aria-live` region rather than
 * `role="status"`: those screens already own their status regions.
 */
export function CoinGainToast({ gain, onDone, placement = 'run' }: { gain: CoinGain | null; onDone: () => void; placement?: 'run' | 'menu' }) {
  const [shown, setShown] = useState<CoinGain | null>(gain)
  useEffect(() => {
    // Cleared by its owner (a new run, leaving the run): take the toast down now.
    if (!gain) {
      setShown(null)
      return undefined
    }
    setShown(gain)
    const timer = window.setTimeout(() => { setShown(null); onDone() }, 4_200)
    return () => clearTimeout(timer)
  }, [gain, onDone])
  return <div className={`coin-gain${placement === 'menu' ? ' coin-gain--menu' : ''}`} aria-live="polite">
    {shown ? <p key={shown.id} className="coin-gain__toast" data-pending={shown.pending || undefined}>
      <CoinIcon size={40} className="coin-gain__icon" />
      <span className="coin-gain__copy">
        <strong>+{formatCoins(shown.coins)} {shown.coins === 1 ? 'coin' : 'coins'}{shown.pending ? ' pending' : ''}</strong>
        <small>{shown.pending
          ? `Boss bounty · claimed when you record the run (${formatCoins(shown.total)} to claim)`
          : `${shown.source === 'pastRuns' ? 'Your past runs' : 'Run recorded'} · ${formatCoins(shown.total)} in your purse`}</small>
      </span>
    </p> : null}
  </div>
}
