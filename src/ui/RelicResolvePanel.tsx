import { useState } from 'react'
import { pendingRelicEligibleCards } from '../game/run.ts'
import type { PendingGuardianSocket, PendingRelicPreview } from '../game/run.ts'
import { cardDef } from '../game/cards.ts'
import { relicDef } from '../game/relics.ts'
import type { CardInstance } from '../game/types.ts'
import { Card } from './Card.tsx'
import { assetPath } from '../game/assets.ts'
import { LootChoice } from './RewardScreen.tsx'

type Props = {
  pending: PendingRelicPreview
  deck: CardInstance[]
  onResolve: (cardUids: string[], rewardIndices: number[]) => void
}

const CARD_COUNTS: Record<string, number> = {
  war_paint: 1, whetstone: 1, astrolabe: 3, empty_cage: 2, pandoras_box: 3, tiny_house: 1,
}

export function RelicResolvePanel({ pending, deck, onResolve }: Props) {
  const [cards, setCards] = useState<string[]>([])
  const [rewards, setRewards] = useState<number[]>([])
  const [activeReward, setActiveReward] = useState<number | null>(null)
  const eligible = pendingRelicEligibleCards({ deck }, pending.relicId)
  const count = Math.min(CARD_COUNTS[pending.relicId] ?? 0, eligible.length)
  const rewardReady = (pending.rewardChoices ?? []).every((_choice, index) => rewards[index] !== undefined)
  const chooseReward = (reward: number, choice: number) => {
    const next = [...rewards]
    next[reward] = choice
    setRewards(next)
    setActiveReward(null)
    if (cards.length === count && (pending.rewardChoices ?? []).every((_choices, index) => next[index] !== undefined)) onResolve(cards, next)
  }
  if (pending.relicId === 'orrery' && activeReward !== null) {
    const choices = pending.rewardChoices?.[activeReward] ?? []
    return <section className="reward-screen reward-screen--card-choice">
      <h2 className="reward-screen__title">Choose a Card</h2>
      <div className="reward-screen__cards">{choices.map((defId, index) => <Card key={`${defId}-${index}`}
        card={{ uid: `orrery-${activeReward}-${index}`, defId, upgraded: false }} onClick={() => chooseReward(activeReward, index)} />)}</div>
      <button className="reward-screen__skip" type="button" onClick={() => chooseReward(activeReward, -1)}>Skip</button>
    </section>
  }
  if (pending.relicId === 'orrery') return <section className="reward-screen reward-screen--loot">
    <h2 className="reward-screen__title">Loot!</h2>
    <div className="reward-screen__players"><div className="reward-screen__player">
      {(pending.rewardChoices ?? []).map((_choices, reward) => rewards[reward] === undefined ? <LootChoice key={reward}
        icon={<img src={assetPath('menu/current-deck.webp')} alt="" />} onClick={() => setActiveReward(reward)}>Add a card to your deck.</LootChoice> : null)}
    </div></div>
    <button className="reward-screen__skip" type="button" onClick={() => onResolve([], (pending.rewardChoices ?? []).map(() => -1))}>Skip</button>
  </section>
  return <section className="room-screen relic-resolve">
    <h2>Resolve {relicDef(pending.relicId).name}</h2>
    {/* The panel asks the player to pick cards for an effect it never stated. */}
    <p className="room-item-text">{relicDef(pending.relicId).text}</p>
    {count > 0 ? <div className="campfire__deck">{eligible.map((card) => <Card key={card.uid} card={card}
      selected={cards.includes(card.uid)} onClick={() => setCards((current) => current.includes(card.uid)
        ? current.filter((uid) => uid !== card.uid)
        : current.length < count ? [...current, card.uid] : current)} />)}</div> : null}
    {(pending.rewardChoices ?? []).map((choices, reward) => <div key={reward} className="campfire__deck">
      {choices.map((defId, index) => <Card key={`${reward}-${index}`}
        card={{ uid: `relic-reward-${reward}-${index}`, defId, upgraded: pending.rewardUpgraded?.[reward] === true }}
        selected={rewards[reward] === index} onClick={() => chooseReward(reward, index)} />)}
      <button type="button" aria-pressed={rewards[reward] === -1} onClick={() => chooseReward(reward, -1)}>{rewards[reward] === -1 ? '✓ ' : ''}Skip reward</button>
      {(pending.guardianGemGroups?.[reward] ?? []).map((gemId) => <Card key={`${reward}-${gemId}`}
        card={{ uid: `relic-gem-${reward}-${gemId}`, defId: gemId, upgraded: false }} />)}
    </div>)}
    <button type="button" disabled={cards.length !== count || !rewardReady}
      onClick={() => onResolve(cards, rewards)}>Resolve Relic</button>
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
