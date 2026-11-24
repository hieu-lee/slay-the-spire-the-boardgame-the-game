import { memo, type Dispatch, type RefObject, type SetStateAction } from 'react'
import { assetPath, potionIconPath } from '../../game/assets.ts'
import { cardCost, cardDef, faceOf } from '../../game/cards.ts'
import {
  activePowerWindow,
  cardNeedsEnemy,
  guardianCardNeedsAlly,
  overflowShivCount,
  powerAbilityUsed,
  powerActivationAllowed,
  reachedTimeWarpLimit,
  spendMiracle,
  spendVigor,
  type activeCardPlayWindow,
  type CombatState,
  type DiscardOrders,
  type owedPlayerChoices,
  type PendingTriggerAbility,
  type PlayerChoiceAnswer,
  type PotionContext,
  type PowerContext,
  type StartTurnAbility,
  type StartTurnScryAbility,
} from '../../game/combat.ts'
import { potionDef } from '../../game/relics.ts'
import { CAPS, type CardInstance, type Player } from '../../game/types.ts'
import { CourierPeek, courierPeekPhase } from '../CourierPanel.tsx'
import { Icon, StatusIcon, dieIcon } from '../Icon.tsx'
import { PotionTooltipAnchor } from '../PotionIcon.tsx'
import { PowerGlyph } from '../PowerRow.tsx'
import { PHASE_LABEL, gainedShivs } from './helpers.ts'
import { StartTurnOrder } from './StartTurnOrder.tsx'
import type { CombatScreenProps, Pending } from './types.ts'

export type CombatBarProps = {
  combatBarRef: RefObject<HTMLElement | null>
  endTurnRef: RefObject<HTMLButtonElement | null>
  state: CombatState
  viewer: Player
  viewerId: string
  livingPlayers: readonly Player[]
  copyResolutionLabel: string | null
  hermitSetupPending: boolean
  hermitSetupOwner: Player | undefined
  onCourierReveal: CombatScreenProps['onCourierReveal']
  courierUsedBy: CombatScreenProps['courierUsedBy']
  playerChoicePrompt: string | null
  viewerPlayerChoice: ReturnType<typeof owedPlayerChoices>[number] | undefined
  usingPlayerChoice: boolean
  submitPlayerChoice: (answer: Omit<PlayerChoiceAnswer, 'choiceId'>) => void
  setPlayerChoiceDiscarding: Dispatch<SetStateAction<boolean>>
  relicScry: CombatState['pendingRelicScry']
  voluntaryActionsBlocked: boolean
  forcedCard: NonNullable<CombatState['startTurnProgress']>['forcedCard']
  distilled: CombatState['pendingDistilled']
  endTurnResolving: boolean
  pendingTrigger: PendingTriggerAbility | null | undefined
  pending: Pending | null
  setPending: Dispatch<SetStateAction<Pending | null>>
  pendingPowerUid: string | null
  setPendingPowerUid: Dispatch<SetStateAction<string | null>>
  usingPower: boolean
  setPowerChamberUids: Dispatch<SetStateAction<string[]>>
  setPowerLoadUids: Dispatch<SetStateAction<string[]>>
  setPowerExhaustUids: Dispatch<SetStateAction<string[]>>
  powerOrbSlots: readonly number[]
  setPowerOrbSlots: Dispatch<SetStateAction<number[]>>
  setPowerGemContext: Dispatch<SetStateAction<PowerContext | null>>
  setPowerScryConfirmed: Dispatch<SetStateAction<boolean>>
  requestPowerPreview: (powerUid: string) => void
  usePower: (powerUid: string, context: PowerContext) => void
  creativeAiEffect: { anyNumber?: boolean } | undefined
  canUsePotionNow: (potionId: string) => boolean
  pendingPotion: string | null
  setPendingPotion: Dispatch<SetStateAction<string | null>>
  usingPotion: boolean
  viewerHasSozu: boolean
  setPotionShivEnemyUids: Dispatch<SetStateAction<string[]>>
  setPotionOverflowRequired: Dispatch<SetStateAction<number>>
  setPotionCardUids: Dispatch<SetStateAction<string[]>>
  consumePotion: (potionId: string, context?: PotionContext, overflow?: { expected: number; skip: boolean }) => void
  spendingShiv: boolean
  setSpendingShiv: Dispatch<SetStateAction<boolean>>
  spendingSoulburn: boolean
  setSpendingSoulburn: Dispatch<SetStateAction<boolean>>
  extraCrispyPower: CardInstance | undefined
  extraCrispySoulburn: boolean
  setExtraCrispySoulburn: Dispatch<SetStateAction<boolean>>
  miracleOnCard: boolean
  setMiracleOnCard: Dispatch<SetStateAction<boolean>>
  onAction: CombatScreenProps['onAction']
  onChange: CombatScreenProps['onChange']
  retainAllowance: number
  discardableHand: readonly CardInstance[]
  optionalRetainUids: ReadonlySet<string>
  retainedSet: ReadonlySet<string>
  allowanceRetains: readonly string[]
  viewerRetainedCards: readonly string[]
  setRetainedCards: Dispatch<SetStateAction<Record<string, string[]>>>
  viewerNeedsEndTurnChoice: boolean
  viewerNeedsDiscardTop: boolean
  discardCandidates: readonly CardInstance[]
  viewerDiscardTop: string | undefined
  setDiscardTops: Dispatch<SetStateAction<Record<string, string>>>
  playWindow: ReturnType<typeof activeCardPlayWindow>
  finishTurn: () => void
  chamberClosing: boolean
  discardOrders: DiscardOrders
  confirmedDiscards: number
  endTurnParticipants: readonly string[]
  endTurnCount: string | null
  stagedStartTurnTriggerPending: boolean
  startTurnCount: string | null
  startTurnOpen: boolean
  activeStartTurnScry: { playerId: string } | null | undefined
  orderedStartTurnScries: readonly StartTurnScryAbility[]
  canOrderStartTurnScries: boolean
  startTurnOrderHint: (canMove: boolean, noun: string, count: number, locked?: boolean) => string
  moveStartTurnScry: (id: string, delta: -1 | 1) => void
  finishStartTurnScryOrder: () => void
  startTurnChoicesOpen: boolean
  stagedStartTurnTriggers: CombatScreenProps['stagedStartTurnTriggers']
  setEditingStagedStartTurnTrigger: Dispatch<SetStateAction<number | null>>
  pendingStartEnemy: StartTurnAbility | undefined
  startEnemyChoiceAvailable: (enemyUid: string) => boolean
  chooseStartTurnEnemy: (enemyUid: string) => void
  visibleStartModeShift: StartTurnAbility | undefined
  canCommitStartTurnOrder: boolean
  partyStartTurnOrderLocked: boolean
  orderedStartAbilities: readonly StartTurnAbility[]
  startTurnTargets: Record<string, (string | null | undefined)[]>
  startTurnEvokeSlots: Record<string, number[]>
  startTurnEnemyTargets: Record<string, string | undefined>
  startTurnPlayerTargets: Record<string, string | undefined>
  startTurnExhaustUids: Record<string, string | undefined>
  startTurnModeShifts: Record<string, boolean | undefined>
  savedStartTurnEnemyTargets: CombatScreenProps['savedStartTurnEnemyTargets']
  setStartTurnEnemyTargets: Dispatch<SetStateAction<Record<string, string | undefined>>>
  setStartTurnPlayerTargets: Dispatch<SetStateAction<Record<string, string | undefined>>>
  setStartTurnExhaustUids: Dispatch<SetStateAction<Record<string, string | undefined>>>
  setStartTurnModeShifts: Dispatch<SetStateAction<Record<string, boolean | undefined>>>
  setStartTurnTargets: Dispatch<SetStateAction<Record<string, (string | null | undefined)[]>>>
  setStartTurnEvokeSlots: Dispatch<SetStateAction<Record<string, number[]>>>
  setStartTurnEvokeTargets: Dispatch<SetStateAction<Record<string, (string | null | undefined)[]>>>
  moveStartTurnAbility: (id: string, delta: -1 | 1) => void
  canResolveStartTurn: boolean
  resolvingStartTurnMode: boolean
  finishStartTurn: () => void
  startTurnReady: boolean
  sendingStartTurn: boolean
  viewerStartTurnDecided: boolean
  startTurnCoordinator: Player | undefined
  partyStartTurnOrderPending: boolean
  startTurnCoordinatorId: CombatScreenProps['startTurnCoordinatorId']
  startTurnChoiceId: CombatScreenProps['startTurnChoiceId']
  fumesOwnerId: string | undefined
  startTurnStuck: boolean
  onResync: CombatScreenProps['onResync']
  resyncing: boolean
  setResyncing: Dispatch<SetStateAction<boolean>>
}

export const CombatBar = memo(function CombatBar({
  combatBarRef,
  endTurnRef,
  state,
  viewer,
  viewerId,
  livingPlayers,
  copyResolutionLabel,
  hermitSetupPending,
  hermitSetupOwner,
  onCourierReveal,
  courierUsedBy,
  playerChoicePrompt,
  viewerPlayerChoice,
  usingPlayerChoice,
  submitPlayerChoice,
  setPlayerChoiceDiscarding,
  relicScry,
  voluntaryActionsBlocked,
  forcedCard,
  distilled,
  endTurnResolving,
  pendingTrigger,
  pending,
  setPending,
  pendingPowerUid,
  setPendingPowerUid,
  usingPower,
  setPowerChamberUids,
  setPowerLoadUids,
  setPowerExhaustUids,
  powerOrbSlots,
  setPowerOrbSlots,
  setPowerGemContext,
  setPowerScryConfirmed,
  requestPowerPreview,
  usePower,
  creativeAiEffect,
  canUsePotionNow,
  pendingPotion,
  setPendingPotion,
  usingPotion,
  viewerHasSozu,
  setPotionShivEnemyUids,
  setPotionOverflowRequired,
  setPotionCardUids,
  consumePotion,
  spendingShiv,
  setSpendingShiv,
  spendingSoulburn,
  setSpendingSoulburn,
  extraCrispyPower,
  extraCrispySoulburn,
  setExtraCrispySoulburn,
  miracleOnCard,
  setMiracleOnCard,
  onAction,
  onChange,
  retainAllowance,
  discardableHand,
  optionalRetainUids,
  retainedSet,
  allowanceRetains,
  viewerRetainedCards,
  setRetainedCards,
  viewerNeedsEndTurnChoice,
  viewerNeedsDiscardTop,
  discardCandidates,
  viewerDiscardTop,
  setDiscardTops,
  playWindow,
  finishTurn,
  chamberClosing,
  discardOrders,
  confirmedDiscards,
  endTurnParticipants,
  endTurnCount,
  stagedStartTurnTriggerPending,
  startTurnCount,
  startTurnOpen,
  activeStartTurnScry,
  orderedStartTurnScries,
  canOrderStartTurnScries,
  startTurnOrderHint,
  moveStartTurnScry,
  finishStartTurnScryOrder,
  startTurnChoicesOpen,
  stagedStartTurnTriggers,
  setEditingStagedStartTurnTrigger,
  pendingStartEnemy,
  startEnemyChoiceAvailable,
  chooseStartTurnEnemy,
  visibleStartModeShift,
  canCommitStartTurnOrder,
  partyStartTurnOrderLocked,
  orderedStartAbilities,
  startTurnTargets,
  startTurnEvokeSlots,
  startTurnEnemyTargets,
  startTurnPlayerTargets,
  startTurnExhaustUids,
  startTurnModeShifts,
  savedStartTurnEnemyTargets,
  setStartTurnEnemyTargets,
  setStartTurnPlayerTargets,
  setStartTurnExhaustUids,
  setStartTurnModeShifts,
  setStartTurnTargets,
  setStartTurnEvokeSlots,
  setStartTurnEvokeTargets,
  moveStartTurnAbility,
  canResolveStartTurn,
  resolvingStartTurnMode,
  finishStartTurn,
  startTurnReady,
  sendingStartTurn,
  viewerStartTurnDecided,
  startTurnCoordinator,
  partyStartTurnOrderPending,
  startTurnCoordinatorId,
  startTurnChoiceId,
  fumesOwnerId,
  startTurnStuck,
  onResync,
  resyncing,
  setResyncing,
}: CombatBarProps) {
  return (
    <header ref={combatBarRef} className="combat__bar">
      <span className="combat__turn">Turn {state.turn}</span>
      <span className="combat__die" title="The round's shared die">
        <Icon name={dieIcon(state.die)} size={26} decorative={false} />
      </span>
      <span key={`${state.turn}-${state.phase}`} className={`combat__phase combat__phase--${state.phase}`}>{state.phase === 'copy'
        ? `Resolve ${copyResolutionLabel ?? 'card'}`
        : hermitSetupPending ? 'Load 1 card'
        : hermitSetupOwner ? `${hermitSetupOwner.name} Loads a card`
        : PHASE_LABEL[state.phase]}</span>
      {onCourierReveal && courierPeekPhase(state)
        ? <CourierPeek placement="bar" players={state.players} viewerId={viewerId} usedBy={courierUsedBy ?? []} onReveal={onCourierReveal} /> : null}
      <span className="combat__actions">
        {/* Slayer Pack: a card-given choice (Heel Hook, Magnetism) docks in the bar, off the board,
            so it never covers an enemy or its intent. */}
        {playerChoicePrompt ? <span className="combat__power-hint" role="status">{playerChoicePrompt}</span> : null}
        {viewer && viewerPlayerChoice ? (
          <span className="player-choice" role="group" aria-label={`${viewerPlayerChoice.sourceLabel} choice`}>
            {viewerPlayerChoice.kind === 'drawOrDiscard' ? <>
              <span className="combat__power-hint" title={`${viewerPlayerChoice.sourceLabel}: you may draw a card or discard a card`}>
                {viewerPlayerChoice.sourceLabel}:
              </span>
              <button type="button" disabled={usingPlayerChoice || viewer.drawLocked ||
                viewer.draw.length + viewer.discard.length === 0}
                onClick={() => submitPlayerChoice({ draw: true })}>Draw a card</button>
              <button type="button" disabled={usingPlayerChoice || viewer.hand.length === 0}
                onClick={() => setPlayerChoiceDiscarding(true)}>Discard a card</button>
              <button type="button" disabled={usingPlayerChoice}
                onClick={() => submitPlayerChoice({})}>Neither</button>
            </> : <>
              <span className="combat__power-hint"
                title={`${viewerPlayerChoice.sourceLabel}: you may return cards from the top of your discard pile`}>
                <span className="player-choice__source">{viewerPlayerChoice.sourceLabel.replace(/^.*'s /, '')}: </span>
                {viewer.discard.slice(
                  viewer.discard.length - Math.min(viewerPlayerChoice.upTo, viewer.discard.length)).reverse()
                  .map((card) => faceOf(cardDef(card.defId), card.upgraded).name).join(', ')}
              </span>
              {Array.from({ length: Math.min(viewerPlayerChoice.upTo, viewer.discard.length) }, (_unused, index) => {
                const names = viewer.discard.slice(viewer.discard.length - index - 1).reverse()
                  .map((card) => faceOf(cardDef(card.defId), card.upgraded).name).join(' and ')
                return <button key={index} type="button" disabled={usingPlayerChoice} aria-label={`Return ${names}`}
                  onClick={() => submitPlayerChoice({ count: index + 1 })}>Take {index + 1}</button>
              })}
              <button type="button" disabled={usingPlayerChoice} aria-label="Return nothing"
                onClick={() => submitPlayerChoice({ count: 0 })}>Take none</button>
            </>}
          </span>
        ) : null}
        {!viewer.dead && !relicScry && !voluntaryActionsBlocked && (state.phase === 'player' || state.phase === 'discard' ||
          state.phase === 'start' && viewer.potions.includes('gamblers_brew')) ? (
          <>
            {activePowerWindow(state) && !forcedCard && !distilled && !endTurnResolving && !pendingTrigger ? viewer.powers.flatMap((power) => {
              const def = faceOf(cardDef(power.defId), power.upgraded)
              if (!def.activeAbility) return []
              const staged = pendingPowerUid === power.uid
              const used = powerAbilityUsed(state, viewer.id, power.uid)
              const attachedGem = power.attachedGemId ? cardDef(power.attachedGemId).name : null
              // Slayer Pack: Master Reality and Creative AI need a card to return
              // (Creative AI also an Orb to remove); Creative AI asks which Orbs.
              const returnsDiscardTop = def.effects.some((effect) =>
                effect.kind === 'returnDiscardTop' || effect.kind === 'removeOrbsForDiscardTop')
              const removesOrbs = def.effects.some((effect) => effect.kind === 'removeOrbsForDiscardTop')
              return [<button
                type="button"
                key={power.uid}
                disabled={usingPower || used || Boolean(pending?.choiceCards) ||
                  !powerActivationAllowed(def, state, viewer) ||
                  def.id === 'hermit_shadow_cloak' && ![...viewer.hand, ...viewer.chamber].some((card) =>
                    faceOf(cardDef(card.defId), card.upgraded).type === 'curse') ||
                  def.id === 'hermit_black_wind' && (viewer.chamber.length === 0 || viewer.hand.length === 0) ||
                  returnsDiscardTop && viewer.discard.length === 0 ||
                  removesOrbs && viewer.orbs.every((orb) => orb == null)}
                aria-label={used ? `${def.name}${attachedGem ? ` with ${attachedGem}` : ''} used`
                  : `Use ${def.name}${attachedGem ? ` with ${attachedGem}` : ''}`}
                aria-pressed={staged}
                onClick={() => {
                  setPending(null)
                  setSpendingShiv(false)
                  setMiracleOnCard(false)
                  setPendingPotion(null)
                  setPotionShivEnemyUids([])
                  setPotionOverflowRequired(0)
                  setPowerChamberUids([])
                  setPowerLoadUids([])
                  setPowerExhaustUids([])
                  setPowerOrbSlots([])
                  setPowerGemContext(null)
                  setPowerScryConfirmed(false)
                  const needsTarget = def.target === 'row' ||
                    cardNeedsEnemy(def, viewer, true, undefined, true, power.attachedGemId)
                  const needsGemChoice = guardianCardNeedsAlly(def, viewer, power.attachedGemId) &&
                    livingPlayers.length > 1 ||
                    power.attachedGemId === 'guardian_jasper' || power.attachedGemId === 'guardian_amethyst'
                  const needsHermitChoice = def.id === 'hermit_shadow_cloak' || def.id === 'hermit_black_wind'
                  if (!staged && def.id === 'guardian_gem_finder') requestPowerPreview(power.uid)
                  else if (!staged && !needsTarget && !needsGemChoice && !needsHermitChoice && !removesOrbs &&
                    def.id !== 'guardian_revenge_protocol') usePower(power.uid, {})
                  else setPendingPowerUid(staged ? null : power.uid)
                }}
              ><PowerGlyph def={def} /></button>]
            }) : null}
            {/* Slayer Pack: Creative AI's Orbs are picked on the board; its instruction and
                confirm dock here so no prompt row covers the Orbs on a horizontal phone. */}
            {creativeAiEffect ? (
              <span className="combat__power-hint" aria-hidden="true">
                {creativeAiEffect.anyNumber ? 'Tap Orbs to remove' : 'Tap an Orb to remove'}
              </span>
            ) : null}
            {creativeAiEffect?.anyNumber ? (
              <button type="button" disabled={usingPower || powerOrbSlots.length === 0}
                onClick={() => usePower(pendingPowerUid!, { orbSlots: [...powerOrbSlots] })}>
                Return {powerOrbSlots.length} card{powerOrbSlots.length === 1 ? '' : 's'}
              </button>
            ) : null}
            {(state.phase === 'player' || state.phase === 'start') && !forcedCard && !distilled && !endTurnResolving && !pendingTrigger ? [...new Set(viewer.potions)].flatMap((potionId) => {
              if (!canUsePotionNow(potionId)) return []
              const potion = potionDef(potionId)
              const staged = pendingPotion === potionId
              const count = viewer.potions.filter((held) => held === potionId).length
              const shivs = gainedShivs(potion.effects)
              const capacity = state.potionLimit + (viewer.relics.some((relic) => relic.defId === 'potion_belt') ? 2 : 0)
              const needsTarget = ['gamblers_brew', 'liquid_memories', 'liquid_void', 'transforming_brew', 'purity_potion', 'destiny_draught'].includes(potionId) ||
                potionId === 'mystery_potion' && state.die <= 2 ||
                potionId === 'entropic_brew' && !viewerHasSozu &&
                  viewer.potions.length - 1 + 2 > capacity || Boolean(potion.target) || (
                potion.supportTarget === 'anyPlayer' && livingPlayers.length > 1
              ) || overflowShivCount(state, shivs) > 0
              const descriptionId = `potion-action-${viewer.id}-${potionId}-description`
              // A potion that needs a target is not drunk by the committing
              // tap — that tap arms targeting, and the target is chosen next.
              // Already staged, the button only un-stages: free and
              // reversible, so there is nothing to read first and no label.
              return <PotionTooltipAnchor id={potionId} key={potionId}
                confirmLabel={needsTarget ? (staged ? undefined : 'aim') : 'drink'}>
                <span id={descriptionId} className="visually-hidden">{potion.text}</span>
                <button
                  type="button"
                  disabled={usingPotion || Boolean(pending?.choiceCards)}
                  aria-label={`Use ${potion.name}${count > 1 ? ` ×${count}` : ''}`}
                  aria-describedby={descriptionId}
                  data-webmcp-sequence-end={!potion.effects.length || potion.effects.some((effect) =>
                    effect.kind === 'draw' || effect.kind === 'drawToHandSize')
                    ? 'true' : undefined}
                  aria-pressed={needsTarget ? staged : undefined}
                  onClick={() => {
                    if (needsTarget) {
                      setPending(null)
                      setPendingPowerUid(null)
                      setSpendingShiv(false)
                      setMiracleOnCard(false)
                      setPendingPotion(staged ? null : potionId)
                      setPotionShivEnemyUids([])
                      setPotionOverflowRequired(staged ? 0 : overflowShivCount(state, shivs))
                      setPotionCardUids([])
                    } else consumePotion(potionId)
                  }}
                >
                  <img className="item-icon-image" src={potionIconPath(potionId)} alt="" />
                </button>
              </PotionTooltipAnchor>
            }) : null}
            {state.phase === 'player' && !forcedCard && !distilled && !relicScry && !endTurnResolving &&
            !pendingTrigger && !viewer.cardPlayLocked && viewer.shivs > 0 ? (
              <button
                type="button"
                className={spendingShiv ? 'is-chosen' : undefined}
                disabled={Boolean(pending?.choiceCards)}
                aria-label="Use Shiv"
                aria-pressed={spendingShiv}
                onClick={() => {
                  setPending(null)
                  setPendingPowerUid(null)
                  setMiracleOnCard(false)
                  setPendingPotion(null)
                  setPotionShivEnemyUids([])
                  setPotionOverflowRequired(0)
                  setSpendingShiv((current) => !current)
                  setSpendingSoulburn(false)
                }}
              >
                <StatusIcon name="shiv" size={22} />
              </button>
            ) : null}
            {state.phase === 'player' && viewer.guardianMode ? (
              <button type="button"
                disabled={viewer.vigor < 1 || Boolean(pending?.choiceCards) || Boolean(forcedCard) || Boolean(distilled) ||
                  Boolean(relicScry) || endTurnResolving || Boolean(pendingTrigger) ||
                  viewer.cardPlayLocked || reachedTimeWarpLimit(state, viewer)}
                aria-label={`Spend 1 Vigor, ${viewer.vigor} available`}
                title="Spend 1 Vigor to boost your card effects for the rest of this turn"
                onClick={() => {
                  setPending(null)
                  setPendingPowerUid(null)
                  setPendingPotion(null)
                  setSpendingShiv(false)
                  setSpendingSoulburn(false)
                  if (onAction) onAction({ kind: 'spendVigor' })
                  else onChange?.(spendVigor(state, viewer.id))
                }}>
                <StatusIcon name="vigor" size={22} />
                <span aria-hidden="true">{viewer.vigor}</span>
              </button>
            ) : null}
            {state.phase === 'player' && !forcedCard && !distilled && !relicScry && !endTurnResolving &&
            !pendingTrigger && !viewer.cardPlayLocked && viewer.soulburn > 0 ? (
              <button
                type="button"
                className={spendingSoulburn ? 'is-chosen' : undefined}
                disabled={Boolean(pending?.choiceCards)}
                aria-label={`Spend Soulburn, ${viewer.soulburn} available`}
                aria-pressed={spendingSoulburn}
                onClick={() => {
                  setPending(null)
                  setPendingPowerUid(null)
                  setMiracleOnCard(false)
                  setPendingPotion(null)
                  setPotionShivEnemyUids([])
                  setPotionOverflowRequired(0)
                  setSpendingShiv(false)
                  setExtraCrispySoulburn(false)
                  setSpendingSoulburn((current) => !current)
                }}
              >
                <img className="item-icon-image" src={assetPath('icons/hexaghost-flame.png')} alt="" />
                <span aria-hidden="true">{viewer.soulburn}</span>
              </button>
            ) : null}
            {spendingSoulburn && extraCrispyPower ? (
              <button type="button" className={extraCrispySoulburn ? 'is-chosen' : undefined}
                aria-label="Use Extra Crispy with Soulburn" aria-pressed={extraCrispySoulburn}
                onClick={() => setExtraCrispySoulburn((current) => !current)}>
                Extra Crispy ×2
              </button>
            ) : null}
            {state.phase === 'player' && !forcedCard && !distilled && !endTurnResolving && !pendingTrigger && viewer.miracles > 0 ? (
              <button
                type="button"
                disabled={Boolean(pending?.choiceCards)}
                aria-label={viewer.energy === CAPS.energy ? 'Use Miracle on next card' : 'Use Miracle (+1 Energy)'}
                aria-pressed={viewer.energy === CAPS.energy ? miracleOnCard : undefined}
                onClick={() => {
                  if (viewer.energy < CAPS.energy) {
                    if (onAction) onAction({ kind: 'spendMiracle' })
                    else onChange?.(spendMiracle(state, viewer.id))
                  }
                  else {
                    setPending(null)
                    setPendingPowerUid(null)
                    setSpendingShiv(false)
                    setPendingPotion(null)
                    setPotionShivEnemyUids([])
                    setPotionOverflowRequired(0)
                    setMiracleOnCard((current) => !current)
                  }
                }}
              >
                <Icon name="miracle" size={22} />
              </button>
            ) : null}
            {state.phase === 'discard' && (retainAllowance > 0 && discardableHand.length > 0 || optionalRetainUids.size > 0) ? (
              <span className="retain-options" role="group"
                aria-label={`Retain up to ${retainAllowance + optionalRetainUids.size} cards for ${viewer.name}`}>
                {discardableHand.filter((card) => retainAllowance > 0 || optionalRetainUids.has(card.uid)).map((card) => {
                  const retained = retainedSet.has(card.uid)
                  const name = faceOf(cardDef(card.defId), card.upgraded).name
                  return <button key={card.uid} type="button" aria-pressed={retained}
                    disabled={!retained && !optionalRetainUids.has(card.uid) && allowanceRetains.length >= retainAllowance}
                    onClick={() => setRetainedCards((current) => ({
                      ...current,
                      [viewer.id]: retained
                        ? viewerRetainedCards.filter((uid) => uid !== card.uid)
                        : [...viewerRetainedCards, card.uid],
                    }))}>
                    {retained ? '✓ ' : ''}Retain {name}
                  </button>
                })}
              </span>
            ) : null}
            {state.phase === 'discard' && viewerNeedsEndTurnChoice && viewerNeedsDiscardTop &&
            discardCandidates.length > 1 ? (
              <label className="discard-order">
                Top discard
                <select
                  aria-label={`Top discard for ${viewer.name}`}
                  value={viewerDiscardTop}
                  onChange={(event) => setDiscardTops((current) => ({
                    ...current,
                    [viewer.id]: event.target.value,
                  }))}
                >
                  {discardCandidates.map((card) => {
                    const def = faceOf(cardDef(card.defId), card.upgraded)
                    return <option key={card.uid} value={card.uid}>{`${def.unplayable ? '—' : cardCost(def, viewer.powers, viewer.lostHpThisCombat)} · ${def.name}`}</option>
                  })}
                </select>
              </label>
            ) : null}
            {/* The count lives on the End turn button itself. A co-op turn
                ends when everyone says so, and being told who the table is
                waiting on is the whole reason a second screen existed. */}
            {!forcedCard && !distilled && !(playWindow && !playWindow.optional) ? <button type="button" ref={endTurnRef} className="combat__end-turn" onClick={finishTurn}
              disabled={Boolean(pending?.choiceCards) || Boolean(pendingTrigger) || endTurnResolving || chamberClosing ||
                state.phase === 'player' && voluntaryActionsBlocked ||
                state.phase === 'discard' && !viewerNeedsEndTurnChoice}>
              {state.phase === 'discard'
                ? `${discardOrders[viewer.id] ? 'Update' : 'Confirm'} end-turn effect (${confirmedDiscards}/${endTurnParticipants.length})`
                : endTurnCount ? `End turn ${endTurnCount}` : 'End turn'}
            </button> : null}
          </>
        ) : null}
        {stagedStartTurnTriggerPending && startTurnCount ? (
          <button type="button" className="combat__end-turn" disabled>
            Resolve start turn {startTurnCount}
          </button>
        ) : null}
        {startTurnOpen && !stagedStartTurnTriggerPending && !activeStartTurnScry &&
        orderedStartTurnScries.length > 0 ? (
          <>
            <StartTurnOrder title="Before-draw Scry order"
              hint={startTurnOrderHint(canOrderStartTurnScries, 'Scries', orderedStartTurnScries.length)} players={state.players}
              steps={orderedStartTurnScries.map((ability) => ({
                ...ability, badges: [{ text: `Scry ${ability.amount}` }],
              }))}
              canMove={canOrderStartTurnScries} onMove={moveStartTurnScry} />
            <button type="button" className="combat__end-turn" disabled={!canOrderStartTurnScries} onClick={finishStartTurnScryOrder}>
              {canOrderStartTurnScries ? 'Confirm before-draw order' : 'Waiting for before-draw order'}
            </button>
          </>
        ) : null}
        {startTurnChoicesOpen ? (
          <>
            {stagedStartTurnTriggers?.map((trigger) => (
              <button type="button" key={trigger.id} onClick={() => setEditingStagedStartTurnTrigger(trigger.id)}>
                Edit {trigger.label}
              </button>
            ))}
            {state.startTurnStage === 'facing' && pendingStartEnemy ? (
              <span className="combat__power-hint" role="status">{pendingStartEnemy.label}</span>
            ) : null}
            {pendingStartEnemy?.id.startsWith('facing:') && pendingStartEnemy.targets?.some((target) => target.uid === 'none') ? (
              <button type="button" disabled={!startEnemyChoiceAvailable('none')}
                onClick={() => chooseStartTurnEnemy('none')}>Face away</button>
            ) : null}
            {!visibleStartModeShift && state.startTurnStage !== 'facing' ? <StartTurnOrder key={`${state.combatId}/${state.turn}`} title="Start-of-turn order"
              hint={startTurnOrderHint(canCommitStartTurnOrder && !partyStartTurnOrderLocked, 'effects',
                orderedStartAbilities.length, partyStartTurnOrderLocked)} foldWhenShort
              players={state.players}
              steps={orderedStartAbilities.map((ability) => {
                const decided = (startTurnTargets[ability.id] ?? [])
                  .filter((target) => target !== undefined).length
                const evoked = startTurnEvokeSlots[ability.id]?.length ?? 0
                const targetChosen = startTurnEnemyTargets[ability.id] !== undefined
                const exhaustChosen = startTurnExhaustUids[ability.id] !== undefined
                return {
                  ...ability,
                  badges: [
                    ...ability.targets?.length ? [{ text: targetChosen ? 'Target set' : 'Choose target', done: targetChosen }]
                      : ability.exhaustCards ? [ability.playerId === viewer.id || exhaustChosen
                        ? { text: exhaustChosen ? 'Exhaust set' : 'Choose a card to Exhaust', done: exhaustChosen }
                        : { text: `Waiting for ${state.players.find((player) => player.id === ability.playerId)?.name ??
                          'a teammate'}` }]
                      : [],
                    ...ability.overflowShivs > 0
                      ? [{ text: `Shiv targets ${decided}/${ability.overflowShivs}`, done: decided === ability.overflowShivs }]
                      : [],
                    ...evoked > 0 || ability.evokeChoice
                      ? [{ text: `Evoke ${evoked}${ability.evokeChoice ? '+' : ''}`, done: !ability.evokeChoice }]
                      : [],
                  ],
                }
              })}
              canMove={canCommitStartTurnOrder && !partyStartTurnOrderLocked} onMove={moveStartTurnAbility} /> : null}
            {orderedStartAbilities.some((ability) =>
              (ability.targets?.length ?? 0) > 1 && startTurnEnemyTargets[ability.id] !== undefined) ||
              Object.values(startTurnPlayerTargets).some((playerId) => playerId !== undefined) ||
              Object.values(startTurnExhaustUids).some((uid) => uid !== undefined) ||
              Object.values(startTurnModeShifts).some((shift) => shift !== undefined) ||
              Object.values(startTurnTargets).some((targets) =>
                targets.some((target) => target !== undefined)) ||
              Object.values(startTurnEvokeSlots).some((slots) => slots.length > 0) ? (
              <button type="button" disabled={!canResolveStartTurn}
                onClick={() => {
                  setStartTurnEnemyTargets(Object.fromEntries(orderedStartAbilities.map((ability) => [
                    ability.id,
                    savedStartTurnEnemyTargets?.[ability.id] ??
                      (ability.targets?.length === 1 ? ability.targets[0]!.uid : undefined),
                  ])))
                  setStartTurnPlayerTargets(Object.fromEntries(orderedStartAbilities.map((ability) => [
                    ability.id,
                    ability.players?.length === 1 ? ability.players[0]!.id : undefined,
                  ])))
                  setStartTurnExhaustUids(Object.fromEntries(orderedStartAbilities.map((ability) => [
                    ability.id, ability.exhaustCards?.length === 1 ? ability.exhaustCards[0]!.uid : undefined,
                  ])))
                  setStartTurnModeShifts({})
                  setStartTurnTargets(Object.fromEntries(orderedStartAbilities.map((ability) => [
                    ability.id,
                    Array(ability.overflowShivs).fill(undefined),
                  ])))
                  setStartTurnEvokeSlots(Object.fromEntries(orderedStartAbilities.map((ability) => [ability.id, []])))
                  setStartTurnEvokeTargets(Object.fromEntries(orderedStartAbilities.map((ability) => [ability.id, []])))
                }}>
                Reset start choices
              </button>
            ) : null}
            {!visibleStartModeShift && !resolvingStartTurnMode
              ? <button type="button" className="combat__end-turn" onClick={() => finishStartTurn()}
              disabled={!startTurnReady || !canResolveStartTurn || sendingStartTurn}>
              {viewerStartTurnDecided
                ? `Waiting for ${startTurnCoordinator?.name ?? 'the party'}${startTurnCount ? ` (${startTurnCount})` : ''}`
                : sendingStartTurn ? 'Confirming…'
                : canResolveStartTurn
                ? partyStartTurnOrderPending && viewer.id === startTurnCoordinatorId ? 'Confirm start-of-turn order'
                  : startTurnChoiceId && viewer.id === fumesOwnerId ? 'Confirm Noxious Fumes target'
                    : startTurnCount ? `Resolve start turn ${startTurnCount}` : 'Resolve start of turn'
                : startTurnCount ? `Resolve start turn ${startTurnCount}` : startTurnCoordinator
                  ? `Waiting for ${startTurnCoordinator.name}` : 'Waiting for start-turn order'}
              </button> : null}
          </>
        ) : null}
        {startTurnStuck && onResync ? (
          <button type="button" className="combat__resync" disabled={resyncing}
            onClick={() => {
              setResyncing(true)
              void onResync().finally(() => setResyncing(false))
            }}>
            {resyncing ? 'Re-syncing…' : 'Stuck? Re-sync start of turn'}
          </button>
        ) : null}
      </span>
    </header>
  )
})
