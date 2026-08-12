import { useEffect, useMemo, useRef, useState } from 'react'
import { CARDS, faceOf } from '../game/cards.ts'
import type { CardDef } from '../game/cards.ts'
import { cardImagePath } from '../game/assets.ts'
import { StatusIcon } from './Icon.tsx'
import { cardAccessibleName, cardPlayText } from './Card.tsx'

type Pool = CardDef['owner'] | 'all'

const POOLS: { id: Pool; label: string; sigil: string }[] = [
  { id: 'all', label: 'All cards', sigil: '✦' },
  { id: 'ironclad', label: 'Ironclad', sigil: '◒' },
  { id: 'silent', label: 'Silent', sigil: '◢' },
  { id: 'defect', label: 'Defect', sigil: '⌾' },
  { id: 'watcher', label: 'Watcher', sigil: '◇' },
  { id: 'colorless', label: 'Colorless', sigil: '☼' },
  { id: 'curse', label: 'Curses', sigil: '☠' },
  { id: 'status', label: 'Statuses', sigil: '✺' },
]

const CARDS_BY_NAME = Object.values(CARDS).sort((a, b) => a.name.localeCompare(b.name))

export function CompendiumScreen({ onBack }: { onBack: () => void }) {
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
      return (pool === 'all' || card.owner === pool) &&
        (type === 'all' || face.type === type) &&
        (rarities.size === 0 || rarities.has(face.rarity)) &&
        (cost === 'all' || (cost === '3+' ? typeof face.cost === 'number' && face.cost >= 3 : String(face.cost) === cost)) &&
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
        <button type="button" className="compendium__back" onClick={onBack} aria-label="Back to main menu">←</button>
        <h1>Compendium</h1>
        <label className="compendium__search">
          <span className="visually-hidden">Search cards</span>
          <input type="search" placeholder="Search" value={search}
            onChange={(event) => setSearch(event.target.value)} />
          {search ? <button type="button" onClick={() => setSearch('')} aria-label="Clear search">×</button> : null}
        </label>
        <div className="compendium__pools" role="group" aria-label="Card pool">
          {POOLS.map((entry) => (
            <button key={entry.id} type="button" title={entry.label} aria-label={entry.label}
              aria-pressed={pool === entry.id} onClick={() => setPool(entry.id)}>{entry.sigil}</button>
          ))}
        </div>
        <section className="compendium__filter-block">
          <h2>Card Type <span aria-hidden="true">≡↓</span></h2>
          <div className="compendium__types" role="group" aria-label="Card type">
            <button type="button" aria-label="All card types" aria-pressed={type === 'all'} onClick={() => setType('all')}>?</button>
            <button type="button" aria-label="Attack cards" aria-pressed={type === 'attack'} onClick={() => setType('attack')}><StatusIcon name="attack" /></button>
            <button type="button" aria-label="Skill cards" aria-pressed={type === 'skill'} onClick={() => setType('skill')}><StatusIcon name="block" /></button>
            <button type="button" aria-label="Power cards" aria-pressed={type === 'power'} onClick={() => setType('power')}><StatusIcon name="power" /></button>
          </div>
        </section>
        <section className="compendium__filter-block">
          <h2>Rarity <span aria-hidden="true">≡↓</span></h2>
          <div className="compendium__checks">
            {(['starter', 'common', 'uncommon', 'rare', 'special'] as const).map((value) => (
              <label key={value}><input type="checkbox" checked={rarities.has(value)}
                onChange={() => toggleRarity(value)} /> {value === 'special' ? 'Other' : value}</label>
            ))}
          </div>
        </section>
        <section className="compendium__filter-block">
          <h2>Cost <span aria-hidden="true">≡↓</span></h2>
          <div className="compendium__segments" role="group" aria-label="Energy cost">
            {(['all', '0', '1', '2', '3+', 'X'] as const).map((value) => (
              <button type="button" key={value} aria-label={value === 'all' ? 'Any energy cost' : `${value} energy`}
                aria-pressed={cost === value} onClick={() => setCost(value)}>{value === 'all' ? '•' : value}</button>
            ))}
          </div>
        </section>
        <button type="button" className="compendium__sort" aria-pressed={ascending}
          onClick={() => setAscending((value) => !value)}>A – Z <span aria-hidden="true">≡{ascending ? '↓' : '↑'}</span></button>
        <label className="compendium__upgrade">
          <input type="checkbox" checked={upgraded} onChange={(event) => setUpgraded(event.target.checked)} />
          View upgrades
        </label>
      </aside>

      <section className="compendium__library" aria-labelledby="library-title">
        <header><h2 id="library-title">{POOLS.find((entry) => entry.id === pool)?.label}</h2><span aria-live="polite">{cards.length} cards</span></header>
        <div className="compendium__grid">
          {cards.map((card) => {
            const showUpgrade = upgraded && Boolean(card.upgrade)
            const face = faceOf(card, showUpgrade)
            const playText = cardPlayText(face)
            return (
              <button type="button" className={`compendium-card compendium-card--${card.owner}`}
                key={card.id} onClick={() => setSelected(card)}
                aria-label={`${cardAccessibleName(face)}, ${face.rarity}`}>
                {card.owner !== 'status' ? (
                  <img src={cardImagePath(face, showUpgrade)} alt="" loading="lazy"
                    onLoad={(event) => { event.currentTarget.style.visibility = 'visible' }}
                    onError={(event) => { event.currentTarget.style.visibility = 'hidden' }} />
                ) : null}
                <span className="compendium-card__fallback"><strong>{face.name}</strong><small>{face.type} · {face.rarity}</small>
                  {playText ? <span className="compendium-card__rules">{playText}</span> : null}
                </span>
              </button>
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
          <span className="compendium__detail-card">
                {selected?.owner !== 'status' ? (
                  <img src={cardImagePath(selectedFace, upgraded && Boolean(selected?.upgrade))} alt=""
                    onLoad={(event) => { event.currentTarget.style.visibility = 'visible' }}
                    onError={(event) => { event.currentTarget.style.visibility = 'hidden' }} />
                ) : null}
                <span className="compendium-card__fallback"><strong>{selectedFace.name}</strong><small>{selectedFace.type} · {selectedFace.rarity}</small>
                  <span className="compendium-card__rules">{cardPlayText(selectedFace)}</span>
                </span>
              </span>
        </dialog>
      ) : null}
    </main>
  )
}
