import { useEffect, useMemo, useState } from 'react'
import { assetPath, characterHeroArt } from '../game/assets.ts'
import { cardDef } from '../game/cards.ts'
import type { NeowCard, NeowDecision, NeowImmediateReward, NeowPlayerState, NeowRewardOffer } from '../game/neow.ts'
import { neowCard } from '../game/neow.ts'
import { canUpgradeCard } from '../game/run.ts'
import type { PotionRewardDecision, RewardSource } from '../game/run.ts'
import { potionDef, relicDef } from '../game/relics.ts'
import type { CardInstance, Player } from '../game/types.ts'
import { Card } from './Card.tsx'
import { IconValue } from './Icon.tsx'
import { ItemImage } from './ItemImage.tsx'
import { RewardItem } from './RewardScreen.tsx'

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
  potionLimit: number
  onViewer?: (playerId: string) => void
  onGold: (playerId: string, gain: boolean) => void
  onReveal: (playerId: string, stage: 'red' | 'reward', sources: RewardSource[]) => void
  onReward: (playerId: string, choice: number | null | PotionRewardDecision, stage: 'red' | 'reward') => void
  onEffect: (playerId: string, gain: boolean, decision: NeowDecision) => void
  onChoose: (playerId: string, optionIndex: number, decision: NeowDecision) => void
  /** Arms the next deck change to play as a reveal, for a card gained without ever being shown (a random Rare). */
  onArmCardGain?: () => void
}

function offerNames(offer: NeowRewardOffer | null): string[] {
  if (!offer) return []
  if (offer.kind === 'potion') return offer.choices.map((id) => potionDef(id).name)
  if (offer.kind === 'relic') return offer.choices.map((id) => relicDef(id).name)
  return offer.choices.map((id) => cardDef(id).name)
}

function offerTitle(offer: NeowRewardOffer): string {
  if (offer.kind === 'potion') return 'Choose a Potion'
  if (offer.kind === 'relic') return 'Choose a Relic'
  return 'Choose a Card'
}

function selectableCards(player: NeowUiPlayer, effect: NeowImmediateReward | null) {
  if (!effect || !player.deck || !['upgrade', 'remove', 'transform'].includes(effect.kind) ||
    effect.kind === 'upgrade' && effect.random) return { cards: [] as CardInstance[], count: 0 }
  const cards = effect.kind === 'upgrade' ? player.deck.filter(canUpgradeCard)
    : effect.kind === 'remove' ? player.deck.filter((card) => card.defId !== 'ascenders_bane')
      : player.deck.filter((card) => cardDef(card.defId).owner !== 'curse')
  return { cards, count: Math.min('count' in effect ? effect.count : 0, cards.length) }
}

function OfferChoice({ offer, player, players, potionLimit, enabled, onResolve }: {
  offer: NeowRewardOffer
  player: NeowUiPlayer
  players: NeowUiPlayer[]
  potionLimit: number
  enabled: boolean
  onResolve: (choice: number | null | PotionRewardDecision) => void
}) {
  const key = `${offer.kind}:${offer.cardsDrawn.join(',')}`
  const [choice, setChoice] = useState<number | null | undefined>()
  useEffect(() => setChoice(undefined), [key])

  if (offer.kind === 'potion') {
    const potionId = offer.choices[0]
    const blocked = player.relics.some((relic) => relic.defId === 'sozu')
    const limit = potionLimit
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
          {players.filter((candidate) => candidate.id !== player.id && !candidate.relics.some((relic) => relic.defId === 'sozu') && candidate.potions.length < limit)
            .map((candidate) => <button type="button" key={candidate.id} disabled={!enabled}
              onClick={() => onResolve({ kind: 'pass', playerId: candidate.id })}>Pass to {candidate.name}</button>)}
        </> : null}
        <button type="button" className="neow-offer__skip" disabled={!enabled}
          onClick={() => onResolve({ kind: 'skip' })}>Skip</button>
      </RewardItem>
    </div>
  }

  if (offer.kind === 'relic') {
    const relicId = offer.choices[0]
    return <div className="neow-offer neow-offer--relic">
      <h3>{relicId ? relicDef(relicId).name : 'Empty Relic supply'}</h3>
      {relicId ? <ItemImage kind="relic" id={relicId} card /> : null}
      {relicId ? <p className="room-item-text">{relicDef(relicId).text}</p> : null}
      <div className="neow-offer__actions">
        {relicId ? <button type="button" disabled={!enabled} onClick={() => onResolve(0)}>Take Relic</button> : null}
        <button type="button" disabled={!enabled} onClick={() => onResolve(null)}>Skip Relic</button>
      </div>
    </div>
  }

  return <div className="neow-offer">
    <p className="muted">These cards are face-up to the whole party. Choose one or skip.</p>
    <div className="neow-offer__cards">
      {offer.choices.map((defId, index) => <Card key={`${defId}-${index}`}
        card={{ uid: `neow-offer-${index}`, defId, upgraded: false }}
        selected={choice === index} playable={enabled}
        onClick={() => enabled && setChoice(index)} />)}
    </div>
    <div className="neow-offer__actions">
      <button type="button" aria-pressed={choice === null} disabled={!enabled}
        onClick={() => setChoice(null)}>Skip reward</button>
      <button type="button" disabled={!enabled || choice === undefined}
        onClick={() => choice !== undefined && onResolve(choice)}>Confirm reward</button>
    </div>
  </div>
}

export function NeowScreen({ players, progress, viewerId, potionLimit, enabled = true, disabledMessage, onViewer, onGold, onReveal, onReward, onEffect, onChoose, onArmCardGain }: Props) {
  const participants = players.filter((player) => progress[player.id])
  const viewerParticipates = participants.some((player) => player.id === viewerId)
  const viewer = participants.find((player) => player.id === viewerId) ?? participants[0]
  const viewerProgress = viewer ? progress[viewer.id] : undefined
  const [selectedCards, setSelectedCards] = useState<string[]>([])
  const [selectedSources, setSelectedSources] = useState<RewardSource[]>([])
  const pendingEffectKey = viewerProgress?.pendingEffect ? JSON.stringify(viewerProgress.pendingEffect) : ''
  const availableSourcesKey = viewerProgress?.availableSources?.join(',') ?? ''
  useEffect(() => setSelectedCards([]), [viewerId, viewerProgress?.blueOption, pendingEffectKey, viewerProgress?.done])
  useEffect(() => setSelectedSources([]), [viewerId, viewerProgress?.redRewardPending, viewerProgress?.rewardKind, viewerProgress?.redReward, viewerProgress?.reward, availableSourcesKey])
  const selection = useMemo(() => viewer && viewerProgress
    ? selectableCards(viewer, viewerProgress.pendingEffect)
    : { cards: [] as CardInstance[], count: 0 }, [viewer, viewerProgress])
  if (!viewer || !viewerProgress) return null
  const activeViewer = viewer
  const activeProgress = viewerProgress
  const card = activeProgress.card ?? (activeProgress.cardId ? neowCard(activeProgress.cardId) : undefined)
  const currentOffer = activeProgress.redReward ?? activeProgress.reward
  const prismaticSources = activeProgress.availableSources ?? []
  const unrevealedStage = !activeProgress.redGoldPending && activeProgress.redRewardPending && !activeProgress.redReward && !activeProgress.pendingEffect ? 'red'
    : activeProgress.rewardKind && !activeProgress.reward ? 'reward' : null
  const unrevealedKind = unrevealedStage === 'red' ? 'Card Reward' : activeProgress.rewardKind === 'rare' ? 'Rare Card Reward'
    : activeProgress.rewardKind === 'colorless' ? 'Colorless Card Reward'
      : activeProgress.rewardKind === 'potion' ? 'Potion' : activeProgress.rewardKind === 'relic' ? 'Relic' : 'Reward'
  const blueReady = !activeProgress.redGoldPending && !activeProgress.redRewardPending && !activeProgress.redReward && activeProgress.blueOption === null && !activeProgress.done
  const effect = activeProgress.pendingEffect
  const effectLabel = effect?.kind === 'randomRare' ? 'random Rare card'
    : effect?.kind === 'gold' ? `${effect.amount} Gold`
      : effect ? `${effect.kind} ${effect.count} card${effect.count === 1 ? '' : 's'}` : ''

  return <section className="neow-screen" aria-labelledby="neow-title">
    <img className="neow-screen__neow" src={assetPath('neow/neow.webp')} alt="Neow" />
    <img className="neow-screen__hero" src={assetPath(characterHeroArt(viewer.character))} alt={viewer.name} />
    <header className="neow-screen__header">
      <h2 id="neow-title">Neow’s Blessing</h2>
      <span className="neow-screen__progress" role="status">{Object.values(progress).filter((seat) => seat?.done).length}/{participants.length} ready</span>
    </header>

    <div className="neow-faces" aria-label="Dealt Neow cards">
      {participants.map((player) => {
        const state = progress[player.id]
        const face = state?.card ?? (state?.cardId ? neowCard(state.cardId) : undefined)
        const revealed = offerNames(state?.redReward ?? state?.reward ?? null)
        return <article key={player.id} className={`neow-face${participants.length === 1 ? ' neow-face--solo' : ''}${player.id === viewerId ? ' neow-face--active' : ''}${state?.done ? ' neow-face--done' : ''}`}>
          <div className="neow-face__owner"><strong>{player.name}</strong><span>{state?.done ? 'Ready' : state?.redGoldPending || state?.redRewardPending || state?.redReward ? 'Red reward' : state?.blueOption !== null ? 'Resolving' : 'Choosing'}</span></div>
          <blockquote>“{face?.text ?? '…'}”</blockquote>
          <div className="neow-face__red"><IconValue name="gold" value={3} size={18} /> + Card Reward</div>
          <ol>{face?.options.map((option, index) => <li key={option.label} data-picked={state?.blueOption === index || undefined}>{option.label}</li>)}</ol>
          {revealed.length ? <p className="neow-face__reveal"><span>Face-up:</span> {revealed.join(', ') || 'empty supply'}</p> : null}
          {onViewer && player.id !== viewerId && !state?.done ? <button type="button" onClick={() => onViewer(player.id)}>Resolve {player.name}</button> : null}
        </article>
      })}
    </div>

    {!viewerParticipates ? <section className="neow-action" aria-labelledby="neow-action-title">
      <h3 id="neow-action-title">Catch Up in progress</h3>
      <p className="neow-action__waiting" role="status">Waiting for the Catch Up players to finish Neow’s Blessing.</p>
    </section> : <section className={`neow-action${currentOffer ? ' neow-action--offer' : ''}`} aria-labelledby="neow-action-title">
      <div className="neow-action__owner">
        <span>{viewer.name}</span><h3 id="neow-action-title">{viewerProgress.done ? 'Blessing complete' : activeProgress.redGoldPending ? 'Take or skip 3 Gold' : currentOffer ? offerTitle(currentOffer) : effect ? `Resolve ${effectLabel}` : unrevealedStage ? `${unrevealedKind} is face down` : blueReady ? 'Choose a blessing' : 'Resolving blessing'}</h3>
      </div>
      {viewerProgress.done ? <p className="neow-action__waiting" role="status">Waiting for the rest of the party.</p> : null}
      {activeProgress.redGoldPending ? <div className="neow-unrevealed"><p><strong>3 Gold</strong><span>Gain or independently skip this reward.</span></p><div className="neow-offer__actions"><button type="button" disabled={!enabled} onClick={() => onGold(viewer.id, true)}>Gain 3 Gold</button><button type="button" disabled={!enabled} onClick={() => onGold(viewer.id, false)}>Skip 3 Gold</button></div></div> : null}
      {unrevealedStage ? <div className="neow-unrevealed">
        <p><strong>{unrevealedKind}</strong><span>Reveal it to the party, or skip it without drawing.</span></p>
        {activeProgress.prismatic && prismaticSources.length ? <fieldset className="neow-source-choice">
          <legend>Choose 3 different reward decks</legend>
          {prismaticSources.map((source) => <label key={source}>
            <input type="checkbox" checked={selectedSources.includes(source)}
              disabled={!enabled || !selectedSources.includes(source) && selectedSources.length >= 3}
              onChange={(event) => setSelectedSources((current) => event.target.checked ? [...current, source] : current.filter((id) => id !== source))} />
            {source === 'colorless' ? 'Colorless' : source[0]!.toUpperCase() + source.slice(1)}
          </label>)}
        </fieldset> : null}
        {activeProgress.prismatic && prismaticSources.length < 3 ? <p role="status">Fewer than 3 reward decks remain. Skip this reward unseen.</p> : null}
        <div className="neow-offer__actions">
          <button type="button" disabled={!enabled || activeProgress.prismatic && selectedSources.length !== 3}
            onClick={() => onReveal(viewer.id, unrevealedStage, selectedSources)}>Reveal {unrevealedKind}</button>
          <button type="button" disabled={!enabled} onClick={() => onReward(viewer.id, null, unrevealedStage)}>Skip unseen</button>
        </div>
      </div> : null}
      {currentOffer ? <OfferChoice key={`${viewer.id}:${currentOffer.kind}:${currentOffer.cardsDrawn.join(',')}`}
        offer={currentOffer} player={viewer} players={players} potionLimit={potionLimit} enabled={enabled}
        onResolve={(choice) => onReward(viewer.id, choice, viewerProgress.redReward ? 'red' : 'reward')} /> : null}
      {blueReady && card ? <div className="neow-options">
        {card.options.map((option, index) => <button type="button" key={option.label} disabled={!enabled}
          onClick={() => onChoose(activeViewer.id, index, {})}>
          <span>{index + 1}</span><strong>{option.label}</strong>
        </button>)}
      </div> : null}
      {effect ? <fieldset className="neow-card-choice"><legend>{selection.cards.length > 0 ? `Select ${selection.count} card${selection.count === 1 ? '' : 's'} to ${effect.kind}` : `Gain ${effectLabel}`}</legend>
        {selection.cards.length > 0 ? <div>{selection.cards.map((candidate) => <Card key={candidate.uid} card={candidate}
          selected={selectedCards.includes(candidate.uid)} playable={enabled}
          onClick={() => enabled && setSelectedCards((current) => current.includes(candidate.uid)
            ? current.filter((uid) => uid !== candidate.uid)
            : current.length < selection.count ? [...current, candidate.uid] : current)} />)}</div> : null}
        <button type="button" disabled={!enabled || selectedCards.length !== selection.count}
          onClick={() => {
            if (effect.kind === 'randomRare') onArmCardGain?.()
            onEffect(viewer.id, true, { cardUids: selectedCards })
          }}>Gain reward</button>
        <button type="button" disabled={!enabled} onClick={() => onEffect(viewer.id, false, {})}>Skip reward</button>
      </fieldset> : null}
      {!enabled && !viewerProgress.done ? <p className="neow-action__waiting" role="status">
        {disabledMessage ?? 'Reconnecting… your Blessing is preserved.'}
      </p> : null}
    </section>}
  </section>
}
