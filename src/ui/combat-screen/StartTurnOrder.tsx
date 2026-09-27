import { useState } from 'react'
import { cardDef, faceOf } from '../../game/cards.ts'
import type { StartTurnAbility } from '../../game/combat/types.ts'
import type { Player } from '../../game/types.ts'
import { Icon } from '../Icon.tsx'
import { ItemImage } from '../ItemImage.tsx'
import { PowerGlyph } from '../PowerRow.tsx'

export type StartTurnOrderStep = {
  id: string
  playerId: string
  label: string
  visual?: StartTurnAbility['visual']
  /** Choices this step still needs (`done: false`) or has made (`true`); no `done` is plain information. */
  badges?: { text: string; done?: boolean }[]
}

/**
 * Before-draw Scries carry no `visual`; their id still ends with the trigger
 * source (`relic:<index>:<ability>` or `power:<uid>`), which names the art.
 */
function stepVisual(step: StartTurnOrderStep, owner: Player | undefined): StartTurnAbility['visual'] {
  if (step.visual || !owner) return step.visual
  const relic = /(?:^|\/)relic:(\d+):\d+$/.exec(step.id)
  const relicId = relic ? owner.relics[Number(relic[1])]?.defId : undefined
  if (relicId) return { kind: 'relic', relicId }
  const power = /(?:^|\/)power:([^/:]+)(?::extra:\d+)?$/.exec(step.id)
  return power ? { kind: 'card', cardUid: power[1]! } : undefined
}

function StepArt({ step, owner }: { step: StartTurnOrderStep; owner: Player | undefined }) {
  const visual = stepVisual(step, owner)
  const power = visual?.kind === 'card' ? owner?.powers.find((card) => card.uid === visual.cardUid) : undefined
  return (
    <span className="start-turn-order__art" aria-hidden="true">
      {visual?.kind === 'relic' ? <ItemImage kind="relic" id={visual.relicId} />
        : power ? <PowerGlyph def={faceOf(cardDef(power.defId), power.upgraded)} />
        : step.id.startsWith('enemy:') ? <Icon name="monster" size={26} />
        : null}
    </span>
  )
}

/** Short screens (horizontal phones, 1280x800 laptops), where an open list reaches the enemies. */
const COMPACT_BOARD = '(max-height: 53.125rem)'

/**
 * The start-of-turn (or before-draw Scry) resolution order as numbered steps,
 * open by default so nobody resolves an order they never saw. On a short screen
 * a list that owes no choice starts folded so the enemies stay readable; its
 * heading still counts the steps. Each step shows
 * its relic or Power art, whose it is when a party shares the list, and any
 * choice it still waits on; the move buttons are full-size touch targets.
 */
export function StartTurnOrder({ title, hint, steps, players, canMove, onMove, foldWhenShort = false }: {
  title: string
  hint: string
  /** Start folded on a short screen while no step owes a choice. */
  foldWhenShort?: boolean
  steps: readonly StartTurnOrderStep[]
  players: readonly Player[]
  canMove: boolean
  onMove: (id: string, delta: -1 | 1) => void
}) {
  const party = players.length > 1
  const owed = steps.some((step) => step.badges?.some((badge) => badge.done === false))
  // Only the first render decides; afterwards the player's own fold wins.
  const [startsOpen] = useState(() => !foldWhenShort || owed || !window.matchMedia(COMPACT_BOARD).matches)
  const movable = steps.length > 1
  return (
    <details className="start-turn-order" open={startsOpen}>
      <summary>
        <span className="start-turn-order__title">{title}</span>{' '}
        <span className="start-turn-order__count">{steps.length}</span>
      </summary>
      <p className={`start-turn-order__hint${movable && !canMove ? ' start-turn-order__hint--blocked' : ''}`}>{hint}</p>
      <ol aria-label={title} tabIndex={0}>
        {steps.map((step, index) => {
          const owner = players.find((player) => player.id === step.playerId)
          // "Silent's Demon Form" reads as "Demon Form" beside a Silent owner tag.
          const name = owner && (step.label.startsWith(`${owner.name}'s `) || step.label.startsWith(`${owner.name} — `))
            ? step.label.slice(owner.name.length + 3)
            : step.label
          return (
            <li key={step.id} className="start-turn-order__step">
              <span className="start-turn-order__index" aria-hidden="true">{index + 1}</span>
              <StepArt step={step} owner={owner} />
              <span className="start-turn-order__text">
                <span className="start-turn-order__name">{name}</span>
                {party && owner && !step.id.startsWith('enemy:') || step.badges?.length ? (
                  <span className="start-turn-order__meta">
                    {party && owner && !step.id.startsWith('enemy:')
                      ? <span className="start-turn-order__owner">{owner.name}</span> : null}
                    {step.badges?.map((badge) => (
                      <span key={badge.text} className={`start-turn-order__badge${badge.done === undefined ? ' start-turn-order__badge--info'
                        : badge.done ? ' start-turn-order__badge--done' : ''}`}>
                        {badge.text}
                      </span>
                    ))}
                  </span>
                ) : null}
              </span>
              {movable ? (
                <span className="start-turn-order__moves">
                  <button type="button" disabled={!canMove || index === 0}
                    aria-label={`Move ${step.label} earlier`}
                    onClick={() => onMove(step.id, -1)}>▲</button>
                  <button type="button" disabled={!canMove || index === steps.length - 1}
                    aria-label={`Move ${step.label} later`}
                    onClick={() => onMove(step.id, 1)}>▼</button>
                </span>
              ) : null}
            </li>
          )
        })}
      </ol>
    </details>
  )
}
