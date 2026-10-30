import { useEffect, useRef, useState } from 'react'
import { cardDef, faceOf } from '../game/cards.ts'
import type { CardInstance } from '../game/types.ts'
import { Card, cardKeywordTips, cardRuleDescription } from './Card.tsx'
import './styles/card-inspection.css'

export function CardInspectionDialog({
  cards, initialCardUid, viewAllUpgraded, onClose,
}: {
  cards: readonly CardInstance[]
  initialCardUid: string
  viewAllUpgraded: boolean
  onClose: () => void
}) {
  const [selectedUid, setSelectedUid] = useState(initialCardUid)
  const [previewAll, setPreviewAll] = useState(viewAllUpgraded)
  const [upgradeOverride, setUpgradeOverride] = useState<boolean | null>(null)
  const [direction, setDirection] = useState<-1 | 0 | 1>(0)
  const dialog = useRef<HTMLDialogElement>(null)
  const index = cards.findIndex((card) => card.uid === selectedUid)
  const card = cards[index]
  const upgraded = upgradeOverride ?? Boolean(card?.upgraded || previewAll)
  const def = card ? faceOf(cardDef(card.defId), upgraded && Boolean(cardDef(card.defId).upgrade)) : null
  const gem = card?.attachedGemId ? cardDef(card.attachedGemId) : null
  const tips = def ? [...cardKeywordTips(def), ...(gem ? [
    { name: gem.name, text: cardRuleDescription(gem) },
  ] : [])] : []

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const element = dialog.current
    element?.showModal()
    return () => {
      element?.close()
      if (opener?.isConnected) opener.focus({ preventScroll: true })
    }
  }, [])

  useEffect(() => { if (!card) onClose() }, [card, onClose])

  const navigate = (direction: -1 | 1) => {
    const next = cards[index + direction]
    if (!next) return
    dialog.current?.focus({ preventScroll: true })
    setDirection(direction)
    setSelectedUid(next.uid)
    setUpgradeOverride(null)
  }

  return <dialog ref={dialog} className="card-inspection" tabIndex={-1} aria-label={`Inspect ${def?.name ?? 'card'}`}
    data-direction={direction}
    onCancel={(event) => { event.preventDefault(); event.stopPropagation(); onClose() }}
    onClick={(event) => { if (event.target === event.currentTarget) onClose() }}
    onKeyDown={(event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      event.preventDefault()
      event.stopPropagation()
      navigate(event.key === 'ArrowLeft' ? -1 : 1)
    }}>
    {card && def ? <>
      <div className="card-inspection__stage">
        <button type="button" className="card-inspection__nav" aria-label="Previous card"
          style={{ visibility: index > 0 ? undefined : 'hidden' }} disabled={index === 0}
          onClick={() => navigate(-1)}>
          <svg viewBox="0 0 100 110" aria-hidden="true"><path d="M88 7 Q94 3 94 13 L94 97 Q94 107 85 102 L9 61 Q0 55 9 49 Z" /></svg>
        </button>
        <Card key={card.uid} card={{ ...card, upgraded: upgraded && Boolean(cardDef(card.defId).upgrade) }}
          className="card-inspection__card" playable={false} tabIndex={-1} />
        <button type="button" className="card-inspection__nav card-inspection__nav--next" aria-label="Next card"
          style={{ visibility: index < cards.length - 1 ? undefined : 'hidden' }} disabled={index === cards.length - 1}
          onClick={() => navigate(1)}>
          <svg viewBox="0 0 100 110" aria-hidden="true"><path d="M88 7 Q94 3 94 13 L94 97 Q94 107 85 102 L9 61 Q0 55 9 49 Z" /></svg>
        </button>
        {tips.length > 0 ? <aside className="card-inspection__tips" aria-label="Card keywords">
          {tips.map((tip, index) => <section key={`${tip.name}:${index}`}><h3>{tip.name}</h3><p>{tip.text}</p></section>)}
        </aside> : null}
      </div>
      <footer className="card-inspection__footer">
        {cardDef(card.defId).upgrade ? <label>
          <input type="checkbox" checked={upgraded} onChange={(event) => {
            // After a manual toggle, navigation follows each owned card's actual upgrade state.
            setPreviewAll(false)
            setUpgradeOverride(event.target.checked)
          }} /> View Upgrades
        </label> : null}
      </footer>
    </> : null}
  </dialog>
}
