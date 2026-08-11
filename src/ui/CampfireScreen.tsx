import { useState } from 'react'
import { cardDef, faceOf } from '../game/cards.ts'
import { canRestAtCampfire, canSmithAtCampfire, canUpgradeCard } from '../game/run.ts'
import type { CampfireChoice } from '../game/run.ts'
import type { Player } from '../game/types.ts'
import { Card } from './Card.tsx'
import { Icon } from './Icon.tsx'

type CampfireScreenProps = {
  players: Player[]
  onResolve: (choices: Record<string, { choice: CampfireChoice; cardUid?: string }>) => void
}

type Decision = { choice: CampfireChoice; cardUid?: string }

/**
 * Each player picks Rest or Smith independently (p.9). Nobody moves on until
 * every living player has decided, which mirrors the table: you all leave the
 * campfire together.
 */
export function CampfireScreen({ players, onResolve }: CampfireScreenProps) {
  const [decisions, setDecisions] = useState<Record<string, Decision>>({})
  const living = players.filter((player) => !player.dead)
  const settled = living.every((player) => {
    const decision = decisions[player.id]
    if (!decision) return false
    return decision.choice === 'rest' || decision.choice === 'skip' || decision.cardUid !== undefined
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
          const upgradable = player.deck.filter(canUpgradeCard)
          const chosenCard = upgradable.find((card) => card.uid === decision?.cardUid)
          const canRest = canRestAtCampfire(player)
          const canSmith = canSmithAtCampfire(player)
          return (
            <div className="campfire__player" key={player.id}>
              <span className="campfire__name">
                {player.name} · {player.hp}/{player.maxHp}
              </span>

              <div className="campfire__choices">
                <button
                  type="button"
                  disabled={!canRest}
                  className={decision?.choice === 'rest' ? 'is-chosen' : ''}
                  onClick={() =>
                    setDecisions((current) => ({ ...current, [player.id]: { choice: 'rest' } }))
                  }
                >
                  Rest
                  <span className="muted"> +3 HP</span>
                </button>
                <button
                  type="button"
                  className={decision?.choice === 'smith' ? 'is-chosen' : ''}
                  disabled={!canSmith}
                  onClick={() =>
                    setDecisions((current) => ({ ...current, [player.id]: { choice: 'smith' } }))
                  }
                >
                  Smith
                  <span className="muted"> upgrade</span>
                </button>
                {!canRest && !canSmith ? (
                  <button type="button" className={decision?.choice === 'skip' ? 'is-chosen' : ''}
                    onClick={() => setDecisions((current) => ({ ...current, [player.id]: { choice: 'skip' } }))}>
                    Do nothing
                  </button>
                ) : null}
              </div>

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
