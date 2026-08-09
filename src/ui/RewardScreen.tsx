import { useState } from 'react'
import { cardDef } from '../game/cards.ts'
import type { CardRewardOffer } from '../game/run.ts'
import type { Player } from '../game/types.ts'
import { Card } from './Card.tsx'

type RewardScreenProps = {
  players: Player[]
  rewards: CardRewardOffer[]
  onReveal: (playerId: string) => void
  onResolve: (decisions: Record<string, number | null>) => void
}

/** Every living player takes one revealed card or skips (rulebook p.8). */
export function RewardScreen({ players, rewards, onReveal, onResolve }: RewardScreenProps) {
  const [decisions, setDecisions] = useState<Record<string, number | null>>({})
  const [upgradePreviews, setUpgradePreviews] = useState<Record<string, boolean>>({})
  const settled = rewards.every((offer) => offer.playerId in decisions)

  return (
    <section className="reward-screen">
      <h2>Card rewards</h2>
      <p className="muted">Choose one revealed card for each player, or skip it.</p>
      <div className="reward-screen__players">
        {rewards.map((offer) => {
          const player = players.find((candidate) => candidate.id === offer.playerId)
          if (!player) return null
          return (
            <div className="reward-screen__player" key={player.id}>
              <h3>{player.name}</h3>
              {offer.upgraded && <p className="reward-screen__upgrade">Upgraded card reward</p>}
              {offer.choices === null ? (
                <div className="reward-screen__unrevealed">
                  <button type="button" onClick={() => onReveal(player.id)}>Reveal 3 for {player.name}</button>
                  <span className="muted">or skip without looking</span>
                </div>
              ) : (
                <>
                  <div className="reward-screen__cards">
                    {offer.choices.map((defId, index) => {
                      const key = `${player.id}-${index}`
                      const previewing = upgradePreviews[key] === true
                      const name = cardDef(defId).name
                      return (
                        <div className="reward-screen__choice" key={`${index}-${defId}`}>
                          <Card
                            card={{
                              uid: `reward-${player.id}-${index}`,
                              defId,
                              upgraded: previewing,
                            }}
                            selected={decisions[player.id] === index}
                            onClick={() => setDecisions((current) => ({ ...current, [player.id]: index }))}
                          />
                          <button
                            type="button"
                            aria-pressed={previewing}
                            onClick={() => setUpgradePreviews((current) => ({ ...current, [key]: !previewing }))}
                          >
                            Show {name} {previewing ? 'base' : 'upgrade'}
                          </button>
                        </div>
                      )
                    })}
                  </div>
                  <span className="reward-screen__scroll-hint muted">
                    {offer.choices.length} choices · scroll to see all
                  </span>
                </>
              )}
              <button
                type="button"
                className={decisions[player.id] === null ? 'is-chosen' : ''}
                aria-pressed={decisions[player.id] === null}
                onClick={() => setDecisions((current) => ({ ...current, [player.id]: null }))}
              >
                {decisions[player.id] === null ? '✓ ' : ''}
                {offer.choices === null ? `Skip ${player.name}'s reward unseen` : `Skip ${player.name}'s card`}
              </button>
            </div>
          )
        })}
      </div>
      <button type="button" disabled={!settled} onClick={() => onResolve(decisions)}>
        {settled ? 'Collect rewards' : 'Everyone must choose'}
      </button>
    </section>
  )
}
