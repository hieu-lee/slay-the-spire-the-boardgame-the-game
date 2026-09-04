import { useRef, useState } from 'react'
import { pendingRelicEligibleCards } from '../game/run.ts'
import type { PendingGuardianSocket, PendingRelicPreview } from '../game/run.ts'
import type { ActionOutcome } from '../multiplayer/useRoomSession.ts'
import { cardDef } from '../game/cards.ts'
import { relicDef } from '../game/relics.ts'
import type { CardInstance } from '../game/types.ts'
import { Card } from './Card.tsx'
import { LootChoice } from './RewardScreen.tsx'
import { CardRewardIcon, CardRewardPicker } from './CardRewardPicker.tsx'

type Props = {
  pending: PendingRelicPreview
  deck: CardInstance[]
  onRewardChoice: (reward: number, choice: number) => void | Promise<ActionOutcome>
  onResolve: (cardUids: string[], rewardIndices: number[]) => void | Promise<ActionOutcome>
}

const CARD_COUNTS: Record<string, number> = {
  war_paint: 1, whetstone: 1, astrolabe: 3, empty_cage: 2, pandoras_box: 3, tiny_house: 1,
}

export function RelicResolvePanel({ pending, deck, onRewardChoice, onResolve }: Props) {
  const [cards, setCards] = useState<string[]>([])
  const [rewards, setRewards] = useState<number[]>(() => Object.assign([], pending.rewardIndices))
  const [rewardChoicePending, setRewardChoicePending] = useState(false)
  const actionPendingRef = useRef(false)
  const [resolving, setResolving] = useState(false)
  const [activeReward, setActiveReward] = useState<number | null>(() =>
    ['enchiridion', 'downfall_enchiridion'].includes(pending.relicId) && pending.rewardIndices?.[0] === undefined ? 0 : null)
  const eligible = pendingRelicEligibleCards({ deck }, pending.relicId)
  const count = Math.min(CARD_COUNTS[pending.relicId] ?? 0, eligible.length)
  const rewardReady = (pending.rewardChoices ?? []).every((_choice, index) => rewards[index] !== undefined)
  const clearPending = () => {
    actionPendingRef.current = false
    setRewardChoicePending(false)
    setResolving(false)
  }
  const chooseReward = (reward: number, choice: number) => {
    if (actionPendingRef.current) return
    actionPendingRef.current = true
    const next = [...rewards]
    next[reward] = choice
    setRewards(next)
    const outcome = onRewardChoice(reward, choice)
    if (outcome) {
      setRewardChoicePending(true)
      void outcome.then((result) => {
        const acknowledged = result.snapshot?.pendingRelic?.rewardIndices?.[reward] === choice
        if (!acknowledged && result.status !== 'accepted') {
          setRewards((current) => { const restored = [...current]; delete restored[reward]; return restored })
          clearPending()
          setActiveReward(reward)
        }
      }, () => {
        setRewards((current) => { const restored = [...current]; delete restored[reward]; return restored })
        clearPending()
        setActiveReward(reward)
      })
    } else queueMicrotask(clearPending)
    setActiveReward(null)
    if (cards.length === count && (pending.rewardChoices ?? []).every((_choices, index) => next[index] !== undefined)) onResolve(cards, next)
  }
  const resolveRelic = (cardUids: string[], rewardIndices: number[]) => {
    if (actionPendingRef.current) return
    actionPendingRef.current = true
    setResolving(true)
    const outcome = onResolve(cardUids, rewardIndices)
    if (outcome) void outcome.then((result) => {
      if (result.status !== 'accepted') clearPending()
    }, clearPending)
    else queueMicrotask(clearPending)
  }
  const rewardIsRare = (reward: number) => pending.relicId === 'enchiridion' || pending.relicId === 'forbidden_fruit' && reward === 1
  if (rewardChoicePending) return <section className="reward-screen reward-screen--card-choice" aria-busy="true">
    <h2 className="reward-screen__title">Choose a Card</h2>
    <p className="muted" role="status">Claiming card…</p>
  </section>
  if (activeReward !== null) {
    const choices = pending.rewardChoices?.[activeReward] ?? []
    return <CardRewardPicker choices={choices} upgraded={pending.rewardUpgraded?.[activeReward] === true}
      uidPrefix={`relic-reward-${activeReward}`} onChoose={(choice) => chooseReward(activeReward, choice)}
      onSkip={() => chooseReward(activeReward, -1)} />
  }
  if ((pending.rewardChoices?.length ?? 0) > 0 && count === 0) return <section className="reward-screen reward-screen--loot">
    <h2 className="reward-screen__title">Loot!</h2>
    <div className="reward-screen__players"><div className="reward-screen__player">
      {(pending.rewardChoices ?? []).map((_choices, reward) => rewards[reward] === undefined ? <LootChoice key={reward}
        icon={<CardRewardIcon rare={rewardIsRare(reward)} />} onClick={() => setActiveReward(reward)}>Add a card to your deck.</LootChoice> : null)}
    </div></div>
    <button className="reward-screen__skip" type="button" disabled={resolving}
      onClick={() => resolveRelic([], (pending.rewardChoices ?? []).map((_choices, index) => rewards[index] ?? -1))}>{resolving ? 'Resolving…' : 'Skip'}</button>
  </section>
  return <section className="room-screen relic-resolve">
    <h2>Resolve {relicDef(pending.relicId).name}</h2>
    {/* The panel asks the player to pick cards for an effect it never stated. */}
    <p className="room-item-text">{relicDef(pending.relicId).text}</p>
    {count > 0 ? <div className="campfire__deck">{eligible.map((card) => <Card key={card.uid} card={card}
      selected={cards.includes(card.uid)} onClick={() => setCards((current) => current.includes(card.uid)
        ? current.filter((uid) => uid !== card.uid)
        : current.length < count ? [...current, card.uid] : current)} />)}</div> : null}
    {(pending.rewardChoices ?? []).map((_choices, reward) => rewards[reward] === undefined ? <LootChoice key={reward}
      icon={<CardRewardIcon rare={rewardIsRare(reward)} />} onClick={() => setActiveReward(reward)}>Add a card to your deck.</LootChoice> : null)}
    <button type="button" disabled={resolving || cards.length !== count || !rewardReady}
      onClick={() => resolveRelic(cards, rewards)}>{resolving ? 'Resolving…' : 'Resolve Relic'}</button>
  </section>
}

export function GuardianSocketPanel({ pending, deck, onResolve }: {
  pending: PendingGuardianSocket
  deck: CardInstance[]
  onResolve: (gemId: string) => void
}) {
  const host = deck.find((card) => card.uid === pending.cardUid)
  return <section className="room-screen relic-resolve">
    <h2>Socket a Gem{host ? ` into ${cardDef(host.defId).name}` : ''}</h2>
    <p className="room-item-text">Choose one revealed Gem. The others return to the bottom of the Gem deck.</p>
    <div className="campfire__deck">
      {pending.gemIds.map((gemId) => <Card key={gemId}
        card={{ uid: `socket-${gemId}`, defId: gemId, upgraded: false }}
        onClick={() => onResolve(gemId)} />)}
    </div>
  </section>
}
