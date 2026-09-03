import { useEffect, useState } from 'react'
import { assetPath } from '../game/assets.ts'
import { cardIsCurse } from '../game/cards.ts'
import type { VisibleRun } from '../multiplayer/useRoomSession.ts'
import { potionDef, relicDef } from '../game/relics.ts'
import { potionLimit } from '../game/acquisition.ts'
import type { RewardSource } from '../game/run.ts'
import { rewardSourceLabel } from './reward-source.ts'
import { Card } from './Card.tsx'
import { ItemImage } from './ItemImage.tsx'
import { LootChoice } from './RewardScreen.tsx'

type Props = {
  run: VisibleRun
  viewerId: string
  choice?: number | null
  decided: string[]
  confirmed: string[]
  onAction: (action: object) => void
}

export function OnlineRewardScreen({ run, viewerId, choice, decided, confirmed, onAction }: Props) {
  const [activeCard, setActiveCard] = useState(false)
  const [sources, setSources] = useState<RewardSource[]>([])
  const offer = run.rewards.find((candidate) => candidate.playerId === viewerId)
  const player = run.players.find((candidate) => candidate.id === viewerId)
  if (!offer || !player) return null
  const sozu = player.relics.some((relic) => relic.defId === 'sozu')
  const potionBlocked = player.potions.length >= potionLimit(run.ascension, player) || sozu
  const itemsPending = run.rewards.some((candidate) => candidate.gold || candidate.potion !== false ||
    (candidate.relic ?? false) !== false || (candidate.bossRelics ?? false) !== false || candidate.transformReward)
  const everyCardChoiceIsMade = run.rewards.filter((candidate) => candidate.cardReward)
    .every((candidate) => decided.includes(candidate.playerId))
  useEffect(() => {
    if (!itemsPending && offer.cardReward && decided.includes(viewerId) && everyCardChoiceIsMade && !confirmed.includes(viewerId)) {
      onAction({ kind: 'cardReward', choice: 'confirm' })
    }
  }, [confirmed, decided, everyCardChoiceIsMade, itemsPending, offer.cardReward, onAction, viewerId])
  const pickCard = (nextChoice: number | null) => {
    onAction({ kind: 'cardReward', choice: nextChoice })
    setActiveCard(false)
  }
  const skipLoot = () => {
    if (offer.gold) onAction({ kind: 'goldReward' })
    if (offer.potion) onAction({ kind: 'potionReward', choice: 'skipAll' })
    if (offer.relic) onAction({ kind: 'relicReward', choice: 'skip' })
    if (offer.bossRelics) onAction({ kind: 'bossRelicReward', choice: 'skip' })
    if (offer.transformReward) onAction({ kind: 'transformReward', cardUid: null })
    if (offer.cardReward) pickCard(null)
  }

  if (activeCard && offer.cardReward && offer.choices === null) return <section className="reward-screen reward-screen--card-choice">
    <h2 className="reward-screen__title">Choose a Card</h2>
    {offer.prismatic ? <fieldset className="reward-screen__sources"><legend>Choose 3 reward decks</legend>
      {(offer.availableSources ?? []).map((source) => <label key={source}><input type="checkbox" checked={sources.includes(source)}
        onChange={(event) => setSources((current) => event.target.checked
          ? current.length < 3 ? [...current, source] : current
          : current.filter((candidate) => candidate !== source))} /> {rewardSourceLabel(source)}</label>)}
      <button type="button" disabled={sources.length !== 3} onClick={() => onAction({ kind: 'cardReward', choice: 'reveal', sources })}>Reveal cards</button>
    </fieldset> : <p className="muted">Revealing cards…</p>}
    <button className="reward-screen__skip" type="button" onClick={() => pickCard(null)}>Skip</button>
  </section>

  if (activeCard && offer.cardReward && offer.choices !== null) return <section className="reward-screen reward-screen--card-choice">
    <h2 className="reward-screen__title">Choose a Card</h2>
    <div className="reward-screen__cards">
      {offer.choices.map((defId, index) => <Card key={`${defId}-${index}`}
        card={{ uid: `reward-${viewerId}-${index}`, defId, upgraded: offer.upgraded }} selected={choice === index}
        onClick={() => pickCard(index)} />)}
    </div>
    <button className="reward-screen__skip" type="button" onClick={() => pickCard(null)}>Skip</button>
  </section>

  return <section className="reward-screen reward-screen--loot">
    <h2 className="reward-screen__title">Loot!</h2>
    <div className="reward-screen__players"><div className="reward-screen__player">
      {offer.gold ? <LootChoice onClick={() => onAction({ kind: 'goldReward' })} icon={<img src={assetPath('icons/gold.png')} alt="" />}>{offer.gold} Gold</LootChoice> : null}
      {typeof offer.potion === 'string' ? <><LootChoice disabled={potionBlocked} onClick={() => onAction({ kind: 'potionReward', choice: 'gain' })}
        icon={<ItemImage kind="potion" id={offer.potion} />}>{potionDef(offer.potion).name}</LootChoice>
        <div className="loot-choice__actions">
          <button type="button" onClick={() => onAction({ kind: 'potionReward', choice: 'skip' })}>Skip {potionDef(offer.potion).name}</button>
          {potionBlocked && !sozu ? player.potions.map((held, index) => <button type="button" key={`${held}-${index}`}
            onClick={() => onAction({ kind: 'potionReward', choice: 'replace', potionId: held })}>Replace {potionDef(held).name}</button>) : null}
          {potionBlocked && run.players.filter((target) => target.id !== player.id && !target.dead && target.potions.length < potionLimit(run.ascension, target) &&
            !target.relics.some((relic) => relic.defId === 'sozu')).map((target) => <button type="button" key={target.id}
              onClick={() => onAction({ kind: 'potionReward', choice: 'pass', playerId: target.id })}>Pass to {target.name}</button>)}
        </div></> : null}
      {typeof offer.relic === 'string' ? <><LootChoice onClick={() => onAction({ kind: 'relicReward', choice: 'gain' })}
        icon={<ItemImage kind="relic" id={offer.relic} />}>{relicDef(offer.relic).name}</LootChoice>
        <div className="loot-choice__actions"><button type="button" onClick={() => onAction({ kind: 'relicReward', choice: 'skip' })}>Skip {relicDef(offer.relic).name}</button></div></> : null}
      {Array.isArray(offer.bossRelics) ? offer.bossRelics.map((relicId) => <LootChoice key={relicId} onClick={() => onAction({ kind: 'bossRelicReward', choice: 'gain', relicId })}
        icon={<ItemImage kind="relic" id={relicId} />}>{relicDef(relicId).name}</LootChoice>)
      : null}
      {Array.isArray(offer.bossRelics) ? <div className="loot-choice__actions"><button type="button" onClick={() => onAction({ kind: 'bossRelicReward', choice: 'skip' })}>Skip boss Relics</button></div> : null}
      {offer.cardReward ? <LootChoice disabled={itemsPending} onClick={() => {
        setActiveCard(true)
        if (offer.choices === null && !offer.prismatic) onAction({ kind: 'cardReward', choice: 'reveal' })
      }} icon={<img src={assetPath('menu/current-deck.webp')} alt="" />}>{decided.includes(viewerId) ? 'Card reward chosen.' : 'Add a card to your deck.'}</LootChoice> : null}
      {offer.transformReward ? <div className="reward-screen__transform"><strong>Transform a card</strong>
        <div className="reward-screen__cards">{(player.deck ?? []).filter((card) => !cardIsCurse(card.defId)).map((card) =>
          <Card key={card.uid} card={card} playable onClick={() => onAction({ kind: 'transformReward', cardUid: card.uid })} />)}</div>
        <button type="button" onClick={() => onAction({ kind: 'transformReward', cardUid: null })}>Skip Transform</button>
      </div> : null}
    </div></div>
    <button className="reward-screen__skip" type="button" onClick={skipLoot}>Skip</button>
  </section>
}
