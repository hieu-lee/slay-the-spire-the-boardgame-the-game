import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { assetPath, characterHeroArt } from '../game/assets.ts'
import type { NeowCard, NeowDecision, NeowImmediateReward, NeowPlayerState, NeowRewardOffer } from '../game/neow.ts'
import { neowCard } from '../game/neow.ts'
import { neowEffectSelection } from '../game/run/neow.ts'
import type { PotionRewardDecision, RewardSource } from '../game/run.ts'
import { rewardSourceLabel } from './reward-source.ts'
import { potionDef, relicDef } from '../game/relics.ts'
import type { CardInstance, Player } from '../game/types.ts'
import { CardRewardPicker } from './CardRewardPicker.tsx'
import { CardPicker } from './CardPicker.tsx'
import { IconValue } from './Icon.tsx'
import { ItemImage } from './ItemImage.tsx'
import { RewardItem } from './RewardScreen.tsx'
import { potionLimit } from '../game/acquisition.ts'

type NeowUiPlayer = Pick<Player, 'id' | 'name' | 'character' | 'hp' | 'maxHp' | 'gold' | 'potions' | 'relics'> & {
  deck: CardInstance[] | null
}
type NeowUiProgress = Omit<NeowPlayerState, 'cardId' | 'rewardQueue'> & {
  cardId?: string
  card?: NeowCard
  rewardQueue?: NeowPlayerState['rewardQueue']
  availableSources?: RewardSource[]
  prismatic?: boolean
}

type Props = {
  players: NeowUiPlayer[]
  progress: Record<string, NeowUiProgress | null>
  viewerId: string
  enabled?: boolean
  disabledMessage?: string
  ascension: number
  onViewer?: (playerId: string) => void
  onGold: (playerId: string, gain: boolean) => void | Promise<unknown>
  onReveal: (playerId: string, stage: 'red' | 'reward', sources: RewardSource[]) => void | Promise<unknown>
  onReward: (playerId: string, choice: number | null | PotionRewardDecision, stage: 'red' | 'reward') => void | Promise<unknown>
  onEffect: (playerId: string, gain: boolean, decision: NeowDecision) => void | Promise<unknown>
  onChoose: (playerId: string, optionIndex: number, decision: NeowDecision) => void | Promise<unknown>
  /** Arms the next deck change to play as a reveal, for a card gained without ever being shown (a random Rare). */
  onArmCardGain?: () => void
}

function offerTitle(offer: NeowRewardOffer): string {
  if (offer.kind === 'potion') return 'Choose a Potion'
  if (offer.kind === 'relic') return 'Choose a Relic'
  return 'Choose a Card'
}

function selectableCards(player: NeowUiPlayer, effect: NeowImmediateReward | null, excludedUids: readonly string[] = []) {
  if (!effect || !player.deck || effect.kind === 'upgrade' && effect.random) return { cards: [] as CardInstance[], count: 0 }
  const { eligible: cards, required: count } = neowEffectSelection(player.deck, effect, excludedUids)
  return { cards, count }
}

function OfferChoice({ offer, player, players, ascension, enabled, onResolve }: {
  offer: NeowRewardOffer
  player: NeowUiPlayer
  players: NeowUiPlayer[]
  ascension: number
  enabled: boolean
  onResolve: (choice: number | null | PotionRewardDecision) => void
}) {
  if (offer.kind === 'potion') {
    const potionId = offer.choices[0]
    const blocked = player.relics.some((relic) => relic.defId === 'sozu')
    const limit = potionLimit(ascension, player)
    return <div className="neow-offer neow-offer--potion item-offer-list">
      <RewardItem kind="potion" id={potionId} title={potionId ? potionDef(potionId).name : 'Empty Potion supply'}
        note={potionId ? undefined : 'No Potion remains in the supply.'}>
        {potionId ? <>
          <button type="button" disabled={!enabled || blocked || player.potions.length >= limit}
            onClick={() => onResolve({ kind: 'gain' })}>Take</button>
          {player.potions.map((held, index) => <button type="button" key={`${held}-${index}`}
            disabled={!enabled || blocked} onClick={() => onResolve({ kind: 'replace', potionId: held })}>
            <ItemImage kind="potion" id={held} /> Replace {potionDef(held).name}
          </button>)}
          {players.filter((candidate) => candidate.id !== player.id && !candidate.relics.some((relic) => relic.defId === 'sozu') &&
            candidate.potions.length < potionLimit(ascension, candidate))
            .map((candidate) => <button type="button" key={candidate.id} disabled={!enabled}
              onClick={() => onResolve({ kind: 'pass', playerId: candidate.id })}>Pass to {candidate.name}</button>)}
        </> : null}
        <button type="button" className="neow-offer__skip" disabled={!enabled}
          onClick={() => onResolve({ kind: 'skip' })}>Skip</button>
      </RewardItem>
    </div>
  }

  if (offer.kind === 'relic') {
    return <div className="neow-offer neow-offer--relic item-offer-list">
      {offer.choices.length > 0 ? offer.choices.map((relicId, index) =>
        <RewardItem key={`${relicId}-${index}`} kind="relic" id={relicId} title={relicDef(relicId).name}>
          <button type="button" disabled={!enabled} onClick={() => onResolve(index)}>Take Relic</button>
        </RewardItem>) : <RewardItem kind="relic" title="Empty Relic supply" note="No Relic remains in the supply." />}
      <div className="neow-offer__actions">
        <button type="button" disabled={!enabled} onClick={() => onResolve(null)}>Skip Relic</button>
      </div>
    </div>
  }

  return <CardRewardPicker choices={offer.choices} upgraded={offer.upgraded === true} disabled={!enabled}
    uidPrefix="neow-offer" onChoose={onResolve} onSkip={() => onResolve(null)} />
}

export function NeowScreen({ players, progress, viewerId, ascension, enabled = true, disabledMessage, onViewer, onGold, onReveal, onReward, onEffect, onChoose, onArmCardGain }: Props) {
  const participants = players.filter((player) => progress[player.id])
  const viewerParticipates = participants.some((player) => player.id === viewerId)
  const viewer = participants.find((player) => player.id === viewerId) ?? participants[0]
  const viewerProgress = viewer ? progress[viewer.id] : undefined
  const [selectedCards, setSelectedCards] = useState<string[]>([])
  const [selectedSources, setSelectedSources] = useState<RewardSource[]>([])
  const [submitting, setSubmitting] = useState(false)
  const submittingRef = useRef(false)
  const pendingEffectKey = viewerProgress?.pendingEffect ? JSON.stringify(viewerProgress.pendingEffect) : ''
  const deckKey = viewer?.deck?.map((card) => card.uid).join(',') ?? ''
  const availableSourcesKey = viewerProgress?.availableSources?.join(',') ?? ''
  useEffect(() => setSelectedCards([]), [viewerId, viewerProgress?.blueOption, pendingEffectKey, deckKey, viewerProgress?.done])
  useEffect(() => setSelectedSources([]), [viewerId, viewerProgress?.redRewardPending, viewerProgress?.rewardKind, viewerProgress?.redReward, viewerProgress?.reward, availableSourcesKey])
  const selection = useMemo(() => viewer && viewerProgress
    ? selectableCards(viewer, viewerProgress.pendingEffect, viewerProgress.transformExcludedUids)
    : { cards: [] as CardInstance[], count: 0 }, [viewer, viewerProgress])
  if (!viewer || !viewerProgress) return null
  const activeViewer = viewer
  const activeProgress = viewerProgress
  const card = activeProgress.card ?? (activeProgress.cardId ? neowCard(activeProgress.cardId) : undefined)
  const currentOffer = activeProgress.redReward ?? activeProgress.reward
  const heartsBoon = card?.source === 'heart'
  const blessingName = heartsBoon ? 'The Heart’s Boon' : 'Neow’s Blessing'
  const blessingWord = heartsBoon ? 'Boon' : 'Blessing'
  const prismaticSources = activeProgress.availableSources ?? []
  const unrevealedStage = !activeProgress.redGoldPending && activeProgress.redRewardPending && !activeProgress.redReward && !activeProgress.pendingEffect ? 'red'
    : activeProgress.rewardKind && !activeProgress.reward ? 'reward' : null
  const unrevealedKind = unrevealedStage === 'red' ? 'Card Reward' : activeProgress.rewardKind === 'rare' ? 'Rare Card Reward'
    : activeProgress.rewardKind === 'colorless' ? 'Colorless Card Reward'
      : activeProgress.rewardKind === 'potion' ? 'Potion' : activeProgress.rewardKind === 'relic' ? 'Relic' : 'Reward'
  const blueReady = !activeProgress.redGoldPending && !activeProgress.redRewardPending && !activeProgress.redReward && activeProgress.blueOption === null && !activeProgress.done
  const effect = activeProgress.pendingEffect
  const effectLabel = effect?.kind === 'transform' ? 'transform a card'
    : effect?.kind === 'randomRare' ? 'random Rare card'
    : effect?.kind === 'gold' ? `${effect.amount} Gold`
      : effect ? `${effect.kind} ${effect.count} card${effect.count === 1 ? '' : 's'}` : ''
  const canAct = enabled && !submitting
  const submit = (action: () => void | Promise<unknown>) => {
    if (submittingRef.current) return
    submittingRef.current = true
    setSubmitting(true)
    void Promise.resolve().then(action).finally(() => {
      submittingRef.current = false
      setSubmitting(false)
    })
  }

  return <section className={`neow-screen${heartsBoon ? ' neow-screen--heart' : ''}`} aria-labelledby="neow-title">
    <img className={`neow-screen__neow${heartsBoon ? ' neow-screen__neow--heart' : ''}`}
      src={assetPath(heartsBoon ? 'combat/enemies/corrupt_heart.webp' : 'neow/neow.webp')}
      alt={heartsBoon ? 'The Heart' : 'Neow'} />
    <img className="neow-screen__hero" src={assetPath(characterHeroArt(viewer.character))} alt={viewer.name} />
    <header className="neow-screen__header">
      <h2 id="neow-title">{blessingName}</h2>
      <span className="neow-screen__progress" role="status">{Object.values(progress).filter((seat) => seat?.done).length}/{participants.length} ready</span>
    </header>

    <div className="neow-faces" aria-label={`Dealt ${blessingName} cards`}>
      {participants.map((player) => {
        const state = progress[player.id]
        const face = state?.card ?? (state?.cardId ? neowCard(state.cardId) : undefined)
        return <article key={player.id} className={`neow-face${participants.length === 1 ? ' neow-face--solo' : ''}${player.id === viewerId ? ' neow-face--active' : ''}${state?.done ? ' neow-face--done' : ''}`}>
          <div className="neow-face__owner"><strong>{player.name}</strong><span>{state?.done ? 'Ready' : state?.redGoldPending || state?.redRewardPending || state?.redReward ? 'Red reward' : state?.blueOption !== null ? 'Resolving' : 'Choosing'}</span></div>
          <blockquote>“{face?.text ?? '…'}”</blockquote>
          <div className="neow-face__red">{face?.source === 'heart'
            ? '3 Card Rewards'
            : <><IconValue name="gold" value={3} size={18} /> + Card Reward</>}</div>
          <ol>{face?.options.map((option, index) => <li key={option.label} data-picked={state?.blueOption === index || undefined}>{option.label}</li>)}</ol>
          {onViewer && player.id !== viewerId && !state?.done ? <button type="button" onClick={() => onViewer(player.id)}>Resolve {player.name}</button> : null}
        </article>
      })}
    </div>

    {!viewerParticipates ? <section className="neow-action" aria-labelledby="neow-action-title">
      <h3 id="neow-action-title">Catch Up in progress</h3>
      <p className="neow-action__waiting" role="status">Waiting for the Catch Up players to finish {blessingName}.</p>
    </section> : <section className={`neow-action${currentOffer ? ' neow-action--offer' : ''}`} aria-labelledby="neow-action-title">
      <div className="neow-action__owner">
        <span>{viewer.name}</span><h3 id="neow-action-title">{viewerProgress.done ? `${blessingWord} complete` : activeProgress.redGoldPending ? 'Take or skip 3 Gold' : currentOffer ? offerTitle(currentOffer) : effect ? `Resolve ${effectLabel}` : unrevealedStage ? `${unrevealedKind} is face down` : blueReady ? `Choose a ${blessingWord.toLowerCase()}` : `Resolving ${blessingWord.toLowerCase()}`}</h3>
      </div>
      {viewerProgress.done ? <p className="neow-action__waiting" role="status">Waiting for the rest of the party.</p> : null}
      {activeProgress.redGoldPending ? <div className="neow-unrevealed"><p><strong>3 Gold</strong><span>Gain or independently skip this reward.</span></p><div className="neow-offer__actions"><button type="button" disabled={!canAct} onClick={() => submit(() => onGold(viewer.id, true))}>Gain 3 Gold</button><button type="button" disabled={!canAct} onClick={() => submit(() => onGold(viewer.id, false))}>Skip 3 Gold</button></div></div> : null}
      {unrevealedStage ? <div className="neow-unrevealed">
        <p><strong>{unrevealedKind}</strong><span>Reveal your options, or skip without drawing.</span></p>
        {activeProgress.prismatic && prismaticSources.length ? <fieldset className="neow-source-choice">
          <legend>Choose 3 different reward decks</legend>
          {prismaticSources.map((source) => <label key={source}>
            <input type="checkbox" checked={selectedSources.includes(source)}
              disabled={!canAct || !selectedSources.includes(source) && selectedSources.length >= 3}
              onChange={(event) => setSelectedSources((current) => event.target.checked ? [...current, source] : current.filter((id) => id !== source))} />
            {rewardSourceLabel(source)}
          </label>)}
        </fieldset> : null}
        {activeProgress.prismatic && prismaticSources.length < 3 ? <p role="status">Fewer than 3 reward decks remain. Skip this reward unseen.</p> : null}
        <div className="neow-offer__actions">
          <button type="button" disabled={!canAct || activeProgress.prismatic && selectedSources.length !== 3}
            onClick={() => submit(() => onReveal(viewer.id, unrevealedStage, selectedSources))}>Reveal {unrevealedKind}</button>
          <button type="button" disabled={!canAct} onClick={() => submit(() => onReward(viewer.id, null, unrevealedStage))}>Skip unseen</button>
        </div>
      </div> : null}
      {currentOffer ? <OfferChoice key={`${viewer.id}:${currentOffer.kind}:${currentOffer.cardsDrawn.join(',')}`}
        offer={currentOffer} player={viewer} players={players} ascension={ascension} enabled={canAct}
        onResolve={(choice) => submit(() => onReward(viewer.id, choice, viewerProgress.redReward ? 'red' : 'reward'))} /> : null}
      {blueReady && card ? <div className="neow-options">
        {card.options.map((option, index) => <button type="button" key={option.label} disabled={!canAct}
          onClick={() => submit(() => onChoose(activeViewer.id, index, {}))}>
          <span>{index + 1}</span><strong>{option.label}</strong>
        </button>)}
      </div> : null}
      {effect && selection.cards.length === 0 ? <fieldset className="neow-card-choice"><legend>Gain {effectLabel}</legend>
        <button type="button" disabled={!canAct || selectedCards.length !== selection.count}
          onClick={() => submit(() => {
            if (effect.kind === 'randomRare') onArmCardGain?.()
            return onEffect(viewer.id, true, { cardUids: selectedCards })
          })}>Gain reward</button>
        <button type="button" disabled={!canAct} onClick={() => submit(() => onEffect(viewer.id, false, {}))}>Skip reward</button>
      </fieldset> : null}
      {effect && selection.cards.length > 0 ? createPortal(<CardPicker
        cards={selection.cards}
        verb={effect.kind === 'upgrade' ? 'Upgrade' : effect.kind === 'transform' ? 'Transform' : 'Remove'}
        selectedCardUids={selectedCards}
        maxSelections={selection.count}
        onSelect={(uid) => canAct && setSelectedCards((current) => current.includes(uid)
          ? current.filter((cardUid) => cardUid !== uid)
          : current.length < selection.count ? [...current, uid] : current)}
        onClear={() => canAct && setSelectedCards([])}
        onBack={() => canAct && submit(() => onEffect(viewer.id, false, {}))}
        onConfirm={() => canAct && selectedCards.length === selection.count && submit(() => onEffect(viewer.id, true, { cardUids: selectedCards }))}
        confirmLabel="Confirm reward"
        backLabel="Skip reward"
        confirmDisabled={!canAct || selectedCards.length !== selection.count}
        backDisabled={!canAct}
        disabled={!canAct}
      />, document.body) : null}
      {submitting ? <p className="neow-action__waiting" role="status">Resolving choice…</p> : null}
      {!enabled && !viewerProgress.done ? <p className="neow-action__waiting" role="status">
        {disabledMessage ?? `Reconnecting… your ${blessingWord} is preserved.`}
      </p> : null}
    </section>}
  </section>
}
