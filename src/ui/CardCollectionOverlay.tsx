import { useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
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
  const dialog = useRef<HTMLDialogElement | null>(null)
  const titleId = useId()

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
        <h2 id={titleId}>{label}</h2>
        <p>{cards.length} card{cards.length === 1 ? '' : 's'}</p>
        <div className="choice-modal__cards">
          {open ? cards.map((card) => <Card key={card.uid} card={card} playable={false} />) : null}
          {open && cards.length === 0 ? <span className="muted">No cards.</span> : null}
        </div>
        <button type="button" onClick={() => setOpen(false)}>Close</button>
      </div>
    </dialog>
  </>
}
