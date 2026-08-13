import { useState } from 'react'
import { cardDef, faceOf } from '../game/cards.ts'
import { canUpgradeCard } from '../game/run.ts'
import type { CampfireDecision } from '../game/run.ts'
import type { Player } from '../game/types.ts'
import { Card } from './Card.tsx'
import { Icon } from './Icon.tsx'

type CampfireScreenProps = {
  players: Player[]
  onResolve: (choices: Record<string, CampfireDecision>) => void
  rubyAvailable?: boolean
}

type Decision = CampfireDecision

/**
 * Each player picks Rest or Smith independently (p.9). Nobody moves on until
 * every living player has decided, which mirrors the table: you all leave the
 * campfire together.
 */
export function CampfireScreen({ players, onResolve, rubyAvailable = false }: CampfireScreenProps) {
  const [decisions, setDecisions] = useState<Record<string, Decision>>({})
  const living = players.filter((player) => !player.dead)
  const settled = living.every((player) => {
    const decision = decisions[player.id]
    if (!decision) return false
    return decision.choice === 'rest' || decision.choice === 'leave' || decision.choice === 'ruby' || decision.cardUid !== undefined
  })

  return (
    <section className="campfire">
      <h2>
        <Icon name="burn" size={26} /> Campfire
      </h2>
      <p className="muted">Rest to heal 3, or Smith to upgrade a card.</p>

      <div className="campfire__players">
        {living.map((player) => {
          const decision = decisions[player.id]
          const coffee = player.relics.some((relic) => relic.defId === 'coffee_dripper')
          const hammer = player.relics.some((relic) => relic.defId === 'fusion_hammer')
          const peacePipe = player.relics.some((relic) => relic.defId === 'peace_pipe')
          const restHeal = 3 + (player.relics.some((relic) => relic.defId === 'regal_pillow') ? 3 : 0)
          const upgradable = player.deck.filter(canUpgradeCard)
          const blocked = coffee && (hammer || upgradable.length === 0)
          const chosenCard = upgradable.find((card) => card.uid === decision?.cardUid)
          return (
            <div className="campfire__player" key={player.id}>
              <span className="campfire__name">
                {player.name} · {player.hp}/{player.maxHp}
              </span>

              <div className="campfire__choices">
                {blocked ? <button type="button"
                  className={decision?.choice === 'leave' ? 'is-chosen' : ''}
                  onClick={() => setDecisions((current) => ({ ...current, [player.id]: { choice: 'leave' } }))}>
                  Leave <span className="muted">No campfire action available</span>
                </button> : null}
                <button
                  type="button"
                  className={decision?.choice === 'rest' ? 'is-chosen' : ''}
                  disabled={coffee}
                  onClick={() =>
                    setDecisions((current) => ({ ...current, [player.id]: { choice: 'rest' } }))
                  }
                >
                  Rest
                  <span className="muted"> +{restHeal} HP{coffee ? ' · blocked by Coffee Dripper' : ''}</span>
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
                  Smith
                  <span className="muted"> upgrade</span>
                </button>
              </div>

              {decision?.choice === 'rest' && peacePipe ? <div className="campfire__deck">
                {player.deck.filter((card) => card.defId !== 'ascenders_bane').map((card) => <Card key={card.uid} card={card}
                  selected={decision.removeCardUid === card.uid}
                  onClick={() => setDecisions((current) => ({ ...current, [player.id]: {
                    ...decision, removeCardUid: decision.removeCardUid === card.uid ? undefined : card.uid,
                  } }))} />)}
              </div> : null}

              {decision?.choice === 'smith' ? (
                <>
                  <div className="campfire__deck">
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
                  </div>

                  {/* The upgraded face gets its own panel rather than replacing
                      the card in the list, where swapping it in place read as
                      "this card was always upgraded". */}
                  {chosenCard ? (
                    <div className="campfire__preview">
                      <span className="campfire__preview-label">Becomes</span>
                      <Card card={{ ...chosenCard, upgraded: true }} playable={false} />
                      <span className="campfire__picked">
                        {faceOf(cardDef(chosenCard.defId), true).name}
                      </span>
                    </div>
                  ) : null}
                </>
              ) : null}
            </div>
          )
        })}
      </div>

      <button type="button" className="campfire__leave" disabled={!settled} onClick={() => onResolve(decisions)}>
        {settled ? 'Leave the campfire' : 'Everyone must choose'}
      </button>
    </section>
  )
}
