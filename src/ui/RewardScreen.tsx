import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { assetPath } from '../game/assets.ts'
import { cardIsCurse } from '../game/cards.ts'
import type { CardRewardOffer, PotionRewardDecision, RewardSource } from '../game/run.ts'
import { potionLimit } from '../game/acquisition.ts'
import { potionDef, relicDef } from '../game/relics.ts'
import type { Player } from '../game/types.ts'
import { Card } from './Card.tsx'
import { CardRewardIcon, CardRewardPicker } from './CardRewardPicker.tsx'
import { ItemImage } from './ItemImage.tsx'
import { rewardSourceLabel } from './reward-source.ts'

export function LootChoice({ children, icon, onClick, disabled = false }: {
  children: ReactNode
  icon: ReactNode
  onClick: () => void
  disabled?: boolean
}) {
  return <button className="loot-choice" type="button" onClick={onClick} disabled={disabled}>
    <span className="loot-choice__icon">{icon}</span><strong>{children}</strong>
  </button>
}

export function PotionLootChoices({ potionId, player, ascension, disabled = false, onChoose }: {
  potionId: string
  player: Pick<Player, 'potions' | 'relics'>
  ascension: number
  disabled?: boolean
  onChoose: (decision: PotionRewardDecision) => void
}) {
  const name = potionDef(potionId).name
  const sozu = player.relics.some((relic) => relic.defId === 'sozu')
  if (player.potions.length < potionLimit(ascension, player) || sozu) return <LootChoice disabled={disabled || sozu}
    onClick={() => onChoose({ kind: 'gain' })} icon={<ItemImage kind="potion" id={potionId} />}>{name}</LootChoice>
  return player.potions.map((held, index) => <LootChoice key={`${held}-${index}`} disabled={disabled}
    onClick={() => onChoose({ kind: 'replace', potionId: held })} icon={<ItemImage kind="potion" id={potionId} />}>
    {name} — replace {potionDef(held).name}
  </LootChoice>)
}

/** Shared compact item row for Neow and room offers. */
export function RewardItem({ kind, id, title, note, children }: {
  kind: 'relic' | 'potion'
  id?: string
  title: string
  note?: string
  children?: ReactNode
}) {
  const detail = id ? kind === 'relic' ? relicDef(id).text : potionDef(id).text : note
  return <div className={`reward-item reward-screen__${kind}`} role="group" aria-label={title}>
    {id ? <ItemImage kind={kind} id={id} /> : <span className="reward-item__facedown" aria-hidden="true">{kind === 'relic' ? '◆' : '●'}</span>}
    <div className="reward-item__body"><strong>{title}</strong>{detail ? <span className="room-item-text">{detail}</span> : null}</div>
    <div className="reward-item__actions">{children}</div>
  </div>
}

type RewardScreenProps = {
  players: Player[]
  rewards: CardRewardOffer[]
  onReveal: (playerId: string, sources?: readonly RewardSource[]) => void
  onGold: (playerId: string, gain?: boolean) => void
  onPotion: (playerId: string, decision: PotionRewardDecision) => void
  onRelic: (playerId: string, choice: 'gain' | 'skip') => void
  onBossRelic: (playerId: string, relicId: string | null) => void
  onTransform: (playerId: string, cardUid: string | null) => void
  onResolve: (decisions: Record<string, number | null>) => void
  ascension: number
  act: number
}

/** A compact, click-to-claim loot table. Card choices take over the sheet. */
export function RewardScreen({ players, rewards, onReveal, onGold, onPotion, onRelic, onBossRelic, onTransform, onResolve, ascension, act }: RewardScreenProps) {
  const [activeCardPlayerId, setActiveCardPlayerId] = useState<string | null>(null)
  const [sources, setSources] = useState<RewardSource[]>([])
  const backdrop = { '--reward-backdrop': `url("${assetPath(`backgrounds/boss-act-${act}.webp`)}")` } as CSSProperties
  const activeOffer = activeCardPlayerId === null ? undefined : rewards.find((offer) => offer.playerId === activeCardPlayerId && offer.cardReward)
  const activePlayer = activeOffer && players.find((player) => player.id === activeOffer.playerId)
  const availableSources = activeOffer?.availableSources ?? []
  const availableSourcesKey = availableSources.join(',')
  useEffect(() => setSources((current) => current.filter((source) => availableSources.includes(source))), [availableSourcesKey])
  const chooseCard = (playerId: string, choice: number | null) => {
    setActiveCardPlayerId(null)
    onResolve({ [playerId]: choice })
  }
  const skipLoot = () => {
    rewards.forEach((offer) => {
      if (offer.gold) onGold(offer.playerId, false)
      if (offer.potion) onPotion(offer.playerId, { kind: 'skipAll' })
      if (offer.relic) onRelic(offer.playerId, 'skip')
      if (offer.bossRelics) onBossRelic(offer.playerId, null)
      if (offer.transformReward) onTransform(offer.playerId, null)
    })
    const skipped = Object.fromEntries(rewards.filter((offer) => offer.cardReward).map((offer) => [offer.playerId, null]))
    if (Object.keys(skipped).length > 0) onResolve(skipped)
  }

  if (activeOffer && activePlayer && activeOffer.choices === null && activeOffer.prismatic) return <section className="reward-screen reward-screen--card-choice" style={backdrop}>
    <h2 className="reward-screen__title">Choose a Card</h2>
    <fieldset className="reward-screen__sources"><legend>Choose 3 reward decks</legend>
      {(activeOffer.availableSources ?? []).map((source) => <label key={source}><input type="checkbox" checked={sources.includes(source)}
        onChange={(event) => setSources((current) => event.target.checked
          ? current.length < 3 ? [...current, source] : current
          : current.filter((candidate) => candidate !== source))} /> {rewardSourceLabel(source)}</label>)}
      <button type="button" disabled={sources.length !== 3} onClick={() => onReveal(activePlayer.id, sources)}>Reveal cards</button>
    </fieldset>
    <button className="reward-screen__skip" type="button" onClick={() => chooseCard(activePlayer.id, null)}>Skip</button>
  </section>

  if (activeOffer && activePlayer && activeOffer.choices !== null) return <CardRewardPicker
    choices={activeOffer.choices} upgraded={activeOffer.upgraded} uidPrefix={`reward-${activePlayer.id}`} style={backdrop}
    onChoose={(index) => chooseCard(activePlayer.id, index)} onSkip={() => chooseCard(activePlayer.id, null)} />

  return <section className="reward-screen reward-screen--loot" style={backdrop}>
    <h2 className="reward-screen__title">Loot!</h2>
    <div className="reward-screen__players">
      {rewards.map((offer) => {
        const player = players.find((candidate) => candidate.id === offer.playerId)
        if (!player) return null
        return <div className="reward-screen__player" key={player.id}>
          {players.length > 1 ? <h3>{player.name}</h3> : null}
          {offer.gold ? <LootChoice onClick={() => onGold(player.id)} icon={<img src={assetPath('icons/gold.png')} alt="" />}>{offer.gold} Gold</LootChoice> : null}
          {typeof offer.potion === 'string' ? <PotionLootChoices potionId={offer.potion} player={player} ascension={ascension}
            onChoose={(decision) => onPotion(player.id, decision)} /> : null}
          {typeof offer.relic === 'string' ? <LootChoice onClick={() => onRelic(player.id, 'gain')}
            icon={<ItemImage kind="relic" id={offer.relic} />}>{relicDef(offer.relic).name}</LootChoice> : null}
          {Array.isArray(offer.bossRelics) ? offer.bossRelics.map((relicId) => <LootChoice key={relicId} onClick={() => onBossRelic(player.id, relicId)}
            icon={<ItemImage kind="relic" id={relicId} />}>{relicDef(relicId).name}</LootChoice>)
          : null}
          {offer.cardReward ? <LootChoice onClick={() => {
            setActiveCardPlayerId(player.id)
            setSources([])
            if (!offer.prismatic) onReveal(player.id)
          }}
            icon={<CardRewardIcon rare={offer.cardSource === 'rare'} />}>Add a card to your deck.</LootChoice> : null}
          {offer.transformReward ? <div className="reward-screen__transform"><strong>Transform a card</strong>
            <div className="reward-screen__cards">{player.deck.filter((card) => !cardIsCurse(card.defId)).map((card) =>
              <Card key={card.uid} card={card} playable onClick={() => onTransform(player.id, card.uid)} />)}</div>
            <button type="button" onClick={() => onTransform(player.id, null)}>Skip Transform</button>
          </div> : null}
        </div>
      })}
    </div>
    <button className="reward-screen__skip" type="button" onClick={skipLoot}>Skip</button>
  </section>
}
