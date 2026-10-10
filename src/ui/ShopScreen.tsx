// The Shop: where a profile spends the coins its boss victories paid. Two
// sections — the five Slayer card packs, and a Skins teaser that is not for
// sale yet. A bought pack's cards join every new run's reward decks (see
// docs/shop.md). The screen sits on the same painted Spire and parchment boards
// as the Leaderboard and Stats.
import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { assetPath, cardThumbPath } from '../game/assets.ts'
import { CARD_PACK_PRICE } from '../game/coins.ts'
import { cardDef, faceOf } from '../game/cards.ts'
import type { CardDef } from '../game/cards.ts'
import { CARD_PACK_IDS, CARD_PACKS } from '../game/packs.ts'
import type { CardPackDef, CardPackId } from '../game/packs.ts'
import { buyPack, coinsShort, ownsPack } from '../wallet.ts'
import { updateWallet } from '../wallet-storage.ts'
import { CardKeywordHelp, cardAccessibleName } from './Card.tsx'
import { CoinAmount, CoinIcon, formatCoins } from './Coins.tsx'
import { ScannedCardFace } from './CompendiumScreen.tsx'
import { CHARACTER_LABEL } from './run-summary-data.ts'
import { playSoundEffect } from './sfx.ts'
import { useWallet } from './useWallet.ts'

type Tab = 'packs' | 'skins'

/** Each pack's colour, after the hero it belongs to; Colorless stays a cool grey. */
const PACK_ACCENT: Record<CardPackId, string> = {
  slayer_ironclad: '#d2402f',
  slayer_silent: '#47a456',
  slayer_defect: '#3a8bdc',
  slayer_watcher: '#9a5ad8',
  slayer_colorless: '#a3a7ad',
}

/** The three cards fanned on each pack: the two its tagline names, and one between. */
const PACK_FAN: Record<CardPackId, readonly [string, string, string]> = {
  slayer_ironclad: ['slayer_brutality', 'slayer_reaper', 'slayer_searing_blow'],
  slayer_silent: ['slayer_caltrops', 'slayer_nightmare', 'slayer_phantasmal_killer'],
  slayer_defect: ['slayer_aggregate', 'slayer_creative_ai', 'slayer_reboot'],
  slayer_watcher: ['slayer_bowling_bash', 'slayer_master_reality', 'slayer_wheel_kick'],
  slayer_colorless: ['slayer_bandage_up', 'slayer_secret_technique', 'slayer_violence'],
}

const SKIN_TEASERS = ['ironclad', 'silent', 'defect', 'watcher'] as const

const ownerLabel = (pack: CardPackDef) => pack.owner === 'colorless' ? 'Colorless' : CHARACTER_LABEL[pack.owner]
const accentStyle = (id: CardPackId) => ({ '--pack-accent': PACK_ACCENT[id] }) as CSSProperties

function PackFan({ id, size = 'tile' }: { id: CardPackId; size?: 'tile' | 'dialog' }) {
  return <span className={`shop-fan shop-fan--${size}`} aria-hidden="true">
    {PACK_FAN[id].map((cardId, index) =>
      <img key={cardId} className={`shop-fan__card shop-fan__card--${index}`} src={cardThumbPath(cardDef(cardId), false)}
        alt="" draggable={false} />)}
  </span>
}

function PackTile({ pack, owned, short, onBuy, onBrowse }: {
  pack: CardPackDef
  owned: boolean
  short: number
  onBuy: () => void
  onBrowse: () => void
}) {
  const headingId = `shop-pack-${pack.id}`
  return <li className="shop-pack" data-pack={pack.id} data-owned={owned || undefined} style={accentStyle(pack.id)}
    aria-labelledby={headingId}>
    <div className="shop-pack__art">
      <PackFan id={pack.id} />
      {owned ? <span className="shop-pack__seal">Owned</span> : null}
    </div>
    <div className="shop-pack__body">
      <h3 id={headingId}><span className="shop-pack__owner">{ownerLabel(pack)}</span> <span className="shop-pack__kind">Slayer Pack</span></h3>
      <p className="shop-pack__eyebrow">{pack.cardIds.length} cards</p>
      <p className="shop-pack__tagline">{pack.tagline}</p>
      <div className="shop-pack__price">
        {owned ? <span className="shop-pack__owned-note">In your runs</span>
          : <><CoinAmount coins={CARD_PACK_PRICE} size={24} />
            {short > 0 ? <small className="shop-pack__short">Need {formatCoins(short)} more</small> : null}</>}
      </div>
      <div className="shop-pack__actions">
        {owned ? <button type="button" className="shop-button shop-button--owned" disabled>Owned</button>
          : <button type="button" className="shop-button shop-button--buy" disabled={short > 0}
            aria-label={short > 0 ? `Not enough coins for ${pack.name}` : `Buy ${pack.name}`} onClick={onBuy}>
            {short > 0 ? 'Not enough coins' : 'Buy'}
          </button>}
        <button type="button" className="shop-button shop-button--browse" aria-label={`Browse ${pack.name} cards`}
          onClick={onBrowse}>Browse cards</button>
      </div>
    </div>
  </li>
}

/** Every card of a pack, both faces, zoomable like the Compendium. */
function PackBrowser({ pack, onClose }: { pack: CardPackDef; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const zoomDialog = useRef<HTMLDialogElement>(null)
  const [upgraded, setUpgraded] = useState(false)
  const [zoomed, setZoomed] = useState<CardDef | null>(null)
  useEffect(() => {
    const node = dialog.current
    if (node && !node.open) node.showModal()
  }, [])
  useEffect(() => {
    const node = zoomDialog.current
    if (zoomed && node && !node.open) node.showModal()
  }, [zoomed])
  const cards = pack.cardIds.map(cardDef)
  // The zoom is a dialog inside this one, and React hands its `close` to this handler too.
  return <dialog ref={dialog} className="shop-browse" style={accentStyle(pack.id)} aria-labelledby="shop-browse-title"
    onClose={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className="shop-browse__panel">
      <header>
        <div>
          <p className="shop-browse__eyebrow">{ownerLabel(pack)} · {cards.length} cards</p>
          <h2 id="shop-browse-title">{pack.name}</h2>
        </div>
        <label className="shop-browse__upgrade">
          <input type="checkbox" checked={upgraded} onChange={(event) => setUpgraded(event.target.checked)} />
          Upgrades
        </label>
        <button type="button" className="shop-browse__close" aria-label="Close pack" onClick={() => dialog.current?.close()}>×</button>
      </header>
      <ul className="shop-browse__grid">
        {cards.map((card) => {
          const face = faceOf(card, upgraded && Boolean(card.upgrade))
          return <li key={card.id}>
            <CardKeywordHelp def={face}>{(keywordHelpProps) => (
              <button {...keywordHelpProps} type="button" className={`compendium-card compendium-card--${card.owner} shop-browse__card`}
                aria-label={`${cardAccessibleName(face)}, ${face.rarity}`} onClick={() => setZoomed(card)}>
                <ScannedCardFace def={face} upgraded={upgraded && Boolean(card.upgrade)} />
              </button>
            )}</CardKeywordHelp>
          </li>
        })}
      </ul>
    </section>
    {zoomed ? <dialog ref={zoomDialog} className="compendium__detail shop-zoom" aria-label={`${zoomed.name}, both faces`}
      onClose={() => setZoomed(null)}>
      <button type="button" onClick={() => zoomDialog.current?.close()} aria-label="Close card detail">×</button>
      <div className="shop-zoom__faces">
        {[false, true].filter((face) => !face || Boolean(zoomed.upgrade)).map((face) => {
          const def = faceOf(zoomed, face)
          return <figure key={String(face)}>
            <span className="compendium__detail-card shop-zoom__card" role="group" tabIndex={0} aria-label={cardAccessibleName(def)}>
              <ScannedCardFace def={def} upgraded={face} full />
            </span>
            <figcaption>{face ? 'Upgraded' : 'Base'}</figcaption>
          </figure>
        })}
      </div>
    </dialog> : null}
  </dialog>
}

/** Asks before spending, then celebrates the pack that was bought. */
function PurchaseDialog({ pack, coins, onClose, onBrowse }: {
  pack: CardPackDef
  coins: number
  onClose: () => void
  onBrowse: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  const done = useRef<HTMLButtonElement>(null)
  const [bought, setBought] = useState(false)
  const [refusal, setRefusal] = useState('')
  useEffect(() => {
    const node = dialog.current
    if (node && !node.open) node.showModal()
    cancel.current?.focus()
  }, [])
  useEffect(() => { if (bought) done.current?.focus() }, [bought])
  const confirm = () => {
    let outcome: ReturnType<typeof buyPack> | null = null
    // Read-modify-write of the stored wallet: another tab may have spent the coins meanwhile.
    updateWallet((wallet) => {
      outcome = buyPack(wallet, pack.id)
      return outcome.wallet
    })
    const result = outcome as ReturnType<typeof buyPack> | null
    if (result?.ok) {
      setBought(true)
      playSoundEffect('magic')
    } else setRefusal(result?.reason === 'owned' ? 'You already own this pack.' : 'You no longer have enough coins.')
  }
  return <dialog ref={dialog} className="shop-confirm" style={accentStyle(pack.id)} data-bought={bought || undefined}
    aria-labelledby="shop-confirm-title" aria-describedby="shop-confirm-copy" onClose={onClose}>
    <section className="shop-confirm__panel menu-board">
      <div className="shop-confirm__art">
        {bought ? <span className="shop-confirm__burst" aria-hidden="true" /> : null}
        <PackFan id={pack.id} size="dialog" />
      </div>
      {bought ? <>
        <p className="shop-confirm__eyebrow">Pack unlocked</p>
        <h2 id="shop-confirm-title">{pack.name}</h2>
        <p id="shop-confirm-copy">Its {pack.cardIds.length} cards now join the reward decks of every run you start.</p>
        <p className="shop-confirm__balance"><CoinAmount coins={coins} size={22} /> left</p>
        <div className="shop-confirm__actions">
          <button type="button" className="shop-button shop-button--browse" onClick={onBrowse}>Browse cards</button>
          <button ref={done} type="button" className="shop-button shop-button--buy" onClick={() => dialog.current?.close()}>Done</button>
        </div>
      </> : <>
        <p className="shop-confirm__eyebrow">Confirm purchase</p>
        <h2 id="shop-confirm-title">Buy the {pack.name}?</h2>
        <p id="shop-confirm-copy">Its {pack.cardIds.length} cards join the reward decks of every run you start from now on.</p>
        <p className="shop-confirm__balance">
          <CoinAmount coins={CARD_PACK_PRICE} size={22} />
          <span aria-hidden="true">→</span>
          <span>{formatCoins(Math.max(0, coins - CARD_PACK_PRICE))} left</span>
        </p>
        {refusal ? <p className="shop-confirm__refusal" role="alert">{refusal}</p> : null}
        <div className="shop-confirm__actions">
          <button ref={cancel} type="button" className="shop-button shop-button--browse" onClick={() => dialog.current?.close()}>Cancel</button>
          <button type="button" className="shop-button shop-button--buy" disabled={Boolean(refusal)} onClick={confirm}>
            Buy for <CoinAmount coins={CARD_PACK_PRICE} size={20} />
          </button>
        </div>
      </>}
    </section>
  </dialog>
}

function SkinsTeaser() {
  return <div className="shop-skins">
    <header className="shop__section-head">
      <h2 id="shop-skins-title">Skins</h2>
    </header>
    <div className="shop-skins__display">
    <ul className="shop-skins__racks" aria-label="Skins on display">
      {SKIN_TEASERS.map((hero) => <li key={hero} className="shop-skin" aria-label={`${CHARACTER_LABEL[hero]} skin, coming soon`}>
        <img src={assetPath(`menu/character-select/portrait-${hero}.png`)} alt="" draggable={false} />
        <span className="shop-skin__veil" aria-hidden="true">
          <svg viewBox="0 0 24 24" className="shop-skin__lock"><path d="M7 10V7a5 5 0 0 1 10 0v3" /><rect x="4.5" y="10" width="15" height="11" rx="2" /><circle cx="12" cy="15.2" r="1.6" /></svg>
        </span>
        <span className="shop-skin__name" aria-hidden="true">{CHARACTER_LABEL[hero]}</span>
      </li>)}
    </ul>
    <p className="shop-skins__ribbon"><span>Coming soon</span></p>
    </div>
  </div>
}

export function ShopScreen({ onBack }: { onBack: () => void }) {
  const wallet = useWallet()
  const [tab, setTab] = useState<Tab>('packs')
  const [buying, setBuying] = useState<CardPackId | null>(null)
  const [browsing, setBrowsing] = useState<CardPackId | null>(null)
  const tabs = useRef(new Map<Tab, HTMLButtonElement>())
  const short = coinsShort(wallet)
  useEffect(() => { tabs.current.get('packs')?.focus({ preventScroll: true }) }, [])
  useEffect(() => {
    const leave = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || document.querySelector('dialog[open]')) return
      event.preventDefault()
      onBack()
    }
    document.addEventListener('keydown', leave)
    return () => document.removeEventListener('keydown', leave)
  }, [onBack])
  const choose = (next: Tab) => {
    setTab(next)
    tabs.current.get(next)?.focus()
  }
  const tabKeys = (event: ReactKeyboardEvent) => {
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
      event.preventDefault()
      choose(event.key === 'Home' ? 'packs' : event.key === 'End' ? 'skins' : tab === 'packs' ? 'skins' : 'packs')
    }
  }
  const tabButton = (id: Tab, label: string, note?: string) =>
    <button type="button" role="tab" className="shop__tab" id={`shop-tab-${id}`} aria-selected={tab === id} aria-controls={`shop-panel-${id}`}
      tabIndex={tab === id ? 0 : -1} onClick={() => setTab(id)} onKeyDown={tabKeys}
      ref={(element) => { if (element) tabs.current.set(id, element); else tabs.current.delete(id) }}>
      <span>{label}</span>{note ? <small>{note}</small> : null}
    </button>
  return (
    <main className="shop menu-ground" data-tab={tab}>
      <aside className="shop__rail menu-board menu-board--slate">
        <button type="button" className="shop__back ribbon-back" onClick={onBack} aria-label="Back to main menu"><span aria-hidden="true"></span></button>
        <h1>Shop</h1>
        <p className="shop__purse">
          <span className="visually-hidden">Your purse: </span>
          <CoinIcon size={52} className="shop__purse-icon" />
          <span><strong>{formatCoins(wallet.coins)}</strong><small>{wallet.coins === 1 ? 'coin' : 'coins'}</small></span>
        </p>
        <div className="shop__tabs" role="tablist" aria-label="Shop sections" aria-orientation="vertical">
          {tabButton('packs', 'Card Packs', `${wallet.packs.length}/${CARD_PACK_IDS.length}`)}
          {tabButton('skins', 'Skins', 'Soon')}
        </div>
      </aside>

      {/* One stable panel per tab, so each tab's aria-controls always names a real element. */}
      <section className="shop__stock menu-board" role="tabpanel" id="shop-panel-packs" aria-labelledby="shop-tab-packs"
        hidden={tab !== 'packs'}>
          <header className="shop__section-head">
            <h2>The Slayer Pack</h2>
          </header>
          <ul className="shop__packs">
            {CARD_PACK_IDS.map((id) => <PackTile key={id} pack={CARD_PACKS[id]} owned={ownsPack(wallet, id)} short={short}
              onBuy={() => setBuying(id)} onBrowse={() => setBrowsing(id)} />)}
          </ul>
      </section>
      <section className="shop__stock menu-board" role="tabpanel" id="shop-panel-skins" aria-labelledby="shop-tab-skins"
        hidden={tab !== 'skins'}>
        <SkinsTeaser />
      </section>

      {buying ? <PurchaseDialog key={buying} pack={CARD_PACKS[buying]} coins={wallet.coins} onClose={() => setBuying(null)}
        onBrowse={() => { setBuying(null); setBrowsing(buying) }} /> : null}
      {browsing ? <PackBrowser key={browsing} pack={CARD_PACKS[browsing]} onClose={() => setBrowsing(null)} /> : null}
    </main>
  )
}
