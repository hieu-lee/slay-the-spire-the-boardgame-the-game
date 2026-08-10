import { useState } from 'react'
import { cardDef } from '../game/cards.ts'
import { potionDef, relicDef } from '../game/relics.ts'
import type { CardRewardOffer, RewardDecision } from '../game/run.ts'
import { CAPS } from '../game/types.ts'
import type { Player } from '../game/types.ts'
import { Card } from './Card.tsx'

type RewardScreenProps = {
  players: Player[]
  ascension: number
  rewards: CardRewardOffer[]
  onReveal: (playerId: string) => void
  onRevealItem: (playerId: string, kind: 'potion' | 'relic') => void
  onResolve: (playerId: string, decision: RewardDecision) => void
}

type RewardDraft = Partial<RewardDecision>

/** Every living player resolves their printed card, potion, and relic rewards. */
export function RewardScreen({ players, ascension, rewards, onReveal, onRevealItem, onResolve }: RewardScreenProps) {
  const [decisions, setDecisions] = useState<Record<string, RewardDraft>>({})
  const [upgradePreviews, setUpgradePreviews] = useState<Record<string, boolean>>({})
  const setDecision = (playerId: string, decision: RewardDraft) => setDecisions((current) => ({
    ...current,
    [playerId]: { ...current[playerId], ...decision },
  }))
  const settled = rewards.every((offer) => {
    const decision = decisions[offer.playerId]
    return (!offer.hasCard || decision?.card !== undefined)
      && (!offer.hasPotion || decision?.potionRecipientId !== undefined)
      && (!offer.hasRelic || decision?.relicId !== undefined)
  })
  const selectedRelics = new Set(Object.values(decisions).map((decision) => decision.relicId).filter(Boolean))
  const potionCap = ascension >= 4 ? 2 : CAPS.potions

  return (
    <section className="reward-screen">
      <h2>Combat rewards</h2>
      <p className="muted">Choose, pass, or skip each printed reward.</p>
      <div className="reward-screen__players">
        {rewards.map((offer) => {
          const player = players.find((candidate) => candidate.id === offer.playerId)
          if (!player) return null
          const recipient = players.find((candidate) => candidate.id === decisions[player.id]?.potionRecipientId)
          const discard = decisions[player.id]?.discardPotionId
          const potionReady = !offer.hasPotion || decisions[player.id]?.potionRecipientId === null || Boolean(
            offer.potionId && recipient && (discard
              ? recipient.potions.includes(discard)
              : recipient.potions.length < potionCap),
          )
          return (
            <div className="reward-screen__player" key={player.id}>
              <h3>{player.name}</h3>
              {offer.upgraded && offer.hasCard && <p className="reward-screen__upgrade">Upgraded card reward</p>}
              {offer.hasCard ? (offer.choices === null ? (
                <div className="reward-screen__unrevealed">
                  <button type="button" onClick={() => onReveal(player.id)}>Reveal 3 for {player.name}</button>
                  <span className="muted">or skip without looking</span>
                </div>
              ) : (
                <>
                  <div className="reward-screen__cards">
                    {offer.choices.map((defId, index) => {
                      const key = `${player.id}-${index}`
                      const previewing = upgradePreviews[key] ?? offer.upgraded
                      const name = cardDef(defId).name
                      return (
                        <div className="reward-screen__choice" key={`${index}-${defId}`}>
                          <Card
                            card={{
                              uid: `reward-${player.id}-${index}`,
                              defId,
                              upgraded: previewing,
                            }}
                            selected={decisions[player.id]?.card === index}
                            onClick={() => setDecision(player.id, { card: index })}
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
              )) : null}
              {offer.hasCard ? (
                <button
                  type="button"
                  className={decisions[player.id]?.card === null ? 'is-chosen' : ''}
                  aria-pressed={decisions[player.id]?.card === null}
                  onClick={() => setDecision(player.id, { card: null })}
                >
                  {decisions[player.id]?.card === null ? '✓ ' : ''}
                  {offer.choices === null ? `Skip ${player.name}'s card unseen` : `Skip ${player.name}'s card`}
                </button>
              ) : null}
              {offer.hasPotion && !offer.potionId ? (
                <fieldset className="reward-screen__item">
                  <legend>Potion reward</legend>
                  <button type="button" onClick={() => onRevealItem(player.id, 'potion')}>Draw potion</button>
                  <button type="button" aria-pressed={decisions[player.id]?.potionRecipientId === null} onClick={() => setDecision(player.id, { potionRecipientId: null, discardPotionId: null })}>Skip potion unseen</button>
                </fieldset>
              ) : offer.potionId ? (
                <fieldset className="reward-screen__item">
                  <legend>{potionDef(offer.potionId).name}</legend>
                  <p>{potionDef(offer.potionId).text}</p>
                  {players.filter((recipient) => !recipient.dead).map((recipient) => {
                    const belt = recipient.potions
                    return belt.length < potionCap ? (
                      <button
                        type="button"
                        key={recipient.id}
                        aria-pressed={decisions[player.id]?.potionRecipientId === recipient.id && decisions[player.id]?.discardPotionId === null}
                        onClick={() => setDecision(player.id, { potionRecipientId: recipient.id, discardPotionId: null })}
                      >
                        Give to {recipient.name}
                      </button>
                    ) : belt.map((held, index) => (
                      <button
                        type="button"
                        key={`${recipient.id}-${held}-${index}`}
                        aria-pressed={decisions[player.id]?.potionRecipientId === recipient.id && decisions[player.id]?.discardPotionId === held}
                        onClick={() => setDecision(player.id, { potionRecipientId: recipient.id, discardPotionId: held })}
                      >
                        Replace {potionDef(held).name} on {recipient.name}
                      </button>
                    ))
                  })}
                  <button type="button" aria-pressed={decisions[player.id]?.potionRecipientId === null} onClick={() => setDecision(player.id, { potionRecipientId: null, discardPotionId: null })}>
                    Skip potion
                  </button>
                </fieldset>
              ) : null}
              {offer.hasRelic && offer.relicChoices === null ? (
                <fieldset className="reward-screen__item">
                  <legend>Relic reward</legend>
                  <button type="button" onClick={() => onRevealItem(player.id, 'relic')}>Reveal relics</button>
                  <button type="button" aria-pressed={decisions[player.id]?.relicId === null} onClick={() => setDecision(player.id, { relicId: null })}>Skip relic unseen</button>
                </fieldset>
              ) : offer.relicChoices && offer.relicChoices.length > 0 ? (
                <fieldset className="reward-screen__item">
                  <legend>Relic</legend>
                  {offer.relicChoices.map((id) => (
                    <button
                      type="button"
                      key={id}
                      disabled={selectedRelics.has(id) && decisions[player.id]?.relicId !== id}
                      aria-pressed={decisions[player.id]?.relicId === id}
                      title={relicDef(id).text}
                      onClick={() => setDecision(player.id, { relicId: id })}
                    >
                      {relicDef(id).name}
                    </button>
                  ))}
                  <button type="button" aria-pressed={decisions[player.id]?.relicId === null} onClick={() => setDecision(player.id, { relicId: null })}>
                    Skip relic
                  </button>
                </fieldset>
              ) : null}
              <button type="button" disabled={!settled || !potionReady} onClick={() => onResolve(player.id, {
                card: decisions[player.id]?.card ?? null,
                potionRecipientId: decisions[player.id]?.potionRecipientId ?? null,
                discardPotionId: decisions[player.id]?.discardPotionId ?? null,
                relicId: decisions[player.id]?.relicId ?? null,
              })}>
                {!settled
                  ? 'Reveal and choose every reward first'
                  : potionReady ? `Collect ${player.name}'s rewards` : 'Collect another reward or revise this potion'}
              </button>
            </div>
          )
        })}
      </div>
    </section>
  )
}
