import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { cardDef, faceOf } from '../game/cards.ts'
import type { CardInstance } from '../game/types.ts'
import { Card } from './Card.tsx'

type CardCollectionOverlayProps = {
  cards: readonly CardInstance[]
  label: string
  triggerClassName: string
  children: ReactNode
  dataPile?: 'discard' | 'exhaust'
}

/** One read-only card viewer for the deck and both face-up combat piles. */
export function CardCollectionOverlay({
  cards, label, triggerClassName, children, dataPile,
}: CardCollectionOverlayProps) {
  const [open, setOpen] = useState(false)
  const [sort, setSort] = useState<'obtained' | 'type' | 'cost' | 'name'>('obtained')
  const [ascending, setAscending] = useState(true)
  const [viewUpgrades, setViewUpgrades] = useState(false)
  const dialog = useRef<HTMLDialogElement | null>(null)
  const titleId = useId()
  const sortedCards = useMemo(() => cards.map((card, index) => ({
    card: viewUpgrades && cardDef(card.defId).upgrade ? { ...card, upgraded: true } : card, index,
  })).sort((left, right) => {
    const leftDef = faceOf(cardDef(left.card.defId), left.card.upgraded)
    const rightDef = faceOf(cardDef(right.card.defId), right.card.upgraded)
    const byName = leftDef.name.localeCompare(rightDef.name)
    const byType = leftDef.type.localeCompare(rightDef.type) || byName
    const leftCost = typeof leftDef.cost === 'number' ? leftDef.cost : Number.POSITIVE_INFINITY
    const rightCost = typeof rightDef.cost === 'number' ? rightDef.cost : Number.POSITIVE_INFINITY
    const compared = sort === 'obtained' ? left.index - right.index
      : sort === 'type' ? byType
        : sort === 'cost' ? leftCost - rightCost || byName
          : byName
    return (compared || left.index - right.index) * (ascending ? 1 : -1)
  }).map(({ card }) => card),
  [ascending, cards, sort, viewUpgrades])
  const chooseSort = (next: typeof sort) => {
    if (next === sort) setAscending((current) => !current)
    else { setSort(next); setAscending(true) }
  }

  useEffect(() => {
    const element = dialog.current
    if (!element) return
    if (open) {
      if (!element.open) element.showModal()
    } else if (element.open) element.close()
  }, [open])

  return <>
    <button type="button" className={triggerClassName} data-pile={dataPile}
      aria-label={`${label}, ${cards.length} card${cards.length === 1 ? '' : 's'}`}
      title={label} onClick={() => setOpen(true)}>
      {children}
    </button>
    <dialog ref={dialog} className="choice-modal card-collection" aria-labelledby={titleId}
      onClose={() => setOpen(false)}>
      <div className="choice-modal__panel">
        <header className="card-collection__header"><h2 id={titleId}>{label}</h2>
          <span>{cards.length} card{cards.length === 1 ? '' : 's'}</span></header>
        <div className="card-collection__sort" role="group" aria-label="Sort cards">
          {([['obtained', 'Obtained'], ['type', 'Card Type'], ['cost', 'Cost'], ['name', 'A - Z']] as const).map(([key, text]) =>
            <button type="button" key={key} aria-pressed={sort === key} onClick={() => chooseSort(key)}>
              {text} <span aria-hidden="true">{sort === key ? ascending ? '↑' : '↓' : '↕'}</span>
            </button>)}
        </div>
        <div className="choice-modal__cards">
          {open ? sortedCards.map((card) => <Card key={card.uid} card={card} playable={false} />) : null}
          {open && cards.length === 0 ? <span className="muted">No cards.</span> : null}
        </div>
        <footer className="card-collection__footer"><label><input type="checkbox" aria-label={`${label} upgrade preview`} checked={viewUpgrades}
          onChange={(event) => setViewUpgrades(event.target.checked)} /> View Upgrades</label>
          <button type="button" onClick={() => setOpen(false)}>Close</button></footer>
      </div>
    </dialog>
  </>
}
