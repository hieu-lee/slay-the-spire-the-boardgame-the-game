import { useState } from 'react'
import { pendingRelicEligibleCards } from '../game/run.ts'
import type { PendingRelicPreview } from '../game/run.ts'
import { relicDef } from '../game/relics.ts'
import type { CardInstance } from '../game/types.ts'
import { Card } from './Card.tsx'

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
  const eligible = pendingRelicEligibleCards({ deck }, pending.relicId)
  const count = Math.min(CARD_COUNTS[pending.relicId] ?? 0, eligible.length)
  const rewardReady = (pending.rewardChoices ?? []).every((_choice, index) => rewards[index] !== undefined)
  return <section className="room-screen">
    <h2>Resolve {relicDef(pending.relicId).name}</h2>
    {/* The panel asks the player to pick cards for an effect it never stated. */}
    <p className="room-item-text">{relicDef(pending.relicId).text}</p>
    {count > 0 ? <div className="campfire__deck">{eligible.map((card) => <Card key={card.uid} card={card}
      selected={cards.includes(card.uid)} onClick={() => setCards((current) => current.includes(card.uid)
        ? current.filter((uid) => uid !== card.uid)
        : current.length < count ? [...current, card.uid] : current)} />)}</div> : null}
    {(pending.rewardChoices ?? []).map((choices, reward) => <div key={reward} className="campfire__deck">
      {choices.map((defId, index) => <Card key={`${reward}-${index}`}
        card={{ uid: `relic-reward-${reward}-${index}`, defId, upgraded: false }}
        selected={rewards[reward] === index} onClick={() => setRewards((current) => {
          const next = [...current]; next[reward] = index; return next
        })} />)}
      <button type="button" aria-pressed={rewards[reward] === -1} onClick={() => setRewards((current) => {
        const next = [...current]; next[reward] = -1; return next
      })}>{rewards[reward] === -1 ? '✓ ' : ''}Skip reward</button>
    </div>)}
    <button type="button" disabled={cards.length !== count || !rewardReady}
      onClick={() => onResolve(cards, rewards)}>Resolve Relic</button>
  </section>
}
