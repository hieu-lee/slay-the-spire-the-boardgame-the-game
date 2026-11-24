// Start of Turn: reset, draw, roll the shared die, then work through the
// abilities that answer the new turn in the order the table chose (p.12).
//
// The phase is resumable on purpose. A Scry, a Facing choice or a forced card
// stops the sequence mid-way and parks its progress on the state, because the
// answer has to come from a player — and in a multiplayer game, from a player
// whose hand nobody else may see.
import {
  clone,
  combatIsOver,
  enemyLabel,
  nextEnemyCopy,
  findPlayer,
  livingEnemies,
  orbDamageTargets,
} from './board.ts'
import {
  applyEffect,
  dieRelicEffectsForParty,
  discardByCardEffect,
  drawInto,
  flushPendingTriggers,
  pendingTriggerSlimeEnemyChoiceCount,
  publishTurnEffect,
  publishTurnEffectApplications,
  discardTopLine,
  resolveTriggerSource,
  takeDiscardTop,
  resolveShivAttack,
  settle,
  triggerHermitChoices,
  triggerNeedsEnemyChoice,
  triggerNeedsHermitChoice,
  triggerNeedsPlayerChoice,
  triggerNeedsRowChoice,
  triggerSlimeChoice,
  triggerSourceById,
  triggerSources,
} from './effects.ts'
import { applyEnemyAction } from './enemy-turn.ts'
import { addStatus, damageEnemy } from './pieces.ts'
import { discardOrderNeedsChoice, effectEvokePlan, effectIsActive, invalidPlayChoice, mandatoryChoicePending, owedPlayerChoices, reachesEnemy } from './queries.ts'
import {
  defaultStartTurnChoices,
  defaultStartTurnChoicesForOrder,
  facingChoicesAreValid,
  facingRowPlan,
  hasPostRollStartTurnChoice,
  isPostRollStartTurnPotionChoice,
  isPostRollStartTurnRelicChoice,
  pendingStartTurnSources,
  playerHasPostRollStartTurnChoice,
  startTurnAbilities,
  startTurnAbilitiesFor,
  startTurnChoicePending,
  startTurnDiscardPreview,
  startTurnOrderChoicePlayerIdWithResolver,
  startTurnPowerLeftPlay,
  startTurnScryAbilities,
  startTurnScryPreview,
  startTurnSources,
  triggerTargets,
  validStartTurnOrder,
} from './start-turn-queries.ts'
import type {
  CombatState,
  PlayerChoiceAnswer,
  StartTurnAbility,
  StartTurnChoice,
  TriggerSource,
  PlayContext,
  TurnEffectPresentation,
} from './types.ts'
import { cardDef } from '../cards.ts'
import { gainBlock, gainVulnerable } from '../damage.ts'
import { drawSummon, enemyAbilities, enemyDef, startingHp } from '../enemies.ts'
import { nextInt } from '../rng.ts'
import { CAPS } from '../types.ts'
import type { Enemy, Player } from '../types.ts'
import { clearSlimeTurn } from '../downfall/slime-boss.ts'
import { shiftGuardianMode } from '../downfall/guardian.ts'
import { chosenDieRelicAbilities, relicDef, TURN_REFRESH_RELICS } from '../relics.ts'

export {
  defaultStartTurnChoices,
  facingChoicesAreValid,
  hasPostRollStartTurnChoice,
  isPostRollStartTurnPotionChoice,
  isPostRollStartTurnRelicChoice,
  playerHasPostRollStartTurnChoice,
  startTurnAbilities,
  startTurnChoicePending,
  startTurnDiscardPreview,
  startTurnScryAbilities,
  startTurnScryPreview,
  triggerTargets,
}

/**
 * Begins a Player Turn: either the first of the combat, or the one that
 * follows a finished Enemy Turn.
 *
 * The guard is the point. This is reachable from the network through the room
 * layer, and while it was callable at any moment a client could re-run it to
 * refill Energy, deal itself a fresh hand, and skip the Enemy Turn entirely.
 * Only two states may begin a turn: a combat that has not started, and a round
 * whose Enemy Turn has just ended.
 */
export function preparePlayerTurn(state: CombatState): CombatState {
  if (mandatoryChoicePending(state)) return state
  const opening = state.turn === 0
  if (!opening && state.phase !== 'roundEnd') return state
  return beginPlayerTurn(clone(state))
}

/** Begins a turn but pauses after opening hands, before the shared Roll. */
export function preparePlayerTurnThroughDraw(state: CombatState): CombatState {
  if (mandatoryChoicePending(state)) return state
  const opening = state.turn === 0
  if (!opening && state.phase !== 'roundEnd') return state
  return beginPlayerTurn(clone(state), true)
}

export function resolveDueSummons(next: CombatState, timing: 'startOfTurn' | 'endOfTurn'): void {
  const due = next.pendingSummons.filter((summon) =>
    (summon.timing ?? 'startOfTurn') === timing && summon.turn <= next.turn)
  next.pendingSummons = next.pendingSummons.filter((summon) => !due.includes(summon))
  for (const summon of due) {
    const source = next.enemies.find((enemy) => enemy.uid === summon.sourceUid)
    const ascension = source?.ascension
    summon.defIds.forEach((name, index) => {
      const defId = summon.direct ? name : drawSummon(next.summonSupply, name)
      if (!defId) {
        next.log = [...next.log, `No ${enemyDef(name).name} remained in the Summons deck`]
        return
      }
      const def = enemyDef(defId, ascension)
      const hp = startingHp(def, next.players.length)
      const summonBuff = source && enemyAbilities(enemyDef(source.defId, source.ascension))
        .find((ability) => ability.kind === 'buffSummons' && defId.startsWith(ability.defIdPrefix))
      const summoned: Enemy = {
        uid: `${summon.sourceUid}-summon-${next.turn}-${summon.row}-${index}`,
        defId, row: summon.row, isBoss: summon.isBoss ?? false, ascension,
        hp, maxHp: hp, block: summonBuff?.kind === 'buffSummons' ? summonBuff.block : 0,
        strength: (summon.strengthDefId === undefined || summon.strengthDefId === name ? summon.strength ?? 0 : 0) +
          (summon.strengthPerPower
            ? Math.max(0, ...next.players.filter((player) => !player.dead).map((player) => player.powers.length))
            : 0) + (summonBuff?.kind === 'buffSummons' ? summonBuff.strength : 0),
        vulnerable: 0, weak: 0, poison: 0, goldReward: 0, cardReward: null,
        actionIndex: 0, phase: 0, abilityUsed: false, dead: false,
        copy: nextEnemyCopy(next.enemies, def.name),
      }
      const sourceIndex = source && source.row === summon.row &&
        (source.isBoss || enemyDef(source.defId, source.ascension).elite)
        ? next.enemies.indexOf(source) : -1
      if (sourceIndex < 0) next.enemies.push(summoned)
      else next.enemies.splice(sourceIndex, 0, summoned)
      next.log = [...next.log, `${def.name} was summoned`]
    })
  }
}

export function finishStartTurnDraw(next: CombatState, drewFrom: number, roll: boolean): void {
  if (roll) next.die = nextInt(next.rng, 6) + 1
  if (roll) for (const player of next.players) {
    const snecko = next.enemies.find((enemy) => !enemy.dead && enemy.row === player.row &&
      enemyAbilities(enemyDef(enemy.defId, enemy.ascension)).some((ability) => ability.kind === 'confusion'))
    const confusion = snecko && enemyAbilities(enemyDef(snecko.defId, snecko.ascension))
      .find((ability) => ability.kind === 'confusion')
    if (confusion?.kind === 'confusion') player.enemyNextCardCost = confusion.byRoll[next.die] ?? null
  }
  next.log = [
    ...next.log.slice(0, drewFrom),
    `Turn ${next.turn} begins${roll ? ` (die ${next.die})` : ''}`,
    ...next.log.slice(drewFrom),
  ]
}

function continueStartTurnDraw(next: CombatState, drewFrom: number, pauseAfterDraw = false): CombatState {
  for (const player of next.players) {
    if (player.dead) continue
    for (const relic of player.relics) {
      if (TURN_REFRESH_RELICS.has(relic.defId)) relic.spent = false
    }
    drawInto(next, player, 5)
  }

  flushPendingTriggers(next)
  if (!combatIsOver(next) && next.pendingTriggers.length === 0) queueHermitSetupLoads(next)
  if (combatIsOver(next)) {
    finishStartTurnDraw(next, drewFrom, false)
    return settle(next)
  }
  if (next.pendingTriggers.length > 0 || (next.pendingHermitSetupLoads?.length ?? 0) > 0) {
    next.startTurnProgress = { choices: [], rollPending: { drewFrom, pauseAfterDraw } }
    return next
  }
  if (pauseAfterDraw) {
    next.startTurnProgress = { choices: [], pauseAfterDraw: { drewFrom } }
    return next
  }
  // One roll per round; every die effect this round reads this value. It comes
  // after every Draw-step reaction, so the die cannot inform those choices.
  finishStartTurnDraw(next, drewFrom, true)
  return next
}

/**
 * The Hermit board's Start of Combat ability: draw 1, then Load 1. Start of
 * Combat abilities resolve after the opening Draw, so the Load chooses from
 * the whole six-card hand. It runs once per combat; while its private Load
 * choices wait, the Draw step stays paused before the Roll. Mutates `next`.
 */
export function queueHermitSetupLoads(next: CombatState): void {
  if (next.turn !== 1 || next.hermitSetupQueued !== false) return
  next.hermitSetupQueued = true
  for (const player of next.players) {
    if (player.dead || player.character !== 'hermit') continue
    if (drawInto(next, player, 1).length > 0) {
      next.log = [...next.log, `${player.name} draws 1 card for the Hermit board ability`]
    }
    if (player.hand.length > 0 && player.chamber.length < player.chamberSlots) {
      next.pendingHermitSetupLoads = [...(next.pendingHermitSetupLoads ?? []), { playerId: player.id }]
    }
  }
  flushPendingTriggers(next)
}

/**
 * Continues the paused Draw step once the last Hermit setup Load resolves.
 * `prepared` marks Mysterious Sphere's prepared combat, which pauses after the
 * Draw; only combats saved at the old turn-0 setup Load need to be told.
 * Mutates `next`.
 */
export function resumeStartTurnAfterHermitSetup(next: CombatState, prepared = false): CombatState {
  const rollPending = next.startTurnProgress?.rollPending
  // A Loaded Curse can end the fight; the turn still gets its log divider, unrolled.
  if (rollPending && combatIsOver(next)) finishStartTurnDraw(next, rollPending.drewFrom, false)
  settle(next)
  if (next.turn === 0 && next.phase === 'player') {
    // Saved before the ability moved after the opening hand: its draw and Load already happened.
    if ((next.pendingHermitSetupLoads?.length ?? 0) > 0) return next
    next.hermitSetupQueued = true
    return prepared ? preparePlayerTurnThroughDraw(next) : startPlayerTurnWithChoices(next)
  }
  if (next.phase !== 'start' || !rollPending || next.pendingTriggers.length > 0 ||
    (next.pendingHermitSetupLoads?.length ?? 0) > 0) return next
  if (rollPending.pauseAfterDraw) {
    next.startTurnProgress = { choices: [], pauseAfterDraw: { drewFrom: rollPending.drewFrom } }
    return next
  }
  next.startTurnProgress = undefined
  finishStartTurnDraw(next, rollPending.drewFrom, true)
  return finishPreparedStartTurnWithChoices(next)
}

/** Start of Turn: reset, draw 5, then roll the shared die (p.12). Mutates `next`. */
function beginPlayerTurn(next: CombatState, pauseAfterDraw = false): CombatState {
  const opening = next.turn === 0
  next.phase = 'start'
  next.turn += 1
  resolveDueSummons(next, 'startOfTurn')
  for (const enemy of next.enemies) {
    if (!enemy.pendingDefId) continue
    enemy.defId = enemy.pendingDefId
    enemy.pendingDefId = undefined
    enemy.actionIndex = 0
    next.log = [...next.log, `${enemyLabel(next.enemies, enemy)} enters Defensive Mode`]
  }
  for (const source of next.enemies.filter((enemy) => !enemy.dead)) {
    for (const ability of enemyAbilities(enemyDef(source.defId, source.ascension))) {
      if (ability.kind === 'startRoundSelfVulnerable') {
        const before = source.vulnerable
        source.vulnerable = gainVulnerable(source.vulnerable, ability.amount)
        if (source.vulnerable > before) {
          next.log = [...next.log,
            `${enemyLabel(next.enemies, source)} gains ${source.vulnerable - before} Vulnerable`]
          const actor = next.players.find((player) => !player.dead) ?? next.players[0]
          if (actor) publishTurnEffect(next, actor.id, source.defId, 'vulnerable', { enemyIds: [source.uid] })
        }
      }
      if (ability.kind === 'reviveOnePerRow') {
        const revived: string[] = []
        for (const row of new Set(next.players.filter((player) => !player.dead).map((player) => player.row))) {
          const target = next.enemies.find((enemy) => enemy.dead && enemy.row === row &&
            enemy.defId.startsWith(ability.defIdPrefix))
          if (!target) continue
          target.dead = false
          target.hp = startingHp(enemyDef(target.defId, target.ascension), next.players.length)
          target.block = target.vulnerable = target.weak = target.poison = 0
          target.strength = 0
          target.actionIndex = 0
          target.abilityUsed = false
          revived.push(target.uid)
          next.log = [...next.log, `${enemyLabel(next.enemies, target)} revives through Infinite Blades`]
        }
        const actor = next.players.find((player) => !player.dead) ?? next.players[0]
        if (actor && revived.length > 0) publishTurnEffect(next, actor.id, source.defId, 'heal', { enemyIds: revived })
      }
    }
  }
  next.discardedThisTurn = []
  next.stanceChangedThisTurn = []
  next.powerTriggersUsedThisTurn = []
  next.playedCardsThisTurn = []
  next.partyAttackDiscount = false
  next.startTurnStage = 'effects'
  next.startTurnProgress = undefined
  // Where this round's log starts, so the divider can be placed above anything
  // the Start of Turn itself writes.
  const drewFrom = next.log.length

  // The Start of Turn phases run in the order the rulebook prints them (p.12):
  // Reset, Draw, Roll, then start-of-turn abilities. The order matters even
  // though the roll is independent of the draw today, because it decides which
  // RNG values each step consumes — swapping them changes every seeded replay.
  //
  // Reset is its own pass over the whole party before ANY drawing starts. The
  // rulebook prints them as two numbered steps, and now that drawing can fire
  // a Power, an interleaved loop would let one player's on-draw Block be wiped
  // by a later player's reset.
  for (const player of next.players) {
    if (player.dead) continue
    const leftover = !opening && player.relics.some((relic) => relic.defId === 'ice_cream') ? player.energy : 0
    player.energy = Math.min(CAPS.energy, 3 + leftover)
    player.nextCardCost = null
    player.enemyNextCardCost = null
    const shieldCharger = player.powers.find((power) => power.defId === 'guardian_shield_charger')
    if (shieldCharger) player.block = Math.min(player.block, shieldCharger.upgraded ? 3 : 2)
    const keepBlock = Boolean(shieldCharger) || player.powers.some((power) => cardDef(power.defId).retainBlock) || player.calipersArmed
    if (!keepBlock) player.block = 0
    player.calipersArmed = false
    player.drawLocked = false
    // Slayer Pack: Brutality reads the round that just ended; kept only when true so
    // existing saves and replays serialise exactly as before.
    if ((player.hpLostThisRound ?? 0) > 0) player.lostHpLastRound = true
    else delete player.lostHpLastRound
    player.hpLostThisRound = 0
    player.hpLossLimitThisRound = undefined
    player.freeCardsThisTurn = 0
    player.freeAttacksThisTurn = 0
    player.freeGemCardsThisTurn = 0
    player.freePowersThisTurn = 0
    player.cardPlayLocked = false
    player.doubledAttacksThisTurn = 0
    player.tripledAttacksThisTurn = 0
    player.doubledCardsThisTurn = 0
    player.doubledSkillsThisTurn = 0
    player.retainCardsThisTurn = 0
    delete player.retainBlockAllowance
    player.cardsPlayedThisTurn = 0
    player.energySpentThisTurn = 0
    player.spentTwoEnergyOnCardThisTurn = false
    player.nextPowerOrSlimeDiscount = undefined
    player.powerPlayedThisTurn = false
    player.damageDealtZeroThisTurn = false
    player.soulburnUsedThisTurn = false
    player.nextSoulburnDamageBonus = 0
    player.exhaustNextCardAfterUid = undefined
    player.attacksPlayedThisTurn = 0
    for (const slime of player.slimes) clearSlimeTurn(slime)
    player.nextAttackRapidFire = 0
    for (const pile of ['hand', 'draw', 'discard', 'exhaust', 'powers', 'chamber'] as const) {
      player[pile] = player[pile].map(({
        freeThisTurn: _free,
        costReductionThisTurn: _reduction,
        ...card
      }) => card)
    }
  }
  const beforeDraw = next.players.flatMap((player) => player.dead ? [] :
    triggerSources(player, { kind: 'beforeDraw' }).map((source) => ({
      playerId: player.id, sourceId: source.id,
    })))
  const actionableBeforeDraw = beforeDraw.filter(({ playerId, sourceId }) => {
    const player = findPlayer(next, playerId)!
    const source = triggerSourceById(player, sourceId)!
    if (player.draw.length > 0) return true
    resolveTriggerSource(next, player, source, { scryDiscardUids: [] })
    return false
  })
  if (actionableBeforeDraw.length > 0) {
    const amountsByPlayer = new Map<string, Set<number>>()
    for (const { playerId, sourceId } of actionableBeforeDraw) {
      const player = findPlayer(next, playerId)!
      const source = triggerSourceById(player, sourceId)!
      const amount = source.effects.find((effect) => effect.kind === 'scry')?.amount
      if (amount === undefined) continue
      const amounts = amountsByPlayer.get(playerId) ?? new Set<number>()
      amounts.add(amount)
      amountsByPlayer.set(playerId, amounts)
    }
    const orderMatters = [...amountsByPlayer.values()].some((amounts) => amounts.size > 1)
    next.startTurnProgress = {
      choices: [], beforeDraw: {
        drewFrom, sources: actionableBeforeDraw, ordered: !orderMatters, pauseAfterDraw,
      },
    }
    return resolveEmptyStartTurnScries(next)
  }
  return continueStartTurnDraw(next, drewFrom, pauseAfterDraw)
}

/** Empty private previews have only one legal outcome: keep nothing and continue. */
function resolveEmptyStartTurnScries(state: CombatState): CombatState {
  const preview = startTurnScryPreview(state)
  return preview && preview.cards.length === 0
    ? resolveStartTurnScry(state, preview.playerId, preview.id, [])
    : state
}

export function orderStartTurnScries(state: CombatState, order: readonly string[]): CombatState {
  const progress = state.phase === 'start' ? state.startTurnProgress?.beforeDraw : undefined
  if (!progress || progress.ordered || state.pendingTriggers.length > 0) return state
  const byId = new Map(progress.sources.map((source) => [
    `${state.combatId}/${state.turn}/${source.playerId}/${source.sourceId}`, source,
  ]))
  if (order.length !== byId.size || new Set(order).size !== byId.size ||
    order.some((id) => !byId.has(id))) return state
  const next = clone(state)
  next.startTurnProgress!.beforeDraw!.sources = order.map((id) => ({ ...byId.get(id)! }))
  next.startTurnProgress!.beforeDraw!.ordered = true
  return next
}

export function continueBeforeDraw(state: CombatState): CombatState {
  const progress = state.startTurnProgress?.beforeDraw
  if (state.pendingCardCopy) return state
  if (!progress || progress.sources.length > 0 || state.pendingTriggers.length > 0) return settle(state)
  state.startTurnProgress = undefined
  const continued = continueStartTurnDraw(state, progress.drewFrom, progress.pauseAfterDraw)
  return progress.pauseAfterDraw ? continued : finishPreparedStartTurnWithChoices(continued)
}

/** Continues Mysterious Sphere from its printed after-Draw interruption. */
export function resumePlayerTurnAfterDraw(state: CombatState): CombatState {
  const pending = state.startTurnProgress?.pauseAfterDraw
  if (state.phase !== 'start' || !pending || state.pendingTriggers.length > 0) return state
  const next = clone(state)
  next.startTurnProgress = undefined
  finishStartTurnDraw(next, pending.drewFrom, true)
  return finishPreparedStartTurnWithChoices(next)
}

/** Resolves the current owner's private pre-draw Scry and advances the Draw step. */
export function resolveStartTurnScry(
  state: CombatState,
  playerId: string,
  sourceId: string,
  discardUids: readonly string[],
): CombatState {
  const preview = startTurnScryPreview(state)
  const pending = state.startTurnProgress?.beforeDraw?.sources[0]
  if (!preview || !pending || preview.playerId !== playerId || preview.id !== sourceId) return state
  const player = findPlayer(state, playerId)
  const source = player && triggerSourceById(player, pending.sourceId)
  if (!player || !source) return state

  const next = clone(state)
  const progress = next.startTurnProgress!.beforeDraw!
  progress.sources = progress.sources.slice(1)
  const actor = findPlayer(next, playerId)!
  const liveSource = triggerSourceById(actor, pending.sourceId)!
  if (!resolveTriggerSource(next, actor, liveSource, { scryDiscardUids: discardUids })) return state
  return resolveEmptyStartTurnScries(continueBeforeDraw(next))
}

/** Stages every owner's private Hermit/Slime choice before anyone confirms the round. */
export function stageStartTurnTriggerChoice(state: CombatState): CombatState {
  if (state.phase !== 'start' || state.startTurnProgress || state.pendingTriggers.length > 0) return state
  const next = clone(state)
  for (const entry of startTurnSources(state)) {
    if (!entry.source) continue
    const player = findPlayer(next, entry.ability.playerId)!
    const source = triggerSourceById(player, entry.source.id)!
    const pending = {
      id: next.nextTriggerId++, playerId: player.id, sourceId: source.id, startTurn: true as const,
    }
    next.pendingTriggers.push(pending)
    const needsChoice = triggerNeedsHermitChoice(next, player, source) || triggerSlimeChoice(next, player, source) ||
      pendingTriggerSlimeEnemyChoiceCount(next, pending.id, []) > 0
    if (needsChoice && deterministicStartTurnTriggerChoice(next, player, source) === null) continue
    next.pendingTriggers.pop()
  }
  return next.pendingTriggers.length > 0 ? next : state
}

function forcedTriggerCards(
  cards: readonly { uid: string }[],
  minimum: number,
  amount: number,
): string[] | null {
  if (minimum !== amount) return null
  if (amount === 0) return []
  return amount === 1 && cards.length === 1 ? [cards[0]!.uid] : null
}

/** The private trigger context when exactly one complete input is legal. */
function deterministicStartTurnTriggerChoice(
  state: CombatState,
  player: Player,
  source: TriggerSource,
): StartTurnChoice['trigger'] | null | undefined {
  const needsHermit = triggerNeedsHermitChoice(state, player, source)
  const hermit = triggerHermitChoices(player, source)
  let trigger: NonNullable<StartTurnChoice['trigger']> = {}
  if (needsHermit) {
    if (!hermit) return null
    const loadUids = forcedTriggerCards(hermit.loadCards, hermit.loadMinimum, hermit.loadAmount)
    const chamberUids = forcedTriggerCards(hermit.chamberCards, hermit.chamberMinimum, hermit.chamberAmount)
    if (loadUids === null || chamberUids === null) return null
    trigger = { loadUids, chamberUids, hermitEnemyUids: [] }
  }
  if (triggerNeedsEnemyChoice(state, player, source) || triggerNeedsRowChoice(state, player, source) ||
    triggerNeedsPlayerChoice(state, source)) return null

  const slime = triggerSlimeChoice(state, player, source)
  if (slime) {
    if (slime.minimum !== slime.amount || slime.amount !== 1 || slime.cards.length !== 1) return null
    trigger.slimeUids = [slime.cards[0]!.uid]
  }
  const preview = state.pendingTriggers.some((pending) => pending.playerId === player.id && pending.sourceId === source.id)
    ? state
    : (() => {
        const next = clone(state)
        next.pendingTriggers.push({ id: next.nextTriggerId++, playerId: player.id, sourceId: source.id, startTurn: true })
        return next
      })()
  const pending = preview.pendingTriggers.find((candidate) =>
    candidate.playerId === player.id && candidate.sourceId === source.id)!
  const slimeEnemyAmount = pendingTriggerSlimeEnemyChoiceCount(preview, pending.id, trigger.slimeUids ?? [])
  if (slimeEnemyAmount > 0) {
    const enemy = livingEnemies(state)
    if (enemy.length !== 1) return null
    trigger.slimeEnemyUids = Array(slimeEnemyAmount).fill(enemy[0]!.uid)
  }
  const slimeResolution = source.effects.some((effect) => effectIsActive(effect, state, player) &&
    ['growSlime', 'commandSlime', 'gainSlimeVigor', 'tapSlime', 'rainOfGoop'].includes(effect.kind))
  return needsHermit || slime || slimeEnemyAmount > 0 || slimeResolution ? trigger : undefined
}

/** Resolves the ordered ability phase prepared by `preparePlayerTurn`. */
export function resolveStartPlayerTurn(
  state: CombatState,
  choices: readonly StartTurnChoice[],
): CombatState {
  if (state.phase !== 'start' || state.startTurnProgress?.forcedCard ||
    state.startTurnProgress?.beforeDraw || state.startTurnProgress?.rollPending ||
    state.startTurnProgress?.pauseAfterDraw || state.startTurnProgress?.discard ||
    (state.pendingTriggers?.length ?? 0) > 0 || owedPlayerChoices(state).length > 0) return state
  const sources = pendingStartTurnSources(state)
  const order = choices.map((choice) => choice.id)
  if (!validStartTurnOrder(sources, order)) return state

  const next = clone(state)
  next.startTurnProgress = undefined
  return continueStartTurn(next, choices, state)
}

function validStartTurnShivChoice(
  state: CombatState,
  player: Player,
  overflowShivs: number,
  enemyUids: readonly (string | null)[],
): boolean {
  if (enemyUids.length > overflowShivs) return false
  const simulation = clone(state)
  const actor = findPlayer(simulation, player.id)!
  for (const enemyUid of enemyUids) {
    if (actor.dead || combatIsOver(simulation)) return false
    if (enemyUid === null) continue
    const target = livingEnemies(simulation).find((enemy) => enemy.uid === enemyUid)
    if (!target) return false
    resolveShivAttack(simulation, actor, enemyUid, 1 + actor.shivDamageBonus,
      { enemyUid, playerId: null })
  }
  return enemyUids.length === overflowShivs || actor.dead || combatIsOver(simulation)
}

function validStartTurnEvokeChoice(
  state: CombatState,
  player: Player,
  source: TriggerSource | undefined,
  choice: StartTurnChoice,
): boolean {
  const slots = choice.evokeSlots ?? []
  const targets = choice.evokeEnemyUids ?? []
  if (!source) return slots.length === 0 && targets.length === 0
  const plan = effectEvokePlan(source.effects, player, slots, state.die)
  if (plan.invalid || plan.index !== slots.length || targets.length > plan.chosen.length) {
    return false
  }
  const simulation = clone(state)
  const actor = findPlayer(simulation, player.id)!
  for (let index = 0; index < plan.chosen.length; index++) {
    if (combatIsOver(simulation)) return targets.length === index
    if (index >= targets.length) return false
    const orb = plan.chosen[index]!
    if (orb === 'frost') {
      if (targets[index] !== null) return false
      continue
    }
    // Summons still pending keep the combat going with nothing left to hit; the target is moot.
    if (livingEnemies(simulation).length === 0) continue
    const damageTargets = orbDamageTargets(simulation, actor, orb, targets[index])
    if (!damageTargets) return false
    for (const target of damageTargets) {
      damageEnemy(simulation, target, (orb === 'lightning' ? 2 :
        3 + actor.powers.length + (actor.darkOrbEvokeBonus ?? 0)) +
        (actor.orbEvokeBonus ?? 0))
    }
  }
  return targets.length === plan.chosen.length && (!plan.next || combatIsOver(simulation))
}

export function continueStartTurn(
  state: CombatState,
  choices: readonly StartTurnChoice[],
  rollback?: CombatState,
  stopAfterChoiceId?: string,
): CombatState {
  const facingRows = state.startTurnStage === 'facing' ? facingRowPlan(state, choices) : null
  if (state.startTurnStage === 'facing' && !facingRows) return rollback ?? state
  const next = state
  if (facingRows) for (const player of next.players) player.row = facingRows.get(player.id) ?? player.row
  let forcedDrawResolved = false
  for (let index = 0; index < choices.length; index++) {
    const choice = choices[index]!
    const entry = startTurnSources(next).find(({ ability }) => ability.id === choice.id)
    if (!entry) {
      const inactive = startTurnSources(next, true).find(({ ability }) => ability.id === choice.id)
      if (inactive && findPlayer(next, inactive.ability.playerId)?.dead) continue
      // Slayer Pack: An earlier ability took this Power out of play (a Metamorphosis
      // follows the Power it copied); a Power that is gone has nothing left to resolve.
      if (!inactive && startTurnPowerLeftPlay(next, choice.id)) continue
    }
    const player = entry && findPlayer(next, entry.ability.playerId)
    const ability = entry ? startTurnAbilitiesFor(next, [entry])[0] : undefined
    if (!entry || !player || !ability ||
      (ability.targets
        ? ability.targets.length > 0 && !ability.targets.some((target) => target.uid === choice.enemyUid)
        : choice.enemyUid !== undefined) ||
      (ability.players
        ? !ability.players.some((candidate) => candidate.id === choice.targetPlayerId)
        : choice.targetPlayerId !== undefined) ||
      (ability.guardianModeShift
        ? typeof choice.guardianModeShift !== 'boolean'
        : choice.guardianModeShift !== undefined)) {
      next.startTurnProgress = { choices: choices.slice(index).map((pending) => ({ ...pending })) }
      return rollback ?? next
    }
    if (!validStartTurnShivChoice(next, player, ability.overflowShivs, choice.shivEnemyUids) ||
      !validStartTurnEvokeChoice(next, player, entry.source, choice)) {
      next.startTurnProgress = { choices: choices.slice(index).map((pending) => ({ ...pending })) }
      // A forced draw ahead of this ability (Mayhem) was planned as a card that must be played, so this
      // ability's Shiv and Evoke picks were parked behind it. When that card turned out unplayable and
      // was discarded, nothing was played to resume the order: keep the draw and ask for the picks now.
      return forcedDrawResolved ? settle(next) : rollback ?? next
    }
    if (!entry.source) {
      if (entry.guardianModeShiftPlayerId) {
        if (choice.guardianModeShift && player.guardianMode !== null && !player.guardianModeLocked) {
          player.guardianMode = shiftGuardianMode(player.guardianMode)
          next.log = [...next.log,
            `${player.name} enters ${player.guardianMode === 'attack' ? 'Attack' : 'Defense'} Mode`]
          publishTurnEffect(next, player.id, 'guardian-mode-shift', 'buff', { actorTargeted: true })
        }
      } else if (entry.facingPlayerId) {
        const facingPlayer = findPlayer(next, entry.facingPlayerId)
        const enemy = next.enemies.find((candidate) => !candidate.dead && candidate.uid === choice.enemyUid)
        if (!facingPlayer) return rollback ?? next
        if (choice.enemyUid === 'none') {
          if (livingEnemies(next).filter((candidate) => enemyAbilities(enemyDef(candidate.defId, candidate.ascension))
            .some((entry) => entry.kind === 'facing')).length !== 1) return rollback ?? next
          facingPlayer.facingEnemyUid = null
        } else {
          const facing = enemy && enemyAbilities(enemyDef(enemy.defId, enemy.ascension))
            .find((entry) => entry.kind === 'facing')
          if (!enemy || facing?.kind !== 'facing') return rollback ?? next
          facingPlayer.facingEnemyUid = enemy.uid
          let presentation: TurnEffectPresentation | undefined
          if (facing.effect === 'spear') {
            if (addStatus(next, facingPlayer, 'burn', 2, enemy.uid) > 0) presentation = 'burn'
          } else if (enemy.actionIndex === 0) {
            const before = facingPlayer.energy
            facingPlayer.energy = Math.max(0, facingPlayer.energy - 1)
            if (facingPlayer.energy < before) presentation = 'weak'
          } else if (enemy.actionIndex === 1) {
            if (!facingPlayer.drawLocked) presentation = 'weak'
            facingPlayer.drawLocked = true
          } else {
            if (!facingPlayer.damageDealtZeroThisTurn) presentation = 'weak'
            facingPlayer.damageDealtZeroThisTurn = true
          }
          if (presentation) publishTurnEffect(next, facingPlayer.id, enemy.defId, presentation, { actorTargeted: true })
        }
      } else if (entry.enemyUid) {
        const enemy = next.enemies.find((candidate) => candidate.uid === entry.enemyUid)
        if (enemy) {
          if (entry.enemyAction) {
            const revived = next.enemies.filter((candidate) => candidate.dead &&
              (candidate.defId.startsWith('darkling') || candidate.defId.startsWith('downfall_darkling_')))
              .map((candidate) => candidate.uid)
            applyEnemyAction(next, enemy, entry.enemyAction)
            if (revived.length > 0) publishTurnEffect(next, player.id, enemy.defId, 'heal', { enemyIds: revived })
          } else {
            const before = enemy.block
            enemy.block = gainBlock(enemy.block, entry.enemyBlock ?? 0)
            if (enemy.block > before) publishTurnEffect(next, player.id, enemy.defId, 'block', { enemyIds: [enemy.uid] })
          }
        }
      }
      if (choice.id === stopAfterChoiceId && index + 1 < choices.length) {
        next.startTurnProgress = { choices: choices.slice(index + 1).map((pending) => ({ ...pending })) }
        return settle(next)
      }
      continue
    }
    const checkpoint = rollback ? null : clone(next)
    // The two recurring discard sources currently consist solely of their
    // mandatory discard. Do not bypass any future source's companion effects.
    const privateDiscard = entry.source.effects.length === 1 && entry.source.effects[0]?.kind === 'discard'
      ? entry.source.effects[0]
      : undefined
    if (privateDiscard) {
      const required = Math.min(privateDiscard.amount, player.hand.length)
      if (required > 0 && (required < player.hand.length || discardOrderNeedsChoice(player, player.hand))) {
        next.startTurnProgress = {
          choices: choices.slice(index + 1).map((pending) => ({ ...pending })),
          discard: {
            playerId: player.id,
            sourceId: entry.source.id,
            remaining: required,
            pendingTriggers: [],
          },
        }
        return settle(next)
      }
      if (required > 0) {
        const cards = player.hand.slice(0, required)
        discardByCardEffect(next, player, cards)
        publishTurnEffect(next, player.id, entry.source.presentationSourceId, 'discard', { actorTargeted: true })
      }
      if (next.pendingTriggers.length > 0) {
        next.startTurnProgress = { choices: choices.slice(index + 1).map((pending) => ({ ...pending })) }
        return settle(next)
      }
      if (combatIsOver(next)) return settle(next)
      if (choice.id === stopAfterChoiceId && index + 1 < choices.length) {
        next.startTurnProgress = { choices: choices.slice(index + 1).map((pending) => ({ ...pending })) }
        return settle(next)
      }
      continue
    }
    const slimeResolution = entry.source.effects.some((effect) => effectIsActive(effect, next, player) &&
      ['growSlime', 'commandSlime', 'gainSlimeVigor', 'tapSlime', 'rainOfGoop'].includes(effect.kind))
    const deterministicTrigger = deterministicStartTurnTriggerChoice(next, player, entry.source)
    if ((triggerNeedsHermitChoice(next, player, entry.source) ||
      triggerSlimeChoice(next, player, entry.source) || slimeResolution) && !choice.trigger &&
      deterministicTrigger === null) {
      next.pendingTriggers ??= []
      next.nextTriggerId ??= 0
      next.pendingTriggers.push({
        id: next.nextTriggerId++, playerId: player.id, sourceId: entry.source.id,
        ...(choice.enemyUid === undefined ? {} : { enemyUid: choice.enemyUid }),
      })
      flushPendingTriggers(next)
    } else if (!resolveTriggerSource(next, player, entry.source, {
      shivEnemyUids: choice.shivEnemyUids,
      enemyUid: choice.trigger?.enemyUid ?? choice.enemyUid,
      enemyRow: choice.trigger?.enemyRow,
      evokeSlots: choice.evokeSlots,
      evokeEnemyUids: choice.evokeEnemyUids,
      targetPlayerId: choice.trigger?.targetPlayerId ?? choice.targetPlayerId,
      exhaustUids: choice.exhaustUids,
      hermitContext: choice.trigger ?? deterministicTrigger ?? undefined,
    })) {
      if (rollback) return rollback
      checkpoint!.startTurnProgress = { choices: choices.slice(index).map((pending) => ({ ...pending })) }
      return checkpoint!
    }
    if (entry.source.effects.some((effect) => effect.kind === 'drawAndPlayFree')) forcedDrawResolved = true
    if ((next.pendingTriggers?.length ?? 0) > 0) {
      next.startTurnProgress = { choices: choices.slice(index + 1).map((pending) => ({ ...pending })) }
      return settle(next)
    }
    // Slayer Pack: a private "you may" (Magnetism) pauses the order here
    // and `resolvePendingPlayerChoice` resumes it with the abilities after it.
    if (owedPlayerChoices(next).length > 0) {
      next.startTurnProgress = { choices: choices.slice(index + 1).map((pending) => ({ ...pending })) }
      return settle(next)
    }
    if (next.startTurnProgress?.forcedCard) {
      next.startTurnProgress.choices = choices.slice(index + 1).map((pending) => ({ ...pending }))
      return settle(next)
    }
    if (next.startTurnProgress?.discard) {
      next.startTurnProgress.choices = choices.slice(index + 1).map((pending) => ({ ...pending }))
      return settle(next)
    }
    if (combatIsOver(next)) return settle(next)
    if (choice.id === stopAfterChoiceId && index + 1 < choices.length) {
      next.startTurnProgress = { choices: choices.slice(index + 1).map((pending) => ({ ...pending })) }
      return settle(next)
    }
  }
  next.startTurnProgress = undefined
  const facing = livingEnemies(next).some((enemy) =>
    enemyAbilities(enemyDef(enemy.defId, enemy.ascension)).some((ability) => ability.kind === 'facing'))
  if (next.startTurnStage !== 'facing' && facing) {
    next.startTurnStage = 'facing'
    return settle(next)
  }
  next.startTurnStage = undefined
  next.phase = 'player'
  return settle(next)
}

export function finishForcedCardPlay(
  state: CombatState,
  choices: readonly StartTurnChoice[] | null,
): CombatState {
  if (state.pendingDistilled) {
    const owner = findPlayer(state, state.pendingDistilled.playerId)
    const remaining = state.pendingDistilled.cards.filter((card) => owner?.hand.some((held) => held.uid === card.uid))
    state.pendingDistilled = remaining.length ? { ...state.pendingDistilled, cards: remaining } : undefined
  }
  if (choices === null || combatIsOver(state)) return state
  if ((state.pendingTriggers?.length ?? 0) > 0) {
    state.startTurnProgress = { choices: choices.map((choice) => ({ ...choice })) }
    return state
  }
  if (state.pendingCardCopy) {
    state.pendingCardCopy.forcedChoices = choices.map((choice) => ({ ...choice }))
    return state
  }
  if (state.startTurnProgress?.forcedCard) {
    state.startTurnProgress.choices = choices.map((choice) => ({ ...choice }))
    return state
  }
  if ((state.pendingDieRelicChoices?.length ?? 0) > 0) {
    state.startTurnProgress = { choices: choices.map((choice) => ({ ...choice })) }
    return state
  }
  return continueStartTurn(state, choices)
}

function resumeAfterDieRelicChoice(state: CombatState): CombatState {
  if ((state.pendingDieRelicChoices?.length ?? 0) === 0) flushPendingTriggers(state)
  const settled = settle(state)
  return (settled.pendingDieRelicChoices?.length ?? 0) === 0 && settled.phase === 'start' &&
    (settled.pendingTriggers?.length ?? 0) === 0 &&
    settled.startTurnProgress && !settled.startTurnProgress.forcedCard &&
    !settled.startTurnProgress.beforeDraw && !settled.startTurnProgress.rollPending &&
    !settled.startTurnProgress.pauseAfterDraw &&
    !settled.startTurnProgress.discard
    ? continueStartTurn(settled, settled.startTurnProgress.choices)
    : settled
}

export function resolvePendingDieRelicChoice(
  state: CombatState,
  playerId: string,
  context: Pick<PlayContext, 'discardUids' | 'exhaustUids' | 'enemyUid'> & { choiceId?: number },
): CombatState {
  const pending = state.pendingDieRelicChoices?.[0]
  if (!pending || pending.playerId !== playerId ||
    context.choiceId !== undefined && context.choiceId !== pending.id) return state
  const next = clone(state)
  let first = true
  while (next.pendingDieRelicChoices?.length) {
    const queued = next.pendingDieRelicChoices[0]!
    const owner = findPlayer(next, queued.playerId)
    const ability = owner && chosenDieRelicAbilities(relicDef(queued.relicDefId))[queued.abilityIndex]
    if (!owner || !ability || ability.trigger.kind !== 'dieRelic') return state
    const privateEffect = ability.effects.find((effect) =>
      effect.kind === 'discard' || effect.kind === 'exhaustFromHand')
    if (!first && privateEffect) break
    const selected = privateEffect?.kind === 'discard' ? context.discardUids ?? [] : context.exhaustUids ?? []
    const required = privateEffect ? Math.min(privateEffect.amount, owner.hand.length) : 0
    if (privateEffect && (new Set(selected).size !== selected.length ||
      selected.some((uid) => !owner.hand.some((card) => card.uid === uid)) ||
      (ability.optional ? selected.length !== 0 && selected.length !== required : selected.length !== required))) return state
    const skipped = ability.optional && selected.length === 0
    const needsEnemy = !skipped && ability.effects.some((effect) => reachesEnemy(effect, owner))
    const enemyUid = needsEnemy && livingEnemies(next).some((enemy) => enemy.uid === queued.enemyUid)
      ? queued.enemyUid : first ? context.enemyUid : queued.enemyUid
    if (needsEnemy && !livingEnemies(next).some((enemy) => enemy.uid === enemyUid)) {
      if (!first) break
      return state
    }
    next.pendingDieRelicChoices = next.pendingDieRelicChoices.slice(1)
    if (!skipped) {
      const turnEffectApplications: NonNullable<PlayContext['turnEffectApplications']> = []
      const nestedContext: PlayContext = {
        enemyUid,
        playerId: queued.targetPlayerId,
        ...(privateEffect?.kind === 'discard' ? { discardUids: selected } : {}),
        ...(privateEffect?.kind === 'exhaustFromHand' ? { exhaustUids: selected } : {}),
        shortfall: false,
        invalidDiscardChoice: false,
        invalidExhaustChoice: false,
        pendingTriggers: [],
        turnEffectApplications,
      }
      for (const effect of dieRelicEffectsForParty(queued.relicDefId, ability.effects, next.players.length)) {
        applyEffect(next, owner, effect, ability.target ?? 'enemy', ability.supportTarget ?? 'self', nestedContext,
          queued.sourceLabel)
        if (invalidPlayChoice(nestedContext)) return state
      }
      publishTurnEffectApplications(next, owner.id, queued.relicDefId, turnEffectApplications)
      if (nestedContext.pendingTriggers?.length) {
        next.pendingTriggers = [...nestedContext.pendingTriggers, ...(next.pendingTriggers ?? [])]
      }
    }
    first = false
  }
  return resumeAfterDieRelicChoice(next)
}

/** Deterministic disconnect fallback: mandatory payments resolve; optional ones are declined. */
export function defaultPendingDieRelicChoice(state: CombatState, playerId: string): CombatState {
  const pending = state.pendingDieRelicChoices?.[0]
  const owner = pending && findPlayer(state, playerId)
  const ability = pending && owner && chosenDieRelicAbilities(relicDef(pending.relicDefId))[pending.abilityIndex]
  if (!pending || pending.playerId !== playerId || !owner || !ability) return state
  const effect = ability.effects.find((candidate) => candidate.kind === 'discard' || candidate.kind === 'exhaustFromHand')
  const chosen = ability.optional || !effect ? [] : owner.hand.slice(0, effect.amount).map((card) => card.uid)
  return resolvePendingDieRelicChoice(state, playerId, {
    choiceId: pending.id,
    ...(effect?.kind === 'discard' ? { discardUids: chosen } : { exhaustUids: chosen }),
    enemyUid: livingEnemies(state)[0]?.uid ?? null,
  })
}

export function finishCardCopy(
  state: CombatState,
  choices: readonly StartTurnChoice[] | null,
): CombatState {
  const resumed = finishForcedCardPlay(state, choices)
  return resumed.phase === 'start' && resumed.startTurnProgress?.beforeDraw
    ? continueBeforeDraw(resumed)
    : resumed
}

/** Resolves Tools of the Trade without exposing its owner's hand to the table. */
export function resolveStartTurnDiscard(
  state: CombatState,
  playerId: string,
  sourceId: string,
  discardUid: string,
): CombatState {
  const preview = startTurnDiscardPreview(state)
  if (!preview || preview.playerId !== playerId || preview.sourceId !== sourceId ||
    !preview.cards.some((card) => card.uid === discardUid)) return state
  const next = clone(state)
  const pending = next.startTurnProgress!.discard!
  const choices = [...next.startTurnProgress!.choices]
  const actor = findPlayer(next, playerId)!
  const source = triggerSourceById(actor, pending.sourceId)
  const selectedUids = [...(pending.selectedUids ?? []), discardUid]
  let remaining = (pending.remaining ?? 1) - 1
  const unselected = actor.hand.filter((card) => !selectedUids.includes(card.uid))
  if (remaining === unselected.length && !discardOrderNeedsChoice(actor, unselected)) {
    selectedUids.push(...unselected.map((card) => card.uid))
    remaining = 0
  }
  if (remaining > 0) {
    next.startTurnProgress!.discard = { ...pending, remaining, selectedUids }
    return settle(next)
  }
  const cards = selectedUids.map((uid) => actor.hand.find((held) => held.uid === uid)!)
  discardByCardEffect(next, actor, cards)
  if (source) publishTurnEffect(next, actor.id, source.presentationSourceId, 'discard', { actorTargeted: true })
  next.startTurnProgress = undefined
  next.pendingTriggers = [...next.pendingTriggers, ...pending.pendingTriggers]
  flushPendingTriggers(next)
  if (combatIsOver(next)) return settle(next)
  if ((next.pendingTriggers?.length ?? 0) > 0) {
    next.startTurnProgress = { choices }
    return settle(next)
  }
  return continueStartTurn(settle(next), choices)
}

/**
 * Answers a decision a card handed to one player: Heel Hook's draw-or-discard
 * or Magnetism's return-from-discard. Only that player may answer, from their
 * own hand or face-up discard pile; declining is always legal. A pause in the
 * ordered Start of Turn resumes with the abilities queued after it.
 */
export function resolvePendingPlayerChoice(
  state: CombatState,
  playerId: string,
  answer: PlayerChoiceAnswer,
): CombatState {
  const pending = state.pendingPlayerChoices?.find((choice) =>
    choice.id === answer.choiceId && choice.playerId === playerId)
  const owner = pending && findPlayer(state, playerId)
  if (!pending) return state
  const { draw, discardUid, count } = answer
  // A dead (Last Stand) or departed owner can only decline: the choice lapses.
  if (!owner || owner.dead) {
    if (draw !== undefined || discardUid !== undefined || count !== undefined) return state
    const next = clone(state)
    next.pendingPlayerChoices = next.pendingPlayerChoices!.filter((choice) => choice.id !== pending.id)
    if (next.pendingPlayerChoices.length === 0) delete next.pendingPlayerChoices
    next.log = [...next.log, `${pending.sourceLabel}: ${owner?.name ?? 'its chooser'} is gone; the choice lapses`]
    return resumeAfterPlayerChoice(settle(next))
  }
  if (draw !== undefined && typeof draw !== 'boolean' ||
    discardUid !== undefined && typeof discardUid !== 'string' ||
    count !== undefined && !Number.isSafeInteger(count)) return state
  if (pending.kind === 'drawOrDiscard') {
    if (count !== undefined || draw === true && discardUid !== undefined) return state
    if (draw === true && (owner.drawLocked || owner.draw.length + owner.discard.length === 0)) return state
    if (discardUid !== undefined && !owner.hand.some((card) => card.uid === discardUid)) return state
  } else if (draw !== undefined || discardUid !== undefined ||
    count !== undefined && (count < 0 || count > Math.min(pending.upTo, owner.discard.length))) return state

  const next = clone(state)
  const actor = findPlayer(next, playerId)!
  next.pendingPlayerChoices = next.pendingPlayerChoices!.filter((choice) => choice.id !== pending.id)
  if (next.pendingPlayerChoices.length === 0) delete next.pendingPlayerChoices
  if (pending.kind === 'drawOrDiscard') {
    if (draw === true) {
      const drawn = drawInto(next, actor, 1)
      next.log = [...next.log, `${pending.sourceLabel}: ${actor.name} draws ${drawn.length}`]
    } else if (discardUid !== undefined) {
      next.log = [...next.log, `${pending.sourceLabel}: ${actor.name} chooses to discard`]
      discardByCardEffect(next, actor, [actor.hand.find((card) => card.uid === discardUid)!])
    } else {
      next.log = [...next.log, `${pending.sourceLabel}: ${actor.name} neither draws nor discards`]
    }
  } else if ((count ?? 0) > 0) {
    next.log = [...next.log, `${pending.sourceLabel}: ${discardTopLine(actor, takeDiscardTop(actor, count!, 'hand', false), 'hand')}`]
  } else {
    next.log = [...next.log, `${pending.sourceLabel}: ${actor.name} leaves their discard pile alone`]
  }
  return resumeAfterPlayerChoice(settle(next))
}

/** Resumes a Start of Turn that a now-answered (or lapsed) player choice paused. */
function resumeAfterPlayerChoice(settled: CombatState): CombatState {
  return settled.phase === 'start' && settled.startTurnProgress && owedPlayerChoices(settled).length === 0 &&
    (settled.pendingTriggers?.length ?? 0) === 0 && !mandatoryChoicePending(settled) &&
    !settled.startTurnProgress.forcedCard && !settled.startTurnProgress.beforeDraw &&
    !settled.startTurnProgress.rollPending && !settled.startTurnProgress.pauseAfterDraw &&
    !settled.startTurnProgress.discard
    ? continueStartTurn(settled, settled.startTurnProgress.choices)
    : settled
}

/** Disconnect and death fallback for `resolvePendingPlayerChoice`: an absent player declines; a dead one's lapses. */
export function defaultPendingPlayerChoice(state: CombatState, playerId: string): CombatState {
  const pending = state.pendingPlayerChoices?.find((choice) => choice.playerId === playerId)
  return pending ? resolvePendingPlayerChoice(state, playerId, { choiceId: pending.id }) : state
}

/**
 * Every choice whose owner died (Last Stand) or left the combat lapses, resuming a Start of Turn it
 * paused. Deterministic; the same reference when none is stranded. Callers: the room server's
 * settle loop and the local client, so a loaded or resumed state can never stay wedged.
 */
export function lapseStrandedPlayerChoices(state: CombatState): CombatState {
  let next = state
  for (;;) {
    const stranded = next.pendingPlayerChoices?.find((choice) =>
      !next.players.some((player) => player.id === choice.playerId && !player.dead))
    if (!stranded) return next
    const lapsed = resolvePendingPlayerChoice(next, stranded.playerId, { choiceId: stranded.id })
    if (lapsed === next) return next
    next = lapsed
  }
}

/** Backwards-compatible deterministic start for simulations with no UI choice. */
export function startPlayerTurn(state: CombatState): CombatState {
  let prepared = preparePlayerTurn(state)
  const scries = startTurnScryAbilities(prepared)
  if (scries.length > 0) prepared = orderStartTurnScries(prepared, scries.map((ability) => ability.id))
  for (let preview = startTurnScryPreview(prepared); preview; preview = startTurnScryPreview(prepared)) {
    const next = resolveStartTurnScry(prepared, preview.playerId, preview.id, [])
    if (next === prepared) break
    prepared = next
  }
  let resolved = prepared === state || prepared.phase !== 'start'
    ? prepared
    : resolveStartPlayerTurn(prepared, defaultStartTurnChoices(prepared))
  for (let preview = startTurnDiscardPreview(resolved); preview; preview = startTurnDiscardPreview(resolved)) {
    const card = preview.cards[0]
    if (!card) break
    const next = resolveStartTurnDiscard(resolved, preview.playerId, preview.sourceId, card.uid)
    if (next === resolved) break
    resolved = next
  }
  return resolved
}

/** Starts a table-facing turn, pausing when a player owns a Start-of-Turn action. */
export function startPlayerTurnWithChoices(state: CombatState): CombatState {
  const prepared = preparePlayerTurn(state)
  if (prepared === state || prepared.phase !== 'start') return prepared
  if (prepared.startTurnProgress?.beforeDraw) return prepared
  return finishPreparedStartTurnWithChoices(prepared)
}

export function startTurnOrderChoicePlayerId(
  state: CombatState,
  knownAbilities?: readonly StartTurnAbility[],
): string | undefined {
  return startTurnOrderChoicePlayerIdWithResolver(state, resolveStartPlayerTurn, knownAbilities)
}

export function startTurnNeedsChoice(
  state: CombatState,
  knownAbilities?: readonly StartTurnAbility[],
  playerId?: string,
): boolean {
  if (playerId === undefined ? hasPostRollStartTurnChoice(state) : state.players.some((player) =>
    player.id === playerId && playerHasPostRollStartTurnChoice(state, player))) return true
  const abilities = knownAbilities ?? startTurnAbilities(state)
  // An ability that cannot be resolved without input, whatever else is queued.
  if (abilities.some((ability) => (ability.exhaustCards?.length ?? 0) > 1 || ability.overflowShivs > 0 ||
    ability.guardianModeShift ||
    (ability.targets?.length ?? 0) > 1 ||
    (ability.players?.length ?? 0) > 1 || ability.evokeChoice)) return true
  if (abilities.some((ability) => ability.id === 'enemy:darkling/regrow') &&
    abilities.some((ability) => (ability.targets?.length ?? 0) > 0)) return true
  return startTurnOrderChoicePlayerId(state, abilities) !== undefined
}

/** Players who genuinely owe input before Start of Turn can finish. */
export function startTurnChoicePlayerIds(
  state: CombatState,
  knownAbilities?: readonly StartTurnAbility[],
  includeOrderChoice = true,
  committedChoices: readonly StartTurnChoice[] = [],
  includePostRollChoices = true,
): string[] {
  if (state.phase !== 'start') return []
  const players = new Set(state.players.map((player) => player.id))
  const required = new Set<string>()
  const add = (playerId: string | undefined) => {
    if (playerId && players.has(playerId)) required.add(playerId)
  }

  for (const trigger of state.pendingTriggers ?? []) if (trigger.startTurn) add(trigger.playerId)
  add(state.startTurnProgress?.discard?.playerId)
  add(state.startTurnProgress?.forcedCard?.playerId)

  const beforeDraw = state.startTurnProgress?.beforeDraw
  if (beforeDraw) {
    if (!beforeDraw.ordered) add(beforeDraw.sources[0]?.playerId)
    else {
      const preview = startTurnScryPreview(state)
      if ((preview?.cards.length ?? 0) > 0) add(preview?.playerId)
    }
  }

  // Die-changing Relics and Potions are an earlier, exclusive decision
  // window.  Do not make owners confirm abilities produced by a die result
  // that can still change, and do not run the downstream order simulator for
  // every multiplayer snapshot while this window is open.
  if (includePostRollChoices) {
    const postRollOwners = state.players
      .filter((player) => !player.dead && playerHasPostRollStartTurnChoice(state, player))
      .map((player) => player.id)
    if (postRollOwners.length > 0) return postRollOwners
  }

  const abilities = knownAbilities ?? startTurnAbilities(state)
  if (includeOrderChoice) add(startTurnOrderChoicePlayerId(state, abilities))
  // A choice in an earlier ability deliberately blocks simulation of later
  // effects. Complete the same order with safe defaults so a downstream owner
  // (for example full-slot Storm behind another player's overflow Shiv) is not
  // mistaken for an idle seat and omitted from the quorum.
  const order = abilities.map((ability) => ability.id)
  const downstreamChoicePlayers = new Set<string>()
  if (order.length > 0) defaultStartTurnChoicesForOrder(
    state, order, downstreamChoicePlayers, undefined, committedChoices,
  )
  for (const playerId of downstreamChoicePlayers) add(playerId)
  for (const ability of abilities) if (
    (ability.exhaustCards?.length ?? 0) > 1 || ability.overflowShivs > 0 || ability.guardianModeShift ||
    (ability.targets?.length ?? 0) > 1 || (ability.players?.length ?? 0) > 1 || ability.evokeChoice
  ) add(ability.playerId)
  // If input exists only because aimed effects can invalidate one another, one
  // involved owner commits the shared order; deterministic owners do not vote.
  if (includeOrderChoice && required.size === 0 && startTurnNeedsChoice(state, abilities)) {
    add(abilities.find((ability) => (ability.targets?.length ?? 0) > 0)?.playerId ?? abilities[0]?.playerId)
  }
  return [...required]
}

function finishPreparedStartTurnWithChoices(prepared: CombatState): CombatState {
  if (prepared.phase !== 'start' || prepared.startTurnProgress || prepared.pendingTriggers.length > 0) return prepared
  const staged = stageStartTurnTriggerChoice(prepared)
  if (staged !== prepared) return staged
  const abilities = startTurnAbilities(prepared)
  return startTurnNeedsChoice(prepared, abilities)
    ? prepared
    : resolveStartPlayerTurn(prepared, defaultStartTurnChoices(prepared))
}
