// The Shop: where a profile spends the coins its boss victories paid. Two
// sections — the five Slayer card packs, and the Skins (one rack per skin in
// `skins.ts`, plus locked racks for the heroes without one yet). A bought pack's
// cards join every new run's reward decks, a bought skin is worn from here or
// from Profile (see docs/shop.md). The screen sits on the same painted Spire and parchment boards
// as the Leaderboard and Stats.
import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { assetPath, cardThumbPath } from '../game/assets.ts'
import { CARD_PACK_PRICE, SKIN_PRICES } from '../game/coins.ts'
import { cardDef, faceOf } from '../game/cards.ts'
import type { CardDef } from '../game/cards.ts'
import { CARD_PACK_IDS, CARD_PACKS } from '../game/packs.ts'
import type { CardPackDef, CardPackId } from '../game/packs.ts'
import { characterOfSkin, SKIN_IDS, SKIN_LABELS, skinsOf } from '../game/skins.ts'
import type { SkinId } from '../game/skins.ts'
import { BASE_CHARACTER_IDS } from '../game/types.ts'
import type { CharacterId } from '../game/types.ts'
import { setPreferredSkin, wearBoughtSkin } from '../skin-preference.ts'
import { coinsShort, ownsPack, ownsSkin } from '../wallet.ts'
import { purchasePack, purchaseSkin } from '../wallet-storage.ts'
import { CardKeywordHelp, cardAccessibleName } from './Card.tsx'
import { CoinAmount, CoinIcon, formatCoins } from './Coins.tsx'
import { ScannedCardFace } from './CompendiumScreen.tsx'
import { cardSkin, usePreferredSkins, useCardSkins } from './skin-context.tsx'
import { CHARACTER_LABEL } from './run-summary-data.ts'
import { playSoundEffect } from './sfx.ts'
import { useWallet } from './useWallet.ts'

export type ShopTab = 'packs' | 'skins'
type Tab = ShopTab

/** Each pack's colour, after the hero it belongs to; Colorless stays a cool grey. */
const PACK_ACCENT: Record<CardPackId, string> = {
  slayer_ironclad: '#d2402f',
  slayer_silent: '#47a456',
  slayer_defect: '#3a8bdc',
  slayer_watcher: '#9a5ad8',
  slayer_colorless: '#a3a7ad',
}

/** The three cards fanned on each pack: a showcase of its signature cards. */
const PACK_FAN: Record<CardPackId, readonly [string, string, string]> = {
  slayer_ironclad: ['slayer_brutality', 'slayer_reaper', 'slayer_searing_blow'],
  slayer_silent: ['slayer_caltrops', 'slayer_nightmare', 'slayer_phantasmal_killer'],
  slayer_defect: ['slayer_aggregate', 'slayer_creative_ai', 'slayer_reboot'],
  slayer_watcher: ['slayer_bowling_bash', 'slayer_master_reality', 'slayer_wheel_kick'],
  slayer_colorless: ['slayer_bandage_up', 'slayer_secret_technique', 'slayer_violence'],
}

/** A skin's rack is lit in its hero's colour. */
const HERO_ACCENT: Partial<Record<CharacterId, string>> = {
  ironclad: PACK_ACCENT.slayer_ironclad,
  silent: PACK_ACCENT.slayer_silent,
  defect: PACK_ACCENT.slayer_defect,
  watcher: PACK_ACCENT.slayer_watcher,
}
const heroAccent = (hero: CharacterId) => HERO_ACCENT[hero] ?? PACK_ACCENT.slayer_colorless

/** The base heroes with no skin yet: they keep a locked rack so the tab shows what is coming. */
const LOCKED_HEROES = BASE_CHARACTER_IDS.filter((hero) => skinsOf(hero).length === 0)

/** The Shop's painted icons (see docs/shop-icons.json). */
const ICON = {
  pack: assetPath('shop/pack.webp'),
  skins: assetPath('shop/skins.webp'),
  browse: assetPath('shop/browse.webp'),
  owned: assetPath('shop/owned.webp'),
  lock: assetPath('shop/lock.webp'),
  deck: assetPath('menu/current-deck.webp'),
}

const ownerLabel = (pack: CardPackDef) => pack.owner === 'colorless' ? 'Colorless' : CHARACTER_LABEL[pack.owner]
const accentStyle = (id: CardPackId) => ({ '--pack-accent': PACK_ACCENT[id] }) as CSSProperties
const heroAccentStyle = (hero: CharacterId) => ({ '--pack-accent': heroAccent(hero) }) as CSSProperties
const heroCrest = (hero: CharacterId | 'colorless') => assetPath(`menu/compendium-icons/${hero}.webp`)
const heroPortrait = (visual: string) => assetPath(`menu/character-select/portrait-${visual}.png`)

/** What the purchase dialog sells: a pack, or a skin. */
type Offer = { pack: CardPackDef } | { skin: SkinId }

function Icon({ src, className }: { src: string; className: string }) {
  return <img className={className} src={src} alt="" aria-hidden="true" draggable={false} />
}

function PackFan({ id, size = 'tile' }: { id: CardPackId; size?: 'tile' | 'dialog' }) {
  const skins = useCardSkins()
  return <span className={`shop-fan shop-fan--${size}`} aria-hidden="true">
    {PACK_FAN[id].map((cardId, index) =>
      <img key={cardId} className={`shop-fan__card shop-fan__card--${index}`} src={cardThumbPath(cardDef(cardId), false, undefined, cardSkin(skins, cardDef(cardId)))}
        alt="" draggable={false} />)}
  </span>
}

/** The hero's emblem from the Compendium, crowning the pack. */
function PackCrest({ pack }: { pack: CardPackDef }) {
  return <Icon className="shop-crest" src={assetPath(`menu/compendium-icons/${pack.owner}.webp`)} />
}

function PackTile({ pack, owned, short, onBuy, onBrowse }: {
  pack: CardPackDef
  owned: boolean
  short: number
  onBuy: () => void
  onBrowse: () => void
}) {
  const headingId = `shop-pack-${pack.id}`
  const progress = { '--progress': (CARD_PACK_PRICE - short) / CARD_PACK_PRICE } as CSSProperties
  // The name keeps the visible price, so "click 960" works for voice control.
  const price = `${formatCoins(CARD_PACK_PRICE)} coins`
  return <li className="shop-pack" data-pack={pack.id} data-owned={owned || undefined} style={accentStyle(pack.id)}
    aria-labelledby={headingId}>
    <PackCrest pack={pack} />
    <button type="button" className="shop-pack__art" aria-label={`Browse the ${pack.cardIds.length} cards of the ${pack.name}`}
      onClick={onBrowse}>
      <PackFan id={pack.id} />
      <span className="shop-pack__count" aria-hidden="true"><Icon className="shop-pack__count-icon" src={ICON.deck} />{pack.cardIds.length}</span>
      <Icon className="shop-pack__zoom" src={ICON.browse} />
    </button>
    <h3 id={headingId}>{ownerLabel(pack)}<span className="visually-hidden"> Slayer Pack</span></h3>
    {owned ? <p className="shop-pack__owned"><Icon className="shop-pack__owned-icon" src={ICON.owned} />Owned</p>
      : <button type="button" className="shop-button shop-button--buy shop-pack__buy" disabled={short > 0} style={progress}
        aria-label={short > 0 ? `Not enough coins for ${pack.name}, ${price}: need ${formatCoins(short)} more` : `Buy ${pack.name}, ${price}`}
        onClick={onBuy}>
        <CoinAmount coins={CARD_PACK_PRICE} size={26} />
      </button>}
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
        <PackCrest pack={pack} />
        <h2 id="shop-browse-title">{pack.name}</h2>
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
function PurchaseDialog({ offer, coins, onClose, onBrowse }: {
  offer: Offer
  coins: number
  onClose: () => void
  onBrowse?: () => void
}) {
  const skin = 'skin' in offer ? offer.skin : null
  const pack = 'pack' in offer ? offer.pack : null
  const hero: CharacterId | 'colorless' = skin ? characterOfSkin(skin) : pack!.owner
  const name = skin ? `${SKIN_LABELS[skin]} skin` : pack!.name
  const price = skin ? SKIN_PRICES[skin] : CARD_PACK_PRICE
  const style = skin ? heroAccentStyle(characterOfSkin(skin)) : accentStyle(pack!.id)
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
  const [buying, setBuying] = useState(false)
  const confirm = async () => {
    if (buying) return
    setBuying(true)
    setRefusal('')
    try {
      const result = skin ? await purchaseSkin(skin) : await purchasePack(pack!.id)
      if (result.ok && skin) wearBoughtSkin(skin)
      if (result.ok) {
        setBought(true)
        playSoundEffect('magic')
      } else setRefusal(result.reason === 'owned' ? `You already own this ${skin ? 'skin' : 'pack'}.` : 'You no longer have enough coins.')
    } catch { setRefusal('Could not reach the Shop. Please try again.') }
    finally { setBuying(false) }
  }
  return <dialog ref={dialog} className="shop-confirm" style={style} data-bought={bought || undefined}
    aria-label={bought ? `${name} unlocked` : `Buy the ${name}?`} aria-describedby="shop-confirm-copy" onClose={onClose}>
    <section className="shop-confirm__panel menu-board">
      <div className={`shop-confirm__art${skin ? ' shop-confirm__art--skin' : ''}`}>
        {bought ? <span className="shop-confirm__burst" aria-hidden="true" /> : null}
        {skin ? <img className="shop-confirm__portrait" src={heroPortrait(skin)} alt="" draggable={false} />
          : <PackFan id={pack!.id} size="dialog" />}
        {bought ? <Icon className="shop-confirm__seal" src={ICON.owned} /> : null}
      </div>
      <h2><Icon className="shop-crest" src={heroCrest(hero)} />{name}</h2>
      <p id="shop-confirm-copy" className="shop-confirm__copy">
        {skin ? `${CHARACTER_LABEL[characterOfSkin(skin)]} skin` : <>
          <Icon className="shop-confirm__deck" src={ICON.deck} />
          {pack!.cardIds.length} cards join every run you start
        </>}
      </p>
      {bought ? <>
        <p className="shop-confirm__balance"><CoinAmount coins={coins} size={26} /><span className="visually-hidden"> left</span></p>
        <div className="shop-confirm__actions">
          {onBrowse ? <button type="button" className="shop-button" onClick={onBrowse}>
            <Icon className="shop-button__icon" src={ICON.browse} />Browse
          </button> : null}
          <button ref={done} type="button" className="shop-button shop-button--buy" onClick={() => dialog.current?.close()}>Done</button>
        </div>
      </> : <>
        <p className="shop-confirm__balance">
          <CoinAmount coins={coins} size={26} />
          <span className="shop-confirm__arrow" aria-hidden="true" />
          <span className="visually-hidden">, after buying: </span>
          <CoinAmount coins={Math.max(0, coins - price)} size={26} />
        </p>
        {refusal ? <p className="shop-confirm__refusal" role="alert">{refusal}</p> : null}
        <div className="shop-confirm__actions">
          <button ref={cancel} type="button" className="shop-button" onClick={() => dialog.current?.close()}>Cancel</button>
          <button type="button" className="shop-button shop-button--buy" disabled={buying} aria-busy={buying} onClick={confirm}>
            Buy <CoinAmount coins={price} size={22} />
          </button>
        </div>
      </>}
    </section>
  </dialog>
}

/** One skin on offer: its portrait, its price to buy, then Owned and a Wear control. */
function SkinRack({ skin, owned, worn, short, onBuy, onWear }: {
  skin: SkinId
  owned: boolean
  worn: boolean
  short: number
  onBuy: () => void
  onWear: () => void
}) {
  const hero = characterOfSkin(skin)
  const name = SKIN_LABELS[skin]
  const price = SKIN_PRICES[skin]
  const headingId = `shop-skin-${skin}`
  const progress = { '--progress': (price - short) / price } as CSSProperties
  const cost = `${formatCoins(price)} coins`
  return <li className="shop-skin" data-skin={skin} data-owned={owned || undefined} data-worn={worn || undefined}
    style={heroAccentStyle(hero)} aria-labelledby={headingId}>
    <span className="shop-skin__art">
      <img className="shop-skin__portrait" src={heroPortrait(skin)} alt="" draggable={false} />
      {owned ? <Icon className="shop-skin__seal" src={ICON.owned} /> : null}
    </span>
    <h3 id={headingId}>{name}<small><Icon className="shop-skin__crest" src={heroCrest(hero)} />{CHARACTER_LABEL[hero]}</small></h3>
    {owned ? <button type="button" className="shop-button shop-skin__wear" aria-pressed={worn}
      aria-label={`${worn ? 'Worn' : 'Wear'}: ${name}, ${CHARACTER_LABEL[hero]} skin`} onClick={onWear}>
      {worn ? '✓ Worn' : 'Wear'}
    </button> : <button type="button" className="shop-button shop-button--buy shop-skin__buy" disabled={short > 0} style={progress}
      aria-label={short > 0 ? `Not enough coins for the ${name} skin, ${cost}: need ${formatCoins(short)} more` : `Buy the ${name} skin, ${cost}`}
      onClick={onBuy}>
      <CoinAmount coins={price} size={26} />
    </button>}
  </li>
}

/** A hero whose skins are not made yet. */
function LockedRack({ hero }: { hero: CharacterId }) {
  return <li className="shop-skin shop-skin--locked" aria-label={`${CHARACTER_LABEL[hero]} skin, coming soon`}>
    <span className="shop-skin__art">
      <img className="shop-skin__portrait" src={heroPortrait(hero)} alt="" draggable={false} />
      <span className="shop-skin__veil" aria-hidden="true"><Icon className="shop-skin__lock" src={ICON.lock} /></span>
    </span>
    <p className="shop-skin__soon" aria-hidden="true">{CHARACTER_LABEL[hero]}<small>Coming soon</small></p>
  </li>
}

export function ShopScreen({ onBack, initialTab = 'packs' }: { onBack: () => void; initialTab?: ShopTab }) {
  const wallet = useWallet()
  const wearing = usePreferredSkins()
  const [tab, setTab] = useState<Tab>(initialTab)
  const [buying, setBuying] = useState<Offer | null>(null)
  const [browsing, setBrowsing] = useState<CardPackId | null>(null)
  const tabs = useRef(new Map<Tab, HTMLButtonElement>())
  const short = coinsShort(wallet)
  useEffect(() => { tabs.current.get(initialTab)?.focus({ preventScroll: true }) }, [initialTab])
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
  const tabButton = (id: Tab, label: string, icon: string) =>
    <button type="button" role="tab" className="shop__tab" id={`shop-tab-${id}`} aria-selected={tab === id} aria-controls={`shop-panel-${id}`}
      tabIndex={tab === id ? 0 : -1} onClick={() => setTab(id)} onKeyDown={tabKeys}
      ref={(element) => { if (element) tabs.current.set(id, element); else tabs.current.delete(id) }}>
      <Icon className="shop__tab-icon" src={icon} /><span>{label}</span>
    </button>
  return (
    <main className="shop menu-ground" data-tab={tab}>
      <aside className="shop__rail menu-board menu-board--slate">
        <button type="button" className="shop__back ribbon-back" onClick={onBack} aria-label="Back to main menu"><span aria-hidden="true"></span></button>
        <h1>Shop</h1>
        <p className="shop__purse">
          <span className="visually-hidden">Your purse: </span>
          <CoinIcon size={52} className="shop__purse-icon" />
          <strong>{formatCoins(wallet.coins)}</strong>
          <span className="visually-hidden"> {wallet.coins === 1 ? 'coin' : 'coins'}</span>
        </p>
        <div className="shop__tabs" role="tablist" aria-label="Shop sections" aria-orientation="vertical">
          {tabButton('packs', 'Card Packs', ICON.pack)}
          {tabButton('skins', 'Skins', ICON.skins)}
        </div>
        <Icon className="shop__merchant" src={assetPath('noncombat/merchant/merchant-seated.webp')} />
      </aside>

      {/* One stable panel per tab, so each tab's aria-controls always names a real element. */}
      <section className="shop__stock menu-board" role="tabpanel" id="shop-panel-packs" aria-labelledby="shop-tab-packs"
        hidden={tab !== 'packs'}>
        <h2 className="shop__title">The Slayer Pack</h2>
        <ul className="shop__packs shop__scene">
          {CARD_PACK_IDS.map((id) => <PackTile key={id} pack={CARD_PACKS[id]} owned={ownsPack(wallet, id)} short={short}
            onBuy={() => setBuying({ pack: CARD_PACKS[id] })} onBrowse={() => setBrowsing(id)} />)}
        </ul>
      </section>
      <section className="shop__stock menu-board" role="tabpanel" id="shop-panel-skins" aria-labelledby="shop-tab-skins"
        hidden={tab !== 'skins'}>
        <h2 className="shop__title">Skins</h2>
        <div className="shop-skins shop__scene">
          <ul className="shop-skins__racks" aria-label="Skins on display">
            {SKIN_IDS.map((skin) => {
              const hero = characterOfSkin(skin)
              return <SkinRack key={skin} skin={skin} owned={ownsSkin(wallet, skin)} worn={wearing[hero] === skin}
                short={coinsShort(wallet, SKIN_PRICES[skin])} onBuy={() => setBuying({ skin })}
                onWear={() => setPreferredSkin(hero, wearing[hero] === skin ? undefined : skin)} />
            })}
            {LOCKED_HEROES.map((hero) => <LockedRack key={hero} hero={hero} />)}
          </ul>
        </div>
      </section>

      {buying ? <PurchaseDialog key={'skin' in buying ? buying.skin : buying.pack.id} offer={buying} coins={wallet.coins}
        onClose={() => setBuying(null)}
        onBrowse={'pack' in buying ? () => { setBuying(null); setBrowsing(buying.pack.id) } : undefined} /> : null}
      {browsing ? <PackBrowser key={browsing} pack={CARD_PACKS[browsing]} onClose={() => setBrowsing(null)} /> : null}
    </main>
  )
}
