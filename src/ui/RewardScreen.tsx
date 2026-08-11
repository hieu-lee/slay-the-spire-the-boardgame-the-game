import { useState } from 'react'
import { cardDef } from '../game/cards.ts'
import { potionDef, relicDef } from '../game/relics.ts'
import { bossRelicCardChoice, rewardRelicCardChoiceId, validRelicCardPicks } from '../game/run.ts'
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
      && (!offer.hasRelic || (offer.requiredRelic ? typeof decision?.relicId === 'string' : decision?.relicId !== undefined))
      && (!(offer.goldReward && offer.goldReward > 0) || decision?.goldTiming !== undefined)
      && validRelicCardPicks(players.find((player) => player.id === offer.playerId)!,
        rewardRelicCardChoiceId(offer, decision?.relicId ?? null),
        decision?.relicCardUids ?? [])
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
          const relicCards = bossRelicCardChoice(player,
            rewardRelicCardChoiceId(offer, decisions[player.id]?.relicId ?? null))
          const potionReady = !offer.hasPotion || decisions[player.id]?.potionRecipientId === null || Boolean(
            offer.potionId && recipient && (discard
              ? recipient.potions.includes(discard)
              : recipient.potions.length < potionCap),
          )
          return (
            <div className="reward-screen__player" key={player.id}>
              <h3>{player.name}</h3>
              {offer.rare && offer.hasCard && <p className="reward-screen__upgrade">Rare card reward</p>}
              {offer.upgraded && offer.hasCard && <p className="reward-screen__upgrade">Upgraded card reward</p>}
              {offer.hasCard ? (offer.choices === null ? (
                <div className="reward-screen__unrevealed">
                  <button type="button" onClick={() => onReveal(player.id)}>Reveal {offer.revealCount ?? 3} for {player.name}</button>
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
              {offer.goldReward && offer.goldReward > 0 ? (
                <fieldset className="reward-screen__item">
                  <legend>{offer.goldReward} Gold</legend>
                  <button type="button" aria-pressed={decisions[player.id]?.goldTiming === 'before'} onClick={() => setDecision(player.id, { goldTiming: 'before' })}>
                    Take {offer.goldReward} Gold{offer.hasRelic ? ' before Relic' : ''}
                  </button>
                  {offer.hasRelic ? <button type="button" aria-pressed={decisions[player.id]?.goldTiming === 'after'} onClick={() => setDecision(player.id, { goldTiming: 'after' })}>
                    Take {offer.goldReward} Gold after Relic
                  </button> : null}
                  <button type="button" aria-pressed={decisions[player.id]?.goldTiming === null} onClick={() => setDecision(player.id, { goldTiming: null })}>Skip Gold</button>
                </fieldset>
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
                  {players.filter((recipient) => !recipient.dead && !recipient.relics.some((relic) => relic.defId === 'sozu')).map((recipient) => {
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
                  <button type="button" onClick={() => onRevealItem(player.id, 'relic')}>Reveal {offer.requiredRelic ? 'relic' : 'relics'}</button>
                  {!offer.requiredRelic && <button type="button" aria-pressed={decisions[player.id]?.relicId === null} onClick={() => setDecision(player.id, { relicId: null, relicCardUids: [] })}>Skip relic unseen</button>}
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
                      onClick={() => setDecision(player.id, { relicId: id, relicCardUids: [] })}
                    >
                      {relicDef(id).name}
                    </button>
                  ))}
                  {!offer.requiredRelic && <button type="button" aria-pressed={decisions[player.id]?.relicId === null} onClick={() => setDecision(player.id, { relicId: null, relicCardUids: [] })}>
                    Skip relic
                  </button>}
                </fieldset>
              ) : null}
              {relicCards.count > 0 ? (
                <fieldset className="reward-screen__item">
                  <legend>{relicCards.label} ({decisions[player.id]?.relicCardUids?.length ?? 0}/{relicCards.count})</legend>
                  <div className="reward-screen__cards">
                    {relicCards.cards.map((card) => {
                      const selected = decisions[player.id]?.relicCardUids?.includes(card.uid) === true
                      return <Card key={card.uid} card={card} selected={selected} onClick={() => {
                        const current = decisions[player.id]?.relicCardUids ?? []
                        const next = selected ? current.filter((uid) => uid !== card.uid)
                          : current.length < relicCards.count ? [...current, card.uid] : current
                        setDecision(player.id, { relicCardUids: next })
                      }} />
                    })}
                  </div>
                </fieldset>
              ) : null}
              <button type="button" disabled={!settled || !potionReady} onClick={() => {
                onResolve(player.id, {
                  card: decisions[player.id]?.card ?? null,
                  potionRecipientId: decisions[player.id]?.potionRecipientId ?? null,
                  discardPotionId: decisions[player.id]?.discardPotionId ?? null,
                  relicId: decisions[player.id]?.relicId ?? null,
                  goldTiming: decisions[player.id]?.goldTiming,
                  relicCardUids: decisions[player.id]?.relicCardUids ?? [],
                })
                setDecisions((current) => {
                  const next = { ...current }
                  delete next[player.id]
                  return next
                })
              }}>
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
