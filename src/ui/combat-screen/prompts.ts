// Pure prompt-string derivations for every combat interaction state.
import { cardDef, type CardDef } from '../../game/cards.ts'
import {
  livingEnemies,
  type activeCardPlayWindow,
  type CombatState,
  type PendingTriggerAbility,
  type StartTurnAbility,
} from '../../game/combat.ts'
import type { PotionDef } from '../../game/relics.ts'
import type { CardInstance, Player } from '../../game/types.ts'
import type { Pending } from './types.ts'

export function enemyPrompt({
  state,
  pending,
  pendingDef,
  normalEnemyPending,
  independentEnemyPending,
  independentHitPending,
  adjacentPickUids,
  spentShivPending,
  overflowOnly,
  pendingShivProgress,
  originalTarget,
  copyTarget,
  rowHitSuffix,
}: {
  state: CombatState
  pending: Pending | null
  pendingDef: CardDef | null
  normalEnemyPending: boolean
  independentEnemyPending: boolean
  independentHitPending: boolean
  adjacentPickUids: Set<string> | null
  spentShivPending: boolean
  overflowOnly: boolean
  pendingShivProgress: { options: readonly { uid: string }[] } | null | undefined
  originalTarget: string
  copyTarget: string
  rowHitSuffix: string
}): string {
  const normalEnemyPrompt = pending?.hitsRow
    ? `Choose an enemy${originalTarget || copyTarget} — its whole row is hit${rowHitSuffix}`
    : pendingDef?.bossTargetCost !== undefined && pending?.cardInHand && state.enemies.some((enemy) => enemy.isBoss && !enemy.dead)
      ? `Choose an enemy${copyTarget} — ${pendingDef.name} costs ${pendingDef.bossTargetCost} Energy on a Boss`
      : `Choose an enemy${originalTarget || copyTarget}`
  return normalEnemyPending
    ? normalEnemyPrompt
    : independentEnemyPending && adjacentPickUids
      ? `${pendingDef?.name} — choose adjacent enemy ${(pending?.enemyUids.length ?? 0) + 1}/${pending?.enemyChoices} for its damage`
    : independentEnemyPending
      ? `Choose ${independentHitPending ? 'damage' : 'token'} target ${(pending?.enemyUids.length ?? 0) + 1}/${pending?.enemyChoices}`
    : spentShivPending
      ? `Choose Shiv attack ${(pending?.shivEnemyUids.length ?? 0) + 1}/${pending?.spentShivs}${
        pendingShivProgress && pendingShivProgress.options.length < livingEnemies(state).length
          ? ' — choose a surviving enemy' : ''}`
    : overflowOnly
    ? `Choose overflow Shiv target ${(pending?.shivEnemyUids.length ?? 0) - (pending?.spentShivs ?? 0) + 1}/${pending?.overflowShivs}, or skip the rest`
    : normalEnemyPrompt
}

export function startTurnPrompt({
  state,
  pendingStartExhaust,
  pendingStartShiv,
  pendingStartEnemy,
  pendingStartPlayer,
  pendingStartEvokeTarget,
  pendingStartEvokeRows,
  pendingStartEvoke,
  teammateStartExhaust,
  rowHitSuffix,
}: {
  state: CombatState
  pendingStartExhaust: StartTurnAbility | undefined
  pendingStartShiv: { ability: StartTurnAbility; index: number } | undefined
  pendingStartEnemy: StartTurnAbility | undefined
  pendingStartPlayer: StartTurnAbility | undefined
  pendingStartEvokeTarget: { ability: StartTurnAbility; index: number } | undefined
  pendingStartEvokeRows: readonly { row: number; uid: string }[]
  pendingStartEvoke: StartTurnAbility | undefined
  teammateStartExhaust: StartTurnAbility | undefined
  rowHitSuffix: string
}): string | null {
  return pendingStartExhaust
    ? `${pendingStartExhaust.label} — choose a card to Exhaust`
    : pendingStartShiv
      ? `${pendingStartShiv.ability.label} — throw Shiv ${pendingStartShiv.index + 1}/${pendingStartShiv.ability.overflowShivs}`
      : pendingStartEnemy
      ? `${pendingStartEnemy.label} — choose an enemy`
    : pendingStartPlayer
      ? `${pendingStartPlayer.label} — choose a player`
    : pendingStartEvokeTarget
      ? `${pendingStartEvokeTarget.ability.label} — choose ${pendingStartEvokeRows.length > 0
        ? `an enemy for the Evoked Orb — its whole row is hit${rowHitSuffix}` : 'a target for the Evoked Orb'}`
    : pendingStartEvoke?.evokeChoice
      ? `${pendingStartEvoke.label} — choose an Orb to Evoke (${pendingStartEvoke.evokeChoice.index + 1})`
    : teammateStartExhaust
      ? `Waiting for ${state.players.find((player) => player.id === teammateStartExhaust.playerId)?.name ??
        'a teammate'} to choose a card to Exhaust`
    : null
}

export function forcedPrompt(
  state: CombatState,
  viewerId: string,
  forcedCard: NonNullable<CombatState['startTurnProgress']>['forcedCard'],
  pending: Pending | null,
): string | null {
  const forcedSource = forcedCard?.sourceLabel ?? (forcedCard
    ? cardDef(forcedCard.sourceCardId ?? 'mayhem').name
    : '')
  return forcedCard && !pending
    ? forcedCard.playerId === viewerId
      ? `${forcedSource} — play the drawn card for 0 Energy`
      : `Waiting for ${state.players.find((player) => player.id === forcedCard.playerId)?.name ?? 'another player'} to play ${forcedSource}'s card`
    : null
}

export function plunderPrompt(
  state: CombatState,
  viewerId: string,
  pendingPlunder: NonNullable<CombatState['pendingPlunderSwitches']>[number] | undefined,
): string | null {
  return pendingPlunder
    ? pendingPlunder.playerId === viewerId
      ? 'Plunder — switch rows or stay where you are'
      : `Waiting for ${state.players.find((player) => player.id === pendingPlunder.playerId)?.name ?? 'another player'} to finish Plunder`
    : null
}

export function playerChoicePrompt(
  state: CombatState,
  waitingPlayerChoice: { playerId: string; sourceLabel: string } | undefined,
): string | null {
  return waitingPlayerChoice
    ? `Waiting for ${state.players.find((player) => player.id === waitingPlayerChoice.playerId)?.name ?? 'another player'} — ${waitingPlayerChoice.sourceLabel}`
    : null
}

export function dieRelicPrompt(
  state: CombatState,
  viewerId: string,
  dieRelicPending: NonNullable<CombatState['pendingDieRelicChoices']>[number] | undefined,
): string | null {
  return dieRelicPending
    ? dieRelicPending.playerId === viewerId
      ? `${dieRelicPending.sourceLabel} — finish the chosen die Relic`
      : `Waiting for ${state.players.find((player) => player.id === dieRelicPending.playerId)?.name ?? 'another player'} to finish a die Relic`
    : null
}

export function triggerPrompt({
  state,
  viewerId,
  pendingTrigger,
  triggerHermitChoicesReady,
  triggerSlimeChoicesReady,
  triggerSlimeEnemyUids,
  triggerSlimeEnemyAmount,
  triggerSlimeEnemyLabels,
  triggerHermitCurse,
  rowHitSuffix,
}: {
  state: CombatState
  viewerId: string
  pendingTrigger: PendingTriggerAbility | null | undefined
  triggerHermitChoicesReady: boolean
  triggerSlimeChoicesReady: boolean
  triggerSlimeEnemyUids: readonly string[]
  triggerSlimeEnemyAmount: number
  triggerSlimeEnemyLabels: readonly string[]
  triggerHermitCurse: CardInstance | undefined
  rowHitSuffix: string
}): string | null {
  return pendingTrigger
    ? pendingTrigger.playerId === viewerId
      ? `${pendingTrigger.label} — choose ${pendingTrigger.hermitChoices && !triggerHermitChoicesReady
        ? 'cards' : pendingTrigger.slimeChoice && !triggerSlimeChoicesReady ? 'Slime or self' :
        triggerSlimeEnemyUids.length < triggerSlimeEnemyAmount
          ? `${triggerSlimeEnemyLabels[triggerSlimeEnemyUids.length] ?? 'Slime'} Command target ${triggerSlimeEnemyUids.length + 1}/${triggerSlimeEnemyAmount}` :
        pendingTrigger.targets ? triggerHermitCurse ? `an enemy for ${cardDef(triggerHermitCurse.defId).name}` : 'an enemy'
          : pendingTrigger.players ? 'a player' :
        pendingTrigger.hermitChoices ? 'cards' : pendingTrigger.slimeChoice ? 'Slime or self' :
          `an enemy — its whole row is hit${rowHitSuffix}`}`
      : `Waiting for ${state.players.find((player) => player.id === pendingTrigger.playerId)?.name ?? 'another player'} to resolve ${pendingTrigger.label}`
    : null
}

export function beforeDrawPrompt(
  state: CombatState,
  viewerId: string,
  activeStartTurnScry: { playerId: string } | null | undefined,
): string | null {
  return activeStartTurnScry && activeStartTurnScry.playerId !== viewerId
    ? `Waiting for ${state.players.find((player) => player.id === activeStartTurnScry.playerId)?.name ?? 'another player'} to Scry before drawing`
    : null
}

export function playWindowPrompt(
  state: CombatState,
  playWindow: ReturnType<typeof activeCardPlayWindow>,
): string | null {
  const playWindowName = playWindow ? cardDef(playWindow.sourceCardId).name : ''
  return playWindow && state.phase === 'player'
    ? `${playWindowName}: play ${playWindow.plays === 1 ? 'one offered card'
      : playWindow.optional ? 'any offered cards' : 'every offered card'
    } for ${playWindow.cost} Energy${playWindow.plays === 1 ? '' : ' each'}`
    : null
}

export function prompt({
  viewer,
  dieRelic,
  plunder,
  trigger,
  forced,
  beforeDraw,
  startTurn,
  playWindow,
  enemy,
  rowHitSuffix,
  pendingPower,
  pendingPowerDef,
  powerScryConfirmed,
  pendingPowerNeedsAlly,
  powerChamberUids,
  powerLoadUids,
  creativeAiEffect,
  pendingPotion,
  pendingPotionDef,
  pendingPotionOverflow,
  pendingPotionNeedsEnemy,
  potionCardUids,
  potionShivEnemyUids,
  viewerHasSozu,
  spendingShiv,
  spendingSoulburn,
  pending,
  pendingDef,
  slimeEnemyChoicesRequired,
  slimeEnemyChoiceLabels,
  chamberChoiceRequired,
  loadedTargetCount,
  modeSatisfied,
  corruptedShardModeNeeded,
  corruptedShardModeSatisfied,
  pendingPowerBeamChoiceNeeded,
  choiceNeeded,
  choicePoolSize,
  pendingSearchKind,
  handChoiceSatisfied,
  pendingEvokeTarget,
  pendingEvokeUsesRows,
  pendingEvokeChoice,
  enemyChoicesDone,
  independentPlayerPending,
  switchChoiceReady,
}: {
  viewer: Player
  dieRelic: string | null
  plunder: string | null
  trigger: string | null
  forced: string | null
  beforeDraw: string | null
  startTurn: string | null
  playWindow: string | null
  enemy: string
  rowHitSuffix: string
  pendingPower: CardInstance | undefined
  pendingPowerDef: CardDef | null
  powerScryConfirmed: boolean
  pendingPowerNeedsAlly: boolean
  powerChamberUids: readonly string[]
  powerLoadUids: readonly string[]
  creativeAiEffect: { anyNumber?: boolean } | undefined
  pendingPotion: string | null
  pendingPotionDef: PotionDef | null
  pendingPotionOverflow: number
  pendingPotionNeedsEnemy: boolean
  potionCardUids: readonly string[]
  potionShivEnemyUids: readonly string[]
  viewerHasSozu: boolean
  spendingShiv: boolean
  spendingSoulburn: boolean
  pending: Pending | null
  pendingDef: CardDef | null
  slimeEnemyChoicesRequired: (pending: Pending) => number
  slimeEnemyChoiceLabels: (pending: Pending) => string[]
  chamberChoiceRequired: (pending: Pending) => number
  loadedTargetCount: (pending: Pending) => number
  modeSatisfied: boolean
  corruptedShardModeNeeded: boolean
  corruptedShardModeSatisfied: boolean
  pendingPowerBeamChoiceNeeded: boolean
  choiceNeeded: number
  choicePoolSize: number
  pendingSearchKind: { kind: 'overexert' | 'replicateSlime' } | undefined
  handChoiceSatisfied: boolean
  pendingEvokeTarget: number
  pendingEvokeUsesRows: boolean
  pendingEvokeChoice: { index: number } | null | undefined
  enemyChoicesDone: boolean
  independentPlayerPending: boolean
  switchChoiceReady: boolean
}): string | null {
  return dieRelic ?? plunder ?? trigger ?? forced ?? beforeDraw ?? startTurn ?? (pendingPowerDef
    ? pendingPowerDef.id === 'guardian_gem_finder'
      ? powerScryConfirmed
        ? pendingPower?.attachedGemId === 'guardian_jasper' ? 'Jasper — Exhaust up to 3 cards'
          : pendingPower?.attachedGemId === 'guardian_amethyst' ? 'Amethyst — choose whether to Mode Shift'
            : pendingPowerNeedsAlly ? 'Gem Finder — Scry confirmed; choose a player'
              : 'Gem Finder — Scry confirmed; choose an enemy'
        : 'Gem Finder — choose cards to discard from the private Scry'
      : pendingPowerDef.id === 'guardian_revenge_protocol'
        ? 'Revenge Protocol — choose an Attack in hand'
      : pendingPowerDef.id === 'hermit_shadow_cloak'
      ? 'Shadow Cloak — choose a Curse to discard from hand or Chamber'
      : pendingPowerDef.id === 'hermit_black_wind'
        ? powerChamberUids.length === 0 ? 'Black Wind — choose a Chamber card to discard'
          : powerLoadUids.length === 0 ? 'Black Wind — choose a card to Load'
            : 'Black Wind — choose an enemy for the loaded Curse'
      : pendingPower?.attachedGemId === 'guardian_jasper'
        ? 'Jasper — Exhaust up to 3 cards'
      : pendingPower?.attachedGemId === 'guardian_onyx' && pendingPowerNeedsAlly
        ? 'Onyx — choose a player'
      : pendingPower?.attachedGemId === 'guardian_amethyst'
        ? 'Amethyst — choose whether to Mode Shift'
      : creativeAiEffect
        ? creativeAiEffect.anyNumber
          ? `${pendingPowerDef.name} — choose Orbs to remove (up to ${Math.min(
            viewer.discard.length, viewer.orbs.filter((orb) => orb != null).length)})`
          : `${pendingPowerDef.name} — choose an Orb to remove`
      : pendingPowerDef.target === 'row'
        ? `Choose an enemy for ${pendingPowerDef.name} — its whole row is hit${rowHitSuffix}`
        : `Choose an enemy for ${pendingPowerDef.name}`
    : pendingPotion === 'gamblers_brew'
      ? "Gambler's Brew — choose the shared die face"
    : pendingPotion === 'liquid_memories'
      ? 'Liquid Memories — choose a card from your discard pile'
    : pendingPotion === 'liquid_void'
      ? 'Liquid Void — choose a card from your Exhaust pile'
    : pendingPotion === 'transforming_brew'
      ? 'Transforming Brew — choose a non-Curse card in your hand'
    : pendingPotion === 'destiny_draught'
      ? 'Destiny Draught — choose any die relic ability'
    : pendingPotion === 'purity_potion'
      ? `Purity — choose up to 3 cards to Exhaust (${potionCardUids.length}/3)`
    : pendingPotion === 'entropic_brew' && !viewerHasSozu
      ? 'Entropic Brew — choose a held Potion to replace'
    : pendingPotionDef
    ? pendingPotionDef.target === 'row'
      ? `Choose an enemy for ${pendingPotionDef.name} — its whole row is hit${rowHitSuffix}`
      : pendingPotionOverflow > 0
        ? `Choose overflow Shiv target ${potionShivEnemyUids.length + 1}/${pendingPotionOverflow}, or skip the rest`
        : `Choose ${pendingPotionNeedsEnemy ? 'an enemy' : 'a player'} for ${pendingPotionDef.name}`
    : spendingShiv
    ? 'Choose an enemy for the Shiv'
    : spendingSoulburn
    ? 'Choose an enemy for Soulburn'
    : (pending?.choice?.kind === 'load' || pending?.choice?.kind === 'loadAny') && !pending.choiceConfirmed
      ? `${pendingDef?.name ?? 'Card'} — choose ${pending.choice.kind === 'loadAny' ? 'up to ' : ''}${pending.choice.amount} card${pending.choice.amount === 1 ? '' : 's'} to Load`
    : pending?.slimeChoice && !pending.slimeChoiceConfirmed &&
      (pendingDef?.cost !== 'X' || pending.energySpent !== null)
      ? `Choose ${pending.slimeChoice.minimum === pending.slimeChoice.amount ? '' : 'up to '}${pending.slimeChoice.amount} Slime${pending.slimeChoice.amount === 1 ? '' : 's'}`
    : pending && pending.slimeEnemyUids.length < slimeEnemyChoicesRequired(pending)
      ? `Choose ${slimeEnemyChoiceLabels(pending)[pending.slimeEnemyUids.length] ?? 'Slime'} Command target ${pending.slimeEnemyUids.length + 1}/${slimeEnemyChoicesRequired(pending)}`
    : pending?.hermitDieRelicChoice && !pending.hermitDieRelicChoiceConfirmed
      ? `Cheat — trigger ${pending.hermitDieRelicChoice.minimum === pending.hermitDieRelicChoice.amount ? '' : 'up to '}${pending.hermitDieRelicChoice.amount} different die relic${pending.hermitDieRelicChoice.amount === 1 ? '' : 's'}`
    : pending?.chamberChoice && chamberChoiceRequired(pending) > 0 && !pending.chamberChoiceConfirmed
      ? `Choose ${chamberChoiceRequired(pending)} Chamber card${chamberChoiceRequired(pending) === 1 ? '' : 's'} to ${pending.chamberChoice.kind}`
    : pending?.chooseLoadSelf === null
      ? `Load ${pendingDef?.name ?? 'this card'} after playing it?`
    : pending?.spendVigor === null
      ? `Choose Vigor to spend on ${pendingDef?.name ?? 'this card'}`
    : pending?.guardianModeShift === null
      ? `Shift Guardian Mode with ${pendingDef?.name ?? 'this card'}?`
    : pending?.guardianBlockSpend === null
      ? `Choose Block to spend with ${pendingDef?.name ?? 'Body Crash'}`
    : pending && pending.hermitEnemyUids.length < loadedTargetCount(pending)
      ? `Choose enemy for loaded Curse ${pending.hermitEnemyUids.length + 1}/${loadedTargetCount(pending)}`
    : pending && pending.soulburnEnemyUids.length < pending.soulburnChoices
      ? `Choose Soulburn target ${pending.soulburnEnemyUids.length + 1}/${pending.soulburnChoices}`
    : pendingDef?.id === 'slayer_metamorphosis' && pending?.metamorphosisPowerUid === undefined
      ? `${pendingDef.name} — choose one of your Powers to attach to and copy`
    : pendingDef?.cost === 'X' && pending?.energySpent === null
      ? `Choose Energy for ${pendingDef.name}`
    : pendingDef?.modes && !modeSatisfied
      ? `Choose how to play ${pendingDef.name}`
    : corruptedShardModeNeeded && !corruptedShardModeSatisfied
      ? `Corrupted Shard — choose a Guardian Mode for ${pendingDef?.name ?? 'this card'}`
    : pendingPowerBeamChoiceNeeded && pending?.guardianPowerCardUid === null
      ? 'Power Beam — choose a Power from your hand or discard pile to play for 0 Energy'
    : pending?.choiceCards && !pending.choiceConfirmed
      ? pending.choice?.kind === 'scry'
        ? `Scry ${pending.choice.amount} — choose any cards to discard`
        : pending.choice?.kind === 'topdeck'
          ? `${pendingDef?.name ?? 'Card'} — choose ${choiceNeeded} card to put on top`
        : pending.choice?.kind === 'recover'
          ? `${pendingDef?.name ?? 'Card'} — choose a card from your discard pile`
        : pending.choice?.kind === 'recoverExhaust'
          ? `${pendingDef?.name ?? 'Card'} — choose ${pending.choice.minimum === 0 ? `up to ${choiceNeeded}` :
            choiceNeeded === 1 ? 'a card' : choiceNeeded} from your Exhaust pile`
        : pending.choice?.kind === 'search'
          ? pendingSearchKind?.kind === 'overexert'
            ? choiceNeeded === 0 ? 'Overexert — no playable card remains after drawing'
              : 'Overexert — choose a playable card from your hand'
            : pendingSearchKind?.kind === 'replicateSlime'
              ? choiceNeeded === 0 ? 'Replication — no Slime is in your draw pile'
                : 'Replication — choose a Slime from your draw pile to play'
              : `${pendingDef?.name ?? 'Card'} — choose ${choiceNeeded} from your draw pile`
        : `Discard ${choiceNeeded} card${choiceNeeded === 1 ? '' : 's'} after drawing`
    : (pending?.choice?.kind === 'discardAny' || pending?.choice?.kind === 'exhaustAny' ||
      pending?.choice?.kind === 'bottomdeck') && !pending.choiceConfirmed
      ? pending.choice.kind === 'discardAny'
        ? `Discard any number of cards — ${pending.picked.length} chosen`
        : pending.choice.kind === 'bottomdeck'
        ? `${pendingDef?.name ?? 'Card'} — choose ${pending.choice.minimum === 0 ? 'any number of cards'
          : `${Math.min(pending.choice.amount, choicePoolSize)} card${pending.choice.amount === 1 ? '' : 's'}`} for the bottom of your draw pile${
          pending.picked.length > 0 ? ` (in this order) — ${pending.picked.length} chosen` : ''}`
        : `Exhaust ${pending.choice.minimum ? `${pending.choice.minimum}-${pending.choice.amount}` : `up to ${pending.choice.amount}`} cards — ${pending.picked.length} chosen`
    : pending?.choice && !handChoiceSatisfied
      ? `${pending.choice.kind === 'discard' ? 'Discard' : 'Exhaust'} ${choiceNeeded} card${
          choiceNeeded === 1 ? '' : 's'
        } — ${pending.picked.length}/${choiceNeeded} chosen`
      : pendingEvokeTarget >= 0
        ? pendingEvokeUsesRows
          ? `Choose an enemy for this evoke — its whole row is hit${rowHitSuffix}`
          : 'Choose an enemy for this evoke'
        : pendingEvokeChoice
          ? `${pendingDef?.name ?? 'Card'} — choose an Orb to Evoke (${pendingEvokeChoice.index + 1})`
        : pending?.needsEnemy && !enemyChoicesDone
        ? enemy
        : independentPlayerPending
          ? `Choose Block recipient ${(pending?.playerIds.length ?? 0) + 1}/${pending?.playerChoices}`
        : pending?.needsAlly && !pending.playerId
          ? 'Choose who gets it'
          : switchChoiceReady
            ? 'Choose another player to switch rows with, or keep rows'
          : null) ?? (pending ? null : playWindow)
}
