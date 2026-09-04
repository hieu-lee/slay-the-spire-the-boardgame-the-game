import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { assetPath } from '../game/assets.ts'
import { cardIsCurse } from '../game/cards.ts'
import type { ActionOutcome, VisibleRun } from '../multiplayer/useRoomSession.ts'
import { potionDef, relicDef } from '../game/relics.ts'
import { potionLimit } from '../game/acquisition.ts'
import type { RewardSource } from '../game/run.ts'
import { rewardSourceLabel } from './reward-source.ts'
import { Card } from './Card.tsx'
import { CardRewardIcon, CardRewardPicker } from './CardRewardPicker.tsx'
import { ItemImage } from './ItemImage.tsx'
import { LootChoice } from './RewardScreen.tsx'

type Props = {
  run: VisibleRun
  viewerId: string
  decided: string[]
  confirmed: string[]
  onAction: (action: object) => Promise<ActionOutcome>
}

export function OnlineRewardScreen({ run, viewerId, decided, confirmed, onAction }: Props) {
  const [activeCard, setActiveCard] = useState(false)
  const [cardChoicePending, setCardChoicePending] = useState(false)
  const cardChoicePendingRef = useRef(false)
  const [revealPending, setRevealPending] = useState(false)
  const revealPendingRef = useRef(false)
  const [lootPending, setLootPending] = useState(false)
  const lootPendingRef = useRef(false)
  const confirmPending = useRef(false)
  const [sources, setSources] = useState<RewardSource[]>([])
  const backdrop = { '--reward-backdrop': `url("${assetPath(`backgrounds/boss-act-${run.act}.webp`)}")` } as CSSProperties
  const offer = run.rewards.find((candidate) => candidate.playerId === viewerId)
  const player = run.players.find((candidate) => candidate.id === viewerId)
  const availableSources = offer?.availableSources ?? []
  const availableSourcesKey = availableSources.join(',')
  useEffect(() => setSources((current) => current.filter((source) => availableSources.includes(source))), [availableSourcesKey])
  useEffect(() => {
    if (offer?.cardReward && decided.includes(viewerId) && !confirmed.includes(viewerId)) {
      if (confirmPending.current) return
      confirmPending.current = true
      void onAction({ kind: 'cardReward', choice: 'confirm' }).then((outcome) => {
        const acknowledged = outcome.snapshot !== undefined && (outcome.snapshot.rewardConfirmed.includes(viewerId) ||
          !outcome.snapshot.run?.rewards.some((candidate) => candidate.playerId === viewerId && candidate.cardReward))
        if (!acknowledged && outcome.status !== 'accepted') confirmPending.current = false
      }, () => { confirmPending.current = false })
    } else if (!offer?.cardReward || confirmed.includes(viewerId)) {
      confirmPending.current = false
    }
  }, [confirmed, decided, offer?.cardReward, onAction, viewerId])
  useEffect(() => {
    if (!offer?.cardReward || decided.includes(viewerId)) {
      cardChoicePendingRef.current = false
      setCardChoicePending(false)
      setActiveCard(false)
    }
    if (offer?.choices !== null) {
      revealPendingRef.current = false
      setRevealPending(false)
    }
  }, [decided, offer?.cardReward, offer?.choices, viewerId])
  if (!offer || !player) return null
  const sozu = player.relics.some((relic) => relic.defId === 'sozu')
  const potionBlocked = player.potions.length >= potionLimit(run.ascension, player) || sozu
  const hasLootChoice = Boolean(offer.gold || offer.potion || offer.relic ||
    Array.isArray(offer.bossRelics) && offer.bossRelics.length > 0 || offer.transformReward ||
    offer.cardReward && !decided.includes(viewerId))
  const pickCard = (nextChoice: number | null) => {
    if (cardChoicePendingRef.current) return
    cardChoicePendingRef.current = true
    setCardChoicePending(true)
    void onAction({ kind: 'cardReward', choice: nextChoice }).then((outcome) => {
      const acknowledged = outcome.snapshot !== undefined && (outcome.snapshot.rewardDecided.includes(viewerId) ||
        !outcome.snapshot.run?.rewards.some((candidate) => candidate.playerId === viewerId && candidate.cardReward))
      if (!acknowledged && outcome.status !== 'accepted') {
        cardChoicePendingRef.current = false
        setCardChoicePending(false)
      }
    }, () => {
      cardChoicePendingRef.current = false
      setCardChoicePending(false)
    })
  }
  const revealCards = (nextSources?: RewardSource[]) => {
    if (revealPendingRef.current) return
    revealPendingRef.current = true
    setRevealPending(true)
    void onAction({ kind: 'cardReward', choice: 'reveal', ...(nextSources ? { sources: nextSources } : {}) }).then((outcome) => {
      const revealed = Array.isArray(outcome.snapshot?.run?.rewards
        .find((candidate) => candidate.playerId === viewerId)?.choices)
      if (!revealed && outcome.status !== 'accepted') {
        revealPendingRef.current = false
        setRevealPending(false)
        if (!offer.prismatic) setActiveCard(false)
      }
    }, () => {
      revealPendingRef.current = false
      setRevealPending(false)
      if (!offer.prismatic) setActiveCard(false)
    })
  }
  const dispatchLoot = (actions: object[]) => {
    if (lootPendingRef.current || actions.length === 0) return
    lootPendingRef.current = true
    setLootPending(true)
    void Promise.all(actions.map(onAction)).then(() => {
      lootPendingRef.current = false
      setLootPending(false)
    }, () => {
      lootPendingRef.current = false
      setLootPending(false)
    })
  }
  const skipLoot = () => {
    const actions: object[] = []
    if (offer.gold) actions.push({ kind: 'goldReward', gain: false })
    if (offer.potion) actions.push({ kind: 'potionReward', choice: 'skipAll' })
    if (offer.relic) actions.push({ kind: 'relicReward', choice: 'skip' })
    if (offer.bossRelics) actions.push({ kind: 'bossRelicReward', choice: 'skip' })
    if (offer.transformReward) actions.push({ kind: 'transformReward', cardUid: null })
    if (offer.cardReward && !decided.includes(viewerId) && !cardChoicePending) actions.push({ kind: 'cardReward', choice: null })
    dispatchLoot(actions)
  }

  if (activeCard && cardChoicePending) return <section className="reward-screen reward-screen--card-choice" style={backdrop} aria-busy="true">
    <h2 className="reward-screen__title">Choose a Card</h2>
    <p className="muted" role="status">Claiming card…</p>
  </section>

  if (activeCard && offer.cardReward && offer.choices === null) return <section className="reward-screen reward-screen--card-choice" style={backdrop}>
    <h2 className="reward-screen__title">Choose a Card</h2>
    {offer.prismatic ? <fieldset className="reward-screen__sources"><legend>Choose 3 reward decks</legend>
      {(offer.availableSources ?? []).map((source) => <label key={source}><input type="checkbox" checked={sources.includes(source)}
        onChange={(event) => setSources((current) => event.target.checked
          ? current.length < 3 ? [...current, source] : current
          : current.filter((candidate) => candidate !== source))} /> {rewardSourceLabel(source)}</label>)}
      <button type="button" disabled={sources.length !== 3 || revealPending} onClick={() => revealCards(sources)}>{revealPending ? 'Revealing…' : 'Reveal cards'}</button>
    </fieldset> : <p className="muted" role="status">Revealing cards…</p>}
    <button className="reward-screen__skip" type="button" onClick={() => pickCard(null)}>Skip</button>
  </section>

  if (activeCard && offer.cardReward && offer.choices !== null) return <CardRewardPicker
    choices={offer.choices} upgraded={offer.upgraded} uidPrefix={`reward-${viewerId}`} style={backdrop}
    onChoose={pickCard} onSkip={() => pickCard(null)} />

  return <section className="reward-screen reward-screen--loot" style={backdrop}>
    <h2 className="reward-screen__title">Loot!</h2>
    <div className="reward-screen__players"><div className="reward-screen__player">
      {offer.gold ? <LootChoice disabled={lootPending} onClick={() => dispatchLoot([{ kind: 'goldReward' }])} icon={<img src={assetPath('icons/gold.png')} alt="" />}>{offer.gold} Gold</LootChoice> : null}
      {typeof offer.potion === 'string' ? <><LootChoice disabled={potionBlocked || lootPending} onClick={() => dispatchLoot([{ kind: 'potionReward', choice: 'gain' }])}
        icon={<ItemImage kind="potion" id={offer.potion} />}>{potionDef(offer.potion).name}</LootChoice>
        {potionBlocked ? <div className="loot-choice__actions">
          {potionBlocked && !sozu ? player.potions.map((held, index) => <button type="button" key={`${held}-${index}`}
            disabled={lootPending} onClick={() => dispatchLoot([{ kind: 'potionReward', choice: 'replace', potionId: held }])}>Replace {potionDef(held).name}</button>) : null}
          {potionBlocked && run.players.filter((target) => target.id !== player.id && !target.dead && target.potions.length < potionLimit(run.ascension, target) &&
            !target.relics.some((relic) => relic.defId === 'sozu')).map((target) => <button type="button" key={target.id}
              disabled={lootPending} onClick={() => dispatchLoot([{ kind: 'potionReward', choice: 'pass', playerId: target.id }])}>Pass to {target.name}</button>)}
        </div> : null}</> : null}
      {typeof offer.relic === 'string' ? <LootChoice disabled={lootPending} onClick={() => dispatchLoot([{ kind: 'relicReward', choice: 'gain' }])}
        icon={<ItemImage kind="relic" id={offer.relic} />}>{relicDef(offer.relic).name}</LootChoice> : null}
      {Array.isArray(offer.bossRelics) ? offer.bossRelics.map((relicId) => <LootChoice key={relicId} disabled={lootPending} onClick={() => dispatchLoot([{ kind: 'bossRelicReward', choice: 'gain', relicId }])}
        icon={<ItemImage kind="relic" id={relicId} />}>{relicDef(relicId).name}</LootChoice>)
      : null}
      {offer.cardReward && !decided.includes(viewerId) && !cardChoicePending ? <LootChoice disabled={lootPending} onClick={() => {
        setActiveCard(true)
        if (offer.choices === null && !offer.prismatic) revealCards()
      }} icon={<CardRewardIcon rare={offer.cardSource === 'rare'} />}>Add a card to your deck.</LootChoice> : null}
      {offer.transformReward ? <div className="reward-screen__transform"><strong>Transform a card</strong>
        <div className="reward-screen__cards">{(player.deck ?? []).filter((card) => !cardIsCurse(card.defId)).map((card) =>
          <Card key={card.uid} card={card} playable={!lootPending} onClick={() => dispatchLoot([{ kind: 'transformReward', cardUid: card.uid }])} />)}</div>
        <button type="button" disabled={lootPending} onClick={() => dispatchLoot([{ kind: 'transformReward', cardUid: null }])}>Skip Transform</button>
      </div> : null}
      {!hasLootChoice ? <p className="muted" role="status">Waiting for teammates…</p> : null}
    </div></div>
    {hasLootChoice ? <button className="reward-screen__skip" type="button" disabled={lootPending} onClick={skipLoot}>Skip</button> : null}
  </section>
}
