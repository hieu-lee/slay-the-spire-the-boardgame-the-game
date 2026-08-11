import { useEffect, useState } from 'react'
import { cardDef, faceOf } from '../game/cards.ts'
import type { VisiblePlayer } from '../multiplayer/useRoomSession.ts'
import { canRestAtCampfire, canSmithAtCampfire, canUpgradeCard } from '../game/run.ts'
import type { CampfireChoice } from '../game/run.ts'
import { Card } from './Card.tsx'
import { Icon } from './Icon.tsx'

type Decision = { choice: CampfireChoice; cardUid?: string }

type Props = {
  player: VisiblePlayer
  saved?: Decision
  decided: string[]
  seats: { playerId: string; name: string }[]
  onAction: (action: object) => void
}

export function OnlineCampfireScreen({ player, saved, decided, seats, onAction }: Props) {
  const [decision, setDecision] = useState<Decision | null>(saved ?? null)
  const deck = player.deck ?? []
  const upgradable = deck.filter(canUpgradeCard)
  const chosen = upgradable.find((card) => card.uid === decision?.cardUid)
  const canRest = canRestAtCampfire(player)
  const canSmith = canSmithAtCampfire(player)
  const ready = decision?.choice === 'rest' || decision?.choice === 'skip' || decision?.cardUid !== undefined

  useEffect(() => {
    if (saved) setDecision(saved)
  }, [saved?.cardUid, saved?.choice])

  return (
    <section className="campfire">
      <h2><Icon name="burn" size={26} /> Campfire</h2>
      <p className="muted">
        {seats.map((seat) => `${seat.name}: ${decided.includes(seat.playerId) ? 'ready' : 'choosing'}`).join(' · ')}
      </p>
      <div className="campfire__player">
        <span className="campfire__name">{player.name} · {player.hp}/{player.maxHp}</span>
        <div className="campfire__choices">
          <button type="button" disabled={!canRest} className={decision?.choice === 'rest' ? 'is-chosen' : ''} onClick={() => setDecision({ choice: 'rest' })}>
            Rest <span className="muted">+3 HP</span>
          </button>
          <button type="button" disabled={!canSmith} className={decision?.choice === 'smith' ? 'is-chosen' : ''} onClick={() => setDecision({ choice: 'smith' })}>
            Smith <span className="muted">upgrade</span>
          </button>
          {!canRest && !canSmith ? (
            <button type="button" className={decision?.choice === 'skip' ? 'is-chosen' : ''} onClick={() => setDecision({ choice: 'skip' })}>
              Do nothing
            </button>
          ) : null}
        </div>
        {decision?.choice === 'smith' ? (
          <div className="campfire__deck">
            {upgradable.map((card) => (
              <Card key={card.uid} card={card} selected={card.uid === decision.cardUid} onClick={() => setDecision({ choice: 'smith', cardUid: card.uid })} />
            ))}
          </div>
        ) : null}
        {chosen ? <p className="muted">Becomes {faceOf(cardDef(chosen.defId), true).name}</p> : null}
      </div>
      <button
        type="button"
        className="campfire__leave"
        disabled={!ready}
        onClick={() => onAction({ kind: 'campfire', choices: { [player.id]: decision } })}
      >
        {decided.includes(player.id) ? 'Update choice' : 'Lock in choice'}
      </button>
    </section>
  )
}
