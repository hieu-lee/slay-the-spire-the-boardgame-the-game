// Playing a card: the atomic step between "the player pressed a card" and "the
// board is settled again".
//
// A play is all-or-nothing. Every choice the card needs is validated before any
// of its text resolves, so a card can never spend its Energy and then stall
// half-resolved on a target the board cannot give it. Everything that has to
// wait for the card to finish — enemy reactions, deferred discards, a copy that
// resolves before its original — is drained here, in printed order, once.
import {
  cardResolutionIsOver,
  clone,
  combatIsOver,
  findPlayer,
  livingEnemies,
  powerAbilityKey,
  powerAbilityUsed,
  resolveEnemyTargets,
  rowExists,
} from './board.ts'
import {
  applyEffect,
  discardByCardEffect,
  drawInto,
  evokeTargetProgress,
  exhaustCards,
  finishDeferredHavocs,
  fireTriggers,
  growSlimeWithTriggers,
  releasePendingTriggers,
  recordAttackPlayed,
  resolveDiscardReactions,
  resolveEnraged,
  resolveExhaustReaction,
  resolvePendingEnemyReactions,
  resolveSlimeCommand,
  resolvePendingSlimeCommands,
  settle,
} from './effects.ts'
import { forgetRetain, playerCanGainBlock } from './pieces.ts'
import { addPresentationEvent, presentationTargets } from './presentation.ts'
import {
  amountOf,
  activePowerWindow,
  cardCanBeForced,
  cardHasRetain,
  cardEnemyChoiceCount,
  cardIsPlayable,
  cardModeIsAvailable,
  cardNeedsChoicePreview,
  cardNeedsEnemy,
  cardReferencesGuardianMode,
  cardPlayerChoiceCount,
  cardShivChoiceCount,
  copySourcesFor,
  effectIsActive,
  effectiveCombatCardDef,
  evokePlan,
  guardianCardNeedsAlly,
  guardianGemForCard,
  guardianPowerBeamCards,
  hasInvalidChosenPlayer,
  hasInvalidRowSwitch,
  invalidPlayChoice,
  latestPlayableAllyAttack,
  mandatoryChoicePending,
  maximumXEnergy,
  needsChosenEnemy,
  omniscienceEligibleCards,
  overflowShivCount,
  playCost,
  reachedTimeWarpLimit,
  resolutionContext,
  slimeChoiceIsAvailable,
  slimeCommandEnemyChoiceCount,
} from './queries.ts'
import { finishCardCopy, finishForcedCardPlay, preparePlayerTurnThroughDraw, startPlayerTurnWithChoices } from './start-turn.ts'
import { cardNeedsCorruptedShard } from '../downfall/items.ts'
import { createRelicInstance } from '../relics.ts'
import type {
  CardChoicePreview,
  CombatState,
  CopySource,
  PlayContext,
  PowerContext,
  PresentationContext,
} from './types.ts'
import { cardDef, cardStaysInPlay, faceOf } from '../cards.ts'
import type { CardDef, Effect, TargetScope } from '../cards.ts'
import { gainBlock, gainStrength } from '../damage.ts'
import { enemyAbilities, enemyDef } from '../enemies.ts'
import { addToDrawTop } from '../piles.ts'
import { CAPS } from '../types.ts'
import type { CardInstance, Player } from '../types.ts'
import { slimeDef } from '../downfall/slime-boss.ts'

function skillExhausts(state: CombatState, actor: Player, def: CardDef): boolean {
  return def.type === 'skill' && (actor.powers.some((power) => cardDef(power.defId).corruptSkills) ||
    state.enemies.some((enemy) => !enemy.dead && enemyAbilities(enemyDef(enemy.defId, enemy.ascension))
      .some((ability) => ability.kind === 'corruptSkills')))
}

function presentationEnemyScope(
  def: CardDef,
  effects: readonly Effect[],
  actor: Player,
  includeEvokes: boolean,
  energySpent: number,
  attachedGemId?: string,
  sourceCardUid?: string,
  energyCharged = energySpent,
  sourceDeadOn = false,
): TargetScope {
  const active = def.modes ? { ...def, modes: undefined, effects: [...effects] } : def
  if (!cardNeedsEnemy(active, actor, includeEvokes, energySpent, false,
    attachedGemId, sourceCardUid, energyCharged, sourceDeadOn)) return 'self'
  if (def.id === 'guardian_prismatic_barrier') return 'row'
  return def.target ?? 'enemy'
}

function presentationCardContext(
  def: CardDef,
  effects: readonly Effect[],
  context: PlayContext,
): PresentationContext {
  return {
    enemyUid: context.enemyUid,
    enemyRow: context.enemyRow,
    enemyUids: cardEnemyChoiceCount(def, context.mode) > 0 ? context.enemyUids : [],
    shivEnemyUids: context.shivEnemyUids,
    evokeEnemyUids: context.evokeEnemyUids,
    playerId: context.playerId,
    playerIds: cardPlayerChoiceCount(def, context.mode) > 0 ? context.playerIds : [],
    switchWithPlayerId: effects.some((effect) => effect.kind === 'switchRows')
      ? context.switchWithPlayerId : undefined,
  }
}

function consumeCopySource(actor: Player, sources: readonly CopySource[]): void {
  if (sources.includes('Echo Form')) actor.doubledCardsThisTurn = actor.doubledCardsThisTurn! - 1
  else if (sources.includes('Blasphemy')) actor.tripledAttacksThisTurn = actor.tripledAttacksThisTurn! - 1
  else if (sources.includes('Double Tap')) actor.doubledAttacksThisTurn = actor.doubledAttacksThisTurn! - 1
  else if (sources.includes('Burst')) actor.doubledSkillsThisTurn = actor.doubledSkillsThisTurn! - 1
}

function hermitRapidFireCount(def: CardDef, actor: Player, sourceInHand = true): number {
  let count = def.hermit?.rapidFire ?? 0
  if (def.hermit?.rapidFireBy === 'curseInChamber') {
    count += Number(actor.chamber.some((card) => faceOf(cardDef(card.defId), card.upgraded).type === 'curse'))
  } else if (def.hermit?.rapidFireBy === 'curses') {
    count += [...actor.hand, ...actor.chamber].filter((card) => faceOf(cardDef(card.defId), card.upgraded).type === 'curse').length
  } else if (def.hermit?.rapidFireBy === 'otherCardsInHand') {
    count += Math.max(0, actor.hand.length - Number(sourceInHand))
  }
  const highNoon = actor.powers.find((power) => power.defId === 'hermit_high_noon')
  if (highNoon && def.rarity === 'starter' && (def.name === 'Strike' || highNoon.upgraded && def.name === 'Defend')) count++
  if (def.type === 'attack') count += actor.nextAttackRapidFire ?? 0
  if (count > 0 && actor.powers.some((power) => power.defId === 'hermit_no_holds_barred')) count++
  return count
}

type CardCopySourceName = NonNullable<CombatState['pendingCardCopy']>['sourceNames'][number]

const choicePreview = (
  state: CombatState,
  kind: CardChoicePreview['kind'],
  cards: CardInstance[],
): CardChoicePreview => ({ kind, cards, reservedRng: { ...state.rng } })

function queuedRapidFire(
  card: CardInstance,
  actor: Player,
  baseSources: CardCopySourceName[],
): Pick<NonNullable<CombatState['pendingCardCopy']>, 'sourceNames' | 'hermitRapidFireCard' | 'deferRapidFire'> {
  const printedDef = faceOf(cardDef(card.defId), card.upgraded)
  if (printedDef.guardianVariableType && actor.character !== 'guardian' && actor.guardianMode === null) {
    return { sourceNames: baseSources, deferRapidFire: true }
  }
  const def = effectiveCombatCardDef(printedDef, actor.guardianMode)
  const rapidFire = hermitRapidFireCount(def, actor, false)
  return {
    sourceNames: [
      ...baseSources,
      ...Array.from({ length: rapidFire * baseSources.length }, () => 'Rapid Fire' as const),
    ],
    hermitRapidFireCard: rapidFire > 0,
  }
}

/**
 * Privately previews a post-reveal choice without advancing the real RNG or
 * changing combat. The played card is held outside every pile, as it will be
 * during the eventual atomic play.
 */
export function previewCardChoice(
  state: CombatState,
  playerId: string,
  cardUid: string,
): CardChoicePreview | null {
  const forced = state.startTurnProgress?.forcedCard
  if (state.phase !== 'player' && !((state.phase === 'start' || state.phase === 'discard') &&
    forced?.playerId === playerId &&
    forced.cardUid === cardUid)) return null
  const player = findPlayer(state, playerId)
  const held = player?.hand.find((card) => card.uid === cardUid)
  if (!player || player.dead || !held) return null
  if (mandatoryChoicePending(state, held.hermitDeadOn === true)) return null
  const printedDef = faceOf(cardDef(held.defId), held.upgraded)
  const def = effectiveCombatCardDef(printedDef, player.guardianMode)
  const printedCost = forced?.cardUid === cardUid ? 0 : playCost(def, player, held)
  const cost = printedCost === 'X' ? player.energy : printedCost
  if (reachedTimeWarpLimit(state, player) || !cardIsPlayable(def, state, player) ||
    cost > player.energy || !cardNeedsChoicePreview(def, state, player)) return null

  const preview = clone(state)
  const actor = findPlayer(preview, playerId)!
  actor.hand = actor.hand.filter((card) => card.uid !== cardUid)
  let drew = false
  for (const effect of def.effects) {
    if (!effectIsActive(effect, preview, actor)) continue
    if (effect.kind === 'searchDraw' || effect.kind === 'searchDrawAndPlayTwice') {
      return choicePreview(preview, 'search', effect.kind === 'searchDraw'
        ? actor.draw
        : omniscienceEligibleCards(preview, actor))
    } else if ((effect as { kind: string }).kind === 'replicateSlime') {
      return choicePreview(preview, 'search', actor.draw.filter((card) => cardDef(card.defId).cardKind === 'slime'))
    } else if (effect.kind === 'draw') {
      drawInto(preview, actor, amountOf(effect.amount, preview, actor), [])
      drew = true
    } else if (drew && (effect as { kind: string }).kind === 'overexert') {
      return choicePreview(preview, 'search', actor.hand.filter((card) => {
        const candidate = faceOf(cardDef(card.defId), card.upgraded)
        return cardIsPlayable(candidate, preview, actor) && (candidate.minimumX ?? 0) === 0
      }))
    } else if (effect.kind === 'scry') {
      return choicePreview(preview, 'scry', actor.draw.slice(0, effect.amount))
    } else if (effect.kind === 'scryToHand') {
      return choicePreview(preview, 'scryToHand', actor.draw.slice(0, effect.amount))
    } else if (drew && effect.kind === 'discard') {
      return choicePreview(preview, 'discard', actor.hand)
    } else if (drew && effect.kind === 'topdeck') {
      return choicePreview(preview, 'topdeck', actor.hand)
    } else if (drew && effect.kind === 'load') {
      const source = effect.source ?? 'hand'
      return choicePreview(preview, effect.upTo ? 'loadAny' : 'load', actor[source])
    }
  }
  return null
}

function settleForbiddenPendingCopy(state: CombatState, actor: Player): CombatState {
  const settled = settle(state)
  const pending = settled.pendingCardCopy
  if (!pending) return settled
  if (actor.cardPlayLocked || reachedTimeWarpLimit(settled, actor)) {
    return skipCardCopy(settled, actor.id, actor.cardPlayLocked ? 'was skipped by Conclude' : 'was skipped by Time Warp')
  }
  const copyDef = faceOf(cardDef(pending.card.defId), pending.card.upgraded)
  if (!cardCanBeForced(copyDef, settled, actor, guardianGemForCard(actor, pending.card), pending.card.uid)) {
    return skipCardCopy(settled, actor.id, 'could not be played')
  }
  return settled
}

function cardResolutionChoicesAreValid(
  state: CombatState,
  player: Player,
  def: CardDef,
  effects: readonly Effect[],
  context: PlayContext,
  energySpent: number,
  sourceCardUid?: string,
  sourceAttachedGemId?: string,
  energyCharged = energySpent,
  sourceDeadOn = false,
): boolean {
  const powerBeamCards = guardianPowerBeamCards(player, sourceCardUid)
  const powerBeamDefense = player.guardianMode === 'defense' ||
    player.guardianMode === null && context.corruptedShardMode === 'defense'
  if (def.id === 'guardian_power_beam') {
    if (powerBeamDefense && powerBeamCards.length > 0) {
      if (!powerBeamCards.some((card) => card.uid === context.guardianPowerCardUid)) return false
    } else if (context.guardianPowerCardUid !== undefined) return false
  } else if (context.guardianPowerCardUid !== undefined) return false
  if (effects.some((effect) => effect.kind === 'copyLastAllyAttack') &&
    !latestPlayableAllyAttack(state, player, sourceCardUid)) {
    return false
  }
  const mandatoryShivs = cardShivChoiceCount(def, player, context.mode)
  const discarded = context.discardUids?.length ?? 0
  const gainedShivs = effects.reduce((sum, effect) => sum + (effect.kind === 'gainShiv'
    ? effect.amount
    : effect.kind === 'gainShivPerDiscard' ? discarded + effect.bonus : 0), 0)
  const shivChoices = context.shivEnemyUids ?? []
  if (shivChoices.length < mandatoryShivs ||
    shivChoices.length > mandatoryShivs + overflowShivCount(state, gainedShivs) ||
    shivChoices.some((uid, index) => (index < mandatoryShivs && uid === null) ||
      (uid !== null && !livingEnemies(state).some((enemy) => enemy.uid === uid)))) return false

  const enemyChoiceCount = effects.reduce((sum, effect) => sum + (!effectIsActive(effect, state, player) ? 0 :
    effect.kind === 'poisonChoices' || effect.kind === 'hitChoices' || effect.kind === 'weakChoices' ||
      effect.kind === 'vulnerableChoices' ? effect.targets : 0), 0)
  const enemyChoices = context.enemyUids ?? []
  const requiresDistinct = effects.some((effect) => effect.kind === 'hitChoices' && effect.distinct)
  if (enemyChoiceCount > 0 && (
    enemyChoices.length !== enemyChoiceCount ||
    (requiresDistinct && new Set(enemyChoices).size !== enemyChoices.length) ||
    enemyChoices.some((uid) => !livingEnemies(state).some((enemy) => enemy.uid === uid))
  )) return false
  const soulburnSpend = effects.find((effect) => effect.kind === 'useAllSoulburn')
  if (soulburnSpend) {
    const gained = effects.slice(0, effects.indexOf(soulburnSpend)).reduce((sum, effect) =>
      sum + (effect.kind === 'gainSoulburn' && effectIsActive(effect, state, player)
        ? amountOf(effect.amount, state, player, undefined, { enemyUid: null, playerId: player.id, energySpent })
        : 0), 0)
    const required = Math.min(6, player.soulburn + gained)
    if ((context.soulburnEnemyUids?.length ?? 0) !== required ||
      context.soulburnEnemyUids?.some((uid) => !livingEnemies(state).some((enemy) => enemy.uid === uid))) return false
  } else if (context.soulburnEnemyUids !== undefined) return false
  const playerChoiceCount = cardPlayerChoiceCount(def, context.mode)
  if (playerChoiceCount > 0 && (
    context.playerIds?.length !== playerChoiceCount ||
    context.playerIds.some((id) => !state.players.some((candidate) => candidate.id === id && !candidate.dead))
  )) return false

  const recover = effects.find((effect) => effect.kind === 'recoverDiscard')
  if (recover) {
    const required = Math.min(recover.amount, player.discard.length)
    const chosen = context.recoverDiscardUids ??
      (context.recoverDiscardUid === undefined ? [] : [context.recoverDiscardUid])
    if ((context.recoverDiscardUids !== undefined && context.recoverDiscardUid !== undefined) ||
      chosen.length !== required || new Set(chosen).size !== chosen.length ||
      chosen.some((uid) => !player.discard.some((card) => card.uid === uid))) return false
  }
  const exhume = effects.find((effect) => effect.kind === 'recoverExhaust')
  if (exhume) {
    const required = Math.min(exhume.amount, player.exhaust.length)
    const chosen = context.recoverExhaustUid
    if ((required === 1 && (!chosen || !player.exhaust.some((card) => card.uid === chosen))) ||
      (required === 0 && chosen !== undefined)) return false
  }
  const expedition = effects.find((effect) =>
    effect.kind === 'recoverExhaustToDraw' || effect.kind === 'recoverExhaustToDiscard')
  if (expedition) {
    const chosen = context.recoverExhaustUids ?? []
    const maximum = Math.min(expedition.amount, player.exhaust.length)
    if (chosen.length > maximum || expedition.kind === 'recoverExhaustToDiscard' && chosen.length !== maximum ||
      new Set(chosen).size !== chosen.length ||
      chosen.some((uid) => !player.exhaust.some((card) => card.uid === uid))) return false
  }
  const search = effects.find((effect) => effect.kind === 'searchDraw' || effect.kind === 'searchDrawAndPlayTwice')
  if (search) {
    const chosen = context.searchDrawUids ?? []
    const eligible = search.kind === 'searchDraw' ? player.draw : omniscienceEligibleCards(state, sourceCardUid
      ? { ...player, hand: player.hand.filter((card) => card.uid !== sourceCardUid) }
      : player)
    const required = Math.min(search.kind === 'searchDraw' ? search.amount : 1, eligible.length)
    if (chosen.length !== required || new Set(chosen).size !== chosen.length ||
      chosen.some((uid) => !eligible.some((card) => card.uid === uid))) return false
  }

  const plan = evokePlan(def, player, context.evokeSlots ?? [], context.mode, energySpent)
  if (plan.invalid || plan.next || plan.index !== (context.evokeSlots?.length ?? 0)) return false
  if (plan.chosen.length > 0 && (!context.evokeSlots || !context.evokeEnemyUids)) return false
  if (context.evokeEnemyUids) {
    if (!context.evokeSlots || context.evokeEnemyUids.length > plan.chosen.length) return false
    const targetPlan = evokeTargetProgress(
      def, state, player, context.evokeSlots, context.evokeEnemyUids, context.mode, energySpent,
    )
    if (!targetPlan.complete || targetPlan.index !== context.evokeEnemyUids.length) return false
  }
  if (guardianCardNeedsAlly(def, player, sourceAttachedGemId) && context.playerId !== null &&
    !state.players.some((candidate) => candidate.id === context.playerId && !candidate.dead)) return false
  return !needsChosenEnemy(state, def, context.enemyUid, player, !context.evokeEnemyUids,
    energySpent, context.mode, sourceAttachedGemId, sourceCardUid, energyCharged, sourceDeadOn) &&
    !hasInvalidChosenPlayer(state, def, context.playerId) &&
    !hasInvalidRowSwitch(state, effects, context.switchWithPlayerId, player)
}

function slimeCommandTargetsAreValid(
  state: CombatState,
  player: Player,
  def: CardDef,
  effects: readonly Effect[],
  context: PlayContext,
  energySpent: number,
  energyCharged = energySpent,
  playedCard?: CardInstance,
  requireAvailableSlimes = true,
): boolean {
  const active = { ...def, modes: undefined, effects: [...effects] }
  const targets = context.slimeEnemyUids ?? []
  return (!requireAvailableSlimes || (context.slimeUids ?? [])
    .every((uid) => slimeChoiceIsAvailable(active, state, player, uid, energySpent))) &&
    targets.length === slimeCommandEnemyChoiceCount(
    active, state, player, context.slimeUids ?? [], energySpent, energyCharged,
    playedCard,
  ) && targets.every((uid) => livingEnemies(state).some((enemy) => enemy.uid === uid))
}

function cleanupPlayedCard(
  state: CombatState,
  actor: Player,
  held: CardInstance,
  def: CardDef,
  context: PlayContext,
  forcedExhaust = false,
): void {
  const played = context.sourceCounter === undefined
    ? { ...forgetRetain(held), hermitDeadOn: undefined }
    : { ...forgetRetain(held), counter: context.sourceCounter, hermitDeadOn: undefined }
  if (context.sourceAttached) return
  if (context.loadSelf) {
    const replacementIndex = context.loadSelfReplaceUid
      ? actor.chamber.findIndex((card) => card.uid === context.loadSelfReplaceUid)
      : -1
    if (replacementIndex >= 0) {
      const [replaced] = actor.chamber.splice(replacementIndex, 1, played)
      actor.discard.push(forgetRetain(replaced!))
      state.log = [...state.log, `${actor.name} discards ${cardDef(replaced!.defId).name} from the Chamber`]
    } else actor.chamber = [...actor.chamber, played]
    return
  }
  const exhaustNext = actor.exhaustNextCardAfterUid !== undefined && actor.exhaustNextCardAfterUid !== held.uid
  if (exhaustNext) actor.exhaustNextCardAfterUid = undefined
  if (def.exhaust || forcedExhaust || exhaustNext || skillExhausts(state, actor, def)) {
    exhaustCards(state, actor, [played], context)
  } else if (def.cardKind === 'slime') {
    const slime = {
      card: { ...played, growOnPlay: undefined }, level: 1, vigor: 0,
      commandsThisTurn: 0, vigorLossAtEndOfTurn: 0, vigorTriggerUsedThisTurn: false,
    }
    actor.slimes = [...actor.slimes, slime]
    if (held.growOnPlay) {
      growSlimeWithTriggers(state, actor, slime, 1, context)
      resolvePendingSlimeCommands(state, actor, context)
    }
  } else if (def.type === 'power') {
    actor.powers = [...actor.powers, played]
  } else if (def.toDrawTop) {
    actor.draw = addToDrawTop(actor, [played]).draw
  } else {
    actor.discard = [...actor.discard, played]
  }
}

function resolveSpreadingSlimes(
  state: CombatState,
  actor: Player,
  energySpent: number,
  context: PlayContext,
): void {
  if (energySpent < 2) return
  for (const slime of actor.slimes ?? []) {
    if (combatIsOver(state)) break
    if (slimeDef(slime).slimeTrigger !== 'onSpendTwoEnergy') continue
    if (!resolveSlimeCommand(state, actor, slime, context)) continue
    state.log = [...state.log, `${actor.name} Commands ${slimeDef(slime).name} after spending ${energySpent} Energy`]
  }
}

function resolveSlimeBossPlayReactions(
  state: CombatState,
  actor: Player,
  played: CardDef,
  playedCard: CardInstance,
  context: PlayContext,
): void {
  if (combatIsOver(state)) return
  if (played.name.includes('Tackle')) for (const power of actor.powers) {
    if (power.defId === 'slime_boss_goop_armor') {
      const amount = power.upgraded ? 2 : 1
      if (playerCanGainBlock(actor)) actor.block = gainBlock(actor.block, amount)
      state.log = [...state.log, `Goop Armor: ${actor.name} gains ${amount} Block`]
    } else if (power.defId === 'slime_boss_consult_playbook' &&
      !state.powerTriggersUsedThisTurn.includes(`power:${power.uid}`)) {
      state.powerTriggersUsedThisTurn.push(`power:${power.uid}`)
      drawInto(state, actor, power.upgraded ? 2 : 1)
      actor.energy = Math.min(CAPS.energy, actor.energy + 1)
      state.log = [...state.log, `Consult Playbook: ${actor.name} draws and gains 1 Energy`]
    }
  }
  if (cardHasRetain(actor, playedCard) &&
    actor.powers.some((power) => power.defId === 'slime_boss_darkling_duo')) {
    const bruiser = actor.slimes?.find((slime) => slime.card.defId === 'slime_boss_bruiser_slime')
    if (bruiser) resolveSlimeCommand(state, actor, bruiser, context, 'Darkling Duo')
  }
}

/**
 * Plays a card from a player's hand. Returns the same state reference when the
 * play is illegal: not that player's card, not enough energy, wrong phase.
 */
export function playCard(
  state: CombatState,
  playerId: string,
  cardUid: string,
  context: PlayContext = { enemyUid: null, playerId: null },
): CombatState {
  if ((state.pendingTriggers?.length ?? 0) > 0 ||
    mandatoryChoicePending(state, context.hermitChamberPlay === true)) return state
  const forced = state.startTurnProgress?.forcedCard
  const forcedPlay = (state.phase === 'start' || state.phase === 'player' || state.phase === 'discard') &&
    forced?.playerId === playerId && forced.cardUid === cardUid
  if (forced && !forcedPlay) return state
  if (state.phase !== 'player' && !forcedPlay) return state
  const player = findPlayer(state, playerId)
  if (!player) return state
  // A forced card's own retaliation (e.g. Thorns/Sharp Hide) can kill its
  // owner before a later card in the same forced chain (Distilled Chaos,
  // Mayhem, Havoc) is chosen; under Last Stand a living teammate keeps that
  // still-armed `startTurnProgress.forcedCard` blocking the whole table
  // forever, so a dead owner must still be able to settle it, exactly like
  // Conclude/Time Warp already do below.
  if (player.dead) return forcedPlay ? abandonForcedCard(state, playerId) : state

  const held = player.hand.find((card) => card.uid === cardUid)
  if (!held) return state

  const printedDef = faceOf(cardDef(held.defId), held.upgraded)
  const attachedGemId = guardianGemForCard(player, held)
  const corruptedModeChoice = player.character !== 'guardian' && player.guardianMode === null &&
    cardReferencesGuardianMode(printedDef, attachedGemId)
  if (corruptedModeChoice && context.corruptedShardMode !== 'attack' && context.corruptedShardMode !== 'defense') return state
  const guardianMode = corruptedModeChoice ? context.corruptedShardMode : player.guardianMode
  const def = effectiveCombatCardDef(printedDef, guardianMode)
  if (player.cardPlayLocked) return forcedPlay ? abandonForcedCard(state, playerId) : state
  if (reachedTimeWarpLimit(state, player)) {
    return forcedPlay ? abandonForcedCard(state, playerId) : state
  }
  if (!cardIsPlayable(def, state, player)) return state
  if (def.modes) {
    if (!Number.isInteger(context.mode) || context.mode! < 0 || context.mode! >= def.modes.length) return state
    if (!cardModeIsAvailable(def, state, player, context.mode!, player.draw.length, held.uid)) return state
  } else if (context.mode !== undefined) return state
  const effects = def.modes ? def.modes[context.mode!]!.effects : def.effects
  const rapidFire = hermitRapidFireCount(def, player)
  const resolvesOnPlay = def.type !== 'power' || def.resolvesOnPlay === true
  const printedCost = forcedPlay ? 0 : playCost(def, player, held)
  if (def.cost === 'X' && printedCost !== 'X' && printedCost < (def.minimumX ?? 0)) return state
  const xCost = printedCost === 'X'
  if (xCost && (!Number.isInteger(context.energySpent) || context.energySpent! < (def.minimumX ?? 0) ||
    context.energySpent! > maximumXEnergy(def, player))) return state
  if (!xCost && context.energySpent !== undefined && context.energySpent !== 0) return state
  const cost = xCost ? context.energySpent! : printedCost
  const vigorSpent = context.spendVigor ?? 0
  if (!Number.isSafeInteger(vigorSpent) || vigorSpent < 0 || vigorSpent > player.vigor ||
    (vigorSpent > 0 && (player.guardianMode === null ||
      def.type !== 'attack' && def.type !== 'skill'))) return state
  const blockSpent = context.guardianBlockSpend ?? 0
  if (!Number.isSafeInteger(blockSpent) || blockSpent < 0 || blockSpent > player.block ||
    (blockSpent > 0 && def.id !== 'guardian_body_crash')) return state
  const effectEnergy = def.cost === 'X' ? cost : 0
  const miracleOnCard = context.spendMiracle === true
  if (forcedPlay && miracleOnCard) return state
  if (miracleOnCard && (
    player.miracles < 1 || player.energy !== CAPS.energy || def.cost === 'X' || cost === 0
  )) return state
  if (cost > player.energy + (miracleOnCard ? 1 : 0)) return state
  // Choices are checked together at the trust boundary. The same validator is
  // reused when the physical card resolves after its separately targeted copy.
  if (!slimeCommandTargetsAreValid(
    state, player, def, resolvesOnPlay ? effects : [], context, effectEnergy, cost, held, !forcedPlay,
  ) || resolvesOnPlay && !cardResolutionChoicesAreValid(
    state, player, def, effects, context, effectEnergy, held.uid, attachedGemId, cost, held.hermitDeadOn === true,
  )) return state
  const next = clone(state)
  const actor = findPlayer(next, playerId)
  // The player was just found in `state`, so a clone must contain them too.
  // Returning `state` here would masquerade as "illegal move" and hide a bug.
  if (!actor) throw new Error(`player ${playerId} vanished from the cloned state`)
  if (cardNeedsCorruptedShard(actor.character, def) && !actor.relics.some((relic) => relic.defId === 'corrupted_shard')) {
    actor.relics.push(createRelicInstance('corrupted_shard'))
    next.log = [...next.log, `${actor.name} gains Corrupted Shard for using ${def.name}`]
  }
  if (corruptedModeChoice) actor.guardianMode = context.corruptedShardMode!
  const akabeko = def.type === 'attack' && (actor.akabekoAttacks ?? 0) > 0
  const pizzazStrength = def.type === 'attack' ? actor.nextAttackStrength ?? 0 : 0
  if (pizzazStrength > 0) actor.nextAttackStrength = 0
  if (akabeko) {
    actor.strength = gainStrength(actor.strength, 1)
    actor.akabekoAttacks!--
  }

  // A card can be played twice by only one effect; later effects wait for the
  // next valid card (rulebook p.24). Burst itself explicitly cannot be copied.
  // The first resolution below is the virtual copy; the physical original
  // stays outside every pile and resolves through `playCardCopy` afterwards.
  const copySources = copySourcesFor(def, actor)
  const doubled = copySources.length > 0
  consumeCopySource(actor, copySources)
  addPresentationEvent(next, {
    kind: 'card',
    actorId: actor.id,
    sourceId: def.id,
    upgraded: held.upgraded,
    copied: doubled,
    energy: cost,
    resolvedType: def.type,
    ...(context.mode === undefined ? {} : { mode: context.mode }),
    ...presentationTargets(next, actor.id,
      presentationEnemyScope(def, effects, actor, !context.evokeEnemyUids, effectEnergy,
        attachedGemId, held.uid, cost, held.hermitDeadOn === true),
      guardianCardNeedsAlly(def, actor, attachedGemId) ? 'anyPlayer' : def.supportTarget ?? 'self',
      presentationCardContext(def, effects, context)),
  })

  // The card leaves hand before resolving and belongs to no pile until cleanup,
  // which is what stops a card that draws from drawing itself (p.12).
  const forcedChoices = forcedPlay && state.phase === 'start' && !forced?.resumeOpenStart
    ? [...(state.startTurnProgress?.choices ?? [])] : null
  if (forcedPlay) next.startTurnProgress = undefined
  actor.hand = actor.hand.filter((card) => card.uid !== cardUid)
  actor.energy -= cost
  actor.energySpentThisTurn = (actor.energySpentThisTurn ?? 0) + cost
  actor.vigor -= vigorSpent
  actor.vigorSpentThisTurn += vigorSpent
  actor.nextCardCost = null
  actor.enemyNextCardCost = null
  if (def.type === 'power' || def.type === 'slime') actor.nextPowerOrSlimeDiscount = undefined
  if ((actor.freeCardsThisTurn ?? 0) > 0) actor.freeCardsThisTurn = actor.freeCardsThisTurn! - 1
  if (def.type === 'attack' && next.partyAttackDiscount) {
    for (const member of next.players) member.freeAttacksThisTurn = Math.max(0, (member.freeAttacksThisTurn ?? 0) - 1)
    next.partyAttackDiscount = false
  } else if (def.type === 'attack' && (actor.freeAttacksThisTurn ?? 0) > 0) {
    actor.freeAttacksThisTurn = actor.freeAttacksThisTurn! - 1
  }
  if (def.guardian?.printedType.startsWith('Gem') && (actor.freeGemCardsThisTurn ?? 0) > 0) {
    actor.freeGemCardsThisTurn!--
  }
  if (def.type === 'power' && (actor.freePowersThisTurn ?? 0) > 0) actor.freePowersThisTurn!--
  if (miracleOnCard) {
    actor.miracles -= 1
    actor.energy += 1
    next.log = [...next.log, `${actor.name} spends a Miracle toward ${def.name}`]
  }
  actor.cardsPlayedThisTurn = (actor.cardsPlayedThisTurn ?? 0) + 1
  if (def.type === 'power') actor.powerPlayedThisTurn = true
  if (def.type === 'attack' || def.type === 'skill') {
    next.playedCardsThisTurn = [
      ...(next.playedCardsThisTurn ?? []),
      { playerId: actor.id, card: forgetRetain(held), copied: doubled, type: def.type },
    ]
  }

  // Logged before its effects resolve: appended afterwards, a kill the card
  // caused reads as OLDER than the card, which is nonsense in a newest-first
  // log.
  next.log = [...next.log, doubled
    ? `${actor.name} played ${def.name} copy (${copySources[0]})`
    : `${actor.name} played ${def.name}`]

  const scope: TargetScope = def.target ?? 'enemy'
  const supportScope: TargetScope = def.supportTarget ?? 'self'
  // A Power with a trigger does nothing when played: its effects are what the
  // trigger does, every time it fires. Resolving them here as well would pay
  // out Demon Form's Strength immediately AND at every Start of Turn.
  // `spentUids` and `shortfall` are this play's verdict, not the caller's
  // request, so they go on a copy. The caller's object is theirs: in the UI it
  // is assembled out of React state, and writing a scratch field back into it
  // would be a mutation from a function that is otherwise pure.
  const ctx = resolutionContext(context, def,
    attachedGemId ? { ...held, attachedGemId } : held, effectEnergy, doubled)
  ctx.hermitRapidFireCard = rapidFire > 0
  let remainingEffects: Effect[] | undefined
  if (resolvesOnPlay) {
    for (const [index, effect] of effects.entries()) {
      applyEffect(next, actor, effect, scope, supportScope, ctx)
      if (invalidPlayChoice(ctx)) return state
      // Combat endings are immediate (p.13), including halfway through a
      // card. Nothing printed later, nor cleanup or play triggers, resolves.
      if (cardResolutionIsOver(next, ctx, actor)) {
        if (akabeko) actor.strength = Math.max(0, actor.strength - 1)
        if (pizzazStrength > 0) actor.strength = Math.max(0, actor.strength - pizzazStrength)
        return finishForcedCardPlay(settle(next), forcedChoices)
      }
      if (ctx.doppelgangerCopy) {
        remainingEffects = effects.slice(index + 1)
        break
      }
    }
  }
  resolvePendingSlimeCommands(next, actor, ctx)
  if (invalidPlayChoice(ctx)) return state
  if (cardResolutionIsOver(next, ctx, actor)) {
    if (akabeko) actor.strength = Math.max(0, actor.strength - 1)
    if (pizzazStrength > 0) actor.strength = Math.max(0, actor.strength - pizzazStrength)
    return finishForcedCardPlay(settle(next), forcedChoices)
  }
  if (akabeko) actor.strength = Math.max(0, actor.strength - 1)
  if (pizzazStrength > 0) actor.strength = Math.max(0, actor.strength - pizzazStrength)

  // Havoc's child is part of Havoc's resolution. Its own cleanup, card-play
  // triggers, and Enraged reaction therefore wait until that child finishes.
  // A Havoc drawn by another Havoc extends the same small stack.
  if (def.id === 'havoc' && next.startTurnProgress?.forcedCard) {
    const corrupt = skillExhausts(next, actor, def)
    next.startTurnProgress.forcedCard.deferredHavocs = [
      ...(forced?.deferredHavocs ?? []),
      { card: forgetRetain(held), exhaust: def.exhaust === true ||
        (forcedPlay && forced.exhaustNonPower && !cardStaysInPlay(def)) || corrupt,
      ...(doubled ? {
        copySourceNames: copySources,
        copyResumePhase: state.phase === 'start' ? 'start' as const : 'player' as const,
      } : {}) },
    ]
    next.startTurnProgress.forcedCard.pendingTriggers = [
      ...(forced?.pendingTriggers ?? []),
      ...(ctx.pendingTriggers ?? []),
    ]
    if (forcedChoices) {
      next.startTurnProgress.choices = forcedChoices.map((choice) => ({ ...choice }))
    }
    return settle(next)
  }

  // Survivor reads "2 Block. Discard 1 card." — the discard is the COST, not a
  // suggestion. Off the network an empty or bogus list would otherwise buy the
  // card's effects for nothing. The whole play is resolved into a clone first,
  // so refusing it here costs the caller nothing and still signals illegality
  // the way every other refusal does: by handing back the very same reference.
  if (invalidPlayChoice(ctx)) return state

  resolvePendingEnemyReactions(next, actor, ctx)
  if (combatIsOver(next)) return finishForcedCardPlay(settle(next), forcedChoices)
  for (const pending of ctx.pendingDiscards ?? []) {
    const owner = findPlayer(next, pending.playerId)
    if (owner) resolveDiscardReactions(next, owner, pending.cards)
    if (combatIsOver(next)) return finishForcedCardPlay(settle(next), forcedChoices)
  }

  if (def.type === 'attack' && (actor.nextAttackRapidFire ?? 0) > 0) actor.nextAttackRapidFire = 0

  if (ctx.doppelgangerCopy) {
    resolveSpreadingSlimes(next, actor, cost, ctx)
    if (combatIsOver(next)) return finishForcedCardPlay(settle(next), forcedChoices)
    const corrupt = skillExhausts(next, actor, def)
    const deferredCopySources = [
      ...copySources,
      ...Array(rapidFire * (copySources.length + 1)).fill('Rapid Fire' as const),
    ]
    const baseSources = ctx.queuedCopySourceNames ?? (ctx.queuedCopyTwice
      ? [ctx.queuedCopySource ?? 'Doppelganger', ctx.queuedCopySource ?? 'Doppelganger']
      : [ctx.queuedCopySource ?? 'Doppelganger'])
    next.pendingCardCopy = {
      id: next.nextTriggerId++,
      playerId: actor.id,
      card: ctx.doppelgangerCopy,
      energySpent: effectEnergy,
      resumePhase: state.phase === 'start' ? 'start' : state.phase === 'discard' ? 'discard' : 'player',
      forcedExhaust: ctx.queuedCopyForcedExhaust === true,
      forcedChoices,
      deferredHavocs: [
        ...(forced?.deferredHavocs ?? []),
        {
          card: forgetRetain(held),
          exhaust: def.exhaust === true ||
            (forcedPlay && forced.exhaustNonPower && !cardStaysInPlay(def)) || corrupt,
          remainingEffects,
          ...(deferredCopySources.length > 0 ? {
            copySourceNames: deferredCopySources,
            copyResumePhase: state.phase === 'start' ? 'start' as const : 'player' as const,
          } : {}),
        },
      ],
      deferredTriggers: [
        ...(forced?.pendingTriggers ?? []),
        ...(ctx.pendingTriggers ?? []),
      ],
      ...queuedRapidFire(ctx.doppelgangerCopy, actor, baseSources),
      ...(ctx.queuedCopyTwiceIfAttack ? { repeatIfAttack: true } : {}),
      virtualOnly: ctx.queuedCopyVirtualOnly ?? true,
      queuedWeaves: ctx.queuedWeaves,
      queuedCopySources: ctx.queuedCopySources,
      consumeFreeCard: ctx.consumeQueuedFreeCard,
      consumeFreeAttack: ctx.consumeQueuedFreeAttack,
    }
    next.phase = 'copy'
    return settleForbiddenPendingCopy(next, actor)
  }

  if (!doubled) cleanupPlayedCard(next, actor, held, def, ctx,
    forcedPlay && forced.exhaustNonPower && !cardStaysInPlay(def))
  if (invalidPlayChoice(ctx)) return state
  if (combatIsOver(next)) return finishForcedCardPlay(settle(next), forcedChoices)
  resolveSpreadingSlimes(next, actor, cost, ctx)
  if (combatIsOver(next)) return finishForcedCardPlay(settle(next), forcedChoices)
  resolveSlimeBossPlayReactions(next, actor, def, held, ctx)
  if (combatIsOver(next)) return finishForcedCardPlay(settle(next), forcedChoices)

  if (def.guardian?.printedType.startsWith('Gem') &&
    actor.powers.some((power) => power.defId === 'guardian_brilliant_scales')) {
    const before = actor.block
    if (playerCanGainBlock(actor)) actor.block = gainBlock(actor.block, 1)
    if (actor.block > before) next.log = [...next.log, `${actor.name}'s Brilliant Scales grants 1 Block`]
  }

  for (const pending of ctx.pendingExhaustTriggers ?? []) {
    const owner = findPlayer(next, pending.playerId)
    if (owner) resolveExhaustReaction(next, owner, pending.card)
    if (combatIsOver(next)) return finishForcedCardPlay(settle(next), forcedChoices)
  }

  for (const ownerId of ctx.pendingPoisonTriggers ?? []) {
    const owner = findPlayer(next, ownerId)
    if (owner) fireTriggers(next, { kind: 'onApplyPoison' }, owner)
    if (combatIsOver(next)) return finishForcedCardPlay(settle(next), forcedChoices)
  }

  for (const pending of ctx.pendingEnemyTokenTriggers ?? []) {
    const owner = findPlayer(next, pending.playerId)
    if (owner) fireTriggers(next, { kind: 'onPutEnemyToken', enemyUid: pending.enemyUid }, owner)
    if (combatIsOver(next)) return finishForcedCardPlay(settle(next), forcedChoices)
  }

  if (def.type === 'attack' && !ctx.sourceAttackCounted) {
    recordAttackPlayed(next, actor)
  }

  // "Abilities triggered by a card do not take effect until the card has
  // finished resolving all of its text" (p.12). A doubled card stays outside
  // every pile until both resolutions finish, so only that exceptional cleanup waits.
  // `held.uid` is excluded: a Power that reacts to cards being played was not
  // in front of you when THIS card was played, so it does not see it.
  fireTriggers(next, { kind: 'onPlayCard', cardType: def.type }, actor, held.uid)
  if (combatIsOver(next)) return finishForcedCardPlay(settle(next), forcedChoices)

  if (def.type === 'skill') resolveEnraged(next, actor)
  if (combatIsOver(next)) return finishForcedCardPlay(settle(next), forcedChoices)

  if (doubled) {
    next.pendingCardCopy = {
      id: next.nextTriggerId++,
      playerId: actor.id,
      card: { ...held },
      energySpent: effectEnergy,
      resumePhase: state.phase === 'start' ? 'start' : state.phase === 'discard' ? 'discard' : 'player',
      forcedExhaust: forcedPlay && forced.exhaustNonPower && !cardStaysInPlay(def),
      forcedChoices,
      deferredHavocs: [...(forced?.deferredHavocs ?? [])],
      sourceNames: [...copySources, ...Array(rapidFire * (copySources.length + 1)).fill('Rapid Fire' as const)],
      hermitRapidFireCard: rapidFire > 0,
    }
    next.phase = 'copy'
    next.log = [...next.log, `${actor.name}'s ${copySources[0]} copy finished; ${def.name} remains to resolve`]
    releasePendingTriggers(next, ctx)
    return settleForbiddenPendingCopy(next, actor)
  }

  if (rapidFire > 0) {
    next.pendingCardCopy = {
      id: next.nextTriggerId++,
      playerId: actor.id,
      card: { ...held },
      energySpent: effectEnergy,
      resumePhase: state.phase === 'start' ? 'start' : state.phase === 'discard' ? 'discard' : 'player',
      forcedExhaust: false,
      forcedChoices,
      deferredHavocs: [...(forced?.deferredHavocs ?? [])],
      deferredTriggers: [...(ctx.pendingTriggers ?? [])],
      sourceNames: Array(rapidFire).fill('Rapid Fire'),
      virtualOnly: true,
      hermitRapidFireCard: true,
    }
    next.phase = 'copy'
    return settleForbiddenPendingCopy(next, actor)
  }

  const resumedTriggers = finishDeferredHavocs(next, actor, forced?.deferredHavocs ?? [])
  ctx.pendingTriggers = [
    ...(forced?.pendingTriggers ?? []), ...(ctx.pendingTriggers ?? []), ...resumedTriggers,
  ]
  releasePendingTriggers(next, ctx)
  return finishForcedCardPlay(settleForbiddenPendingCopy(next, actor), forcedChoices)
}

function stageHermitChamberCard(state: CombatState, playerId: string, cardUid: string): CombatState | null {
  const player = findPlayer(state, playerId)
  const card = player?.chamber.find((held) => held.uid === cardUid)
  if (!player || player.dead || !card || state.phase !== 'player' || state.pendingCardCopy) return null
  const pending = state.pendingHermitChamberPlays?.[0]
  if (pending && (pending.playerId !== playerId || pending.cardUids[0] !== cardUid)) return null
  const staged = clone(state)
  const actor = findPlayer(staged, playerId)!
  actor.chamber = actor.chamber.filter((held) => held.uid !== cardUid)
  actor.hand.push({ ...card, hermitDeadOn: true, ...(pending?.free ? { freeThisTurn: true } : {}) })
  if (pending) {
    const rest = pending.cardUids.slice(1)
    staged.pendingHermitChamberPlays = rest.length
      ? [{ ...pending, cardUids: rest }, ...(staged.pendingHermitChamberPlays?.slice(1) ?? [])]
      : staged.pendingHermitChamberPlays?.slice(1)
  }
  return staged
}

/** Privately previews a Chamber card whose draw is followed by a Load choice. */
export function previewHermitChamberCardChoice(
  state: CombatState,
  playerId: string,
  cardUid: string,
): CardChoicePreview | null {
  const staged = stageHermitChamberCard(state, playerId, cardUid)
  return staged ? previewCardChoice(staged, playerId, cardUid) : null
}

function skipPendingHermitChamberPlay(state: CombatState, pending: NonNullable<CombatState['pendingHermitChamberPlays']>[number], message: string): CombatState {
  const next = clone(state)
  const rest = pending.cardUids.slice(1)
  next.pendingHermitChamberPlays = rest.length
    ? [{ ...pending, cardUids: rest }, ...(next.pendingHermitChamberPlays?.slice(1) ?? [])]
    : next.pendingHermitChamberPlays?.slice(1)
  next.log = [...next.log, message]
  return settle(next)
}

/** Plays a private Chamber card through the ordinary authoritative card pipeline. */
export function playHermitChamberCard(
  state: CombatState,
  playerId: string,
  cardUid: string,
  context: PlayContext = { enemyUid: null, playerId: null },
): CombatState {
  const pending = state.pendingHermitChamberPlays?.[0]
  const owner = findPlayer(state, playerId)
  // A Hermit who dies mid-resolution (e.g. a Thorns/Sharp Hide retaliation)
  // can never legally play their queued Chamber card: `stageHermitChamberCard`
  // rejects any dead player outright, so without this the mandatory play
  // (and the table-wide `phase !== 'player'`-equivalent block it imposes via
  // `mandatoryChoicePending`) would be stuck forever under Last Stand.
  if (pending && pending.playerId === playerId && owner?.dead) {
    return skipPendingHermitChamberPlay(state, pending,
      `${owner.name}'s mandatory Chamber play was skipped because they did not survive to play it`)
  }
  const staged = stageHermitChamberCard(state, playerId, cardUid)
  if (!staged) return state
  const actor = findPlayer(staged, playerId)!
  const card = actor.hand.find((held) => held.uid === cardUid)!
  const def = effectiveCombatCardDef(faceOf(cardDef(card.defId), card.upgraded), actor.guardianMode)
  if (pending && (reachedTimeWarpLimit(staged, actor) || !cardIsPlayable(def, staged, actor) ||
    !cardCanBeForced(def, staged, actor, guardianGemForCard(actor, card), card.uid))) {
    return skipPendingHermitChamberPlay(state, pending,
      `${actor.name}'s mandatory Chamber play of ${def.name} was skipped because it cannot be played`)
  }
  const resolved = playCard(staged, playerId, cardUid, { ...context, hermitChamberPlay: true })
  return resolved === staged ? state : resolved
}

/** Assigns Dead or Alive's Strength to one living player. */
export function resolveHermitStrengthReward(state: CombatState, ownerId: string, targetPlayerId: string): CombatState {
  const pending = state.pendingHermitStrengthRewards?.[0]
  const target = state.players.find((player) => player.id === targetPlayerId && !player.dead)
  if (!pending || pending.playerId !== ownerId || !target) return state
  const next = clone(state)
  const recipient = findPlayer(next, targetPlayerId)!
  recipient.strength = gainStrength(recipient.strength, 1)
  next.pendingHermitStrengthRewards = next.pendingHermitStrengthRewards?.slice(1)
  next.log = [...next.log, `${recipient.name} gains 1 Strength from Dead or Alive`]
  return settle(next)
}

/** Resolves the Hermit's private start-of-combat draw-and-Load board ability. */
export function resolveHermitSetupLoad(
  state: CombatState,
  playerId: string,
  cardUid: string,
  enemyUid: string | null = null,
  pauseAfterDraw = false,
): CombatState {
  const pending = state.pendingHermitSetupLoads?.[0]
  const player = findPlayer(state, playerId)
  if (!pending || pending.playerId !== playerId || !player || player.dead ||
    player.chamber.length >= player.chamberSlots || !player.hand.some((card) => card.uid === cardUid)) return state
  const next = clone(state)
  const actor = findPlayer(next, playerId)!
  const context: PlayContext = { enemyUid, playerId: null, loadUids: [cardUid], loadChoiceIndex: 0,
    invalidHermitChoice: false }
  applyEffect(next, actor, { kind: 'load', amount: 1 }, 'self', 'self', context, 'Hermit board')
  if (context.invalidHermitChoice || actor.hand.some((card) => card.uid === cardUid)) return state
  next.pendingHermitSetupLoads = next.pendingHermitSetupLoads?.slice(1)
  const settled = settle(next)
  return settled.turn === 0 && settled.pendingHermitSetupLoads?.length === 0
    ? pauseAfterDraw ? preparePlayerTurnThroughDraw(settled) : startPlayerTurnWithChoices(settled)
    : settled
}

/** Drops a disconnected Hermit's unresolved private setup choice. */
export function abandonHermitSetupLoad(state: CombatState, playerId: string, pauseAfterDraw = false): CombatState {
  const pending = state.pendingHermitSetupLoads?.[0]
  if (!pending || pending.playerId !== playerId) return state
  const next = clone(state)
  next.pendingHermitSetupLoads = next.pendingHermitSetupLoads?.slice(1)
  next.log = [...next.log, `${findPlayer(next, playerId)?.name ?? 'Hermit'}'s setup Load was skipped after disconnecting`]
  const settled = settle(next)
  return settled.turn === 0 && settled.pendingHermitSetupLoads?.length === 0
    ? pauseAfterDraw ? preparePlayerTurnThroughDraw(settled) : startPlayerTurnWithChoices(settled)
    : settled
}

/** Drops a disconnected Hermit's unresolved private Chamber play. */
export function abandonHermitChamberPlay(state: CombatState, playerId: string): CombatState {
  const pending = state.pendingHermitChamberPlays?.[0]
  if (!pending || pending.playerId !== playerId) return state
  const next = clone(state)
  next.pendingHermitChamberPlays = next.pendingHermitChamberPlays?.slice(1)
  next.log = [...next.log, `${findPlayer(next, playerId)?.name ?? 'Hermit'}'s Chamber play was skipped after disconnecting`]
  return settle(next)
}

/** Resolves the physical original after its separately targeted virtual copy. */
export function playCardCopy(
  state: CombatState,
  playerId: string,
  context: PlayContext = { enemyUid: null, playerId: null },
): CombatState {
  if ((state.pendingTriggers?.length ?? 0) > 0) return state
  const pending = state.pendingCardCopy
  if (state.phase !== 'copy' || !pending || pending.playerId !== playerId) return state
  const player = findPlayer(state, playerId)
  if (!player) return state
  // A card that killed its own actor (e.g. a Skill's Thorns/Sharp Hide
  // reflection) can still queue a physical copy behind it under Last Stand,
  // where a living teammate keeps combat going: `phase: 'copy'` blocks
  // nearly every other action table-wide, so a dead owner must still be able
  // to settle their own pending copy, exactly like Conclude/Time Warp already
  // do, rather than leave it stuck forever.
  if (player.dead) return skipCardCopy(state, playerId, "was skipped because its owner didn't survive to finish it")
  if (player.cardPlayLocked) return skipCardCopy(state, playerId, 'was skipped by Conclude')
  if (reachedTimeWarpLimit(state, player)) return skipCardCopy(state, playerId, 'was skipped by Time Warp')
  const printedDef = faceOf(cardDef(pending.card.defId), pending.card.upgraded)
  const attachedGemId = guardianGemForCard(player, pending.card)
  const corruptedModeChoice = player.character !== 'guardian' && player.guardianMode === null &&
    cardReferencesGuardianMode(printedDef, attachedGemId)
  if (corruptedModeChoice && context.corruptedShardMode !== 'attack' && context.corruptedShardMode !== 'defense') return state
  const guardianMode = corruptedModeChoice ? context.corruptedShardMode : player.guardianMode
  const def = effectiveCombatCardDef(printedDef, guardianMode)
  const sourceName = pending.sourceNames[0]
  if ((sourceName === 'Double Tap' && def.type !== 'attack') ||
    (sourceName === 'Blasphemy' && def.type !== 'attack') ||
    (sourceName === 'Omniscience' && def.type !== 'attack' && def.type !== 'skill') ||
    (sourceName === 'Weave' && def.id !== 'weave') ||
    (sourceName === 'Echo Form' && def.type !== 'attack' && def.type !== 'skill') ||
    (sourceName === 'Burst' && def.type !== 'skill') ||
    (sourceName === 'Doppelganger' && def.type !== 'attack' && def.type !== 'skill')) return state
  if (!cardCanBeForced(def, state, player, attachedGemId, pending.card.uid)) {
    return skipCardCopy(state, playerId, 'could not be played')
  }
  if (def.modes) {
    if (!Number.isInteger(context.mode) || context.mode! < 0 || context.mode! >= def.modes.length) return state
    if (!cardModeIsAvailable(def, state, player, context.mode!)) return state
  } else if (context.mode !== undefined) return state
  const effects = def.modes ? def.modes[context.mode!]!.effects : def.effects
  if (!slimeCommandTargetsAreValid(state, player, def, effects, context, pending.energySpent, 0, pending.card, false) ||
    !cardResolutionChoicesAreValid(state, player, def, effects, context,
    pending.energySpent, pending.card.uid, attachedGemId, pending.energySpent, pending.card.hermitDeadOn === true)) return state

  const next = clone(state)
  const copy = next.pendingCardCopy!
  const actor = findPlayer(next, playerId)!
  if (copy.repeatIfAttack) {
    delete copy.repeatIfAttack
    if (def.type === 'attack') copy.sourceNames = [...copy.sourceNames, 'Overexert']
  }
  if (copy.deferRapidFire) {
    delete copy.deferRapidFire
    const rapidFire = hermitRapidFireCount(def, actor, false)
    copy.sourceNames = [
      ...copy.sourceNames,
      ...Array.from({ length: rapidFire * copy.sourceNames.length }, () => 'Rapid Fire' as const),
    ]
    copy.hermitRapidFireCard = rapidFire > 0
  }
  const sourceIsCopy = copy.finalResolutionCopied === true || copy.virtualOnly === true || copy.sourceNames.length > 1
  if (cardNeedsCorruptedShard(actor.character, def) && !actor.relics.some((relic) => relic.defId === 'corrupted_shard')) {
    actor.relics.push(createRelicInstance('corrupted_shard'))
    next.log = [...next.log, `${actor.name} gains Corrupted Shard for copying ${def.name}`]
  }
  if (corruptedModeChoice) actor.guardianMode = context.corruptedShardMode!
  addPresentationEvent(next, {
    kind: 'card',
    actorId: actor.id,
    sourceId: def.id,
    upgraded: copy.card.upgraded,
    copied: sourceIsCopy,
    energy: copy.energySpent,
    resolvedType: def.type,
    ...(context.mode === undefined ? {} : { mode: context.mode }),
    ...presentationTargets(next, actor.id,
      presentationEnemyScope(def, effects, actor, !context.evokeEnemyUids,
        pending.energySpent, attachedGemId, copy.card.uid, pending.energySpent, copy.card.hermitDeadOn === true),
      guardianCardNeedsAlly(def, actor, attachedGemId) ? 'anyPlayer' : def.supportTarget ?? 'self',
      presentationCardContext(def, effects, context)),
  })
  if ((copy.queuedCopySources?.length ?? 0) > 0) {
    consumeCopySource(actor, copy.queuedCopySources!)
    copy.queuedCopySources = []
  }
  if (copy.consumeFreeCard) actor.freeCardsThisTurn = Math.max(0, (actor.freeCardsThisTurn ?? 0) - 1)
  if (copy.consumeFreeAttack && def.type === 'attack') {
    actor.freeAttacksThisTurn = Math.max(0, (actor.freeAttacksThisTurn ?? 0) - 1)
  }
  if (def.type === 'attack' && (actor.nextAttackRapidFire ?? 0) > 0) actor.nextAttackRapidFire = 0
  actor.cardsPlayedThisTurn = (actor.cardsPlayedThisTurn ?? 0) + 1
  if (def.type === 'attack' || def.type === 'skill') {
    next.playedCardsThisTurn = [
      ...(next.playedCardsThisTurn ?? []),
      {
        playerId: actor.id,
        card: forgetRetain(copy.card),
        copied: sourceIsCopy,
        type: def.type,
      },
    ]
  }
  const ctx = resolutionContext(
    context, def, attachedGemId ? { ...copy.card, attachedGemId } : copy.card, copy.energySpent,
    sourceIsCopy,
  )
  ctx.hermitRapidFireCard = copy.hermitRapidFireCard === true
  next.log = [...next.log, `${actor.name} played ${def.name}`]

  let remainingEffects: Effect[] | undefined
  for (const [index, effect] of effects.entries()) {
    applyEffect(next, actor, effect, def.target ?? 'enemy', def.supportTarget ?? 'self', ctx)
    if (invalidPlayChoice(ctx)) return state
    if (cardResolutionIsOver(next, ctx, actor)) {
      delete next.pendingCardCopy
      return finishForcedCardPlay(settle(next), copy.forcedChoices)
    }
    if (ctx.doppelgangerCopy) {
      remainingEffects = effects.slice(index + 1)
      break
    }
  }
  resolvePendingSlimeCommands(next, actor, ctx)
  if (invalidPlayChoice(ctx)) return state
  if (cardResolutionIsOver(next, ctx, actor)) {
    delete next.pendingCardCopy
    return finishForcedCardPlay(settle(next), copy.forcedChoices)
  }
  // The forced child is part of a copied Havoc. Suspend this copy until that
  // child finishes, just as the copied Havoc does above.
  if (def.id === 'havoc' && next.startTurnProgress?.forcedCard) {
    next.startTurnProgress.forcedCard.deferredHavocs = [
      ...copy.deferredHavocs,
      { card: { ...copy.card }, exhaust: copy.forcedExhaust, virtualOnly: copy.virtualOnly,
        ...(copy.sourceNames.length > 1 ? {
          copySourceNames: copy.sourceNames.slice(1) as CopySource[],
          copyResumePhase: copy.resumePhase,
        } : {}) },
    ]
    next.startTurnProgress.forcedCard.pendingTriggers = [...(ctx.pendingTriggers ?? [])]
    if (copy.deferredTriggers?.length) {
      next.startTurnProgress.forcedCard.pendingTriggers.push(...copy.deferredTriggers)
    }
    if (copy.forcedChoices) {
      next.startTurnProgress.choices = copy.forcedChoices.map((choice) => ({ ...choice }))
    }
    delete next.pendingCardCopy
    next.phase = copy.resumePhase
    return settle(next)
  }
  if (invalidPlayChoice(ctx)) return state

  resolvePendingEnemyReactions(next, actor, ctx)
  if (combatIsOver(next)) {
    delete next.pendingCardCopy
    return finishForcedCardPlay(settle(next), copy.forcedChoices)
  }

  for (const pendingDiscard of ctx.pendingDiscards ?? []) {
    const owner = findPlayer(next, pendingDiscard.playerId)
    if (owner) resolveDiscardReactions(next, owner, pendingDiscard.cards)
    if (combatIsOver(next)) {
      delete next.pendingCardCopy
      return finishForcedCardPlay(settle(next), copy.forcedChoices)
    }
  }
  const finalCopy = copy.sourceNames.length === 1
  if (ctx.doppelgangerCopy) {
    const corrupt = skillExhausts(next, actor, def)
    const baseSources = ctx.queuedCopySourceNames ?? (ctx.queuedCopyTwice
      ? [ctx.queuedCopySource ?? 'Doppelganger', ctx.queuedCopySource ?? 'Doppelganger']
      : [ctx.queuedCopySource ?? 'Doppelganger'])
    next.pendingCardCopy = {
      id: next.nextTriggerId++,
      playerId: actor.id,
      card: ctx.doppelgangerCopy,
      energySpent: copy.energySpent,
      resumePhase: copy.resumePhase,
      forcedExhaust: ctx.queuedCopyForcedExhaust === true,
      forcedChoices: copy.forcedChoices,
      deferredHavocs: [
        ...copy.deferredHavocs,
        { card: forgetRetain(copy.card), exhaust: def.exhaust === true || copy.forcedExhaust || corrupt,
          virtualOnly: copy.virtualOnly,
          remainingEffects,
          ...(copy.sourceNames.length > 1 ? {
            copySourceNames: copy.sourceNames.slice(1) as CopySource[],
            copyResumePhase: copy.resumePhase,
          } : {}) },
      ],
      deferredTriggers: [...(copy.deferredTriggers ?? []), ...(ctx.pendingTriggers ?? [])],
      ...queuedRapidFire(ctx.doppelgangerCopy, actor, baseSources),
      ...(ctx.queuedCopyTwiceIfAttack ? { repeatIfAttack: true } : {}),
      virtualOnly: ctx.queuedCopyVirtualOnly ?? true,
      queuedWeaves: ctx.queuedWeaves,
      queuedCopySources: ctx.queuedCopySources,
      consumeFreeCard: ctx.consumeQueuedFreeCard,
      consumeFreeAttack: ctx.consumeQueuedFreeAttack,
    }
    next.phase = 'copy'
    return settleForbiddenPendingCopy(next, actor)
  }
  if (finalCopy && !copy.virtualOnly) cleanupPlayedCard(next, actor, copy.card, def, ctx, copy.forcedExhaust)
  if (invalidPlayChoice(ctx)) return state
  if (combatIsOver(next)) {
    delete next.pendingCardCopy
    return finishForcedCardPlay(settle(next), copy.forcedChoices)
  }
  resolveSlimeBossPlayReactions(next, actor, def, copy.card, ctx)
  if (combatIsOver(next)) {
    delete next.pendingCardCopy
    return finishForcedCardPlay(settle(next), copy.forcedChoices)
  }
  if (def.guardian?.printedType.startsWith('Gem') &&
    actor.powers.some((power) => power.defId === 'guardian_brilliant_scales')) {
    const before = actor.block
    if (playerCanGainBlock(actor)) actor.block = gainBlock(actor.block, 1)
    if (actor.block > before) next.log = [...next.log, `${actor.name}'s Brilliant Scales grants 1 Block`]
  }
  for (const pendingExhaust of ctx.pendingExhaustTriggers ?? []) {
    const owner = findPlayer(next, pendingExhaust.playerId)
    if (owner) resolveExhaustReaction(next, owner, pendingExhaust.card)
    if (combatIsOver(next)) {
      delete next.pendingCardCopy
      return finishForcedCardPlay(settle(next), copy.forcedChoices)
    }
  }
  for (const ownerId of ctx.pendingPoisonTriggers ?? []) {
    const owner = findPlayer(next, ownerId)
    if (owner) fireTriggers(next, { kind: 'onApplyPoison' }, owner)
    if (combatIsOver(next)) {
      delete next.pendingCardCopy
      return finishForcedCardPlay(settle(next), copy.forcedChoices)
    }
  }
  for (const pendingToken of ctx.pendingEnemyTokenTriggers ?? []) {
    const owner = findPlayer(next, pendingToken.playerId)
    if (owner) fireTriggers(next, { kind: 'onPutEnemyToken', enemyUid: pendingToken.enemyUid }, owner)
    if (combatIsOver(next)) {
      delete next.pendingCardCopy
      return finishForcedCardPlay(settle(next), copy.forcedChoices)
    }
  }

  if (def.type === 'attack' && !ctx.sourceAttackCounted) {
    recordAttackPlayed(next, actor)
  }
  fireTriggers(next, { kind: 'onPlayCard', cardType: def.type }, actor, copy.card.uid)
  if (def.type === 'skill') resolveEnraged(next, actor)
  if (combatIsOver(next)) {
    delete next.pendingCardCopy
    return finishForcedCardPlay(settle(next), copy.forcedChoices)
  }
  if (!finalCopy) {
    copy.sourceNames = copy.sourceNames.slice(1)
    copy.id = next.nextTriggerId++
    next.log = [...next.log, `${actor.name}'s ${copy.sourceNames[0]} copy finished; ${def.name} remains to resolve`]
    releasePendingTriggers(next, ctx)
    return settleForbiddenPendingCopy(next, actor)
  }
  if (copy.queuedWeaves?.length) {
    const woven = copy.queuedWeaves[0]!
    const queuedWeaves = copy.queuedWeaves.slice(1)
    const weave = faceOf(cardDef(woven.defId), woven.upgraded)
    const queuedCopySources = copySourcesFor(weave, actor)
    const sourceNames = queuedCopySources.length > 0
      ? [...queuedCopySources, queuedCopySources.at(-1)!]
      : ['Weave' as const]
    next.pendingCardCopy = {
      id: next.nextTriggerId++,
      playerId: actor.id,
      card: { ...woven, scryDamageBonus: weave.scryPlayBonus },
      energySpent: 0,
      resumePhase: copy.resumePhase,
      forcedExhaust: false,
      forcedChoices: copy.forcedChoices,
      deferredHavocs: copy.deferredHavocs,
      deferredTriggers: [...(copy.deferredTriggers ?? []), ...(ctx.pendingTriggers ?? [])],
      sourceNames,
      queuedWeaves,
      queuedCopySources,
      consumeFreeCard: (actor.freeCardsThisTurn ?? 0) > 0,
      consumeFreeAttack: (actor.freeAttacksThisTurn ?? 0) > 0,
    }
    next.phase = 'copy'
    return settleForbiddenPendingCopy(next, actor)
  }
  delete next.pendingCardCopy
  next.phase = copy.resumePhase
  const resumedTriggers = finishDeferredHavocs(next, actor, copy.deferredHavocs)
  ctx.pendingTriggers = [
    ...(copy.deferredTriggers ?? []), ...(ctx.pendingTriggers ?? []), ...resumedTriggers,
  ]
  releasePendingTriggers(next, ctx)
  return finishCardCopy(settleForbiddenPendingCopy(next, actor), copy.forcedChoices)
}

function skipCardCopy(state: CombatState, playerId: string, reason: string): CombatState {
  const pending = state.pendingCardCopy
  if (state.phase !== 'copy' || !pending || pending.playerId !== playerId) return state
  const next = clone(state)
  const copy = next.pendingCardCopy!
  const actor = findPlayer(next, playerId)
  if (!actor) return state
  delete next.pendingCardCopy
  next.phase = copy.resumePhase
  const def = effectiveCombatCardDef(
    faceOf(cardDef(copy.card.defId), copy.card.upgraded), actor.guardianMode,
  )
  const ctx = resolutionContext({ enemyUid: null, playerId }, def, copy.card, copy.energySpent)
  if (!copy.virtualOnly) cleanupPlayedCard(next, actor, copy.card, def, ctx, copy.forcedExhaust)
  for (const woven of copy.queuedWeaves ?? []) actor.discard.push(forgetRetain(woven))
  for (const pendingExhaust of ctx.pendingExhaustTriggers ?? []) {
    const owner = findPlayer(next, pendingExhaust.playerId)
    if (owner) resolveExhaustReaction(next, owner, pendingExhaust.card)
  }
  next.log = [...next.log, copy.virtualOnly
    ? `${actor.name}'s ${copy.sourceNames[0]} copy of ${def.name} ${reason}`
    : `${actor.name}'s original ${def.name} ${reason}`]
  const resumedTriggers = finishDeferredHavocs(next, actor, copy.deferredHavocs)
  releasePendingTriggers(next, {
    enemyUid: null,
    playerId: actor.id,
    pendingTriggers: [...(copy.deferredTriggers ?? []), ...resumedTriggers],
  })
  return finishCardCopy(settleForbiddenPendingCopy(next, actor), copy.forcedChoices)
}

/** Releases a disconnected owner without letting the rest of the party deadlock. */
export function abandonCardCopy(state: CombatState, playerId: string): CombatState {
  return skipCardCopy(state, playerId, 'was skipped after disconnecting')
}

/** Privately previews the original card's post-copy draw or Scry choice. */
export function previewCardCopyChoice(state: CombatState, playerId: string): CardChoicePreview | null {
  const pending = state.pendingCardCopy
  const player = findPlayer(state, playerId)
  if (state.phase !== 'copy' || !pending || pending.playerId !== playerId || !player || player.dead ||
    player.cardPlayLocked || reachedTimeWarpLimit(state, player)) return null
  const def = faceOf(cardDef(pending.card.defId), pending.card.upgraded)
  if (!cardNeedsChoicePreview(def, state, player)) return null

  const preview = clone(state)
  const actor = findPlayer(preview, playerId)!
  let drew = false
  for (const effect of def.effects) {
    if (!effectIsActive(effect, preview, actor)) continue
    if (effect.kind === 'searchDraw' || effect.kind === 'searchDrawAndPlayTwice') {
      return choicePreview(preview, 'search', effect.kind === 'searchDraw'
        ? actor.draw
        : omniscienceEligibleCards(preview, actor))
    } else if ((effect as { kind: string }).kind === 'replicateSlime') {
      return choicePreview(preview, 'search', actor.draw.filter((card) => cardDef(card.defId).cardKind === 'slime'))
    } else if (effect.kind === 'draw') {
      drawInto(preview, actor, amountOf(effect.amount, preview, actor, undefined, {
        enemyUid: null, playerId, energySpent: pending.energySpent,
      }), [])
      drew = true
    } else if (drew && (effect as { kind: string }).kind === 'overexert') {
      return choicePreview(preview, 'search', actor.hand.filter((card) => {
        const candidate = faceOf(cardDef(card.defId), card.upgraded)
        return cardIsPlayable(candidate, preview, actor) && (candidate.minimumX ?? 0) === 0
      }))
    } else if (effect.kind === 'scry') {
      return choicePreview(preview, 'scry', actor.draw.slice(0, effect.amount))
    } else if (effect.kind === 'scryToHand') {
      return choicePreview(preview, 'scryToHand', actor.draw.slice(0, effect.amount))
    } else if (drew && effect.kind === 'discard') {
      return choicePreview(preview, 'discard', actor.hand)
    } else if (drew && effect.kind === 'topdeck') {
      return choicePreview(preview, 'topdeck', actor.hand)
    } else if (drew && effect.kind === 'load') {
      const source = effect.source ?? 'hand'
      return choicePreview(preview, effect.upTo ? 'loadAny' : 'load', actor[source])
    }
  }
  return null
}

/** Activates a printed once-per-turn Power during the shared Player Turn. */
export function activatePower(
  state: CombatState,
  playerId: string,
  powerUid: string,
  context: PowerContext = {},
): CombatState {
  if (!activePowerWindow(state) || state.startTurnProgress?.forcedCard || mandatoryChoicePending(state) ||
    (state.pendingTriggers?.length ?? 0) > 0) return state
  const player = findPlayer(state, playerId)
  const held = player?.powers.find((power) => power.uid === powerUid)
  if (!player || player.dead || !held) return state
  const def = faceOf(cardDef(held.defId), held.upgraded)
  if (!def.activeAbility || def.oncePerTurn && powerAbilityUsed(state, playerId, powerUid)) return state
  if (held.defId === 'guardian_revenge_protocol') {
    const selected = player.hand.find((card) => card.uid === context.cardUid)
    const selectedDef = selected && faceOf(cardDef(selected.defId), selected.upgraded)
    const selectedType = selectedDef && effectiveCombatCardDef(selectedDef, player.guardianMode).type
    if (player.guardianMode !== 'attack' || !selected || !selectedDef || selectedType !== 'attack' ||
      !cardIsPlayable(selectedDef, state, player) || (selectedDef.minimumX ?? 0) > 0 ||
      !cardCanBeForced(selectedDef, state, player, guardianGemForCard(player, selected), selected.uid)) return state
    const next = clone(state)
    next.powerTriggersUsedThisTurn.push(powerAbilityKey(playerId, powerUid))
    next.startTurnProgress = { choices: [], forcedCard: {
      playerId, cardUid: selected.uid, sourceCardId: held.defId, exhaustNonPower: false,
      ...(state.phase === 'start' ? { resumeOpenStart: true } : {}),
    } }
    next.log = [...next.log, `${player.name}'s Revenge Protocol makes ${selectedDef.name} cost 0`]
    return next
  }
  const energyCost = def.effects.reduce((sum, effect) => sum + (effect.kind === 'spendEnergy' ? effect.amount : 0), 0)
  if (player.energy < energyCost) return state
  if (def.target === 'row') {
    if (!rowExists(state, context.enemyRow)) return state
  } else if (cardNeedsEnemy(def, player, true, undefined, true, held.attachedGemId) &&
    resolveEnemyTargets(state, def.target ?? 'enemy', context.enemyUid ?? null).length === 0) return state
  if (guardianCardNeedsAlly(def, player, held.attachedGemId) && context.playerId !== undefined &&
    !state.players.some((candidate) => candidate.id === context.playerId && !candidate.dead)) return state

  const next = clone(state)
  const actor = findPlayer(next, playerId)!
  if (def.oncePerTurn) next.powerTriggersUsedThisTurn.push(powerAbilityKey(playerId, powerUid))
  const playContext: PlayContext = {
    enemyUid: context.enemyUid ?? null,
    enemyRow: context.enemyRow,
    playerId: context.playerId ?? playerId,
    exhaustUids: context.exhaustUids,
    guardianModeShift: context.guardianModeShift,
    sourcePowerUid: powerUid,
    loadUids: context.loadUids,
    chamberUids: context.chamberUids,
    hermitEnemyUids: context.hermitEnemyUids,
    scryDiscardUids: context.scryDiscardUids,
    sourceAttachedGemId: held.attachedGemId,
  }
  for (const effect of def.effects) {
    applyEffect(next, actor, effect, def.target ?? 'enemy', def.supportTarget ?? 'self', playContext,
      `${actor.name}'s ${def.name}`)
    if (combatIsOver(next)) return settle(next)
  }
  if (invalidPlayChoice(playContext)) return state
  return settle(next)
}

/** Private top-of-draw preview for active Powers such as Gem Finder. */
export function previewPowerChoice(
  state: CombatState,
  playerId: string,
  powerUid: string,
): CardChoicePreview | null {
  if (!activePowerWindow(state) || state.startTurnProgress?.forcedCard || mandatoryChoicePending(state) ||
    (state.pendingTriggers?.length ?? 0) > 0) return null
  const player = findPlayer(state, playerId)
  const held = player?.powers.find((power) => power.uid === powerUid)
  if (!player || player.dead || !held || powerAbilityUsed(state, playerId, powerUid)) return null
  const def = faceOf(cardDef(held.defId), held.upgraded)
  return held.defId === 'guardian_gem_finder' && def.activeAbility
    ? { kind: 'scry', cards: player.draw.slice(0, held.upgraded ? 4 : 3) }
    : null
}

/** Settles a disconnected owner's private forced card and resumes queued abilities. */
export function abandonForcedCard(state: CombatState, playerId: string): CombatState {
  const forced = state.startTurnProgress?.forcedCard
  if ((state.phase !== 'start' && state.phase !== 'player' && state.phase !== 'discard') || forced?.playerId !== playerId ||
    typeof forced.cardUid !== 'string') return state
  const next = clone(state)
  const actor = findPlayer(next, playerId)
  const card = actor?.hand.find((held) => held.uid === forced.cardUid)
  if (!actor || !card) return state
  const choices = state.phase === 'start' && !forced.resumeOpenStart
    ? [...(next.startTurnProgress?.choices ?? [])] : null
  next.startTurnProgress = undefined
  if (forced.exhaustNonPower && !cardStaysInPlay(faceOf(cardDef(card.defId), card.upgraded))) {
    actor.hand = actor.hand.filter((held) => held.uid !== card.uid)
    exhaustCards(next, actor, [card])
  } else {
    discardByCardEffect(next, actor, [card])
  }
  next.log = [...next.log, `${actor.name}'s ${cardDef(forced.sourceCardId ?? 'mayhem').name} card was settled after disconnecting`]
  const resumedTriggers = finishDeferredHavocs(next, actor, forced.deferredHavocs ?? [])
  releasePendingTriggers(next, {
    enemyUid: null,
    playerId: actor.id,
    pendingTriggers: [...(forced.pendingTriggers ?? []), ...resumedTriggers],
  })
  return finishForcedCardPlay(settleForbiddenPendingCopy(next, actor), choices)
}
