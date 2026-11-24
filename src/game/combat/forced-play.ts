// Forced 0-Energy card plays (Mayhem, Havoc, Distilled Chaos, Revenge Protocol):
// disconnect abandonment and deterministic auto-resolution.
//
// Cycle-free helper module below `play.ts`: card-play/preview/copy-settle
// entry points are supplied as callbacks by `play.ts`.
import { clone, findPlayer, livingEnemies } from './board.ts'
import {
  applyEffect,
  discardByCardEffect,
  evokeTargetProgress,
  exhaustCards,
  finishDeferredHavocs,
  releasePendingTriggers,
} from './effects.ts'
import {
  amountOf,
  cardCanBeForced,
  cardIsPlayable,
  cardModeIsAvailable,
  cardNeedsEnemy,
  cardPlayerChoiceCount,
  cardReferencesGuardianMode,
  cardShivChoiceCount,
  conditionIsActive,
  effectIsActive,
  effectiveCombatCardDef,
  evokePlan,
  guardianCardNeedsAlly,
  guardianGemForCard,
  guardianPowerBeamCards,
  invalidPlayChoice,
  metamorphosisCost,
  nextEvokeChoice,
  omniscienceEligibleCards,
  overflowShivCount,
  reachedTimeWarpLimit,
  resolutionContext,
  slimeChoiceIsAvailable,
  slimeCommandEnemyChoiceCount,
  soulburnChoiceCount,
} from './queries.ts'
import { finishForcedCardPlay } from './start-turn.ts'
import type { CardChoicePreview, CombatState, PlayContext } from './types.ts'
import { cardDef, cardStaysInPlay, faceOf } from '../cards.ts'
import type { CardDef, Effect } from '../cards.ts'
import type { CardInstance, Player } from '../types.ts'

/** Settles a disconnected owner's private forced card and resumes queued abilities. */
export function abandonForcedCardWithSettle(
  state: CombatState,
  playerId: string,
  settlePendingCopy: (state: CombatState, actor: Player) => CombatState,
): CombatState {
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
  return finishForcedCardPlay(settlePendingCopy(next, actor), choices)
}

function activeForcedCardEffects(
  effects: readonly Effect[],
  state: CombatState,
  player: Player,
  sourceDeadOn: boolean,
): Effect[] {
  return effects.flatMap((effect): Effect[] => {
    if (!effectIsActive(effect, state, player)) return []
    if (effect.kind === 'sequence') return effect.guardianAction || effect.guardianGemId
      ? [effect]
      : activeForcedCardEffects(effect.effects, state, player, sourceDeadOn)
    if (effect.kind === 'branch') return activeForcedCardEffects(
      conditionIsActive(effect.condition, state, player) ? effect.effects : effect.otherwise,
      state,
      player,
      sourceDeadOn,
    )
    if (effect.kind === 'deadOnEffects') return sourceDeadOn
      ? activeForcedCardEffects(effect.effects, state, player, sourceDeadOn)
      : []
    if (effect.kind === 'roulette') return activeForcedCardEffects(
      effect.byRoll[state.die] ?? [], state, player, sourceDeadOn,
    )
    return [effect]
  })
}

const append = <T>(values: T[] | undefined, additions: readonly T[]): T[] => [...(values ?? []), ...additions]

/**
 * Builds a context only when every pre-resolution choice has exactly one legal
 * outcome. The authoritative `playCard` validator still gets the final word;
 * this helper merely supplies values whose cardinality the board proves.
 */
function deterministicForcedCardContext(
  state: CombatState,
  player: Player,
  held: CardInstance,
  def: CardDef,
  effects: readonly Effect[],
  previewCardChoice: (state: CombatState, playerId: string, cardUid: string) => CardChoicePreview | null,
  mode?: number,
): PlayContext | null {
  const enemies = livingEnemies(state)
  const livingPlayers = state.players.filter((candidate) => !candidate.dead)
  const activeEffects = activeForcedCardEffects(effects, state, player, held.hermitDeadOn === true)
  const context: PlayContext = { enemyUid: null, playerId: null, ...(mode === undefined ? {} : { mode }) }
  let virtualHand = player.hand.filter((card) => card.uid !== held.uid)
  let virtualDiscard = [...player.discard]
  let virtualChamber = [...player.chamber]

  const preview = mode === undefined ? previewCardChoice(state, player.id, held.uid) : null
  if (preview?.kind === 'discard' || preview?.kind === 'topdeck' || preview?.kind === 'load' ||
    preview?.kind === 'loadAny') virtualHand = [...preview.cards]

  for (const effect of activeEffects) {
    if (effect.kind === 'hitChoices' || effect.kind === 'weakChoices' ||
      effect.kind === 'vulnerableChoices' || effect.kind === 'poisonChoices') {
      if (enemies.length !== 1 || effect.kind === 'hitChoices' && effect.distinct && effect.targets > 1) return null
      context.enemyUids = append(context.enemyUids, Array<string>(effect.targets).fill(enemies[0]!.uid))
      continue
    }
    if (effect.kind === 'blockChoices') {
      if (livingPlayers.length !== 1) return null
      context.playerIds = append(context.playerIds, Array<string>(effect.targets).fill(livingPlayers[0]!.id))
      continue
    }
    if (effect.kind === 'discard' || effect.kind === 'exhaustFromHand' || effect.kind === 'topdeck') {
      const cards = preview && ((preview.kind === 'discard' && effect.kind === 'discard') ||
        (preview.kind === 'topdeck' && effect.kind === 'topdeck')) ? preview.cards : virtualHand
      const required = Math.min(effect.amount, cards.length)
      if (required > 1 || required === 1 && cards.length !== 1) return null
      const chosen = cards.slice(0, required).map((card) => card.uid)
      if (effect.kind === 'discard') context.discardUids = append(context.discardUids, chosen)
      else if (effect.kind === 'exhaustFromHand') context.exhaustUids = append(context.exhaustUids, chosen)
      else context.topdeckUids = append(context.topdeckUids, chosen)
      const picked = new Set(chosen)
      virtualHand = cards.filter((card) => !picked.has(card.uid))
      continue
    }
    if (effect.kind === 'discardAny') {
      if (virtualHand.length > 0) return null
      context.discardUids ??= []
      continue
    }
    if (effect.kind === 'exhaustAny') {
      const minimum = Math.min(effect.minimum ?? 0, virtualHand.length)
      if (virtualHand.length > 0 && minimum < virtualHand.length) return null
      if (virtualHand.length > effect.amount) return null
      context.exhaustUids = append(context.exhaustUids, virtualHand.map((card) => card.uid))
      virtualHand = []
      continue
    }
    if (effect.kind === 'recoverDiscard') {
      const required = Math.min(effect.amount, virtualDiscard.length)
      if (required > 1 || required === 1 && virtualDiscard.length !== 1) return null
      const chosen = virtualDiscard.slice(0, required)
      context.recoverDiscardUids = chosen.map((card) => card.uid)
      virtualDiscard = virtualDiscard.slice(required)
      if (effect.toHand) virtualHand.push(...chosen)
      continue
    }
    if (effect.kind === 'recoverExhaust') {
      if (player.exhaust.length > 1) return null
      if (player.exhaust.length === 1) context.recoverExhaustUid = player.exhaust[0]!.uid
      continue
    }
    if (effect.kind === 'recoverExhaustToDraw') {
      if (player.exhaust.length > 0) return null
      context.recoverExhaustUids = []
      continue
    }
    if (effect.kind === 'recoverExhaustToDiscard') {
      const required = Math.min(effect.amount, player.exhaust.length)
      if (required > 1 || required === 1 && player.exhaust.length !== 1) return null
      context.recoverExhaustUids = player.exhaust.slice(0, required).map((card) => card.uid)
      continue
    }
    if (effect.kind === 'scry') {
      const revealed = preview?.kind === 'scry' ? preview.cards : player.draw.slice(0, effect.amount)
      if (revealed.length > 0) return null
      context.scryDiscardUids = []
      continue
    }
    if (effect.kind === 'scryToHand' || effect.kind === 'scryAndPlay') {
      const revealed = preview?.kind === 'scryToHand' ? preview.cards : player.draw.slice(0, effect.amount)
      if (revealed.length > 0) return null
      context.scryDiscardUids = []
      continue
    }
    // Slayer Pack: Forethought chooses from the hand; only an empty one decides itself.
    if (effect.kind === 'bottomdeck') {
      if (virtualHand.length > 0) return null
      context.topdeckUids = []
      continue
    }
    if (effect.kind === 'searchDraw' || effect.kind === 'searchDrawAndPlayTwice') {
      const eligible = preview?.kind === 'search' ? preview.cards : effect.kind === 'searchDraw'
        ? player.draw
        : omniscienceEligibleCards(state, { ...player,
          hand: player.hand.filter((card) => card.uid !== held.uid) })
      const required = Math.min(effect.kind === 'searchDraw' ? effect.amount : 1, eligible.length)
      if (required > 1 || required === 1 && eligible.length !== 1) return null
      context.searchDrawUids = eligible.slice(0, required).map((card) => card.uid)
      continue
    }
    if (effect.kind === 'load') {
      const source = effect.source ?? 'hand'
      const zone = preview && (preview.kind === 'load' || preview.kind === 'loadAny')
        ? preview.cards : source === 'discard' ? virtualDiscard : virtualHand
      const maximum = Math.min(effect.amount, zone.length)
      if (effect.upTo && maximum > 0 || maximum > 1 || maximum === 1 && zone.length !== 1) return null
      const selected = zone.slice(0, maximum)
      context.loadUids = append(context.loadUids, selected.map((card) => card.uid))
      for (const card of selected) {
        if (virtualChamber.length >= player.chamberSlots) {
          if (virtualChamber.length !== 1) return null
          context.chamberUids = append(context.chamberUids, [virtualChamber[0]!.uid])
          virtualChamber = []
        }
        virtualChamber.push(card)
      }
      const picked = new Set(selected.map((card) => card.uid))
      if (source === 'discard') virtualDiscard = virtualDiscard.filter((card) => !picked.has(card.uid))
      else virtualHand = virtualHand.filter((card) => !picked.has(card.uid))
      continue
    }
    if (effect.kind === 'loadSelf' || effect.kind === 'triggerDieRelic') return null
    if (effect.kind === 'playChamber' || effect.kind === 'discountChamber') {
      const chamberAmount = effect.kind === 'playChamber'
        ? effect.amount === 'all' ? virtualChamber.length : effect.amount
        : effect.amount
      const requested = Math.min(chamberAmount, virtualChamber.length)
      if (requested > 1 || requested === 1 && virtualChamber.length !== 1) return null
      context.chamberUids = append(context.chamberUids,
        virtualChamber.slice(0, requested).map((card) => card.uid))
      continue
    }
    if (effect.kind === 'discardChamber') {
      const eligible = virtualChamber.filter((card) => !effect.curseOnly ||
        faceOf(cardDef(card.defId), card.upgraded).type === 'curse')
      const requested = Math.min(effect.amount, eligible.length)
      if (effect.optional && requested > 0 || requested > 1 || requested === 1 && eligible.length !== 1) return null
      const selected = eligible.slice(0, requested)
      context.chamberUids = append(context.chamberUids, selected.map((card) => card.uid))
      const picked = new Set(selected.map((card) => card.uid))
      virtualChamber = virtualChamber.filter((card) => !picked.has(card.uid))
      virtualDiscard.push(...selected)
      continue
    }
    if (effect.kind === 'switchRows') {
      if (livingPlayers.length > 1) return null
      context.switchWithPlayerId = null
      continue
    }

    if (effect.kind === 'growSlime' || effect.kind === 'commandSlime' ||
      effect.kind === 'gainSlimeVigor' || effect.kind === 'tapSlime') {
      const available = player.slimes.filter((candidate) =>
        slimeChoiceIsAvailable({ ...def, modes: undefined, effects: [...effects] }, state, player,
          candidate.card.uid, 0))
      if (effect.kind === 'commandSlime' && effect.all) {
        // `all` has no Slime-card choice; enemy targets are synthesized below.
      } else if ('upToDifferent' in effect && effect.upToDifferent !== undefined && effect.upToDifferent !== 99) {
        if (available.length > 0) return null
      } else {
        const required = effect.kind === 'commandSlime' && effect.upToDifferent === 99
          ? amountOf(effect.amount, state, player, undefined, context) : 1
        if (required === 0) continue
        if (required !== 1 || available.length !== 1) return null
        context.slimeUids = append(context.slimeUids, [available[0]!.card.uid])
      }
      continue
    }
    // Rain of Goop only stores X (+ upgrade bonus) while the card is played;
    // its player/Slime decision belongs to the later Power trigger.
  }

  const mandatoryShivs = cardShivChoiceCount({ ...def, modes: undefined, effects: [...effects] }, player)
  if (mandatoryShivs > 0) {
    if (enemies.length !== 1) return null
    context.shivEnemyUids = Array<string>(mandatoryShivs).fill(enemies[0]!.uid)
  }
  const gainedShivs = activeEffects.reduce((sum, effect) => sum + (effect.kind === 'gainShiv'
    ? effect.amount : effect.kind === 'gainShivPerDiscard' ? (context.discardUids?.length ?? 0) + effect.bonus : 0), 0)
  if (overflowShivCount(state, gainedShivs) > 0) {
    if (enemies.length > 0) return null
    context.shivEnemyUids ??= []
  }

  const soulburnTargets = soulburnChoiceCount(effects, state, player)
  if (soulburnTargets > 0) {
    if (enemies.length !== 1) return null
    context.soulburnEnemyUids = Array<string>(soulburnTargets).fill(enemies[0]!.uid)
  }

  const slimeEnemyTargets = slimeCommandEnemyChoiceCount(
    { ...def, modes: undefined, effects: [...effects] }, state, player, context.slimeUids ?? [], 0, 0, held,
  )
  if (slimeEnemyTargets > 0) {
    if (enemies.length !== 1) return null
    context.slimeEnemyUids = Array<string>(slimeEnemyTargets).fill(enemies[0]!.uid)
  }

  const evokeSlots: number[] = []
  for (;;) {
    const next = nextEvokeChoice({ ...def, modes: undefined, effects: [...effects] }, player, evokeSlots, state.die, undefined, 0)
    if (!next) break
    if (next.options.length !== 1) return null
    evokeSlots.push(next.options[0]!.slot)
  }
  const evokeDef = { ...def, modes: undefined, effects: [...effects] }
  const chosenOrbs = evokePlan(evokeDef, player, evokeSlots, state.die, undefined, 0).chosen
  const evokeEnemyUids: (string | null)[] = []
  for (const orb of chosenOrbs) {
    if (orb === 'frost') {
      evokeEnemyUids.push(null)
      continue
    }
    const target = evokeTargetProgress(evokeDef, state, player, evokeSlots, evokeEnemyUids, undefined, 0)
    if (target.complete) break
    if (target.options.length !== 1) return null
    evokeEnemyUids.push(target.options[0]!.uid)
  }
  if (evokeSlots.length > 0) {
    context.evokeSlots = evokeSlots
    context.evokeEnemyUids = evokeEnemyUids
  }

  const attachedGemId = guardianGemForCard(player, held)
  const targetDef = def.guardian ? def : { ...def, modes: undefined, effects: activeEffects }
  if (def.id === 'guardian_power_beam' && player.guardianMode === 'defense') {
    const powers = guardianPowerBeamCards(player, held.uid)
    if (powers.length > 1) return null
    if (powers.length === 1) context.guardianPowerCardUid = powers[0]!.uid
  }
  const opaquePlayerChoices = cardPlayerChoiceCount(def, mode) - (context.playerIds?.length ?? 0)
  if (opaquePlayerChoices > 0) {
    if (livingPlayers.length !== 1) return null
    context.playerIds = append(context.playerIds,
      Array<string>(opaquePlayerChoices).fill(livingPlayers[0]!.id))
  }
  if (def.supportTarget === 'anyPlayer' || guardianCardNeedsAlly(def, player, attachedGemId)) {
    if (livingPlayers.length !== 1) return null
    context.playerId = livingPlayers[0]!.id
  }
  const needsEnemy = cardNeedsEnemy(
    targetDef, player, true, 0, false, attachedGemId, held.uid, 0, held.hermitDeadOn === true,
  )
  const enemyTarget = enemies.length === 1 ? enemies[0]
    : targetDef.target === 'row' &&
      new Set(enemies.filter((enemy) => !enemy.isBoss).map((enemy) => enemy.row)).size <= 1
      ? enemies.find((enemy) => !enemy.isBoss) ?? enemies[0]
      : undefined
  if (needsEnemy && !enemyTarget) return null
  context.enemyUid = needsEnemy ? enemyTarget!.uid : null
  if (def.cost === 'X') context.energySpent = 0
  if (attachedGemId === 'guardian_jasper') {
    if (virtualHand.length > 0) return null
    const previewState = clone(state)
    const previewActor = findPlayer(previewState, player.id)!
    previewActor.hand = previewActor.hand.filter((card) => card.uid !== held.uid)
    const previewContext = resolutionContext(context, def, { ...held, attachedGemId: undefined }, 0)
    for (const effect of effects) {
      applyEffect(previewState, previewActor, effect, def.target ?? 'enemy', def.supportTarget ?? 'self', previewContext)
      if (invalidPlayChoice(previewContext)) return null
    }
    if (previewActor.hand.length > 0) return null
    context.exhaustUids ??= []
  }
  return context
}

/**
 * Plays a forced card only when the current board proves one complete legal
 * context. This is intentionally narrower than "a default context happens to
 * work": optional choices must remain with their owner even when declining
 * them would also be legal.
 */
export function resolveDeterministicForcedCardWithPlay(
  state: CombatState,
  previewCardChoice: (state: CombatState, playerId: string, cardUid: string) => CardChoicePreview | null,
  playCard: (state: CombatState, playerId: string, cardUid: string, context: PlayContext) => CombatState,
): CombatState {
  const forced = state.startTurnProgress?.forcedCard
  if (!forced || !['start', 'player', 'discard'].includes(state.phase) ||
    (state.pendingTriggers?.length ?? 0) > 0) return state
  const player = findPlayer(state, forced.playerId)
  const held = player?.hand.find((card) => card.uid === forced.cardUid)
  if (!player || player.dead || !held || player.cardPlayLocked || reachedTimeWarpLimit(state, player)) return state

  const printed = faceOf(cardDef(held.defId), held.upgraded)
  const attachedGemId = guardianGemForCard(player, held)
  if (player.character !== 'guardian' && player.guardianMode === null &&
    cardReferencesGuardianMode(printed, attachedGemId)) return state
  const def = effectiveCombatCardDef(printed, player.guardianMode)
  if (!cardIsPlayable(def, state, player) || def.cost === 'X' && (def.minimumX ?? 0) > 0) return state
  // Slayer Pack: A forced play is X = 0, so Metamorphosis may still attach to any Power
  // whose X is 0; which one is its owner's choice. With none it is discarded as usual.
  if (def.id === 'slayer_metamorphosis' &&
    player.powers.some((power) => metamorphosisCost(player, power.uid, held.upgraded) === 0)) return state

  // Vigor, Body Crash, these Mode shifts, and the two choice-bearing Gems all
  // alter the outcome while a zero/false context remains legal.
  if (player.guardianMode !== null && player.vigor > 0 && (def.type === 'attack' || def.type === 'skill') ||
    def.id === 'guardian_body_crash' && player.block > 0 ||
    ['guardian_hack', 'guardian_gear_up', 'guardian_speed_boost'].includes(def.id) ||
    attachedGemId === 'guardian_amethyst' || held.growOnPlay) return state

  const modeEffects = def.modes
    ? def.modes.flatMap((mode, index) => cardModeIsAvailable(def, state, player, index, player.draw.length, held.uid)
      ? [{ index, effects: mode.effects }]
      : [])
    : [{ index: undefined, effects: def.type === 'power' && def.resolvesOnPlay !== true ? [] : def.effects }]
  const candidates: PlayContext[] = []
  for (const { index, effects } of modeEffects) {
    if (!cardCanBeForced({ ...def, modes: undefined, effects: [...effects] },
      state, player, attachedGemId, held.uid)) continue
    const context = deterministicForcedCardContext(state, player, held, def, effects, previewCardChoice, index)
    if (!context) return state
    if (playCard(state, forced.playerId, held.uid, context) !== state) candidates.push(context)
  }
  return candidates.length === 1 ? playCard(state, forced.playerId, held.uid, candidates[0]!) : state
}
