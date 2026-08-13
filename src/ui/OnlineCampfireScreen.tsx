import { useEffect, useState } from 'react'
import { cardDef, faceOf } from '../game/cards.ts'
import { canUpgradeCard } from '../game/run.ts'
import type { VisiblePlayer } from '../multiplayer/useRoomSession.ts'
import type { CampfireDecision } from '../game/run.ts'
import { Card } from './Card.tsx'
import { Icon } from './Icon.tsx'

type Decision = CampfireDecision

type Props = {
  player: VisiblePlayer
  saved?: Decision
  decided: string[]
  seats: { playerId: string; name: string }[]
  onAction: (action: object) => void
  rubyAvailable?: boolean
}

export function OnlineCampfireScreen({ player, saved, decided, seats, onAction, rubyAvailable = false }: Props) {
  const [decision, setDecision] = useState<Decision | null>(saved ?? null)
  const deck = player.deck ?? []
  const upgradable = deck.filter(canUpgradeCard)
  const chosen = upgradable.find((card) => card.uid === decision?.cardUid)
  const coffee = player.relics.some((relic) => relic.defId === 'coffee_dripper')
  const hammer = player.relics.some((relic) => relic.defId === 'fusion_hammer')
  const peacePipe = player.relics.some((relic) => relic.defId === 'peace_pipe')
  const restHeal = 3 + (player.relics.some((relic) => relic.defId === 'regal_pillow') ? 3 : 0)
  const ready = decision?.choice === 'rest' || decision?.choice === 'leave' || decision?.choice === 'ruby' || decision?.cardUid !== undefined

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
          {coffee && (hammer || upgradable.length === 0) ? <button type="button" className={decision?.choice === 'leave' ? 'is-chosen' : ''}
            onClick={() => setDecision({ choice: 'leave' })}>
            Leave <span className="muted">No campfire action available</span>
          </button> : null}
          <button type="button" disabled={coffee} className={decision?.choice === 'rest' ? 'is-chosen' : ''} onClick={() => setDecision({ choice: 'rest' })}>
            Rest <span className="muted">+{restHeal} HP</span>
          </button>
          <button type="button" disabled={hammer || upgradable.length === 0} className={decision?.choice === 'smith' ? 'is-chosen' : ''} onClick={() => setDecision({ choice: 'smith' })}>
            Smith <span className="muted">upgrade</span>
          </button>
          {rubyAvailable ? <button type="button" className={decision?.choice === 'ruby' ? 'is-chosen' : ''} onClick={() => setDecision({ choice: 'ruby' })}>
            ◆ Ruby Key <span className="muted">skip campfire</span>
          </button> : null}
        </div>
        {decision?.choice === 'rest' && peacePipe ? <div className="campfire__deck">
          {deck.filter((card) => card.defId !== 'ascenders_bane').map((card) => <Card key={card.uid} card={card} selected={card.uid === decision.removeCardUid}
            onClick={() => setDecision({ ...decision, removeCardUid: decision.removeCardUid === card.uid ? undefined : card.uid })} />)}
        </div> : null}
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
