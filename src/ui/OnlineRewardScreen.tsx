import { useState } from 'react'
import { cardDef } from '../game/cards.ts'
import type { VisibleRun } from '../multiplayer/useRoomSession.ts'
import { Card } from './Card.tsx'

type Props = {
  run: VisibleRun
  viewerId: string
  choice?: number | null
  decided: string[]
  confirmed: string[]
  onAction: (action: object) => void
}

export function OnlineRewardScreen({ run, viewerId, choice, decided, confirmed, onAction }: Props) {
  const [upgradePreviews, setUpgradePreviews] = useState<Record<string, boolean>>({})
  const allDecided = run.rewards.every((offer) => decided.includes(offer.playerId))

  return (
    <section className="reward-screen">
      <h2>Card rewards</h2>
      <p className="muted">Revealed cards are shared knowledge. Choose only for your own deck.</p>
      <div className="reward-screen__players">
        {run.rewards.map((offer) => {
          const player = run.players.find((candidate) => candidate.id === offer.playerId)
          if (!player) return null
          const mine = player.id === viewerId
          return (
            <div className="reward-screen__player" key={player.id}>
              <h3>{player.name}</h3>
              {offer.upgraded && <p className="reward-screen__upgrade">Upgraded card reward</p>}
              {offer.choices === null ? (
                <div className="reward-screen__unrevealed">
                  {mine ? (
                    <button type="button" onClick={() => onAction({ kind: 'cardReward', choice: 'reveal' })}>
                      Reveal 3
                    </button>
                  ) : <span className="muted">Not revealed yet</span>}
                </div>
              ) : (
                <div className="reward-screen__cards">
                  {offer.choices.map((defId, index) => {
                    const key = `${player.id}-${index}`
                    const showingUpgrade = upgradePreviews[key] ?? offer.upgraded
                    return (
                      <div className="reward-screen__choice" key={key}>
                        <Card
                          card={{ uid: `reward-${key}`, defId, upgraded: showingUpgrade }}
                          playable={mine}
                          selected={mine && choice === index}
                          onClick={mine ? () => onAction({ kind: 'cardReward', choice: index }) : undefined}
                        />
                        <button
                          type="button"
                          aria-pressed={showingUpgrade}
                          onClick={() => setUpgradePreviews((current) => ({ ...current, [key]: !showingUpgrade }))}
                        >
                          Show {cardDef(defId).name} {showingUpgrade ? 'base' : 'upgrade'}
                        </button>
                      </div>
                    )
                  })}
                </div>
              )}
              {mine ? (
                <button
                  type="button"
                  className={choice === null ? 'is-chosen' : ''}
                  onClick={() => onAction({ kind: 'cardReward', choice: null })}
                >
                  {choice === null ? '✓ ' : ''}Skip card
                </button>
              ) : (
                <span className="muted">{decided.includes(player.id) ? 'Chosen' : 'Choosing…'}</span>
              )}
            </div>
          )
        })}
      </div>
      <button
        type="button"
        disabled={!allDecided || !decided.includes(viewerId) || confirmed.includes(viewerId)}
        onClick={() => onAction({ kind: 'cardReward', choice: 'confirm' })}
      >
        {confirmed.includes(viewerId) ? 'Confirmed — waiting for party' : 'Confirm rewards'}
      </button>
    </section>
  )
}
