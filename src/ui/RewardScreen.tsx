import { useState, type ReactNode } from 'react'
import { assetPath } from '../game/assets.ts'
import { cardIsCurse } from '../game/cards.ts'
import type { CardRewardOffer, PotionRewardDecision, RewardSource } from '../game/run.ts'
import { potionLimit } from '../game/acquisition.ts'
import { potionDef, relicDef } from '../game/relics.ts'
import type { Player } from '../game/types.ts'
import { Card } from './Card.tsx'
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
  onGold: (playerId: string) => void
  onPotion: (playerId: string, decision: PotionRewardDecision) => void
  onRelic: (playerId: string, choice: 'gain' | 'skip') => void
  onBossRelic: (playerId: string, relicId: string | null) => void
  onTransform: (playerId: string, cardUid: string | null) => void
  onResolve: (decisions: Record<string, number | null>) => void
  ascension: number
}

/** A compact, click-to-claim loot table. Card choices take over the sheet. */
export function RewardScreen({ players, rewards, onReveal, onGold, onPotion, onRelic, onBossRelic, onTransform, onResolve, ascension }: RewardScreenProps) {
  const [activeCardPlayerId, setActiveCardPlayerId] = useState<string | null>(null)
  const [decisions, setDecisions] = useState<Record<string, number | null>>({})
  const [sources, setSources] = useState<RewardSource[]>([])
  const activeOffer = activeCardPlayerId === null ? undefined : rewards.find((offer) => offer.playerId === activeCardPlayerId && offer.cardReward)
  const activePlayer = activeOffer && players.find((player) => player.id === activeOffer.playerId)
  const itemsPending = rewards.some((offer) => offer.gold || offer.potion !== false || (offer.relic ?? false) !== false ||
    (offer.bossRelics ?? false) !== false || offer.transformReward)
  const chooseCard = (playerId: string, choice: number | null) => {
    const next = { ...decisions, [playerId]: choice }
    setDecisions(next)
    setActiveCardPlayerId(null)
    if (rewards.filter((offer) => offer.cardReward).every((offer) => offer.playerId in next) &&
      rewards.every((offer) => !offer.gold && offer.potion === false && (offer.relic ?? false) === false && (offer.bossRelics ?? false) === false && !offer.transformReward)) onResolve(next)
  }
  const skipLoot = () => {
    rewards.forEach((offer) => {
      if (offer.gold) onGold(offer.playerId)
      if (offer.potion) onPotion(offer.playerId, { kind: 'skipAll' })
      if (offer.relic) onRelic(offer.playerId, 'skip')
      if (offer.bossRelics) onBossRelic(offer.playerId, null)
      if (offer.transformReward) onTransform(offer.playerId, null)
    })
    const skipped = Object.fromEntries(rewards.filter((offer) => offer.cardReward).map((offer) => [offer.playerId, null]))
    if (Object.keys(skipped).length > 0) onResolve(skipped)
  }

  if (activeOffer && activePlayer && activeOffer.choices === null && activeOffer.prismatic) return <section className="reward-screen reward-screen--card-choice">
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

  if (activeOffer && activePlayer && activeOffer.choices !== null) return <section className="reward-screen reward-screen--card-choice">
    <h2 className="reward-screen__title">Choose a Card</h2>
    <div className="reward-screen__cards">
      {activeOffer.choices.map((defId, index) => <Card key={`${defId}-${index}`}
        card={{ uid: `reward-${activePlayer.id}-${index}`, defId, upgraded: activeOffer.upgraded }}
        onClick={() => chooseCard(activePlayer.id, index)} />)}
    </div>
    <button className="reward-screen__skip" type="button" onClick={() => chooseCard(activePlayer.id, null)}>Skip</button>
  </section>

  return <section className="reward-screen reward-screen--loot">
    <h2 className="reward-screen__title">Loot!</h2>
    <div className="reward-screen__players">
      {rewards.map((offer) => {
        const player = players.find((candidate) => candidate.id === offer.playerId)
        if (!player) return null
        const sozu = player.relics.some((relic) => relic.defId === 'sozu')
        const potionBlocked = player.potions.length >= potionLimit(ascension, player) || sozu
        return <div className="reward-screen__player" key={player.id}>
          {players.length > 1 ? <h3>{player.name}</h3> : null}
          {offer.gold ? <LootChoice onClick={() => onGold(player.id)} icon={<img src={assetPath('icons/gold.png')} alt="" />}>{offer.gold} Gold</LootChoice> : null}
          {typeof offer.potion === 'string' ? <><LootChoice disabled={potionBlocked} onClick={() => onPotion(player.id, { kind: 'gain' })}
            icon={<ItemImage kind="potion" id={offer.potion} />}>{potionDef(offer.potion).name}</LootChoice>
            <div className="loot-choice__actions">
              <button type="button" onClick={() => onPotion(player.id, { kind: 'skip' })}>Skip {potionDef(offer.potion).name}</button>
              {potionBlocked && !sozu ? player.potions.map((held, index) => <button type="button" key={`${held}-${index}`}
                onClick={() => onPotion(player.id, { kind: 'replace', potionId: held })}>Replace {potionDef(held).name}</button>) : null}
              {potionBlocked && players.filter((target) => target.id !== player.id && !target.dead && target.potions.length < potionLimit(ascension, target) &&
                !target.relics.some((relic) => relic.defId === 'sozu')).map((target) => <button type="button" key={target.id}
                  onClick={() => onPotion(player.id, { kind: 'pass', playerId: target.id })}>Pass to {target.name}</button>)}
            </div></> : null}
          {typeof offer.relic === 'string' ? <><LootChoice onClick={() => onRelic(player.id, 'gain')}
            icon={<ItemImage kind="relic" id={offer.relic} />}>{relicDef(offer.relic).name}</LootChoice>
            <div className="loot-choice__actions"><button type="button" onClick={() => onRelic(player.id, 'skip')}>Skip {relicDef(offer.relic).name}</button></div></> : null}
          {Array.isArray(offer.bossRelics) ? offer.bossRelics.map((relicId) => <LootChoice key={relicId} onClick={() => onBossRelic(player.id, relicId)}
            icon={<ItemImage kind="relic" id={relicId} />}>{relicDef(relicId).name}</LootChoice>)
          : null}
          {Array.isArray(offer.bossRelics) ? <div className="loot-choice__actions"><button type="button" onClick={() => onBossRelic(player.id, null)}>Skip boss Relics</button></div> : null}
          {offer.cardReward ? <LootChoice disabled={itemsPending} onClick={() => {
            setActiveCardPlayerId(player.id)
            setSources([])
            if (!offer.prismatic) onReveal(player.id)
          }}
            icon={<img src={assetPath('menu/current-deck.webp')} alt="" />}>Add a card to your deck.</LootChoice> : null}
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
