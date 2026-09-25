import { useEffect, useMemo, useRef, useState } from 'react'
import { cardDef, faceOf } from '../../game/cards.ts'
import type { PendingTriggerAbility } from '../../game/combat/types.ts'
import type { CardInstance } from '../../game/types.ts'
import { Card, cardRuleDescription } from '../Card.tsx'

type HermitChoices = NonNullable<PendingTriggerAbility['hermitChoices']>

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

function names(cards: readonly CardInstance[]) {
  const labels = cards.map((card) => cardDef(card.defId).name)
  return labels.length <= 1 ? labels.join('') : `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}`
}

const CHAMBER_VERB = { replace: 'discard', discard: 'discard', play: 'play', discount: 'discount' } as const

function chamberHeading(choices: HermitChoices) {
  const count = plural(choices.chamberAmount, 'Chamber card')
  switch (choices.chamberAction) {
    case 'replace': return `Chamber full — discard ${plural(choices.chamberAmount, 'card')} to make room`
    case 'discard': return `${choices.chamberMinimum < choices.chamberAmount ? 'You may discard' : 'Discard'} ${count}${
      choices.chamberThenDraw > 0 ? ` to draw ${choices.chamberThenDraw}` : ''}`
    case 'play': return `Play ${count}`
    case 'discount': return `Choose ${count} to cost 0 this turn`
  }
}

function toggle(current: readonly string[], uid: string, amount: number): string[] {
  return current.includes(uid) ? current.filter((held) => held !== uid) : [...current, uid].slice(-amount)
}

/**
 * The Load/Chamber picks a Hermit trigger (Combo, Take Aim, Eternal Form, …) asks
 * for, shown as card faces. Cards the trigger itself draws are not in hand yet,
 * so they are badged: otherwise the player is asked to Load a card they cannot see.
 */
export function HermitTriggerChoice({
  label,
  choices,
  hand,
  loadUids,
  chamberUids,
  needsTarget,
  busy,
  onLoadUids,
  onChamberUids,
  onConfirm,
  onViewBoard,
}: {
  label: string
  choices: HermitChoices
  hand: readonly CardInstance[]
  loadUids: readonly string[]
  chamberUids: readonly string[]
  needsTarget: boolean
  busy: boolean
  onLoadUids: (uids: string[]) => void
  onChamberUids: (uids: string[]) => void
  onConfirm: () => void
  onViewBoard: () => void
}) {
  const dialog = useRef<HTMLDialogElement | null>(null)
  const handUids = useMemo(() => new Set(hand.map((card) => card.uid)), [hand])
  useEffect(() => {
    if (dialog.current && !dialog.current.open) dialog.current.showModal()
  }, [])
  const drawn = choices.loadCards.filter((card) => !handUids.has(card.uid))
  const loadOptions = [...drawn, ...choices.loadCards.filter((card) => handUids.has(card.uid))]
  // Faces are small on phones, so the last card touched, hovered or focused is spelled out in full.
  const [detailUid, setDetailUid] = useState<string | undefined>(undefined)
  const detailCard = [...loadOptions, ...choices.chamberCards].find((card) => card.uid === detailUid) ??
    loadOptions[0] ?? choices.chamberCards[0]
  const detailDef = detailCard ? faceOf(cardDef(detailCard.defId), detailCard.upgraded) : undefined
  const dense = loadOptions.length + choices.chamberCards.length > 9
  const inspect = (card: CardInstance) => ({
    onPointerEnter: () => setDetailUid(card.uid),
    onFocus: () => setDetailUid(card.uid),
  })
  const loading = choices.loadCards.filter((card) => loadUids.includes(card.uid))
  const chambered = choices.chamberCards.filter((card) => chamberUids.includes(card.uid))
  const loadReady = loading.length >= choices.loadMinimum && loading.length <= choices.loadAmount
  const chamberReady = chambered.length >= choices.chamberMinimum && chambered.length <= choices.chamberAmount
  const actions = [
    loading.length > 0 ? `Load ${names(loading)}` : '',
    chambered.length > 0 ? `${CHAMBER_VERB[choices.chamberAction]} ${names(chambered)}` : '',
    chambered.length > 0 && choices.chamberThenDraw > 0 ? `draw ${choices.chamberThenDraw}` : '',
  ].filter(Boolean)
  const summary = actions.length === 0 ? 'Continue without choosing'
    : actions.join(', ').replace(/^./, (first) => first.toUpperCase())
  const confirm = !loadReady
    ? `Choose ${plural(choices.loadMinimum - loading.length, 'card')} to Load`
    : !chamberReady
      ? `Choose ${plural(choices.chamberMinimum - chambered.length, 'Chamber card')} to ${
        CHAMBER_VERB[choices.chamberAction]}`
      : needsTarget ? `${summary}, then choose its target` : summary
  const loadHeading = `Load ${choices.loadMinimum < choices.loadAmount ? 'up to ' : ''}${
    plural(choices.loadAmount, 'card')} into the Chamber${choices.loadDiscount ? ' — it costs 0 this turn' : ''}`
  return (
    <dialog ref={dialog} className="choice-modal hermit-trigger-choice" aria-labelledby="hermit-trigger-choice-title"
      onCancel={(event) => {
        event.preventDefault()
        onViewBoard()
      }}
      // Chromium closes without `cancel` on a repeated Escape with no user activation in between.
      onClose={onViewBoard}>
      <div className="choice-modal__panel">
        <header className="hermit-trigger-choice__header">
          <h2 id="hermit-trigger-choice-title">{label}</h2>
          {drawn.length > 0 ? <p className="hermit-trigger-choice__drawn">Drew {names(drawn)}.</p> : null}
        </header>
        {detailDef ? <p className="hermit-trigger-choice__detail" aria-hidden="true">
          <strong>{detailDef.name}</strong> — {cardRuleDescription(detailDef) || 'No rules text.'}
        </p> : null}
        <div className="hermit-trigger-choice__sections">
          {choices.loadCards.length > 0 ? (
            <section aria-labelledby="hermit-trigger-choice-load">
              <h3 id="hermit-trigger-choice-load">
                {loadHeading}
                <span className="hermit-trigger-choice__count">{loading.length}/{choices.loadAmount}</span>
              </h3>
              <div className={`choice-modal__cards hermit-trigger-choice__cards${
                dense ? ' hermit-trigger-choice__cards--many' : ''}`}>
                {loadOptions.map((card) => (
                  <div key={card.uid} className="hermit-trigger-choice__option" {...inspect(card)}>
                    <Card card={card} immediateArt selected={loadUids.includes(card.uid)}
                      accessibleNote={handUids.has(card.uid) ? undefined : 'drawn'}
                      onClick={() => {
                        setDetailUid(card.uid)
                        onLoadUids(toggle(loadUids, card.uid, choices.loadAmount))
                      }} />
                    {handUids.has(card.uid) ? null : <span className="hermit-trigger-choice__badge" aria-hidden="true">Drawn</span>}
                  </div>
                ))}
              </div>
            </section>
          ) : null}
          {choices.chamberCards.length > 0 ? (
            <section aria-labelledby="hermit-trigger-choice-chamber" className="hermit-trigger-choice__chamber">
              <h3 id="hermit-trigger-choice-chamber">
                {chamberHeading(choices)}
                <span className="hermit-trigger-choice__count">{chambered.length}/{choices.chamberAmount}</span>
              </h3>
              <div className="choice-modal__cards hermit-trigger-choice__cards">
                {choices.chamberCards.map((card) => (
                  <div key={card.uid} className="hermit-trigger-choice__option" {...inspect(card)}>
                    <Card card={card} immediateArt selected={chamberUids.includes(card.uid)}
                      onClick={() => {
                        setDetailUid(card.uid)
                        onChamberUids(toggle(chamberUids, card.uid, choices.chamberAmount))
                      }} />
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </div>
        <div className="hermit-trigger-choice__actions">
          <button type="button" className="hermit-trigger-choice__secondary" onClick={onViewBoard}>View board</button>
          <button type="button" className="hermit-trigger-choice__confirm"
            disabled={busy || !loadReady || !chamberReady} onClick={onConfirm}>{confirm}</button>
        </div>
      </div>
    </dialog>
  )
}
