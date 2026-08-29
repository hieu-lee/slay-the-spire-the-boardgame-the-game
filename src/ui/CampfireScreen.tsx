import { useState } from 'react'
import type { CSSProperties } from 'react'
import { assetPath, campfireScenePath } from '../game/assets.ts'
import { canUpgradeCard } from '../game/run.ts'
import type { CampfireDecision } from '../game/run.ts'
import type { Player } from '../game/types.ts'
import { Card } from './Card.tsx'
import { Icon } from './Icon.tsx'

type CampfireScreenProps = {
  players: Player[]
  onResolve: (choices: Record<string, CampfireDecision>) => void
  rubyAvailable?: boolean
  restAllowed?: boolean
}

type Decision = CampfireDecision

/**
 * Each player picks Rest or Smith independently (p.9). Nobody moves on until
 * every living player has decided, which mirrors the table: you all leave the
 * campfire together.
 */
export function CampfireScreen({ players, onResolve, rubyAvailable = false, restAllowed = true }: CampfireScreenProps) {
  const [decisions, setDecisions] = useState<Record<string, Decision>>({})
  const living = players.filter((player) => !player.dead)
  const [focusedId, setFocusedId] = useState(living[0]?.id ?? '')
  const player = living.find((candidate) => candidate.id === focusedId) ?? living[0]
  const decision = player ? decisions[player.id] : undefined
  const coffee = player?.relics.some((relic) => relic.defId === 'coffee_dripper') ?? false
  const hammer = player?.relics.some((relic) => relic.defId === 'fusion_hammer') ?? false
  const peacePipe = player?.relics.some((relic) => relic.defId === 'peace_pipe') ?? false
  const restHeal = player ? 3 + (player.relics.some((relic) => relic.defId === 'regal_pillow') ? 3 : 0) : 3
  const upgradable = player?.deck.filter(canUpgradeCard) ?? []
  const restBlocked = coffee || !restAllowed
  const blocked = restBlocked && (hammer || upgradable.length === 0)
  const settled = living.every((player) => {
    const decision = decisions[player.id]
    if (!decision) return false
    return decision.choice === 'rest' || decision.choice === 'leave' || decision.choice === 'ruby' || decision.cardUid !== undefined
  })

  return (
    <section className="campfire" data-party-size={living.length}
      style={{ '--campfire-scene': `url("${campfireScenePath(living.map((seat) => seat.character))}")` } as CSSProperties}>
      <div className="campfire__prompt">
        <h2><Icon name="burn" size={26} /> Campfire <small>Rest Site</small></h2>
        {player ? <div className="campfire__player" role="group" aria-label={`${player.name}, ${player.hp} of ${player.maxHp} HP`}>
          <span className="campfire__name">What will {player.name} do? · {player.hp}/{player.maxHp} HP</span>
          <div className="campfire__choices">
                {blocked ? <button type="button"
                  className={decision?.choice === 'leave' ? 'is-chosen' : ''}
                  onClick={() => setDecisions((current) => ({ ...current, [player.id]: { choice: 'leave' } }))}>
                  Leave <span className="muted">No campfire action available</span>
                </button> : null}
                <button
                  type="button"
                  className={decision?.choice === 'rest' ? 'is-chosen' : ''}
                  disabled={restBlocked}
                  onClick={() =>
                    setDecisions((current) => ({ ...current, [player.id]: { choice: 'rest' } }))
                  }
                >
                  <img src={assetPath('noncombat/campfire/rest.webp')} alt="" />
                  <strong>Rest</strong>
                  <span className="muted"> +{restHeal} HP{!restAllowed ? ' · blocked by Night Terrors' : coffee ? ' · blocked by Coffee Dripper' : ''}</span>
                </button>
                {rubyAvailable ? <button
                  type="button"
                  className={decision?.choice === 'ruby' ? 'is-chosen' : ''}
                  onClick={() => setDecisions((current) => ({ ...current, [player.id]: { choice: 'ruby' } }))}
                >◆ Ruby Key <span className="muted">skip campfire</span></button> : null}
                <button
                  type="button"
                  className={decision?.choice === 'smith' ? 'is-chosen' : ''}
                  disabled={hammer || upgradable.length === 0}
                  onClick={() =>
                    setDecisions((current) => ({ ...current, [player.id]: { choice: 'smith' } }))
                  }
                >
                  <img src={assetPath('noncombat/campfire/smith.webp')} alt="" />
                  <strong>Smith</strong>
                  <span className="muted"> upgrade</span>
                </button>
          </div>

          {decision?.choice === 'rest' && peacePipe ? <div className="campfire__deck campfire__deck--remove">
                {player.deck.filter((card) => card.defId !== 'ascenders_bane').map((card) => <Card key={card.uid} card={card}
                  selected={decision.removeCardUid === card.uid}
                  onClick={() => setDecisions((current) => ({ ...current, [player.id]: {
                    ...decision, removeCardUid: decision.removeCardUid === card.uid ? undefined : card.uid,
                  } }))} />)}
              </div> : null}

          {decision?.choice === 'smith' ? <div className="campfire__deck campfire__deck--smith">
            {upgradable.map((card) => (
              <Card
                key={card.uid}
                card={card}
                selected={decision.cardUid === card.uid}
                onClick={() =>
                  setDecisions((current) => ({
                    ...current,
                    [player.id]: { choice: 'smith', cardUid: card.uid },
                  }))
                }
              />
            ))}
          </div> : null}
        </div> : null}
      </div>

      <div className="campfire__players" aria-label="Party around the campfire">
        {living.map((seat, index) => {
          const choice = decisions[seat.id]
          const status = choice?.choice === 'smith' && !choice.cardUid ? 'Choose a card' : choice ? choice.choice : 'Choose'
          return <button
            type="button"
            className={`campfire__seat campfire__seat--${index}`}
            key={seat.id}
            aria-label={`${seat.name}, ${seat.hp} of ${seat.maxHp} HP, ${status}`}
            aria-pressed={seat.id === player?.id}
            onClick={() => setFocusedId(seat.id)}
          >
            <span>{seat.name}</span>
            <small>{status}</small>
          </button>
        })}
      </div>

      <button type="button" className="campfire__leave" disabled={!settled} onClick={() => onResolve(decisions)}>
        {settled ? 'Leave the campfire' : 'Everyone must choose'}
      </button>
    </section>
  )
}
