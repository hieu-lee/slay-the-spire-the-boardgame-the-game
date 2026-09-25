import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { CARDS, cardIsCurse, faceOf } from '../game/cards.ts'
import type { CardDef } from '../game/cards.ts'
import { assetPath, cardImagePath, cardThumbPath } from '../game/assets.ts'
import { StatusIcon } from './Icon.tsx'
import { CardKeywordHelp, cardAccessibleName, cardPlayText, revealDecodedImage } from './Card.tsx'
import { CardFace } from './CardFace.tsx'

type Pool = CardDef['owner'] | 'all'

const POOLS: { id: Pool; label: string }[] = [
  { id: 'all', label: 'All cards' },
  { id: 'ironclad', label: 'Ironclad' },
  { id: 'silent', label: 'Silent' },
  { id: 'defect', label: 'Defect' },
  { id: 'watcher', label: 'Watcher' },
  { id: 'slime_boss', label: 'Slime Boss' },
  { id: 'guardian', label: 'Guardian' },
  { id: 'hexaghost', label: 'Hexaghost' },
  { id: 'hermit', label: 'Hermit' },
  { id: 'colorless', label: 'Colorless' },
  { id: 'curse', label: 'Curses' },
  { id: 'status', label: 'Statuses' },
]

const CARDS_BY_NAME = Object.values(CARDS).sort((a, b) => a.name.localeCompare(b.name))

const RARITIES = [
  { id: 'starter', label: 'Starter' },
  { id: 'common', label: 'Common' },
  { id: 'uncommon', label: 'Uncommon' },
  { id: 'rare', label: 'Rare' },
  { id: 'special', label: 'Other' },
  { id: 'curse', label: 'Curse' },
] as const

/**
 * Guardian Gems are printed on clear plastic, so their scans are grey slabs.
 * The compendium multiplies each over its stone's colour. The tints stay light
 * because the multiply also tints the scan's white rules text.
 */
const GEM_TINTS: Record<string, string> = {
  Amber: '#f3b440', Amethyst: '#b98ae6', Aquamarine: '#7fe0e4', Bismuth: '#c9a8ff', Emerald: '#6fdc98',
  Garnet: '#e4808f', Jasper: '#e39a7a', Morganite: '#f6b9c6', Onyx: '#a9adb8', Opal: '#d9eef6',
  Pearl: '#f4efe6', Peridot: '#c6e070', Ruby: '#f07a9e', Sapphire: '#86a8f2', Tourmaline: '#eea0c8',
}
const gemTint = (card: CardDef): CSSProperties | undefined => card.guardian?.printedType === 'Gem' && GEM_TINTS[card.name]
  ? { '--gem': GEM_TINTS[card.name] } as CSSProperties
  : undefined

/**
 * `full` is for the zoom dialog only. The grid paints 208px tiles, and the full
 * scans cost 3 MB of decoded texture each — enough that browsing the library on
 * a phone held over 100 MB of card art at once.
 *
 * The zoom therefore fetches a URL the grid did not warm, so the first zoom of a
 * card shows this component's own card face for as long as the scan takes to
 * arrive. That is the designed fallback face — a complete, legible card — and
 * paying a moment of it once per card beats holding the grid at full resolution.
 */
function ScannedCardFace({ def, upgraded, full = false }: {
  def: CardDef
  upgraded: boolean
  full?: boolean
}) {
  const src = full ? cardImagePath(def, upgraded) : cardThumbPath(def, upgraded)
  const [scanUnavailable, setScanUnavailable] = useState(false)
  useEffect(() => setScanUnavailable(false), [src])
  return (
    <>
      <img src={src} alt="" loading="lazy" decoding="async"
        onLoad={(event) => {
          const image = event.currentTarget
          revealDecodedImage(image, {
            isCurrent: () => image.isConnected && image.getAttribute('src') === src,
            onDecodeError: () => setScanUnavailable(true),
          })
        }}
        onError={(event) => {
          if (event.currentTarget.getAttribute('src') !== src) return
          event.currentTarget.style.visibility = 'hidden'
          setScanUnavailable(true)
        }} />
      <CardFace def={def} rules={cardPlayText(def)} illustration={scanUnavailable} />
    </>
  )
}

export function CompendiumScreen({ onBack, backLabel = 'Back to main menu' }: { onBack: () => void; backLabel?: string }) {
  const [pool, setPool] = useState<Pool>('all')
  const [search, setSearch] = useState('')
  const [type, setType] = useState<'all' | CardDef['type']>('all')
  const [rarities, setRarities] = useState<Set<CardDef['rarity']>>(new Set())
  const [cost, setCost] = useState<'all' | '0' | '1' | '2' | '3+' | 'X'>('all')
  const [ascending, setAscending] = useState(true)
  const [upgraded, setUpgraded] = useState(false)
  const [selected, setSelected] = useState<CardDef | null>(null)
  const detailRef = useRef<HTMLDialogElement | null>(null)

  useEffect(() => {
    const dialog = detailRef.current
    if (selected && dialog && !dialog.open) dialog.showModal()
  }, [selected])

  const cards = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase()
    return CARDS_BY_NAME.filter((card) => {
      const face = faceOf(card, upgraded && Boolean(card.upgrade))
      return (pool === 'all' || (pool === 'curse' ? cardIsCurse(card.id) : card.owner === pool)) &&
        (type === 'all' || face.type === type) &&
        (rarities.size === 0 || rarities.has(face.rarity)) &&
        (cost === 'all' || (!face.unplayable &&
          (cost === '3+' ? typeof face.cost === 'number' && face.cost >= 3 : String(face.cost) === cost))) &&
        (!needle || face.name.toLocaleLowerCase().includes(needle))
    })
      .sort((a, b) => (ascending ? 1 : -1) * a.name.localeCompare(b.name))
  }, [ascending, cost, pool, rarities, search, type, upgraded])

  const toggleRarity = (value: CardDef['rarity']) => setRarities((current) => {
    const next = new Set(current)
    if (next.has(value)) next.delete(value)
    else next.add(value)
    return next
  })
  const selectedFace = selected ? faceOf(selected, upgraded && Boolean(selected.upgrade)) : null

  return (
    <main className="compendium">
      <aside className="compendium__filters">
        <header className="compendium__head">
          <button type="button" className="compendium__back ribbon-back" onClick={onBack} aria-label={backLabel}><span aria-hidden="true"></span></button>
          <h1>Compendium</h1>
        </header>
        <label className="compendium__search">
          <span className="visually-hidden">Search cards</span>
          <input type="search" placeholder="Search" value={search}
            onChange={(event) => setSearch(event.target.value)} />
          {search ? <button type="button" onClick={() => setSearch('')} aria-label="Clear search">×</button> : null}
        </label>
        <div className="compendium__pools" role="group" aria-label="Card pool">
          {POOLS.map((entry) => (
            <button key={entry.id} type="button" title={entry.label} aria-label={entry.label}
              aria-pressed={pool === entry.id} onClick={() => setPool(entry.id)}>
              <img src={assetPath(`menu/compendium-icons/${entry.id}.webp`)} alt="" />
            </button>
          ))}
        </div>
        <section className="compendium__filter-block">
          <h2>Type</h2>
          <div className="compendium__types" role="group" aria-label="Card type">
            <button type="button" aria-label="All card types" aria-pressed={type === 'all'} onClick={() => setType('all')}>All</button>
            <button type="button" aria-label="Attack cards" aria-pressed={type === 'attack'} onClick={() => setType('attack')}><StatusIcon name="attack" /></button>
            <button type="button" aria-label="Skill cards" aria-pressed={type === 'skill'} onClick={() => setType('skill')}><StatusIcon name="block" /></button>
            <button type="button" aria-label="Power cards" aria-pressed={type === 'power'} onClick={() => setType('power')}><StatusIcon name="power" /></button>
            <button type="button" aria-label="Slime cards" aria-pressed={type === 'slime'} onClick={() => setType('slime')}><StatusIcon name="slime" /></button>
          </div>
        </section>
        <section className="compendium__filter-block">
          <h2>Rarity</h2>
          <div className="compendium__checks">
            {RARITIES.map(({ id, label }) => (
              <label key={id} className={`compendium__rarity compendium__rarity--${id}`}>
                <input type="checkbox" aria-label={id === 'special' ? 'Other' : id} checked={rarities.has(id)}
                  onChange={() => toggleRarity(id)} />{label}
              </label>
            ))}
          </div>
        </section>
        <section className="compendium__filter-block">
          <h2>Cost</h2>
          <div className="compendium__segments" role="group" aria-label="Energy cost">
            {(['all', '0', '1', '2', '3+', 'X'] as const).map((value) => (
              <button type="button" key={value} aria-label={value === 'all' ? 'All energy costs' : `${value} energy`}
                aria-pressed={cost === value} onClick={() => setCost(value)}>{value === 'all' ? 'All' : value}</button>
            ))}
          </div>
        </section>
      </aside>

      <section className="compendium__library" aria-labelledby="library-title">
        <header>
          <h2 id="library-title">{POOLS.find((entry) => entry.id === pool)?.label}</h2>
          <span aria-live="polite">{cards.length} {cards.length === 1 ? 'card' : 'cards'}</span>
          <div className="compendium__toggles">
            <button type="button" className="compendium__sort" aria-label={ascending ? 'Sorted A–Z' : 'Sorted Z–A'}
              onClick={() => setAscending((value) => !value)}>{ascending ? 'A–Z' : 'Z–A'}</button>
            <label className="compendium__upgrade">
              <input type="checkbox" aria-label="View upgrades" checked={upgraded} onChange={(event) => setUpgraded(event.target.checked)} />
              Upgrades
            </label>
          </div>
        </header>
        <div className="compendium__grid">
          {cards.map((card) => {
            const showUpgrade = upgraded && Boolean(card.upgrade)
            const face = faceOf(card, showUpgrade)
            return (
              <CardKeywordHelp def={face} key={card.id}>{(keywordHelpProps) => (
                <button {...keywordHelpProps} type="button" className={`compendium-card compendium-card--${card.owner}`} style={gemTint(face)}
                  onClick={() => setSelected(card)} aria-label={`${cardAccessibleName(face)}, ${face.rarity}`}>
                  <ScannedCardFace def={face} upgraded={showUpgrade} />
                </button>
              )}</CardKeywordHelp>
            )
          })}
        </div>
        {cards.length === 0 ? <p className="compendium__empty">No cards match these filters.</p> : null}
      </section>

      {selectedFace ? (
        <dialog ref={detailRef} className="compendium__detail"
          aria-label={`${cardAccessibleName(selectedFace)}, ${selectedFace.rarity}, card detail`}
          onClose={() => setSelected(null)}>
          <button type="button" onClick={() => detailRef.current?.close()} aria-label="Close card detail">×</button>
          <CardKeywordHelp def={selectedFace}>{(keywordHelpProps) => (
            <span {...keywordHelpProps} className="compendium__detail-card" role="group" tabIndex={0} style={gemTint(selectedFace)}
              aria-label={cardAccessibleName(selectedFace)}>
              <ScannedCardFace def={selectedFace} upgraded={upgraded && Boolean(selected?.upgrade)} full />
            </span>
          )}</CardKeywordHelp>
        </dialog>
      ) : null}
    </main>
  )
}
