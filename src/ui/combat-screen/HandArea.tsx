import type { Dispatch, PointerEvent, RefObject, SetStateAction } from 'react'
import { assetPath } from '../../game/assets.ts'
import { cardDef, faceOf } from '../../game/cards.ts'
import {
  effectiveCombatCardDef,
  guardianGemForCard,
  livingEnemies,
  playCost,
  type CardDamagePreview,
  type CombatState,
  type PendingTriggerAbility,
} from '../../game/combat.ts'
import type { CardInstance, DownfallCharacterId, Player } from '../../game/types.ts'
import { Card } from '../Card.tsx'
import { CardCollectionOverlay } from '../CardCollectionOverlay.tsx'
import { IconValue } from '../Icon.tsx'
import { canAfford, downfallEnergyOrbLayers, fanOf, stageHermitChamberViewer } from './helpers.ts'
import type { CardDrag, MotionKey, Pending } from './types.ts'

export type HandAreaProps = {
  state: CombatState
  viewer: Player
  viewerVisual: string | undefined
  skinOrb: boolean
  downfallCharacter: DownfallCharacterId | undefined
  stanceChangedThisTurn: boolean | undefined
  drawCount: number | undefined
  drawPileCount: number
  displayedPileCount: (kind: 'draw' | 'discard' | 'exhaust', count: number) => number
  motionActive: ReadonlySet<MotionKey>
  motionBeats: Record<MotionKey, number>
  chamberTriggerRef: RefObject<HTMLButtonElement | null>
  handScrollRef: RefObject<HTMLDivElement | null>
  handRef: RefObject<HTMLDivElement | null>
  chamberOpen: boolean
  chamberClosing: boolean
  chamberContact: boolean
  toggleChamber: () => void
  requiredHermitChamberCard: NonNullable<CombatState['pendingHermitChamberPlays']>[number] | undefined
  requiredChamberCard: CardInstance | undefined
  requiredChamberUnplayable: boolean
  skipUnplayableHermitChamber: (cardUid: string) => void
  visibleHand: readonly CardInstance[]
  visibleChamberUids: ReadonlySet<string>
  hermitSetupPending: boolean
  hermitTargetedCurses: ReadonlySet<string>
  pending: Pending | null
  setPending: Dispatch<SetStateAction<Pending | null>>
  usingCard: boolean
  pendingTrigger: PendingTriggerAbility | null | undefined
  endTurnResolving: boolean
  voluntaryActionsBlocked: boolean
  forcedCard: NonNullable<CombatState['startTurnProgress']>['forcedCard']
  forcedCardUid: string | null
  distilled: CombatState['pendingDistilled']
  relicScry: CombatState['pendingRelicScry']
  miracleOnCard: boolean
  drawnCards: ReadonlySet<string>
  cardDrag: CardDrag | null
  cardDamage: ReadonlyMap<string, CardDamagePreview>
  handExhaustChoiceUids: ReadonlySet<string>
  chosenStartExhaustUids: ReadonlySet<string>
  pendingStartExhaust: { id: string } | undefined
  suppressCardClick: { current: string | null }
  chamberCardCanStartDrag: (card: CardInstance) => boolean
  submitHermitChamber: (card: CardInstance) => void
  chooseStartTurnExhaust: (cardUid: string) => void
  submitHermitSetup: (card: CardInstance, enemyUid?: string | null) => void
  activateCard: (card: CardInstance) => void
  onCardPointerDown: (card: CardInstance, event: PointerEvent<HTMLButtonElement>, playable: boolean, chamber?: boolean) => void
  onCardPointerMove: (event: PointerEvent<HTMLElement>) => void
  finishCardDrag: (event: PointerEvent<HTMLElement>) => void
  cancelCardDrag: (event: PointerEvent<HTMLElement>) => void
}

export function HandArea({
  state,
  viewer,
  viewerVisual,
  skinOrb,
  downfallCharacter,
  stanceChangedThisTurn,
  drawCount,
  drawPileCount,
  displayedPileCount,
  motionActive,
  motionBeats,
  chamberTriggerRef,
  handScrollRef,
  handRef,
  chamberOpen,
  chamberClosing,
  chamberContact,
  toggleChamber,
  requiredHermitChamberCard,
  requiredChamberCard,
  requiredChamberUnplayable,
  skipUnplayableHermitChamber,
  visibleHand,
  visibleChamberUids,
  hermitSetupPending,
  hermitTargetedCurses,
  pending,
  setPending,
  usingCard,
  pendingTrigger,
  endTurnResolving,
  voluntaryActionsBlocked,
  forcedCard,
  forcedCardUid,
  distilled,
  relicScry,
  miracleOnCard,
  drawnCards,
  cardDrag,
  cardDamage,
  handExhaustChoiceUids,
  chosenStartExhaustUids,
  pendingStartExhaust,
  suppressCardClick,
  chamberCardCanStartDrag,
  submitHermitChamber,
  chooseStartTurnExhaust,
  submitHermitSetup,
  activateCard,
  onCardPointerDown,
  onCardPointerMove,
  finishCardDrag,
  cancelCardDrag,
}: HandAreaProps) {
  return (
    <footer className="hand-area" data-character={viewer.character}
      data-has-chamber={viewer.chamberSlots > 0 || undefined}>
      <div className="hand-area__stats">
        <span className={[
          'pip',
          'pip--energy',
          motionActive.has('energy') ? `motion-pulse-${motionBeats.energy % 2}` : '',
        ].filter(Boolean).join(' ')} data-character={skinOrb ? viewerVisual : viewer.character} data-skin-orb={skinOrb || undefined}
        data-guardian-mode={viewer.guardianMode ?? undefined} data-empty={viewer.energy === 0 || undefined}
        title="Energy">
          {skinOrb ? <img className="energy-orb__skin"
            src={assetPath(`combat/energy-orbs/${viewerVisual}.webp`)} alt="" aria-hidden="true" /> : null}
          {downfallCharacter && !skinOrb ? <span className="energy-orb__layers" aria-hidden="true">
            {downfallEnergyOrbLayers(downfallCharacter, viewer.energy === 0).map(({ layer, src }) =>
              <img key={layer} data-layer={layer} src={src} alt="" />)}
          </span> : null}
          <IconValue name="energy" value={viewer.energy} size={26} />
        </span>
        {viewer.chamberSlots > 0 ? (
          <button ref={chamberTriggerRef} type="button" className={[
            'hermit-chamber-trigger',
            chamberContact ? 'hermit-chamber-trigger--contact' : '',
          ].filter(Boolean).join(' ')}
            aria-expanded={chamberOpen}
            aria-label={`Chamber, ${viewer.chamber.length} of ${viewer.chamberSlots} slots filled`}
            title={chamberClosing ? 'Returning Chamber cards' : chamberOpen
              ? 'Return Chamber cards' : 'Show Chamber cards'}
            disabled={chamberClosing}
            onClick={toggleChamber}>
            <img src={assetPath(chamberOpen || chamberClosing || viewer.chamber.length === 0
              ? 'icons/hermit-chamber.png'
              : 'icons/hermit-chamber-loaded.png')} alt="" />
            <span aria-hidden="true">{viewer.chamber.length}/{viewer.chamberSlots}</span>
          </button>
        ) : null}
        {requiredHermitChamberCard?.playerId === viewer.id &&
        (!requiredChamberCard || requiredChamberUnplayable) ? (
          <button type="button" className="prompt__mode hermit-chamber-skip"
            onClick={() => skipUnplayableHermitChamber(requiredHermitChamberCard.cardUids[0]!)}>
            {requiredChamberCard ? `Skip unplayable ${cardDef(requiredChamberCard.defId).name}`
              : 'Continue after unavailable Chamber card'}
          </button>
        ) : null}
        <CardCollectionOverlay stanceChangedThisTurn={stanceChangedThisTurn} cards={viewer.draw} label="Draw pile" dataPile="draw" ordered={false}
          triggerClassName={['pile', motionActive.has('draw')
            ? `motion-pulse-${motionBeats.draw % 2}` : ''].filter(Boolean).join(' ')}>
          <img className="pile__stack" src={assetPath('combat/piles/draw.webp')} alt="" />
          <span className="pile__count" aria-hidden="true">{displayedPileCount('draw', drawPileCount)}</span>
          <span className="visually-hidden">Draw pile, {drawCount ?? viewer.draw.length} cards</span>
        </CardCollectionOverlay>
        <span className="pile-group">
          {([
            ['discard', 'Discard pile', viewer.discard],
            ['exhaust', 'Exhaust pile', viewer.exhaust],
          ] as const).map(([kind, label, cards]) => (
            <CardCollectionOverlay stanceChangedThisTurn={stanceChangedThisTurn} key={kind} cards={cards} label={label} dataPile={kind}
              triggerClassName={['pile', motionActive.has(kind)
                ? `motion-pulse-${motionBeats[kind] % 2}` : ''].filter(Boolean).join(' ')}>
              <img className="pile__stack" src={assetPath(`combat/piles/${kind}.webp`)} alt="" />
              <span className="pile__count" aria-hidden="true">{displayedPileCount(kind, cards.length)}</span>
            </CardCollectionOverlay>
          ))}
        </span>
      </div>
      {/* Fanned, the way a hand is actually held: each card tilted and
          lifted by its distance from the middle. The angle is set here
          because only the component knows how many cards there are. */}
      <div ref={handScrollRef} className="hand-scroll" onWheel={(event) => {
        event.currentTarget.scrollLeft += event.deltaX || (event.shiftKey ? event.deltaY : 0)
      }}><div ref={handRef} className="hand" data-count={visibleHand.length}>
        {visibleHand.map((card, index) => {
          const chamberCard = visibleChamberUids.has(card.uid)
          const required = chamberCard && requiredHermitChamberCard?.playerId === viewer.id &&
            requiredHermitChamberCard.cardUids[0] === card.uid
          const staged = chamberCard
            ? stageHermitChamberViewer(viewer, card, required && requiredHermitChamberCard?.free)
            : null
          const cardViewer = staged?.player ?? viewer
          const displayedCard = staged?.card ?? card
          const attachedGemId = guardianGemForCard(viewer, card)
          const shownCard = attachedGemId === card.attachedGemId ? card : { ...card, attachedGemId }
          const def = effectiveCombatCardDef(faceOf(cardDef(card.defId), card.upgraded), cardViewer.guardianMode)
          const setupTarget = !chamberCard && hermitSetupPending && hermitTargetedCurses.has(card.defId)
            ? livingEnemies(state).length === 1 ? livingEnemies(state)[0] : undefined
            : null
          const setupPlayable = !chamberCard && hermitSetupPending &&
            (!hermitTargetedCurses.has(card.defId) || Boolean(setupTarget))
          const chamberCancelable = chamberCard && pending?.chamberPlay && pending.card.uid === card.uid &&
            (pending.choicePreviewPending || !pending.choiceCards || pending.choice?.kind === 'recover' ||
              pending.choice?.kind === 'recoverExhaust')
          const chamberPlayable = chamberCard && !chamberClosing &&
            (chamberCardCanStartDrag(card) || chamberCancelable)
          const exhaustChoice = !chamberCard && handExhaustChoiceUids.has(card.uid)
          const handPicksOnly = hermitSetupPending || exhaustChoice
          return <Card stanceChangedThisTurn={stanceChangedThisTurn}
            key={card.uid}
            className={[drawnCards.has(card.uid) ? 'card--drawn' : '',
              cardDrag?.card.uid === card.uid ? 'card--dragging' : '',
              chamberCard ? 'card--chamber-drawn' : '',
              setupPlayable || exhaustChoice && pendingStartExhaust ? 'card--load-choice' : '',
              exhaustChoice && !pendingStartExhaust ? 'card--exhaust-repick' : '',
              // The engine marks only the offered cards that can be played.
              card.playWindowCost !== undefined && !chamberCard ? 'card--play-window' : ''].filter(Boolean).join(' ') || undefined}
            style={{ '--deal-index': index } as React.CSSProperties}
            inspectOnTouch
            fan={fanOf(index, visibleHand.length)}
            liveDamage={chamberCard ? undefined : cardDamage.get(card.uid)}
            card={chamberCard ? displayedCard : shownCard}
            gemPowerDamage={attachedGemId !== card.attachedGemId || undefined}
            cost={card.uid === forcedCardUid ? 0 : playCost(def, cardViewer, displayedCard)}
            playable={chamberCard ? chamberPlayable : exhaustChoice || (hermitSetupPending ? setupPlayable :
              !usingCard &&
              !pendingTrigger &&
              !endTurnResolving &&
              (!voluntaryActionsBlocked || card.uid === forcedCardUid) &&
              (!pending?.choiceCards || pending.card.uid === card.uid) &&
              ((state.phase === 'player' && !forcedCard && !distilled && !relicScry) || card.uid === forcedCardUid ||
                (pending?.card.uid === forcedCardUid && pending.choice !== null && !pending.choiceCards) ||
                (state.phase === 'copy' && pending?.cardInHand === false &&
                  pending.choice !== null && !pending.choiceCards)) &&
              // While a card is staged, other cards stay clickable only as
              // choice targets; an unaffordable card must never be stageable
              // or it strands the player in a pending state it cannot commit.
              (card.uid === forcedCardUid ||
                (pending?.card.uid === forcedCardUid && pending.choice !== null &&
                  !pending.choiceCards && card.uid !== pending.card.uid) ||
                canAfford(state, viewer, card, miracleOnCard, drawCount) ||
                pending?.card.uid === card.uid ||
                (pending?.choice != null && card.uid !== pending.card.uid)))
            }
            selected={pending?.card.uid === card.uid}
            picked={pending?.picked.includes(card.uid) === true || chosenStartExhaustUids.has(card.uid)}
            onClick={chamberCard
              ? () => {
                if (suppressCardClick.current === card.uid) {
                  suppressCardClick.current = null
                  return
                }
                if (chamberCancelable) {
                  setPending(null)
                  return
                }
                submitHermitChamber(card)
              }
              : exhaustChoice
              ? () => chooseStartTurnExhaust(card.uid)
              : hermitSetupPending
              ? () => setupPlayable && submitHermitSetup(card, setupTarget?.uid ?? null)
              : activateCard}
            onPointerDown={handPicksOnly && !chamberCard
              ? undefined
              : (event, playable) => onCardPointerDown(card, event, playable, chamberCard)}
            onPointerMove={handPicksOnly && !chamberCard ? undefined : onCardPointerMove}
            onPointerUp={handPicksOnly && !chamberCard ? undefined : finishCardDrag}
            onPointerCancel={handPicksOnly && !chamberCard ? undefined : cancelCardDrag}
            onLostPointerCapture={handPicksOnly && !chamberCard ? undefined : cancelCardDrag}
          />
        })}
      </div></div>
    </footer>
  )
}
