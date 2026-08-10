import { useEffect, useState } from 'react'
import { cardDef } from '../game/cards.ts'
import { potionDef, relicDef } from '../game/relics.ts'
import type { RewardDecision } from '../game/run.ts'
import { CAPS } from '../game/types.ts'
import type { VisibleRun } from '../multiplayer/useRoomSession.ts'
import { Card } from './Card.tsx'

type Props = {
  run: VisibleRun
  viewerId: string
  choice?: RewardDecision | number | null
  decided: string[]
  onAction: (action: object) => void
}

type RewardDraft = Partial<RewardDecision>

export function OnlineRewardScreen({ run, viewerId, choice, decided, onAction }: Props) {
  const [upgradePreviews, setUpgradePreviews] = useState<Record<string, boolean>>({})
  const [draft, setDraft] = useState<RewardDraft>({})
  const mine = run.rewards.find((offer) => offer.playerId === viewerId)
  const allDecided = run.rewards.every((offer) => decided.includes(offer.playerId))
  const saved = choice === undefined
    ? null
    : typeof choice === 'object' && choice !== null
      ? choice
      : { card: choice, potionRecipientId: null, discardPotionId: null, relicId: null }
  const savedKey = JSON.stringify(saved)

  useEffect(() => {
    setDraft(savedKey === 'null' ? {} : JSON.parse(savedKey) as RewardDraft)
  }, [savedKey])

  const complete = Boolean(mine)
    && (!mine!.hasCard || draft.card !== undefined)
    && (!mine!.hasPotion || draft.potionRecipientId !== undefined)
    && (!mine!.hasRelic || draft.relicId !== undefined)
  const potionCap = run.ascension >= 4 ? 2 : CAPS.potions
  const completeDraft = complete ? {
    card: draft.card ?? null,
    potionRecipientId: draft.potionRecipientId ?? null,
    discardPotionId: draft.discardPotionId ?? null,
    relicId: draft.relicId ?? null,
  } : null
  const dirty = JSON.stringify(completeDraft) !== JSON.stringify(saved)
  const recipient = run.players.find((player) => player.id === draft.potionRecipientId)
  const potionReady = !mine?.hasPotion || draft.potionRecipientId === null || Boolean(
    mine.potionId && recipient && (draft.discardPotionId
      ? recipient.potions.includes(draft.discardPotionId)
      : recipient.potions.length < potionCap),
  )

  return (
    <section className="reward-screen">
      <h2>Combat rewards</h2>
      <p className="muted">Revealed cards and items are shared knowledge. Choose only for your seat.</p>
      <div className="reward-screen__players">
        {run.rewards.map((offer) => {
          const player = run.players.find((candidate) => candidate.id === offer.playerId)
          if (!player) return null
          const isMine = player.id === viewerId
          return (
            <div className="reward-screen__player" key={player.id}>
              <h3>{player.name}</h3>
              {offer.upgraded && offer.hasCard && <p className="reward-screen__upgrade">Upgraded card reward</p>}
              {offer.hasCard ? (offer.choices === null ? (
                <div className="reward-screen__unrevealed">
                  {isMine ? (
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
                          playable={isMine}
                          selected={isMine && draft.card === index}
                          onClick={isMine ? () => setDraft((current) => ({ ...current, card: index })) : undefined}
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
              )) : null}
              {isMine && offer.hasCard ? (
                <button type="button" aria-pressed={draft.card === null} onClick={() => setDraft((current) => ({ ...current, card: null }))}>
                  {draft.card === null ? '✓ ' : ''}Skip card
                </button>
              ) : null}
              {offer.hasPotion && !offer.potionId ? (
                <fieldset className="reward-screen__item">
                  <legend>Potion reward</legend>
                  {isMine ? <button type="button" onClick={() => onAction({ kind: 'cardReward', choice: 'revealPotion' })}>Draw potion</button> : <span className="muted">Not drawn yet</span>}
                  {isMine ? <button type="button" aria-pressed={draft.potionRecipientId === null} onClick={() => setDraft((current) => ({ ...current, potionRecipientId: null, discardPotionId: null }))}>Skip potion unseen</button> : null}
                </fieldset>
              ) : offer.potionId ? (
                <fieldset className="reward-screen__item">
                  <legend>{potionDef(offer.potionId).name}</legend>
                  <p>{potionDef(offer.potionId).text}</p>
                  {isMine ? run.players.filter((recipient) => !recipient.dead).flatMap((recipient) => recipient.potions.length < potionCap ? [(
                    <button type="button" key={recipient.id} aria-pressed={draft.potionRecipientId === recipient.id && draft.discardPotionId === null} onClick={() => setDraft((current) => ({ ...current, potionRecipientId: recipient.id, discardPotionId: null }))}>
                      Give to {recipient.name}
                    </button>
                  )] : recipient.potions.map((held, index) => (
                    <button type="button" key={`${recipient.id}-${held}-${index}`} aria-pressed={draft.potionRecipientId === recipient.id && draft.discardPotionId === held} onClick={() => setDraft((current) => ({ ...current, potionRecipientId: recipient.id, discardPotionId: held }))}>
                      Replace {potionDef(held).name} on {recipient.name}
                    </button>
                  ))) : null}
                  {isMine ? <button type="button" aria-pressed={draft.potionRecipientId === null} onClick={() => setDraft((current) => ({ ...current, potionRecipientId: null, discardPotionId: null }))}>Skip potion</button> : null}
                </fieldset>
              ) : null}
              {offer.hasRelic && offer.relicChoices === null ? (
                <fieldset className="reward-screen__item">
                  <legend>Relic reward</legend>
                  {isMine ? <button type="button" onClick={() => onAction({ kind: 'cardReward', choice: 'revealRelic' })}>Reveal relics</button> : <span className="muted">Not revealed yet</span>}
                  {isMine ? <button type="button" aria-pressed={draft.relicId === null} onClick={() => setDraft((current) => ({ ...current, relicId: null }))}>Skip relic unseen</button> : null}
                </fieldset>
              ) : offer.relicChoices && offer.relicChoices.length > 0 ? (
                <fieldset className="reward-screen__item">
                  <legend>Relic</legend>
                  {offer.relicChoices.map((id) => (
                    <button
                      type="button"
                      key={id}
                      disabled={!isMine}
                      aria-pressed={isMine && draft.relicId === id}
                      title={relicDef(id).text}
                      onClick={isMine ? () => setDraft((current) => ({ ...current, relicId: id })) : undefined}
                    >
                      {relicDef(id).name}
                    </button>
                  ))}
                  {isMine ? <button type="button" aria-pressed={draft.relicId === null} onClick={() => setDraft((current) => ({ ...current, relicId: null }))}>Skip relic</button> : null}
                </fieldset>
              ) : null}
              {isMine ? (
                <button
                  type="button"
                  disabled={!complete}
                  onClick={() => onAction({
                    kind: 'cardReward',
                    choice: completeDraft,
                  })}
                >
                  {decided.includes(player.id) ? 'Update choices' : complete ? 'Save choices' : 'Choose every reward'}
                </button>
              ) : <span className="muted">{decided.includes(player.id) ? 'Chosen' : 'Choosing…'}</span>}
            </div>
          )
        })}
      </div>
      <button
        type="button"
        disabled={!allDecided || !decided.includes(viewerId) || dirty || !potionReady}
        onClick={() => onAction({ kind: 'cardReward', choice: 'collect' })}
      >
        Collect my rewards
      </button>
    </section>
  )
}
