import { useState } from 'react'
import { cardDef } from '../game/cards.ts'
import type { VisibleRun } from '../multiplayer/useRoomSession.ts'
import { Card } from './Card.tsx'
import { potionDef, relicDef } from '../game/relics.ts'

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
  const allDecided = run.rewards.every((offer) => (!offer.cardReward || decided.includes(offer.playerId)) &&
    offer.potion === false && (offer.relic ?? false) === false && (offer.bossRelics ?? false) === false)

  return (
    <section className="reward-screen">
      <h2 className="reward-screen__title">Rewards!</h2>
      <p className="muted">Revealed cards are shared knowledge. Choose only for your own deck.</p>
      <div className="reward-screen__players">
        {run.rewards.map((offer) => {
          const player = run.players.find((candidate) => candidate.id === offer.playerId)
          if (!player) return null
          const mine = player.id === viewerId
          return (
            <div className="reward-screen__player" key={player.id}>
              <h3>{player.name}</h3>
              {offer.relic === null ? mine ? <p><button type="button" onClick={() => onAction({ kind: 'relicReward', choice: 'reveal' })}>Reveal Relic</button>{' '}
                <button className="reward-screen__skip" type="button" onClick={() => onAction({ kind: 'relicReward', choice: 'skip' })}>Skip Relic unseen</button></p>
                : <span className="muted">Relic not revealed</span>
                : typeof offer.relic === 'string' ? <div className="reward-screen__relic"><strong>{relicDef(offer.relic).name}</strong><span>{relicDef(offer.relic).text}</span>
                  {mine ? <><button type="button" onClick={() => onAction({ kind: 'relicReward', choice: 'gain' })}>Gain Relic</button>
                    <button className="reward-screen__skip" type="button" onClick={() => onAction({ kind: 'relicReward', choice: 'skip' })}>Skip</button></> : null}</div> : null}
              {Array.isArray(offer.bossRelics) ? <div className="reward-screen__relic"><strong>Choose a boss Relic</strong>
                {offer.bossRelics.map((id) => <button disabled={!mine} type="button" key={id} onClick={() => onAction({ kind: 'bossRelicReward', choice: 'gain', relicId: id })}>{relicDef(id).name} — {relicDef(id).text}</button>)}
                {mine ? <button className="reward-screen__skip" type="button" onClick={() => onAction({ kind: 'bossRelicReward', choice: 'skip' })}>Skip</button> : null}</div> : null}
              {offer.potion === null ? mine ? <p>
                <button type="button" onClick={() => onAction({ kind: 'potionReward', choice: 'reveal' })}>Reveal Potion</button>{' '}
                <button type="button" onClick={() => onAction({ kind: 'potionReward', choice: 'skip' })}>Skip unseen</button>
              </p> : <p className="muted">Potion not revealed</p> : typeof offer.potion === 'string' ? <div className="reward-screen__potion">
                <strong>{potionDef(offer.potion).name}</strong>
                {mine ? <>
                  <button type="button" disabled={player.potions.length >= (run.ascension >= 4 ? 2 : 3) ||
                    player.relics.some((relic) => relic.defId === 'sozu')}
                    onClick={() => onAction({ kind: 'potionReward', choice: 'gain' })}>Gain</button>
                  <button type="button" onClick={() => onAction({ kind: 'potionReward', choice: 'skip' })}>Skip</button>
                  {player.potions.map((held, index) => <button type="button" key={`${held}-${index}`}
                    disabled={player.relics.some((relic) => relic.defId === 'sozu')}
                    onClick={() => onAction({ kind: 'potionReward', choice: 'replace', potionId: held })}>Replace {potionDef(held).name}</button>)}
                  {run.players.filter((target) => target.id !== player.id && !target.dead &&
                    target.potions.length < (run.ascension >= 4 ? 2 : 3) &&
                    !target.relics.some((relic) => relic.defId === 'sozu')).map((target) => <button type="button" key={target.id}
                    onClick={() => onAction({ kind: 'potionReward', choice: 'pass', playerId: target.id })}>Pass to {target.name}</button>)}
                </> : null}
              </div> : null}
              {!offer.cardReward ? null : <>
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
                <>
                <div className="reward-screen__cards">
                  {offer.choices.map((defId, index) => {
                    const key = `${player.id}-${index}`
                    const showingUpgrade = upgradePreviews[key] ?? offer.upgraded
                    return (
                      <div className="reward-screen__choice" key={key}>
                        {offer.rareChoiceIndices?.includes(index) && (
                          <span className="reward-screen__rare">Golden Ticket · Rare</span>
                        )}
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
                <span className="reward-screen__scroll-hint muted">
                  {offer.choices.length} choices · scroll to see all
                </span>
                </>
              )}
              </>}
              {offer.cardReward && (mine ? (
                <button
                  type="button"
                  className={`reward-screen__skip ${choice === null ? 'is-chosen' : ''}`}
                  onClick={() => onAction({ kind: 'cardReward', choice: null })}
                >
                  {choice === null ? '✓ ' : ''}Skip card
                </button>
              ) : (
                <span className="muted">{decided.includes(player.id) ? 'Chosen' : 'Choosing…'}</span>
              ))}
            </div>
          )
        })}
      </div>
      <button
        className="reward-screen__collect"
        type="button"
        disabled={!allDecided || !decided.includes(viewerId) || confirmed.includes(viewerId)}
        onClick={() => onAction({ kind: 'cardReward', choice: 'confirm' })}
      >
        {confirmed.includes(viewerId) ? 'Confirmed — waiting for party' : 'Confirm rewards'}
      </button>
    </section>
  )
}
