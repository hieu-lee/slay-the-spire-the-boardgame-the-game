import { memo, type Dispatch, type RefObject, type SetStateAction } from 'react'
import { potionIconPath } from '../../game/assets.ts'
import { cardDef, cardIsCurse, faceOf, type CardDef } from '../../game/cards.ts'
import {
  chooseDistilledCard,
  effectiveCombatCardDef,
  type CombatState,
  type owedPlayerChoices,
  type PendingTriggerAbility,
  type PlayerChoiceAnswer,
  type PotionContext,
  type RelicContext,
} from '../../game/combat.ts'
import { potionDef, type PotionDef } from '../../game/relics.ts'
import type { CardInstance, Player } from '../../game/types.ts'
import { Card } from '../Card.tsx'
import { DieRelicChoiceList, dieRelicChoices } from '../DieRelicChoices.tsx'
import { PotionTooltipAnchor } from '../PotionIcon.tsx'
import { HermitTriggerChoice } from './HermitTriggerChoice.tsx'
import type { CombatScreenProps, Pending } from './types.ts'

export type CombatPotionDialogsProps = {
  state: CombatState
  viewer: Player
  stanceChangedThisTurn: boolean | undefined
  itemDialogRef: RefObject<HTMLDialogElement | null>
  pendingPotion: string | null
  pendingPotionDef: PotionDef | null
  pendingPotionNeedsCards: boolean
  potionCardUids: readonly string[]
  setPotionCardUids: Dispatch<SetStateAction<string[]>>
  consumePotion: (potionId: string, context?: PotionContext, overflow?: { expected: number; skip: boolean }) => void
  cancelPotionChoice: () => void
  viewerHasSozu: boolean
}

export const CombatPotionDialogs = memo(function CombatPotionDialogs({
  state,
  viewer,
  stanceChangedThisTurn,
  itemDialogRef,
  pendingPotion,
  pendingPotionDef,
  pendingPotionNeedsCards,
  potionCardUids,
  setPotionCardUids,
  consumePotion,
  cancelPotionChoice,
  viewerHasSozu,
}: CombatPotionDialogsProps) {
  return (
    <>
      {pendingPotionNeedsCards ? (
        <dialog ref={itemDialogRef} className="distilled-choice" aria-labelledby="potion-card-choice-title"
          onCancel={(event) => {
            event.preventDefault()
            cancelPotionChoice()
          }}>
          <h2 id="potion-card-choice-title">{pendingPotionDef!.name}</h2>
          <p>{pendingPotion === 'liquid_memories'
            ? 'Choose one discarded card to return to your hand for 0 Energy this turn.'
            : pendingPotion === 'liquid_void'
              ? 'Choose one Exhausted card to return to your hand for 0 Energy this turn.'
              : pendingPotion === 'transforming_brew'
                ? 'Choose one non-Curse card in your hand to Transform.'
                : 'Choose up to three cards in your hand, then confirm.'}</p>
          <div className="distilled-choice__cards">
            {(pendingPotion === 'liquid_memories' ? viewer.discard
              : pendingPotion === 'liquid_void' ? viewer.exhaust : viewer.hand)
              .filter((card) => pendingPotion !== 'transforming_brew' || !cardIsCurse(card.defId)).map((card) => (
              <Card stanceChangedThisTurn={stanceChangedThisTurn} key={card.uid} card={card} selected={potionCardUids.includes(card.uid)}
                onClick={() => pendingPotion === 'liquid_memories'
                  ? consumePotion(pendingPotion, { recoverDiscardUid: card.uid })
                  : pendingPotion === 'liquid_void'
                    ? consumePotion(pendingPotion, { recoverExhaustUid: card.uid })
                  : pendingPotion === 'transforming_brew'
                    ? consumePotion(pendingPotion, { transformHandUid: card.uid })
                  : setPotionCardUids((current) => current.includes(card.uid)
                    ? current.filter((uid) => uid !== card.uid)
                    : current.length < 3 ? [...current, card.uid] : current)} />
            ))}
          </div>
          {pendingPotion === 'purity_potion' ? (
            <button type="button" className="prompt__mode"
              onClick={() => consumePotion(pendingPotion, { exhaustUids: [...potionCardUids] })}>
              Exhaust {potionCardUids.length || 'none'}
            </button>
          ) : null}
          <button type="button" className="prompt__cancel" onClick={cancelPotionChoice}>Cancel</button>
        </dialog>
      ) : null}

      {pendingPotion === 'destiny_draught' ? (
        <div className="prompt" aria-label="Destiny Draught relic ability">
          <DieRelicChoiceList state={state} choices={dieRelicChoices(state)}
            onChoose={(choice) => consumePotion(pendingPotion, {
              targetRelicPlayerId: choice.owner.id, targetRelicIndex: choice.relicIndex,
              targetAbilityIndex: choice.abilityIndex, enemyUid: choice.enemy?.uid,
              targetPlayerId: choice.targetPlayer?.id,
            })} />
          <button type="button" className="prompt__cancel" onClick={cancelPotionChoice}>Cancel</button>
        </div>
      ) : null}

      {pendingPotion === 'entropic_brew' && !viewerHasSozu ? (
        <dialog ref={itemDialogRef} className="distilled-choice" aria-labelledby="entropic-choice-title"
          onCancel={(event) => {
            event.preventDefault()
            cancelPotionChoice()
          }}>
          <h2 id="entropic-choice-title">Entropic Brew</h2>
          <p>Choose one held Potion to discard, then gain two.</p>
          <div className="item-actions">
            {viewer.potions.filter((held) => held !== 'entropic_brew').map((held, index) => {
              const descriptionId = `entropic-replace-${held}-${index}-description`
              // Deliberately no `confirmLabel`, which is what keeps the
              // read-first step OFF here: this dialog is opened with
              // `showModal`, and the anchor portals its panel to the body —
              // outside the top layer, so under the backdrop. A gate whose
              // panel cannot be seen is a tap that does nothing. That panel is
              // equally unreachable here for a mouse, which is an older and
              // separate problem; the rules stay available through the
              // description below either way.
              return <PotionTooltipAnchor id={held} key={`${held}:${index}`}>
                <span id={descriptionId} className="visually-hidden">{potionDef(held).text}</span>
                <button type="button" aria-describedby={descriptionId}
                onClick={() => consumePotion('entropic_brew', { replacePotionId: held })}>
                  <img className="item-icon-image" src={potionIconPath(held)} alt="" /> Replace {potionDef(held).name}
                </button>
              </PotionTooltipAnchor>
            })}
          </div>
          <button type="button" className="prompt__cancel" onClick={cancelPotionChoice}>Cancel</button>
        </dialog>
      ) : null}
    </>
  )
})

export type CombatChoiceDialogsProps = {
  state: CombatState
  viewer: Player
  viewerId: string
  stanceChangedThisTurn: boolean | undefined
  onAction: CombatScreenProps['onAction']
  onChange: CombatScreenProps['onChange']
  itemDialogRef: RefObject<HTMLDialogElement | null>
  startTurnScryDialogRef: RefObject<HTMLDialogElement | null>
  startTurnDiscardDialogRef: RefObject<HTMLDialogElement | null>
  choiceDialogRef: RefObject<HTMLDialogElement | null>
  gemFinderScryOpen: boolean
  powerChoiceCards: readonly CardInstance[] | null
  pendingPower: CardInstance | undefined
  powerScryDiscardUids: readonly string[]
  setPowerScryDiscardUids: Dispatch<SetStateAction<string[]>>
  confirmPowerScry: () => void
  relicScry: CombatState['pendingRelicScry']
  relicCardUids: readonly string[]
  setRelicCardUids: Dispatch<SetStateAction<string[]>>
  useRelic: (relicIndex: number, context?: RelicContext) => void
  visibleDistilled: CombatState['pendingDistilled']
  activeStartTurnScry: { playerId: string; amount: number; cards: readonly CardInstance[] | null } | null | undefined
  startTurnScryPicked: readonly string[]
  chooseStartTurnScryCard: (card: CardInstance) => void
  resolvingStartTurnScry: boolean
  finishStartTurnScry: () => Promise<void>
  activeStartTurnDiscard: {
    playerId: string
    sourceId: string
    label: string
    remaining: number
    cards: readonly CardInstance[] | null
  } | null | undefined
  finishStartTurnDiscard: (card: CardInstance) => Promise<void>
  pendingTrigger: PendingTriggerAbility | null | undefined
  pendingPlunder: NonNullable<CombatState['pendingPlunderSwitches']>[number] | undefined
  triggerHermitStep: 'cards' | 'board' | 'target'
  setTriggerHermitStep: Dispatch<SetStateAction<'cards' | 'board' | 'target'>>
  triggerHermitLoadUids: string[]
  setTriggerHermitLoadUids: Dispatch<SetStateAction<string[]>>
  triggerHermitChamberUids: string[]
  setTriggerHermitChamberUids: Dispatch<SetStateAction<string[]>>
  triggerHermitNeedsBoard: boolean
  usingTrigger: boolean
  confirmTriggerHermitChoices: () => void
  pending: Pending | null
  setPending: Dispatch<SetStateAction<Pending | null>>
  pendingDef: CardDef | null
  choiceNeeded: number
  pendingSearchKind: { kind: 'overexert' | 'replicateSlime' } | undefined
  selectedSearchType: CardDef['type'] | undefined
  scryPlay: boolean
  scryPlayRequired: boolean
  scryPlayEligible: (card: CardInstance) => boolean
  onChoiceCardClick: (card: CardInstance) => void
  handChoiceSatisfied: boolean
  confirmChoice: () => void
}

export const CombatChoiceDialogs = memo(function CombatChoiceDialogs({
  state,
  viewer,
  viewerId,
  stanceChangedThisTurn,
  onAction,
  onChange,
  itemDialogRef,
  startTurnScryDialogRef,
  startTurnDiscardDialogRef,
  choiceDialogRef,
  gemFinderScryOpen,
  powerChoiceCards,
  pendingPower,
  powerScryDiscardUids,
  setPowerScryDiscardUids,
  confirmPowerScry,
  relicScry,
  relicCardUids,
  setRelicCardUids,
  useRelic,
  visibleDistilled,
  activeStartTurnScry,
  startTurnScryPicked,
  chooseStartTurnScryCard,
  resolvingStartTurnScry,
  finishStartTurnScry,
  activeStartTurnDiscard,
  finishStartTurnDiscard,
  pendingTrigger,
  pendingPlunder,
  triggerHermitStep,
  setTriggerHermitStep,
  triggerHermitLoadUids,
  setTriggerHermitLoadUids,
  triggerHermitChamberUids,
  setTriggerHermitChamberUids,
  triggerHermitNeedsBoard,
  usingTrigger,
  confirmTriggerHermitChoices,
  pending,
  setPending,
  pendingDef,
  choiceNeeded,
  pendingSearchKind,
  selectedSearchType,
  scryPlay,
  scryPlayRequired,
  scryPlayEligible,
  onChoiceCardClick,
  handChoiceSatisfied,
  confirmChoice,
}: CombatChoiceDialogsProps) {
  return (
    <>

      {gemFinderScryOpen && powerChoiceCards ? (
        <dialog ref={itemDialogRef} className="distilled-choice" aria-labelledby="gem-finder-title"
          onCancel={(event) => event.preventDefault()}>
          <h2 id="gem-finder-title">Gem Finder — Scry {pendingPower?.upgraded ? 4 : 3}</h2>
          <p>Select any revealed non-Gem cards to discard.</p>
          <div className="distilled-choice__cards">{powerChoiceCards.map((card) => <Card stanceChangedThisTurn={stanceChangedThisTurn} key={card.uid} card={card}
            playable={cardDef(card.defId).guardian?.printedType.startsWith('Gem') !== true}
            selected={powerScryDiscardUids.includes(card.uid)} onClick={() => setPowerScryDiscardUids((current) =>
              current.includes(card.uid) ? current.filter((uid) => uid !== card.uid) : [...current, card.uid])} />)}</div>
          <button type="button" className="prompt__mode" onClick={confirmPowerScry}>
            {powerScryDiscardUids.length === 0 ? 'Keep all and continue' : `Discard ${powerScryDiscardUids.length} and continue`}
          </button>
        </dialog>
      ) : null}

      {relicScry ? (
        <dialog ref={itemDialogRef} className="distilled-choice" aria-labelledby="golden-eye-title"
          onCancel={(event) => event.preventDefault()}>
          <h2 id="golden-eye-title">Golden Eye — Scry 3</h2>
          {relicScry.playerId === viewerId ? <>
            <p>Select any revealed cards to discard.</p>
            <div className="distilled-choice__cards">{relicScry.cards.map((card) => <Card stanceChangedThisTurn={stanceChangedThisTurn} key={card.uid} card={card}
              selected={relicCardUids.includes(card.uid)} onClick={() => setRelicCardUids((current) =>
                current.includes(card.uid) ? current.filter((uid) => uid !== card.uid) : [...current, card.uid])} />)}</div>
            <button type="button" className="prompt__mode"
              onClick={() => useRelic(relicScry.relicIndex, { scryDiscardUids: [...relicCardUids] })}>
              Discard {relicCardUids.length || 'none'}
            </button>
          </> : <p>Waiting for {state.players.find((player) => player.id === relicScry.playerId)?.name}.</p>}
        </dialog>
      ) : null}

      {visibleDistilled ? (
        <dialog ref={itemDialogRef} className="distilled-choice" aria-labelledby="distilled-choice-title"
          onCancel={(event) => event.preventDefault()}>
          <h2 id="distilled-choice-title">Distilled Chaos</h2>
          {visibleDistilled.playerId === viewerId ? (
            <>
              <p>Choose the next revealed card to play for 0 Energy.</p>
              <div className="distilled-choice__cards">
                {visibleDistilled.cards.map((card) => (
                  <Card stanceChangedThisTurn={stanceChangedThisTurn} key={card.uid} card={card} cost={0} playable
                    onClick={() => onAction
                      ? void onAction({ kind: 'chooseDistilledCard', cardUid: card.uid })
                      : onChange?.(chooseDistilledCard(state, viewerId, card.uid))} />
                ))}
              </div>
            </>
          ) : (
            <p>Waiting for {state.players.find((player) => player.id === visibleDistilled.playerId)?.name ?? 'another player'} to choose the next card.</p>
          )}
        </dialog>
      ) : null}

      {activeStartTurnScry?.playerId === viewerId && activeStartTurnScry.cards ? (
        <dialog ref={startTurnScryDialogRef} className="choice-modal" aria-labelledby="start-turn-scry-title"
          onCancel={(event) => event.preventDefault()}>
          <div className="choice-modal__panel">
            <h2 id="start-turn-scry-title">Foresight — Scry {activeStartTurnScry.amount}</h2>
            <p>Select any revealed cards to discard; unselected cards stay on top in order.</p>
            <div className="choice-modal__cards">
              {activeStartTurnScry.cards.map((card) => (
                <Card stanceChangedThisTurn={stanceChangedThisTurn} key={card.uid} card={card} selected={startTurnScryPicked.includes(card.uid)}
                  onClick={chooseStartTurnScryCard} />
              ))}
              {activeStartTurnScry.cards.length === 0 ? <span className="muted">No cards were revealed.</span> : null}
            </div>
            <button type="button" disabled={resolvingStartTurnScry} onClick={() => void finishStartTurnScry()}>
              {startTurnScryPicked.length === 0
                ? 'Keep all and continue'
                : `Discard ${startTurnScryPicked.length} and continue`}
            </button>
          </div>
        </dialog>
      ) : null}

      {activeStartTurnDiscard?.playerId === viewerId && activeStartTurnDiscard.cards ? (
        <dialog ref={startTurnDiscardDialogRef} className="choice-modal" aria-labelledby="start-turn-discard-title"
          onCancel={(event) => event.preventDefault()}>
          <div className="choice-modal__panel">
            <h2 id="start-turn-discard-title">
              {activeStartTurnDiscard.label} — discard {activeStartTurnDiscard.remaining} card{activeStartTurnDiscard.remaining === 1 ? '' : 's'}
            </h2>
            <p>Choose a card from your hand. This choice is private.</p>
            <div className="choice-modal__cards">
              {activeStartTurnDiscard.cards.map((card) => (
                <Card stanceChangedThisTurn={stanceChangedThisTurn} key={card.uid} card={card} onClick={() => void finishStartTurnDiscard(card)} />
              ))}
            </div>
          </div>
        </dialog>
      ) : null}

      {pendingTrigger?.playerId === viewerId && pendingTrigger.hermitChoices && triggerHermitStep === 'cards' &&
        !pendingPlunder ? (
        <HermitTriggerChoice
          key={pendingTrigger.id}
          label={pendingTrigger.label}
          choices={pendingTrigger.hermitChoices}
          hand={viewer.hand}
          loadUids={triggerHermitLoadUids}
          chamberUids={triggerHermitChamberUids}
          needsTarget={triggerHermitNeedsBoard}
          busy={usingTrigger}
          onLoadUids={setTriggerHermitLoadUids}
          onChamberUids={setTriggerHermitChamberUids}
          onConfirm={confirmTriggerHermitChoices}
          onViewBoard={() => setTriggerHermitStep('board')}
        />
      ) : null}

      {pending?.choiceCards && pending.choice && !pending.choiceConfirmed ? (
        <dialog ref={choiceDialogRef}
          className={`choice-modal${pending.choice.kind === 'scryToHand' ? ' choice-modal--scry-to-hand' : ''}`}
          aria-labelledby="choice-modal-title"
          onCancel={(event) => {
            event.preventDefault()
            if ((pending.cardInHand || pending.chamberPlay) &&
              (pending.choice?.kind === 'recover' || pending.choice?.kind === 'recoverExhaust')) setPending(null)
          }}>
          <div className="choice-modal__panel">
            <h2 id="choice-modal-title">
              {pending.choice.kind === 'scry' || pending.choice.kind === 'scryToHand'
                ? `Scry ${pending.choice.amount}`
                : pending.choice.kind === 'topdeck'
                  ? `Choose ${choiceNeeded} for the top of your draw pile`
                : pending.choice.kind === 'recover'
                  ? `Choose ${choiceNeeded} card${choiceNeeded === 1 ? '' : 's'} from your discard pile`
                : pending.choice.kind === 'recoverExhaust'
                  ? `Choose ${pending.choice.minimum === 0 ? `up to ${choiceNeeded}` :
                    choiceNeeded === 1 ? 'a' : choiceNeeded} card${choiceNeeded === 1 ? '' : 's'} from your Exhaust pile`
                : pending.choice.kind === 'search'
                  ? pendingSearchKind?.kind === 'overexert'
                    ? choiceNeeded === 0 ? 'No playable card remains' : 'Choose a playable card from your hand'
                    : pendingSearchKind?.kind === 'replicateSlime'
                      ? choiceNeeded === 0 ? 'No Slime is in your draw pile' : 'Choose a Slime from your draw pile'
                      : `Choose ${choiceNeeded} from your draw pile`
                : pending.choice.kind === 'load' || pending.choice.kind === 'loadAny'
                  ? `Choose ${pending.choice.kind === 'loadAny' ? 'up to ' : ''}${pending.choice.amount} to Load`
                  : `Choose ${choiceNeeded} to discard`}
            </h2>
            <p>
              {pending.choice.kind === 'scry' || pending.choice.kind === 'scryToHand'
                ? pending.choice.kind === 'scryToHand'
                  ? scryPlay
                    ? scryPlayRequired
                      ? 'Choose one revealed card to play for 0 Energy, and any others to discard.'
                      : 'No revealed card can be played. Select any cards to discard.'
                    : 'Select any cards to discard. You may also put one eligible revealed card into your hand.'
                  : 'Select any revealed cards to discard; unselected cards stay on top in order.'
                : pending.choice.kind === 'topdeck'
                  ? `${pending.picked.length}/${choiceNeeded} selected. The card is committed.`
                : pending.choice.kind === 'recover'
                  ? `${pending.picked.length}/${choiceNeeded} selected from discard.`
                : pending.choice.kind === 'recoverExhaust'
                  ? `${pending.picked.length}/${choiceNeeded} selected from Exhaust.`
                : pending.choice.kind === 'search'
                  ? pendingSearchKind?.kind === 'overexert'
                    ? choiceNeeded === 0 ? 'Continue without playing another card.'
                      : `${pending.picked.length}/${choiceNeeded} selected; the chosen card will be played${
                        selectedSearchType === 'attack' ? ' twice' : ''}.`
                    : pendingSearchKind?.kind === 'replicateSlime'
                      ? choiceNeeded === 0 ? 'Shuffle and continue without playing a Slime.'
                        : `${pending.picked.length}/${choiceNeeded} selected; the chosen Slime will be played and the rest shuffled.`
                      : `${pending.picked.length}/${choiceNeeded} selected; the rest will be shuffled.`
                : pending.choice.kind === 'load' || pending.choice.kind === 'loadAny'
                  ? `${pending.picked.length}/${pending.choice.amount} selected for the Chamber.`
                : `${pending.picked.length}/${choiceNeeded} selected.${pending.picked.length > 0
                  ? ` Discard order (later is higher): ${pending.picked.map((uid, index) => {
                    const card = pending.choiceCards!.find((held) => held.uid === uid)!
                    return `${index + 1}. ${faceOf(cardDef(card.defId), card.upgraded).name}`
                  }).join(' → ')}.`
                  : ''} The card is committed.`}
            </p>
            <div className="choice-modal__cards">
              {pending.choiceCards.map((card) => <div key={card.uid}
                className={pending.choice?.kind === 'scryToHand' ? 'choice-modal__card-option' : undefined}>
                <Card stanceChangedThisTurn={stanceChangedThisTurn} card={card} selected={pending.picked.includes(card.uid) || pending.scryToHandUid === card.uid}
                  onClick={onChoiceCardClick} />
                {pending.choice?.kind === 'scryToHand' && (scryPlay
                  ? scryPlayEligible(card) || pending.scryToHandUid === card.uid : effectiveCombatCardDef(
                  faceOf(cardDef(card.defId), card.upgraded), viewer.guardianMode,
                ).type ===
                  (pendingDef?.effects.find((effect) => effect.kind === 'scryToHand') as { cardType?: string } | undefined)?.cardType)
                  ? <button type="button" className="choice-modal__card-action"
                    aria-pressed={pending.scryToHandUid === card.uid}
                    onClick={() => setPending({ ...pending,
                      picked: pending.picked.filter((uid) => uid !== card.uid),
                      scryToHandUid: pending.scryToHandUid === card.uid ? undefined : card.uid,
                      choiceConfirmed: false,
                    })}>{scryPlay
                      ? pending.scryToHandUid === card.uid ? 'Will play for 0' : 'Play for 0'
                      : pending.scryToHandUid === card.uid ? 'Will put in hand' : 'Put in hand'}</button> : null}
              </div>)}
              {pending.choiceCards.length === 0 ? <span className="muted">No cards were revealed.</span> : null}
            </div>
            <button type="button" disabled={!handChoiceSatisfied} onClick={confirmChoice}>
              {pending.choice.kind === 'scry' || pending.choice.kind === 'scryToHand'
                ? pending.choice.kind === 'scryToHand' && pending.scryToHandUid
                  ? pending.picked.length === 0
                    ? scryPlay ? 'Play selected card, keep the rest' : 'Put selected card in hand and keep the rest'
                    : `Discard ${pending.picked.length}, ${scryPlay ? 'play' : 'put'} selected card${scryPlay ? '' : ' in hand'}`
                  : scryPlayRequired ? 'Choose a card to play'
                  : pending.picked.length === 0 ? 'Keep all' : `Discard ${pending.picked.length} and continue`
                : pending.choice.kind === 'topdeck'
                  ? `Put selected card${choiceNeeded === 1 ? '' : 's'} on top`
                : pending.choice.kind === 'recover'
                  ? pendingDef?.effects.some((effect) => effect.kind === 'recoverDiscard' && effect.toHand)
                    ? `Return selected card${choiceNeeded === 1 ? '' : 's'} to hand`
                    : `Put selected card${choiceNeeded === 1 ? '' : 's'} on top`
                : pending.choice.kind === 'recoverExhaust'
                  ? pendingDef?.effects.some((effect) => effect.kind === 'recoverExhaustToDraw')
                    ? pending.picked.length === 0 ? 'Keep all in Exhaust'
                      : `Put selected card${pending.picked.length === 1 ? '' : 's'} on top of your draw pile`
                    : pendingDef?.effects.some((effect) => effect.kind === 'recoverExhaustToDiscard')
                      ? `Put selected card${pending.picked.length === 1 ? '' : 's'} on top of your discard pile`
                      : 'Return selected card to hand'
                : pending.choice.kind === 'search'
                  ? pendingSearchKind?.kind === 'overexert'
                    ? choiceNeeded === 0 ? 'Continue'
                      : selectedSearchType === 'attack'
                        ? 'Play selected Attack twice' : 'Play selected card'
                    : pendingSearchKind?.kind === 'replicateSlime'
                      ? choiceNeeded === 0 ? 'Shuffle and continue' : 'Play selected Slime and shuffle'
                    : choiceNeeded === 0
                      ? 'Shuffle and continue'
                    : pendingDef?.effects.some((effect) => effect.kind === 'searchDrawAndPlayTwice')
                    ? 'Play selected card twice and shuffle'
                    : `Put selected card${choiceNeeded === 1 ? '' : 's'} in hand and shuffle`
                : pending.choice.kind === 'load' || pending.choice.kind === 'loadAny'
                  ? pending.picked.length === 0 ? 'Load none' : `Load ${pending.picked.length} card${pending.picked.length === 1 ? '' : 's'}`
                : choiceNeeded === 0 ? 'Continue' : `Discard selected card${choiceNeeded === 1 ? '' : 's'}`}
            </button>
          {(pending.cardInHand || pending.chamberPlay) &&
            (pending.choice.kind === 'recover' || pending.choice.kind === 'recoverExhaust') ? (
              <button type="button" className="prompt__cancel" onClick={() => setPending(null)}>Cancel</button>
            ) : null}
          </div>
        </dialog>
      ) : null}
    </>
  )
})

export function PlayerChoiceDiscardDialog({
  dialogRef,
  viewer,
  viewerPlayerChoice,
  playerChoiceDiscarding,
  setPlayerChoiceDiscarding,
  stanceChangedThisTurn,
  usingPlayerChoice,
  submitPlayerChoice,
}: {
  dialogRef: RefObject<HTMLDialogElement | null>
  viewer: Player
  viewerPlayerChoice: ReturnType<typeof owedPlayerChoices>[number] | undefined
  playerChoiceDiscarding: boolean
  setPlayerChoiceDiscarding: Dispatch<SetStateAction<boolean>>
  stanceChangedThisTurn: boolean | undefined
  usingPlayerChoice: boolean
  submitPlayerChoice: (answer: Omit<PlayerChoiceAnswer, 'choiceId'>) => void
}) {
  if (viewerPlayerChoice?.kind !== 'drawOrDiscard' || !playerChoiceDiscarding) return null
  // Slayer Pack: Heel Hook's discard is picked privately from the chooser's own hand.
  return (
    <dialog ref={dialogRef} className="choice-modal" aria-labelledby="player-choice-discard-title"
      onCancel={(event) => { event.preventDefault(); setPlayerChoiceDiscarding(false) }}>
      <div className="choice-modal__panel">
        <h2 id="player-choice-discard-title">{viewerPlayerChoice.sourceLabel} — discard a card</h2>
        <p>Choose a card from your hand. This choice is private.</p>
        <div className="choice-modal__cards">
          {viewer.hand.map((card) => (
            <Card stanceChangedThisTurn={stanceChangedThisTurn} key={card.uid} card={card} onClick={() => submitPlayerChoice({ discardUid: card.uid })} />
          ))}
        </div>
        <button type="button" className="prompt__mode" disabled={usingPlayerChoice}
          onClick={() => setPlayerChoiceDiscarding(false)}>Back</button>
      </div>
    </dialog>
  )
}
