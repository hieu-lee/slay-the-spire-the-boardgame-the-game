import type { Dispatch, RefObject, SetStateAction } from 'react'
import { cardDef, faceOf } from '../../game/cards.ts'
import type { CardDef } from '../../game/cards.ts'
import {
  cardEnemyChoiceCount,
  cardModeIsAvailable,
  effectiveCombatCardDef,
  guardianGemForCard,
  maximumXEnergy,
  metamorphosisCost,
  slimeChoiceIsAvailable,
} from '../../game/combat.ts'
import type {
  CardPlayWindow,
  CombatState,
  PendingTriggerAbility,
  PotionContext,
  PowerContext,
  StartTurnAbility,
} from '../../game/combat.ts'
import type { CardInstance, Player } from '../../game/types.ts'
import { DieRelicChoiceList, dieRelicChoices } from '../DieRelicChoices.tsx'
import { requirementsOf } from './helpers.ts'
import type { Pending, PendingStartChoice } from './types.ts'

export type CombatPromptBarProps = {
  state: CombatState
  viewer: Player
  viewerId: string
  drawCount: number | undefined
  prompt: string | null
  playWindow: CardPlayWindow | undefined
  playWindowPrompt: string | null
  playWindowName: string
  spentShivPending: boolean
  normalEnemyPending: boolean
  usingCard: boolean
  endTurnResolving: boolean
  finishPlayWindow: () => void
  pendingPlunder: NonNullable<CombatState['pendingPlunderSwitches']>[number] | undefined
  submitPlunderRow: (row: number | null) => void
  pendingStartShiv: Extract<PendingStartChoice, { kind: 'shiv' }> | undefined
  canResolveStartTurn: boolean
  chooseStartTurnShiv: (enemyUid: string | null) => void
  pendingTrigger: PendingTriggerAbility | null
  triggerHermitChoicesReady: boolean
  resolveTrigger: (enemyRow?: number, enemyUid?: string, targetPlayerId?: string, slimeEnemyUids?: string[]) => void
  triggerSlimeUids: string[]
  setTriggerSlimeUids: Dispatch<SetStateAction<string[]>>
  setTriggerSlimeEnemyUids: Dispatch<SetStateAction<string[]>>
  triggerSlimeEnemyAmount: number
  pendingHermitPower: boolean
  pendingPowerUid: string | null
  pendingPower: CardInstance | undefined
  pendingPowerDef: CardDef | null
  usePower: (powerUid: string, context: PowerContext) => void
  powerExhaustUids: string[]
  setPowerExhaustUids: Dispatch<SetStateAction<string[]>>
  choosePowerContext: (context: PowerContext) => void
  powerChamberUids: string[]
  setPowerChamberUids: Dispatch<SetStateAction<string[]>>
  powerLoadUids: string[]
  setPowerLoadUids: Dispatch<SetStateAction<string[]>>
  triggerHermitStep: 'cards' | 'board' | 'target'
  setTriggerHermitStep: Dispatch<SetStateAction<'cards' | 'board' | 'target'>>
  triggerHermitReopenRef: RefObject<HTMLButtonElement | null>
  usingTrigger: boolean
  pendingStartPlayer: StartTurnAbility | undefined
  chooseStartTurnPlayer: (playerId: string) => void
  pending: Pending | null
  setPending: Dispatch<SetStateAction<Pending | null>>
  pendingDef: CardDef | null
  pendingEffectiveDef: CardDef | null
  overflowOnly: boolean
  choiceSatisfied: boolean
  commit: (next: Pending, skipOverflow?: boolean) => void
  stageOrCommit: (next: Pending) => void
  hermitDieRelicSelectionsReady: (next: Pending) => boolean
  forcedCardUid: string | null
  chamberChoiceRequired: (next: Pending) => number
  chamberReplacementOptions: (next: Pending) => string[]
  variableMinimum: number
  modeSatisfied: boolean
  onModeClick: (mode: number) => void
  corruptedShardModeNeeded: boolean
  corruptedShardModeSatisfied: boolean
  onCorruptedShardModeClick: (mode: 'attack' | 'defense') => void
  pendingPowerBeamChoiceNeeded: boolean
  pendingPowerBeamCards: readonly CardInstance[]
  pendingPotion: string | null
  pendingPotionOverflow: number
  potionShivEnemyUids: string[]
  consumePotion: (potionId: string, context?: PotionContext, overflow?: { expected: number; skip: boolean }) => void
  switchChoiceReady: boolean
}

export function CombatPromptBar({
  state,
  viewer,
  viewerId,
  drawCount,
  prompt,
  playWindow,
  playWindowPrompt,
  playWindowName,
  spentShivPending,
  normalEnemyPending,
  usingCard,
  endTurnResolving,
  finishPlayWindow,
  pendingPlunder,
  submitPlunderRow,
  pendingStartShiv,
  canResolveStartTurn,
  chooseStartTurnShiv,
  pendingTrigger,
  triggerHermitChoicesReady,
  resolveTrigger,
  triggerSlimeUids,
  setTriggerSlimeUids,
  setTriggerSlimeEnemyUids,
  triggerSlimeEnemyAmount,
  pendingHermitPower,
  pendingPowerUid,
  pendingPower,
  pendingPowerDef,
  usePower,
  powerExhaustUids,
  setPowerExhaustUids,
  choosePowerContext,
  powerChamberUids,
  setPowerChamberUids,
  powerLoadUids,
  setPowerLoadUids,
  triggerHermitStep,
  setTriggerHermitStep,
  triggerHermitReopenRef,
  usingTrigger,
  pendingStartPlayer,
  chooseStartTurnPlayer,
  pending,
  setPending,
  pendingDef,
  pendingEffectiveDef,
  overflowOnly,
  choiceSatisfied,
  commit,
  stageOrCommit,
  hermitDieRelicSelectionsReady,
  forcedCardUid,
  chamberChoiceRequired,
  chamberReplacementOptions,
  variableMinimum,
  modeSatisfied,
  onModeClick,
  corruptedShardModeNeeded,
  corruptedShardModeSatisfied,
  onCorruptedShardModeClick,
  pendingPowerBeamChoiceNeeded,
  pendingPowerBeamCards,
  pendingPotion,
  pendingPotionOverflow,
  potionShivEnemyUids,
  consumePotion,
  switchChoiceReady,
}: CombatPromptBarProps) {
  if (!prompt) return null
  return (
    // Slayer Pack: A card-play window has no glowing piece to point at, so its
    // instruction stays a readable banner even when there is no button.
    <div className={prompt === playWindowPrompt ? 'prompt prompt--status prompt--play-window'
      : spentShivPending && !normalEnemyPending ? 'prompt prompt--status' : 'prompt'}>
      <span className="prompt__text" role="status">{prompt}</span>
      {prompt === playWindowPrompt && playWindow?.optional ? (
        <button type="button" className="prompt__mode" data-play-window-finish
          aria-label={`Done with ${playWindowName}`}
          disabled={usingCard || endTurnResolving} onClick={finishPlayWindow}>
          Done
        </button>
      ) : null}
      {pendingPlunder?.playerId === viewerId ? (
        <>
          <button type="button" className="prompt__mode" onClick={() => submitPlunderRow(null)}>Stay</button>
          {state.players.filter((player) => !player.dead && player.row !== viewer.row).map((player) => (
            <button type="button" className="prompt__mode" key={player.id}
              onClick={() => submitPlunderRow(player.row)}>Switch with {player.name}</button>
          ))}
        </>
      ) : null}
      {pendingStartShiv && canResolveStartTurn ? (
        <button type="button" className="prompt__cancel" aria-label="Skip this Shiv"
          onClick={() => chooseStartTurnShiv(null)}>
          Skip
        </button>
      ) : null}
      {pendingTrigger?.playerId === viewerId && triggerHermitChoicesReady ? pendingTrigger.players?.map((player) => (
        <button type="button" className="prompt__mode" key={player.id}
          onClick={() => resolveTrigger(undefined, undefined, player.id)}>{player.label}</button>
      )) : null}
      {pendingTrigger?.playerId === viewerId && pendingTrigger.slimeChoice ? (
        <span className="hermit-prompt__choice">
          {pendingTrigger.slimeChoice.cards.map((slime) => {
            const selected = triggerSlimeUids.includes(slime.uid)
            return <button type="button" className="prompt__mode" key={slime.uid} aria-pressed={selected}
              onClick={() => {
                setTriggerSlimeUids((current) => selected
                  ? current.filter((uid) => uid !== slime.uid)
                  : [...current, slime.uid].slice(-pendingTrigger.slimeChoice!.amount))
                setTriggerSlimeEnemyUids([])
              }}>{slime.label}</button>
          })}
          {!pendingTrigger.targets && !pendingTrigger.rows && !pendingTrigger.players &&
            triggerSlimeEnemyAmount === 0 ? (
            <button type="button" className="prompt__mode"
              disabled={triggerSlimeUids.length < pendingTrigger.slimeChoice.minimum}
              onClick={() => resolveTrigger()}>
              {triggerSlimeUids.length === 0 ? 'Choose self' : `Confirm ${triggerSlimeUids.length} Slime`}
            </button>
          ) : null}
        </span>
      ) : null}
      {pendingHermitPower && pendingPowerDef?.id === 'hermit_shadow_cloak' ? [...viewer.hand, ...viewer.chamber]
        .filter((card) => faceOf(cardDef(card.defId), card.upgraded).type === 'curse').map((card) => (
          <button type="button" className="prompt__mode" key={card.uid}
            onClick={() => usePower(pendingPowerUid!, { chamberUids: [card.uid] })}>
            Discard {cardDef(card.defId).name}
          </button>
        )) : null}
      {pendingPower?.attachedGemId === 'guardian_jasper' ? (
        <span className="hermit-prompt__choice">
          {viewer.hand.map((card) => {
            const selected = powerExhaustUids.includes(card.uid)
            return <label key={card.uid}>
              <input type="checkbox" checked={selected} disabled={!selected && powerExhaustUids.length >= 3}
                onChange={() => setPowerExhaustUids((current) => selected
                  ? current.filter((uid) => uid !== card.uid)
                  : [...current, card.uid].slice(0, 3))} />
              Exhaust {cardDef(card.defId).name}
            </label>
          })}
          <button type="button" className="prompt__mode"
            onClick={() => choosePowerContext({ exhaustUids: powerExhaustUids })}>
            Confirm {powerExhaustUids.length}
          </button>
        </span>
      ) : null}
      {pendingPower?.attachedGemId === 'guardian_amethyst' ? [false, true].map((shift) => (
        <button type="button" className="prompt__mode" key={String(shift)}
          onClick={() => choosePowerContext({ guardianModeShift: shift })}>
          {shift ? 'Mode Shift' : 'Stay in Mode'}
        </button>
      )) : null}
      {pendingPowerDef?.id === 'guardian_revenge_protocol' ? viewer.hand.filter((card) =>
        effectiveCombatCardDef(faceOf(cardDef(card.defId), card.upgraded), viewer.guardianMode).type === 'attack').map((card) => (
          <button type="button" className="prompt__mode" key={card.uid}
            onClick={() => usePower(pendingPowerUid!, { cardUid: card.uid })}>{cardDef(card.defId).name}</button>
        )) : null}
      {pendingHermitPower && pendingPowerDef?.id === 'hermit_black_wind' && powerChamberUids.length === 0
        ? viewer.chamber.map((card) => (
          <button type="button" className="prompt__mode" key={card.uid}
            onClick={() => setPowerChamberUids([card.uid])}>Discard {cardDef(card.defId).name}</button>
        )) : null}
      {pendingHermitPower && pendingPowerDef?.id === 'hermit_black_wind' && powerChamberUids.length === 1 &&
      powerLoadUids.length === 0 ? viewer.hand.map((card) => (
          <button type="button" className="prompt__mode" key={card.uid} onClick={() => {
            if (['hermit_grudge', 'hermit_malice', 'hermit_horror'].includes(card.defId)) {
              setPowerLoadUids([card.uid])
            } else {
              usePower(pendingPowerUid!, { chamberUids: powerChamberUids, loadUids: [card.uid] })
              setPowerChamberUids([])
            }
          }}>Load {cardDef(card.defId).name}</button>
        )) : null}
      {pendingTrigger?.playerId === viewerId && pendingTrigger.hermitChoices && triggerHermitStep !== 'cards' ? (
        <button type="button" className="prompt__mode" ref={triggerHermitReopenRef} disabled={usingTrigger}
          onClick={() => setTriggerHermitStep('cards')}>
          {triggerHermitStep === 'target' ? 'Change cards' : 'Choose cards'}
        </button>
      ) : null}
      {!pendingStartPlayer?.visual ? pendingStartPlayer?.players?.map((player) => (
        <button type="button" className="prompt__mode" key={player.id}
          onClick={() => chooseStartTurnPlayer(player.id)}>{player.label}</button>
      )) : null}
      {pending && overflowOnly && choiceSatisfied ? (
        <button type="button" className="prompt__cancel" onClick={() => commit(pending, true)}>
          Skip remaining overflow attacks
        </button>
      ) : null}
      {pending && pendingDef?.id === 'slayer_metamorphosis' && pending.metamorphosisPowerUid === undefined
        ? viewer.powers.flatMap((power) => {
          // X is fixed by the copied Power. A fixed cost (play window, free or forced play)
          // is the X the card is played for, so only Powers requiring exactly that are offered.
          const required = metamorphosisCost(viewer, power.uid, pending.card.upgraded) ?? 0
          const fixed = pending.energySpent === null ? undefined : pending.energyCharged ?? 0
          if (fixed !== undefined && required !== fixed) return []
          const energy = fixed === undefined ? required : pending.energySpent ?? 0
          const copied = faceOf(cardDef(power.defId), power.upgraded)
          return [(
            <button type="button" className="prompt__mode" key={power.uid}
              disabled={fixed === undefined && energy > viewer.energy}
              aria-label={`Attach to ${copied.name}${fixed === undefined ? `, spend ${energy} Energy` : ''}`}
              onClick={() => stageOrCommit(fixed === undefined ? {
                ...pending,
                energySpent: energy,
                effectEnergy: energy,
                energyCharged: pending.cardInHand || pending.chamberPlay ? energy : 0,
                metamorphosisPowerUid: power.uid,
              } : { ...pending, metamorphosisPowerUid: power.uid })}>
              {copied.name}{fixed === undefined ? ` (X=${energy})` : ''}
            </button>
          )]
        })
        : pendingDef?.cost === 'X' && pending?.energySpent === null
        ? Array.from({ length: Math.max(0,
          maximumXEnergy(pendingDef, viewer) - (pendingDef.minimumX ?? 0) + 1) }, (_, at) => {
          const energy = at + (pendingDef.minimumX ?? 0)
          return (
            <button type="button" className="prompt__mode" key={energy}
              onClick={() => stageOrCommit({
                ...pending,
                ...requirementsOf(
                  pendingEffectiveDef!, state.players.filter((player) => !player.dead).length, viewer, state,
                  energy, pending.cardInHand || pending.chamberPlay, pending.card.hermitDeadOn === true,
                  pending.choiceCards?.length, guardianGemForCard(viewer, pending.card), pending.card.uid,
                  pending.cardInHand || pending.chamberPlay ? energy : 0,
                ),
                energySpent: energy,
                effectEnergy: energy,
                energyCharged: pending.cardInHand || pending.chamberPlay ? energy : 0,
                slimeUids: [],
                slimeChoiceConfirmed: false,
                slimeEnemyUids: [],
              })}>
              Spend {energy}
            </button>
          )
        })
        : null}
      {pending?.spendVigor === null ? Array.from({ length: viewer.vigor + 1 }, (_, amount) => (
        <button type="button" className="prompt__mode" key={`vigor-${amount}`}
          onClick={() => stageOrCommit({ ...pending, spendVigor: amount })}>
          Spend {amount} Vigor
        </button>
      )) : null}
      {pending?.guardianModeShift === null ? [false, true].map((shift) => (
        <button type="button" className="prompt__mode" key={`mode-shift-${shift}`}
          onClick={() => stageOrCommit({ ...pending, guardianModeShift: shift })}>
          {shift ? 'Shift Mode' : 'Keep Mode'}
        </button>
      )) : null}
      {pending?.secondGuardianModeShift === null ? [false, true].map((shift) => (
        <button type="button" className="prompt__mode" key={`second-${shift}`}
          onClick={() => stageOrCommit({ ...pending, secondGuardianModeShift: shift })}>
          Second Gem: {shift ? 'Mode Shift' : 'Stay in Mode'}
        </button>
      )) : null}
      {pending?.guardianBlockSpend === null ? Array.from({ length: viewer.block + 1 }, (_, amount) => (
        <button type="button" className="prompt__mode" key={`block-spend-${amount}`}
          onClick={() => stageOrCommit({ ...pending, guardianBlockSpend: amount })}>
          Spend {amount} Block
        </button>
      )) : null}
      {pending?.chooseLoadSelf === null ? [false, true].map((load) => (
        <button type="button" className="prompt__mode" key={`load-self-${load}`}
          onClick={() => stageOrCommit({ ...pending, chooseLoadSelf: load, chamberChoiceConfirmed: false })}>
          {load ? 'Load this card' : 'Do not Load'}
        </button>
      )) : null}
      {pending?.hermitDieRelicChoice && !pending.hermitDieRelicChoiceConfirmed ? (
        <>
          <DieRelicChoiceList state={state} choices={dieRelicChoices(state, { needsEnemyForAll: true })}
            pressed={(choice) => pending.hermitDieRelics.some((selected) =>
              selected.playerId === choice.owner.id && selected.relicIndex === choice.relicIndex &&
              selected.abilityIndex === choice.abilityIndex && selected.enemyUid === choice.enemy?.uid &&
              selected.targetPlayerId === choice.targetPlayer?.id)}
            onChoose={(picked) => {
              const choice = {
                playerId: picked.owner.id,
                relicIndex: picked.relicIndex,
                abilityIndex: picked.abilityIndex,
                enemyUid: picked.enemy?.uid,
                targetPlayerId: picked.targetPlayer?.id,
              }
              const sameRelic = pending.hermitDieRelics.findIndex((selected) =>
                selected.playerId === choice.playerId && selected.relicIndex === choice.relicIndex)
              const selected = sameRelic >= 0 &&
                pending.hermitDieRelics[sameRelic]!.abilityIndex === choice.abilityIndex &&
                pending.hermitDieRelics[sameRelic]!.enemyUid === choice.enemyUid &&
                pending.hermitDieRelics[sameRelic]!.targetPlayerId === choice.targetPlayerId
              const hermitDieRelics = selected
                ? pending.hermitDieRelics.filter((_, index) => index !== sameRelic)
                : sameRelic >= 0
                  ? pending.hermitDieRelics.map((current, index) => index === sameRelic ? choice : current)
                  : pending.hermitDieRelics.length < pending.hermitDieRelicChoice!.amount
                    ? [...pending.hermitDieRelics, choice] : pending.hermitDieRelics
              const exact = pending.hermitDieRelicChoice!.minimum === pending.hermitDieRelicChoice!.amount &&
                hermitDieRelics.length === pending.hermitDieRelicChoice!.amount
              const next = { ...pending, hermitDieRelics, hermitDieRelicChoiceConfirmed: false }
              if (exact && hermitDieRelicSelectionsReady(next)) {
                stageOrCommit({ ...next, hermitDieRelicChoiceConfirmed: true })
              }
              else setPending(next)
            }} />
          {pending.hermitDieRelicChoice.minimum !== pending.hermitDieRelicChoice.amount ? (
            <button type="button" className="prompt__mode"
              disabled={pending.hermitDieRelics.length < pending.hermitDieRelicChoice.minimum ||
                !hermitDieRelicSelectionsReady(pending)}
              onClick={() => stageOrCommit({ ...pending, hermitDieRelicChoiceConfirmed: true })}>
              Trigger {pending.hermitDieRelics.length || 'none'}
            </button>
          ) : null}
        </>
      ) : null}
      {pending?.slimeChoice && !pending.slimeChoiceConfirmed &&
      (pendingDef?.cost !== 'X' || pending.energySpent !== null) ? (
        <>
          {(viewer.slimes ?? []).map((slime) => {
            const selected = pending.slimeUids.includes(slime.card.uid)
            const available = !pending.cardInHand && !pending.chamberPlay ||
              forcedCardUid === pending.card.uid || Boolean(
              pendingDef && slimeChoiceIsAvailable(
                pendingDef, state, viewer, slime.card.uid, pending.effectEnergy ?? 0,
              ),
            )
            return <button type="button" className="prompt__mode" key={slime.card.uid} aria-pressed={selected}
              disabled={!available}
              onClick={() => {
                if (!available) return
                const slimeUids = selected ? pending.slimeUids.filter((uid) => uid !== slime.card.uid)
                  : pending.slimeUids.length < pending.slimeChoice!.amount
                    ? [...pending.slimeUids, slime.card.uid] : pending.slimeUids
                const exact = pending.slimeChoice!.minimum === pending.slimeChoice!.amount &&
                  slimeUids.length === pending.slimeChoice!.amount
                const next = { ...pending, slimeUids, slimeChoiceConfirmed: exact, slimeEnemyUids: [] }
                if (exact) stageOrCommit(next)
                else setPending(next)
              }}>{cardDef(slime.card.defId).name} · level {slime.level}</button>
          })}
          {pending.slimeChoice.minimum !== pending.slimeChoice.amount ? (
            <button type="button" className="prompt__mode"
              disabled={pending.slimeUids.length < pending.slimeChoice.minimum}
              onClick={() => stageOrCommit({ ...pending, slimeChoiceConfirmed: true })}>
              Confirm {pending.slimeUids.length}
            </button>
          ) : null}
        </>
      ) : null}
      {pending?.chamberChoice && chamberChoiceRequired(pending) > 0 && !pending.chamberChoiceConfirmed ? (
        <>
          {(() => {
            const choice = pending.chamberChoice!
            const required = chamberChoiceRequired(pending)
            const baseAmount = Math.min(choice.baseAmount ?? required, required)
            const choosingBase = pending.chamberUids.length < baseAmount
            const candidateUids = choice.baseAmount === undefined || choosingBase
              ? choice.eligibleUids
              : chamberReplacementOptions(pending)
            return candidateUids.map((uid) => {
            const card = [...viewer.chamber, ...(pending.choiceCards ?? []), pending.card]
              .find((candidate) => candidate.uid === uid)
            const selected = choosingBase && pending.chamberUids.includes(uid)
            return <button type="button" className="prompt__mode" key={uid} aria-pressed={selected}
              onClick={() => {
                const chamberUids = choice.baseAmount === undefined || choosingBase
                  ? selected ? pending.chamberUids.filter((heldUid) => heldUid !== uid)
                    : pending.chamberUids.length < required ? [...pending.chamberUids, uid] : pending.chamberUids
                  : [...pending.chamberUids, uid]
                const exact = chamberUids.length === chamberChoiceRequired(pending)
                const next = { ...pending, chamberUids, chamberChoiceConfirmed: exact }
                if (exact) stageOrCommit(next)
                else setPending(next)
              }}>{card ? cardDef(card.defId).name : 'Loaded card'}</button>
            })
          })()}
          {pending.chamberChoice.baseAmount !== undefined &&
          pending.chamberUids.length > pending.chamberChoice.baseAmount ? (
            <button type="button" className="prompt__cancel" onClick={() => setPending({
              ...pending,
              chamberUids: pending.chamberUids.slice(0, -1),
              chamberChoiceConfirmed: false,
            })}>Undo replacement</button>
          ) : null}
          {pending.chamberChoice.baseAmount === undefined &&
          pending.chamberChoice.minimum !== pending.chamberChoice.amount ? (
            <button type="button" className="prompt__mode"
              disabled={pending.chamberUids.length < pending.chamberChoice.minimum}
              onClick={() => stageOrCommit({ ...pending, chamberChoiceConfirmed: true })}>
              Confirm {pending.chamberUids.length}
            </button>
          ) : null}
        </>
      ) : null}
      {(pending?.choice?.kind === 'discardAny' || pending?.choice?.kind === 'exhaustAny' ||
        pending?.choice?.kind === 'loadAny' || pending?.choice?.kind === 'bottomdeck') && !pending.choiceConfirmed &&
        !pending.choiceCards ? (
        <button type="button" className="prompt__mode"
          disabled={pending.picked.length < variableMinimum}
          onClick={() => stageOrCommit({ ...pending, choiceConfirmed: true })}>
          {pending.choice.kind === 'bottomdeck'
            ? pending.picked.length === 0 ? 'Put none back' : `Put ${pending.picked.length} on the bottom`
            : pending.picked.length === 0
            ? `${pending.choice.kind === 'discardAny' ? 'Discard' : pending.choice.kind === 'loadAny' ? 'Load' : 'Exhaust'} none`
            : `${pending.choice.kind === 'discardAny' ? 'Discard' : pending.choice.kind === 'loadAny' ? 'Load' : 'Exhaust'} ${pending.picked.length}`}
        </button>
      ) : null}
      {pendingDef?.modes && !modeSatisfied ? pendingDef.modes.map((mode, index) => (
        <button type="button" className="prompt__mode" key={mode.label}
          disabled={!cardModeIsAvailable(pendingDef, state, viewer, index, drawCount,
            pending!.cardInHand || pending!.chamberPlay ? pending!.card.uid : undefined) ||
            (mode.effects.some((effect) => effect.kind === 'hitChoices' && effect.distinct) &&
              cardEnemyChoiceCount(pendingDef, index, state, viewer) > state.enemies.filter((enemy) => !enemy.dead).length)}
          onClick={() => onModeClick(index)}>
          {mode.label}
        </button>
      )) : null}
      {corruptedShardModeNeeded && !corruptedShardModeSatisfied ? (['attack', 'defense'] as const).map((mode) => (
        <button type="button" className="prompt__mode" key={mode}
          onClick={() => onCorruptedShardModeClick(mode)}>
          Enter {mode === 'attack' ? 'Attack' : 'Defense'} Mode
        </button>
      )) : null}
      {pendingPowerBeamChoiceNeeded && pending?.guardianPowerCardUid === null
        ? pendingPowerBeamCards.map((card) => (
          <button type="button" className="prompt__mode" key={card.uid}
            onClick={() => stageOrCommit({ ...pending, guardianPowerCardUid: card.uid })}>
            Play {cardDef(card.defId).name} for 0
          </button>
        ))
        : null}
      {pendingPotion && pendingPotionOverflow > 0 ? (
        <button
          type="button"
          className="prompt__cancel"
          onClick={() => consumePotion(
            pendingPotion,
            { shivEnemyUids: potionShivEnemyUids },
            { expected: pendingPotionOverflow, skip: true },
          )}
        >
          Skip remaining overflow attacks
        </button>
      ) : null}
      {pendingPotion === 'gamblers_brew' ? Array.from({ length: 6 }, (_, index) => (
        <button type="button" className="prompt__mode" key={index + 1}
          onClick={() => consumePotion(pendingPotion, { die: index + 1 })}>
          {index + 1}
        </button>
      )) : null}
      {pending && switchChoiceReady ? (
        <button type="button" className="prompt__cancel"
          onClick={() => stageOrCommit({ ...pending, switchPlayerId: null, switchChoiceDone: true })}>
          Keep rows
        </button>
      ) : null}
    </div>
  )
}
