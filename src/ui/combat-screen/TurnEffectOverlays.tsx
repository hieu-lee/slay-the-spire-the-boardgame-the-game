import type { Dispatch, PointerEvent as ReactPointerEvent, ReactNode, RefObject, SetStateAction } from 'react'
import { assetPath, relicIconPath } from '../../game/assets.ts'
import { cardDef, faceOf } from '../../game/cards.ts'
import { enemyLabel, livingEnemies } from '../../game/combat.ts'
import type {
  CombatState,
  EndTurnAbility,
  PlayerChoiceAnswer,
  StartTurnAbility,
} from '../../game/combat.ts'
import { relicDef } from '../../game/relics.ts'
import type { RelicAbility } from '../../game/relics.ts'
import type { CardInstance, Enemy, OrbType, Player } from '../../game/types.ts'
import { Card } from '../Card.tsx'
import { PlayerChoiceDiscardDialog } from './CombatDialogs.tsx'
import type { EndTurnEffectDrag, PendingStartChoice } from './types.ts'

export type TurnEffectOverlaysProps = {
  state: CombatState
  stanceChangedThisTurn: boolean | undefined
  startTurnEffectSource: StartTurnAbility | undefined
  pendingStartPlayer: StartTurnAbility | undefined
  startTurnEffectDraggable: boolean
  startTurnEffectCard: CardInstance | undefined
  startTurnEffectRelicId: string | undefined
  canResolveStartTurn: boolean
  armedEndTurnAbilityId: string | null
  activateEndTurnEffect: (ability: EndTurnAbility | StartTurnAbility) => void
  onEndTurnEffectPointerDown: (
    ability: EndTurnAbility | StartTurnAbility,
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => void
  onEndTurnEffectPointerMove: (event: ReactPointerEvent<HTMLElement>) => void
  finishEndTurnEffectDrag: (event: ReactPointerEvent<HTMLElement>) => void
  cancelEndTurnEffectDrag: (event: ReactPointerEvent<HTMLElement>) => void
  evokeTargetSource: EndTurnAbility | undefined
  evokeTargetOrb: OrbType | undefined
  pendingStartEvokeTarget: Extract<PendingStartChoice, { kind: 'evokeTarget' }> | undefined
  pendingEvokeTarget: number
  visibleStartModeShift: StartTurnAbility | undefined
  resolvingStartTurnMode: boolean
  chooseStartTurnMode: (mode: 'attack' | 'defense') => void
  endTurnEffect: EndTurnAbility | undefined
  canResolveEndTurn: boolean
  endTurnEffectPrompt: ReactNode
  endTurnEffectCard: CardInstance | undefined
  endTurnChoiceTargets: readonly { uid: string; label: string }[]
  endTurnEffectDrag: EndTurnEffectDrag | null
  endTurnEffectSlimeAsset: string | undefined
  endTurnOrbChoices: readonly { orb: OrbType; target: { uid: string; label: string } }[]
  resolveTurnEffectTarget: (abilityId: string, targetUid: string) => void
  endTurnSelfExhaustOffered: boolean
  endTurnSelfExhaust: boolean
  setEndTurnSelfExhaust: Dispatch<SetStateAction<boolean>>
}

export function TurnEffectOverlays({
  state,
  stanceChangedThisTurn,
  startTurnEffectSource,
  pendingStartPlayer,
  startTurnEffectDraggable,
  startTurnEffectCard,
  startTurnEffectRelicId,
  canResolveStartTurn,
  armedEndTurnAbilityId,
  activateEndTurnEffect,
  onEndTurnEffectPointerDown,
  onEndTurnEffectPointerMove,
  finishEndTurnEffectDrag,
  cancelEndTurnEffectDrag,
  evokeTargetSource,
  evokeTargetOrb,
  pendingStartEvokeTarget,
  pendingEvokeTarget,
  visibleStartModeShift,
  resolvingStartTurnMode,
  chooseStartTurnMode,
  endTurnEffect,
  canResolveEndTurn,
  endTurnEffectPrompt,
  endTurnEffectCard,
  endTurnChoiceTargets,
  endTurnEffectDrag,
  endTurnEffectSlimeAsset,
  endTurnOrbChoices,
  resolveTurnEffectTarget,
  endTurnSelfExhaustOffered,
  endTurnSelfExhaust,
  setEndTurnSelfExhaust,
}: TurnEffectOverlaysProps) {
  return (
    <>
      {startTurnEffectSource ? (
        <section className="end-turn-effects start-turn-effects" aria-live="polite"
          aria-label={`Start-turn effect: ${startTurnEffectSource.label}`}>
          <p className="end-turn-effects__prompt">
            <span className="visually-hidden">{startTurnEffectSource.label}: </span>
            {startTurnEffectSource === pendingStartPlayer ? 'Drag to a player'
              : startTurnEffectDraggable ? 'Drag to an enemy' : 'Choose an Orb'}
          </p>
          <div className="start-turn-effects__source" inert={!startTurnEffectDraggable}>
            {startTurnEffectCard ? (
              <Card stanceChangedThisTurn={stanceChangedThisTurn}
                className="end-turn-effect end-turn-effect--card"
                card={startTurnEffectCard}
                playable={canResolveStartTurn}
                selected={armedEndTurnAbilityId === startTurnEffectSource.id}
                onClick={() => activateEndTurnEffect(startTurnEffectSource)}
                onPointerDown={(event) => onEndTurnEffectPointerDown(startTurnEffectSource, event)}
                onPointerMove={onEndTurnEffectPointerMove}
                onPointerUp={finishEndTurnEffectDrag}
                onPointerCancel={cancelEndTurnEffectDrag}
                onLostPointerCapture={cancelEndTurnEffectDrag}
              />
            ) : startTurnEffectRelicId ? (
              <button
                type="button"
                className="end-turn-effect end-turn-effect--relic"
                disabled={!canResolveStartTurn}
                aria-label={`Resolve ${startTurnEffectSource.label}`}
                aria-pressed={armedEndTurnAbilityId === startTurnEffectSource.id}
                onClick={() => activateEndTurnEffect(startTurnEffectSource)}
                onPointerDown={(event) => onEndTurnEffectPointerDown(startTurnEffectSource, event)}
                onPointerMove={onEndTurnEffectPointerMove}
                onPointerUp={finishEndTurnEffectDrag}
                onPointerCancel={cancelEndTurnEffectDrag}
                onLostPointerCapture={cancelEndTurnEffectDrag}
              >
                <img className="item-icon-image" src={relicIconPath(startTurnEffectRelicId)} alt="" />
              </button>
            ) : null}
          </div>
        </section>
      ) : null}

      {evokeTargetSource && evokeTargetOrb ? (
        <section className="end-turn-effects evoke-target-effect" aria-live="polite" aria-label={evokeTargetSource.label}>
          <p className="end-turn-effects__prompt">
            <span className="visually-hidden">
              {evokeTargetSource.label} {(pendingStartEvokeTarget?.index ?? pendingEvokeTarget) + 1}:{' '}
            </span>
            Drag to an enemy
          </p>
          <button
            type="button"
            className="end-turn-effect end-turn-effect--orb"
            aria-label={`Aim ${evokeTargetSource.label}`}
            aria-pressed={armedEndTurnAbilityId === evokeTargetSource.id}
            onClick={() => activateEndTurnEffect(evokeTargetSource)}
            onPointerDown={(event) => onEndTurnEffectPointerDown(evokeTargetSource, event)}
            onPointerMove={onEndTurnEffectPointerMove}
            onPointerUp={finishEndTurnEffectDrag}
            onPointerCancel={cancelEndTurnEffectDrag}
            onLostPointerCapture={cancelEndTurnEffectDrag}
          >
            <span className={`token--orb token--orb-${evokeTargetOrb}`} aria-hidden="true" />
          </button>
        </section>
      ) : null}

      {visibleStartModeShift ? (
        <section className="guardian-mode-choice" role="group" aria-label="Choose Guardian form for this turn">
          {(['attack', 'defense'] as const).map((mode) => (
            <button type="button" className="end-turn-effect guardian-mode-choice__option" key={mode}
              disabled={resolvingStartTurnMode}
              aria-label={`Choose ${mode === 'attack' ? 'Attack' : 'Defense'} Mode`}
              onClick={() => chooseStartTurnMode(mode)}>
              <img src={assetPath(`combat/characters/guardian${mode === 'defense' ? '-defense' : ''}.webp`)} alt="" />
            </button>
          ))}
        </section>
      ) : null}

      {endTurnEffect ? (
        <section className="end-turn-effects" aria-live="polite" aria-label={`End-turn effect: ${endTurnEffect.label}`}>
          <p className="end-turn-effects__prompt">
            {/* The live text must change per effect, or consecutive effects are never announced. */}
            <span className="visually-hidden">{endTurnEffect.label}: </span>
            {canResolveEndTurn
              ? endTurnEffectPrompt
              : `Waiting for ${state.players.find((player) => player.id === endTurnEffect.playerId)?.name ?? 'its owner'}`}
          </p>
          {endTurnEffectCard ? (
            <Card stanceChangedThisTurn={stanceChangedThisTurn}
              className="end-turn-effect end-turn-effect--card"
              card={endTurnEffectCard}
              playable={canResolveEndTurn && endTurnChoiceTargets.length === 0}
              selected={armedEndTurnAbilityId === endTurnEffect.id ||
                (endTurnEffect.orbChoice && endTurnEffectDrag?.targetUid != null)}
              onClick={endTurnChoiceTargets.length === 0 ? () => activateEndTurnEffect(endTurnEffect) : undefined}
              onPointerDown={endTurnChoiceTargets.length === 0 && !endTurnEffect.orbChoice
                ? (event) => onEndTurnEffectPointerDown(endTurnEffect, event) : undefined}
              onPointerMove={endTurnChoiceTargets.length === 0 && !endTurnEffect.orbChoice
                ? onEndTurnEffectPointerMove : undefined}
              onPointerUp={endTurnChoiceTargets.length === 0 && !endTurnEffect.orbChoice
                ? finishEndTurnEffectDrag : undefined}
              onPointerCancel={endTurnChoiceTargets.length === 0 && !endTurnEffect.orbChoice
                ? cancelEndTurnEffectDrag : undefined}
              onLostPointerCapture={endTurnChoiceTargets.length === 0 && !endTurnEffect.orbChoice
                ? cancelEndTurnEffectDrag : undefined}
            />
          ) : (
            <button
              type="button"
              className={`end-turn-effect end-turn-effect--${endTurnEffectSlimeAsset ? 'slime' : 'orb'}`}
              disabled={!canResolveEndTurn}
              aria-label={`Resolve ${endTurnEffect.label}`}
              aria-pressed={armedEndTurnAbilityId === endTurnEffect.id}
              onClick={() => activateEndTurnEffect(endTurnEffect)}
              onPointerDown={(event) => onEndTurnEffectPointerDown(endTurnEffect, event)}
              onPointerMove={onEndTurnEffectPointerMove}
              onPointerUp={finishEndTurnEffectDrag}
              onPointerCancel={cancelEndTurnEffectDrag}
              onLostPointerCapture={cancelEndTurnEffectDrag}
            >
              {endTurnEffectSlimeAsset
                ? <img className="end-turn-effect__slime" src={endTurnEffectSlimeAsset} alt="" />
                : <span className={`token--orb token--orb-${endTurnEffect.visual?.kind === 'orb'
                  ? endTurnEffect.visual.orb
                  : 'lightning'}`} aria-hidden="true" />}
            </button>
          )}
          {endTurnOrbChoices.length > 0 ? (
            <div className="end-turn-effects__orb-choices" role="group" aria-label={`Choose an Orb for ${endTurnEffect.label}`}>
              {endTurnOrbChoices.map(({ orb, target }) => (
                <button className="end-turn-effects__orb-choice" key={orb} type="button"
                  aria-label={`Duplicate ${orb} Orb effect`}
                  onClick={() => resolveTurnEffectTarget(endTurnEffect.id, target.uid)}>
                  <span className={`token--orb token--orb-${orb}`} aria-hidden="true" />
                </button>
              ))}
            </div>
          ) : null}
          {endTurnSelfExhaustOffered ? (
            <div className="end-turn-effects__choices" role="group" aria-label={`Optional cost for ${endTurnEffect.label}`}>
              <button type="button" aria-pressed={endTurnSelfExhaust}
                onClick={() => setEndTurnSelfExhaust((current) => !current)}>
                {endTurnSelfExhaust ? 'Also Exhaust: on' : 'Also Exhaust for Block'}
              </button>
            </div>
          ) : null}
          {endTurnChoiceTargets.length > 0 ? (
            <div className="end-turn-effects__choices" role="group" aria-label={`Resolve ${endTurnEffect.label}`}>
              {endTurnChoiceTargets.map((target) => (
                <button key={target.uid} type="button" onClick={() => resolveTurnEffectTarget(endTurnEffect.id, target.uid)}>
                  {target.label}
                </button>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}
    </>
  )
}

export type CombatInterruptPanelsProps = {
  state: CombatState
  viewer: Player
  stanceChangedThisTurn: boolean | undefined
  enemyButtonOrder: readonly Enemy[]
  dieRelicPending: NonNullable<CombatState['pendingDieRelicChoices']>[number] | undefined
  dieRelicAbility: RelicAbility | undefined
  dieRelicNeedsEnemy: boolean
  dieRelicCardUids: string[]
  setDieRelicCardUids: Dispatch<SetStateAction<string[]>>
  dieRelicEnemyUid: string | null
  setDieRelicEnemyUid: Dispatch<SetStateAction<string | null>>
  dieRelicTargetUid: string | null
  usingDieRelic: boolean
  submitDieRelicChoice: (discard: boolean) => void
  hermitSetupPending: boolean
  hermitSetupOwner: Player | undefined
  hermitTargetedCurses: ReadonlySet<string>
  submitHermitSetup: (card: CardInstance, enemyUid?: string | null) => void
  playerChoiceDialogRef: RefObject<HTMLDialogElement | null>
  viewerPlayerChoice: NonNullable<CombatState['pendingPlayerChoices']>[number] | undefined
  playerChoiceDiscarding: boolean
  setPlayerChoiceDiscarding: Dispatch<SetStateAction<boolean>>
  usingPlayerChoice: boolean
  submitPlayerChoice: (answer: Omit<PlayerChoiceAnswer, 'choiceId'>) => void
  hermitStrengthPending: boolean
  submitHermitStrength: (targetPlayerId: string) => void
  slayerChoice: NonNullable<CombatState['pendingSlayerChoices']>[number] | undefined
  slayerChoiceOwner: Player | undefined
  usingSlayerChoice: boolean
  submitSlayerChoice: (decision: { enemyUid?: string | null; replace?: boolean }) => void
}

export function CombatInterruptPanels({
  state,
  viewer,
  stanceChangedThisTurn,
  enemyButtonOrder,
  dieRelicPending,
  dieRelicAbility,
  dieRelicNeedsEnemy,
  dieRelicCardUids,
  setDieRelicCardUids,
  dieRelicEnemyUid,
  setDieRelicEnemyUid,
  dieRelicTargetUid,
  usingDieRelic,
  submitDieRelicChoice,
  hermitSetupPending,
  hermitSetupOwner,
  hermitTargetedCurses,
  submitHermitSetup,
  playerChoiceDialogRef,
  viewerPlayerChoice,
  playerChoiceDiscarding,
  setPlayerChoiceDiscarding,
  usingPlayerChoice,
  submitPlayerChoice,
  hermitStrengthPending,
  submitHermitStrength,
  slayerChoice,
  slayerChoiceOwner,
  usingSlayerChoice,
  submitSlayerChoice,
}: CombatInterruptPanelsProps) {
  return (
    <>
      {dieRelicPending?.playerId === viewer.id ? (() => {
        const effect = dieRelicAbility?.effects.find((candidate) =>
          candidate.kind === 'discard' || candidate.kind === 'exhaustFromHand')
        const required = effect ? Math.min(effect.amount, viewer.hand.length) : 0
        const discard = effect?.kind === 'discard'
        const optional = dieRelicAbility?.optional === true
        const accepting = !optional || dieRelicCardUids.length > 0
        const needsRetarget = accepting && dieRelicNeedsEnemy &&
          !livingEnemies(state).some((enemy) => enemy.uid === dieRelicPending.enemyUid)
        if (!effect && !needsRetarget) return null
        return <section className="hermit-prompt hermit-prompt--cards" aria-label="Die Relic card choice">
          <strong>{relicDef(dieRelicPending.relicDefId).name}{effect ? <>: {optional ? 'you may ' : ''}
            {discard ? 'discard' : 'Exhaust'} {required}</> : null}</strong>
          {effect ? viewer.hand.map((card) => {
            const selected = dieRelicCardUids.includes(card.uid)
            return <Card stanceChangedThisTurn={stanceChangedThisTurn} key={card.uid} card={card} selected={selected} onClick={() => setDieRelicCardUids((current) =>
              selected ? current.filter((uid) => uid !== card.uid) : current.length < required
                ? [...current, card.uid] : current)} />
          }) : null}
          {needsRetarget ? <div>
            <strong>Choose a new enemy target</strong>
            {enemyButtonOrder.map((enemy) => <button key={enemy.uid} type="button"
              className={dieRelicEnemyUid === enemy.uid ? 'selected' : undefined}
              onClick={() => setDieRelicEnemyUid(enemy.uid)}>{enemyLabel(state.enemies, enemy)}</button>)}
          </div> : null}
          <button type="button" disabled={usingDieRelic || Boolean(effect) && (!optional && dieRelicCardUids.length !== required ||
            optional && dieRelicCardUids.length !== 0 && dieRelicCardUids.length !== required) ||
            accepting && dieRelicNeedsEnemy && !dieRelicTargetUid}
            onClick={() => submitDieRelicChoice(discard)}>
            {optional && dieRelicCardUids.length === 0 ? 'Skip' : `Resolve ${relicDef(dieRelicPending.relicDefId).name}`}
          </button>
        </section>
      })() : null}

      {hermitSetupPending ? <p className="visually-hidden" role="status"
        aria-label="Hermit start-of-combat Load">Choose a card in hand to Load</p> : null}
      {hermitSetupOwner && !hermitSetupPending ? <p className="visually-hidden" role="status">
        Waiting for {hermitSetupOwner.name} to Load a card</p> : null}
      {hermitSetupPending && viewer.hand.some((card) => hermitTargetedCurses.has(card.defId)) &&
      livingEnemies(state).length > 1 ? (
        <section className="prompt" aria-label="Hermit start-of-combat Load target">
          <span>Load a card from your hand, or Load a Curse at:</span>
          {viewer.hand.filter((card) => hermitTargetedCurses.has(card.defId)).map((card) =>
            enemyButtonOrder.map((enemy) => (
              <button key={`${card.uid}-${enemy.uid}`} type="button" className="prompt__mode"
                onClick={() => submitHermitSetup(card, enemy.uid)}>
                {cardDef(card.defId).name} → {enemyLabel(state.enemies, enemy)}
              </button>
            )))}
        </section>
      ) : null}
      <PlayerChoiceDiscardDialog
        dialogRef={playerChoiceDialogRef}
        viewer={viewer}
        viewerPlayerChoice={viewerPlayerChoice}
        playerChoiceDiscarding={playerChoiceDiscarding}
        setPlayerChoiceDiscarding={setPlayerChoiceDiscarding}
        stanceChangedThisTurn={stanceChangedThisTurn}
        usingPlayerChoice={usingPlayerChoice}
        submitPlayerChoice={submitPlayerChoice}
      />
      {hermitStrengthPending ? (
        <section className="prompt" aria-label="Dead or Alive reward">
          <strong>Dead or Alive: choose a player to gain 1 Strength</strong>
          {state.players.filter((player) => !player.dead).map((player) => (
            <button key={player.id} type="button" className="prompt__mode"
              onClick={() => submitHermitStrength(player.id)}>{player.name}</button>
          ))}
        </section>
      ) : null}
      {slayerChoice && slayerChoice.playerId === viewer.id && state.phase !== 'lost' ? (
        slayerChoice.kind === 'reattach' ? (() => {
          const hosts = enemyButtonOrder.filter((enemy) => enemy.uid !== slayerChoice.fromUid)
          const name = faceOf(cardDef(slayerChoice.card.defId), slayerChoice.card.upgraded).name
          return <section className="prompt" aria-label={`${name} target`} data-slayer-choice="reattach">
            <strong>{name}: its enemy died — attach it to another enemy</strong>
            {hosts.map((enemy) => (
              <button key={enemy.uid} type="button" className="prompt__mode" disabled={usingSlayerChoice}
                onClick={() => submitSlayerChoice({ enemyUid: enemy.uid })}>{enemyLabel(state.enemies, enemy)}</button>
            ))}
            {hosts.length === 0 ? <button type="button" className="prompt__mode" disabled={usingSlayerChoice}
              onClick={() => submitSlayerChoice({ enemyUid: null })}>Discard {name}</button> : null}
          </section>
        })() : slayerChoice.revealed ? (
          // A panel over the board: the revealed card at reading size beside its two answers.
          <section className="distilled-choice slayer-reveal" role="dialog" aria-labelledby="slayer-reveal-title"
            data-slayer-choice="ritualDagger">
            <Card stanceChangedThisTurn={stanceChangedThisTurn} card={{ uid: `slayer-reveal-${slayerChoice.cardUid}`, defId: slayerChoice.revealed, upgraded: false }}
              immediateArt accessibleNote="revealed only to you" />
            <div className="slayer-reveal__text">
              <h2 id="slayer-reveal-title">Ritual Dagger+</h2>
              <p>{state.phase === 'won' ? 'Your killing blow won the fight. ' : ''}You reveal {
                cardDef(slayerChoice.revealed).name} from your rare rewards. Only you can see it.</p>
              <div className="item-actions">
                <button type="button" disabled={usingSlayerChoice} onClick={() => submitSlayerChoice({ replace: false })}>
                  Put it on the bottom of your rare deck</button>
                <button type="button" disabled={usingSlayerChoice} onClick={() => submitSlayerChoice({ replace: true })}>
                  Replace Ritual Dagger with it</button>
              </div>
            </div>
          </section>
        ) : null
      ) : null}
      {slayerChoiceOwner && !slayerChoiceOwner.dead && slayerChoiceOwner.id !== viewer.id && state.phase !== 'lost' ? (
        // Nothing on the board glows for someone else's decision, so the wait stays a readable banner.
        <p className="prompt prompt--status" role="status" data-slayer-waiting="">
          Waiting for {slayerChoiceOwner.name} to resolve {
            slayerChoice?.kind === 'ritualDagger' ? 'Ritual Dagger+' : 'Nightmare+'}{
            state.phase === 'won' ? ' before the party moves on' : ''}
        </p>
      ) : null}
    </>
  )
}
