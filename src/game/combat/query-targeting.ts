// Targeting, choice-counting, evoke-planning, and forced-play feasibility queries.
//
// Pure read-only predicates over combat state, built on top of `query-conditions.ts`.
import { adjacentEnemies, findPlayer, livingEnemies, resolveEnemyTargets } from './board.ts'
import {
  amountOf,
  cardHasRetain,
  countOf,
  effectIsActive,
  effectiveCombatCardDef,
  latestPlayableAllyAttack,
  slimeChoiceIsAvailable,
} from './query-conditions.ts'
import type { CombatState, CountablePlayer, EvokeChoice, PlayContext } from './types.ts'
import { cardDef } from '../cards.ts'
import type { CardDef, Effect } from '../cards.ts'
import type { CardInstance, OrbType, Player } from '../types.ts'
import { slimeDef } from '../downfall/slime-boss.ts'

/**
 * Effects that have to be pointed at an enemy before the card can resolve.
 *
 * `evoke` is here because an evoked Lightning or Dark orb picks a target: left
 * out, Dual Cast silently aimed at the first living enemy and the Defect could
 * not direct their biggest starter card.
 */
const ENEMY_EFFECTS = new Set<string>([
  'hit', 'rowHit', 'damage', 'loseHp', 'applyVulnerable', 'applyWeak', 'poison', 'multiplyPoison',
  'evoke', 'recurseOrb', 'fission', 'clearTargetBlock', 'hitPerExhaust', 'execute', 'attachBounty', 'goldenBullet', 'roulette',
  'evokeAll',
  'damagePerDiscard',
  'attachToTarget',
])

/**
 * Whether this clause can reach an enemy at all, for this player.
 *
 * Conservative on purpose: it answers "no" only when the clause CERTAINLY
 * touches nobody. A counted attack is the case that matters — Barrage swings
 * once per Orb, and with none charged it swings zero times, so asking the
 * player to point it at something is asking for a decision that changes
 * nothing. A bonus reads board state this function is not given, so any bonus
 * counts as "might swing".
 */
export function reachesEnemy(
  effect: Effect,
  actor: CountablePlayer | undefined,
  energySpent?: number,
): boolean {
  // A branch holds hits on either side; a hit inside one still needs its target.
  if (effect.kind === 'branch') return [...effect.effects, ...effect.otherwise].some((nested) => reachesEnemy(nested, actor, energySpent))
  if (!ENEMY_EFFECTS.has(effect.kind)) return false
  if (actor && effect.when?.kind === 'inStance' && actor.stance !== effect.when.stance) return false
  if (actor && effect.when?.kind === 'notInStance' && actor.stance === effect.when.stance) return false
  if (effect.kind === 'hitPerExhaust') return !actor || actor.hand === null || actor.hand.length > 1
  if (effect.kind === 'evoke') {
    if (!actor) return true
    const times = typeof effect.times === 'number' ? effect.times : effect.times.base +
      (effect.times.per ? countOf(effect.times.per, actor, undefined,
        effect.times.per === 'energySpent' && energySpent === undefined ? 1 : energySpent) : 0)
    return times > 0 && actor.orbs.some((orb) => orb === 'lightning' || orb === 'dark')
  }
  if (effect.kind === 'recurseOrb') {
    return !actor || actor.orbs.some((orb) => orb === 'lightning' || orb === 'dark')
  }
  if (effect.kind === 'fission') {
    if (!effect.evoke) return false
    return !actor || actor.orbs.some((orb) => orb === 'lightning' || orb === 'dark')
  }
  if (effect.kind === 'evokeAll') {
    return !actor || actor.orbs.some((orb) => orb === 'lightning' || orb === 'dark')
  }
  if (effect.kind !== 'hit' || effect.times === undefined || !actor) return true
  const times = effect.times
  if (typeof times === 'number') return times > 0
  if (times.bonus) return true
  return times.base + (times.perSlime ?? 0) * (actor.slimes?.length ?? 0) + (times.per
    ? countOf(times.per, actor, undefined,
      times.per === 'energySpent' && energySpent === undefined ? 1 : energySpent)
    : 0) > 0
}

/** Ordered labels for independently targeted Commands produced by the selected Slimes. */
export function slimeCommandEnemyChoiceLabels(
  def: CardDef,
  state: CombatState,
  actor: Player,
  slimeUids: readonly string[],
  energySpent = 0,
  energyCharged = energySpent,
  playedCard?: CardInstance,
): string[] {
  let cursor = 0
  const labels: string[] = []
  const slimes = actor.slimes.map((slime) => ({ ...slime, card: { ...slime.card } }))
  const grownSlime = playedCard?.growOnPlay ? playedCard : undefined
  if (grownSlime) slimes.push({
    card: { ...grownSlime, growOnPlay: undefined }, level: 1, vigor: 0,
    commandsThisTurn: 0, vigorLossAtEndOfTurn: 0, vigorTriggerUsedThisTurn: false,
  })
  const selectedUids = grownSlime ? [...slimeUids, grownSlime.uid] : slimeUids
  const select = (uids: readonly string[]) => uids.flatMap((uid) => {
    const slime = slimes.find((candidate) => candidate.card.uid === uid)
    return slime ? [slime] : []
  })
  const used = new Map(slimes.map((slime) => [slime.card.uid, slime.commandsThisTurn]))
  const deferred: string[] = []
  const command = (slime: Player['slimes'][number], times = 1) => {
    const slimeCard = slimeDef(slime)
    const available = slimeCard.slimeCommandLimit === undefined
      ? times : Math.max(0, Math.min(times, slimeCard.slimeCommandLimit - (used.get(slime.card.uid) ?? 0)))
    used.set(slime.card.uid, (used.get(slime.card.uid) ?? 0) + available)
    if ((slimeCard.id === 'slime_boss_evolution_slime' && slime.level >= 3
      ? 'allEnemies' : slimeCard.slimeTarget ?? 'enemy') !== 'allEnemies' &&
      slimeCard.slimeLevels?.[slime.level]?.some((effect) => reachesEnemy(effect, actor))) {
      const label = `${slimeCard.name} · level ${slime.level}${slime.vigor > 0 ? ` · ${slime.vigor} Strength` : ''}`
      labels.push(...Array(available).fill(label))
    }
  }
  const effects: readonly Effect[] = grownSlime
    ? [...def.effects, { kind: 'growSlime', amount: 1 }]
    : def.effects
  for (const effect of effects) {
    if (!effectIsActive(effect, state, actor)) continue
    if (effect.kind === 'commandSlime') {
      const repeat = amountOf(effect.amount, state, actor, undefined, { enemyUid: null, playerId: actor.id, energySpent })
      let picked: typeof slimes
      if (effect.all) picked = slimes
      else if (effect.same) {
        picked = select(selectedUids.slice(cursor, cursor + 1))
        cursor += 1
      } else {
        picked = select(selectedUids.slice(cursor, cursor +
          (effect.upToDifferent === 99 ? repeat : effect.upToDifferent ?? 1)))
        cursor += picked.length
      }
      for (const slime of picked) command(slime, effect.same ? repeat : 1)
    } else if (effect.kind === 'growSlime') {
      const amount = effect.upToDifferent ?? 1
      const picked = select(selectedUids.slice(cursor, cursor + amount))
      cursor += picked.length
      for (const slime of picked) {
        const max = Math.max(1, ...Object.keys(slimeDef(slime).slimeLevels ?? {}).map(Number))
        const grown = Math.min(max - slime.level, effect.upToDifferent === undefined ? effect.amount : 1)
        if (grown <= 0) continue
        slime.level += grown
        if (effect.commandAfter) command(slime)
        for (let step = 0; step < grown; step++) deferred.push(...slimes
          .filter((candidate) => slimeDef(candidate).slimeTrigger === 'onGrow')
          .map((candidate) => candidate.card.uid))
      }
    } else if (effect.kind === 'gainSlimeVigor') {
      const uid = selectedUids[cursor++]
      const slime = slimes.find((candidate) => candidate.card.uid === uid)
      if (!slime) continue
      const gained = Math.max(0, Math.min(effect.amount, 8 - slime.vigor))
      slime.vigor += gained
      const triggered = gained > 0 && slimeDef(slime).slimeTrigger === 'onGainVigor' &&
        !slime.vigorTriggerUsedThisTurn
      if (triggered) slime.vigorTriggerUsedThisTurn = true
      if (effect.commandAfter) command(slime)
      if (triggered) command(slime)
    } else if (effect.kind === 'rainOfGoop') {
      const uid = selectedUids[cursor++]
      const slime = slimes.find((candidate) => candidate.card.uid === uid)
      if (!slime) continue
      const gained = Math.min(1, 8 - slime.vigor)
      slime.vigor += gained
      if (gained > 0 && slimeDef(slime).slimeTrigger === 'onGainVigor' &&
        !slime.vigorTriggerUsedThisTurn) {
        slime.vigorTriggerUsedThisTurn = true
        command(slime)
      }
    }
  }
  for (const uid of deferred) {
    const slime = slimes.find((candidate) => candidate.card.uid === uid)
    if (slime) command(slime)
  }
  if (energyCharged >= 2) {
    for (const slime of slimes.filter((candidate) => slimeDef(candidate).slimeTrigger === 'onSpendTwoEnergy')) command(slime)
  }
  if ((playedCard ? cardHasRetain(actor, playedCard) : def.retain) &&
    actor.powers.some((power) => power.defId === 'slime_boss_darkling_duo')) {
    const bruiser = slimes.find((slime) => slime.card.defId === 'slime_boss_bruiser_slime')
    if (bruiser) command(bruiser)
  }
  return labels
}

/** Number of independently targeted enemy Commands produced by the selected Slimes. */
export function slimeCommandEnemyChoiceCount(
  def: CardDef,
  state: CombatState,
  actor: Player,
  slimeUids: readonly string[],
  energySpent = 0,
  energyCharged = energySpent,
  playedCard?: CardInstance,
): number {
  return slimeCommandEnemyChoiceLabels(
    def, state, actor, slimeUids, energySpent, energyCharged, playedCard,
  ).length
}

/**
 * Whether this card asks the player to point at an enemy.
 *
 * Only single-target scopes need a choice: `allEnemies` hits everything, and a
 * card with no enemy-facing effect needs nothing. A `row` scope does need one,
 * since the chosen enemy is what picks the row.
 *
 * Exported so the UI prompts for exactly what the engine will require. Two
 * copies of this rule drifted apart once: the UI collected a target the engine
 * then discarded. `actor` is what lets both sides agree that a zero-swing
 * attack needs no target; without it the UI asked, and then nothing happened.
 */
export function cardNeedsEnemy(
  def: CardDef,
  actor?: CountablePlayer,
  includeEvokes = true,
  energySpent?: number,
  forActivation = false,
  attachedGemId?: string,
  sourceCardUid?: string,
  _energyCharged = energySpent,
  sourceDeadOn = false,
): boolean {
  if (def.type === 'power' && (def.trigger || (def.activeAbility && !forActivation))) return false
  if ((def.target ?? 'enemy') === 'allEnemies') return false
  // Several Guardian cards implement their Mode-specific row hit through a
  // special sequence rather than a literal enemy effect, but still need an anchor.
  if (def.target === 'row' && def.guardian && def.effects.some((effect) =>
    effect.kind === 'sequence' && effect.guardianAction)) return true
  if ((attachedGemId && ['guardian_emerald', 'guardian_garnet', 'guardian_ruby'].includes(attachedGemId)) ||
    attachedGemId === 'guardian_peridot' && (!actor || actor.hand?.some((card) => card.uid !== sourceCardUid &&
      cardDef(card.defId).guardian?.printedType.startsWith('Gem')))) return true
  if (def.guardian) {
    if (def.id === 'guardian_refracted_beam') return def.type === 'attack'
    return new Set([
      'guardian_strike', 'guardian_twin_slam', 'guardian_orb_support', 'guardian_strike_for_strike',
      'guardian_disrupt', 'guardian_crystal_edge', 'guardian_fierce_bash', 'guardian_orb_slam',
      'guardian_poly_beam', 'guardian_priming_shot', 'guardian_walker_claw', 'guardian_roll_attack',
      'guardian_vent_steam', 'guardian_speed_boost', 'guardian_incinerate', 'guardian_focus_beam',
      'guardian_gem_cannon', 'guardian_multi_beam', 'guardian_stasis_beam', 'guardian_power_beam',
      'guardian_scale_slash', 'guardian_bauble_burst', 'guardian_body_crash', 'guardian_destroy',
    ]).has(def.id)
  }
  const sourceIsDeadOn = sourceDeadOn || sourceCardUid !== undefined && (
    actor?.hand?.some((card) => card.uid === sourceCardUid && card.hermitDeadOn === true) === true ||
    actor?.chamber.some((card) => card.uid === sourceCardUid && cardDef(card.defId).hermit?.deadOn === true) === true
  )
  const targetsEnemy = (effect: Effect) =>
    (includeEvokes || (effect.kind !== 'evoke' && effect.kind !== 'recurseOrb' && effect.kind !== 'fission' &&
      effect.kind !== 'evokeAll')) &&
    reachesEnemy(effect, actor, energySpent)
  const effects = def.modes?.flatMap((mode) => mode.effects) ?? def.effects
  return effects.some((effect) => targetsEnemy(effect) || sourceIsDeadOn && effect.kind === 'deadOnEffects' &&
    effect.effects.some(targetsEnemy))
}

/** Soulburn a `useAllSoulburn` effect would spend, before any board choice is made. */
export function soulburnChoiceCount(effects: readonly Effect[], state: CombatState, actor: Player): number {
  const spendIndex = effects.findIndex((effect) => effect.kind === 'useAllSoulburn')
  if (spendIndex < 0) return 0
  const gained = effects.slice(0, spendIndex).reduce((sum, effect) =>
    sum + (effect.kind === 'gainSoulburn' && effectIsActive(effect, state, actor)
      ? amountOf(effect.amount, state, actor, undefined, { enemyUid: null, playerId: actor.id, energySpent: 0 })
      : 0), 0)
  return Math.min(6, actor.soulburn + gained)
}

/** Every printed effects list a card could resolve with, one per Mode if modal. */
function everyModeEffects(def: CardDef): readonly Effect[][] {
  return def.modes ? def.modes.map((mode) => mode.effects) : [def.effects]
}

/** Hermit curses whose Chamber-load reaction needs a living enemy to aim at. */
const HERMIT_TARGETED_CURSES = new Set(['hermit_grudge', 'hermit_malice', 'hermit_horror'])

/**
 * Whether a mandatory `load` would have no choice left but a targeted curse.
 *
 * Loading is a free pick among whatever sits in the named zone (p.12 Hermit
 * rules), so it only strands the player when EVERY legal combination forces
 * at least one needs-a-target curse in: if the zone holds enough non-curse
 * cards to fill the mandatory amount, the player simply loads those instead.
 * `sourceCardUid` excludes the card currently resolving from a hand-sourced
 * load's own zone: by the time it actually loads, it has already left hand.
 */
function loadNeedsEnemy(effects: readonly Effect[], actor: Player, sourceCardUid?: string): boolean {
  return effects.some((effect) => {
    if (effect.kind !== 'load' || effect.upTo) return false
    const zone = (effect.source === 'discard' ? actor.discard : actor.hand)
      .filter((card) => card.uid !== sourceCardUid)
    const mandatory = Math.min(effect.amount, zone.length)
    const safe = zone.filter((card) => !HERMIT_TARGETED_CURSES.has(card.defId)).length
    return safe < mandatory
  })
}

/** Whether every mandatory Slime-card selector has enough legal cards to satisfy it. */
function forcedSlimeChoicesExist(
  def: CardDef,
  effects: readonly Effect[],
  state: CombatState,
  actor: Player,
  requireAvailableSlimes: boolean,
): boolean {
  const active = { ...def, modes: undefined, effects: [...effects] }
  const available = actor.slimes.filter((slime) =>
    !requireAvailableSlimes || slimeChoiceIsAvailable(active, state, actor, slime.card.uid, 0)).length
  return effects.every((effect) => {
    if (!effectIsActive(effect, state, actor)) return true
    if (effect.kind === 'growSlime') return effect.upToDifferent !== undefined || available >= 1
    if (effect.kind === 'commandSlime') {
      if (effect.all || effect.upToDifferent !== undefined && effect.upToDifferent !== 99) return true
      const required = effect.upToDifferent === 99 ? amountOf(effect.amount, state, actor) : 1
      return available >= required
    }
    return effect.kind !== 'gainSlimeVigor' && effect.kind !== 'tapSlime' || available >= 1
  })
}

/**
 * Whether a card about to be locked in as a forced 0-Energy play (Distilled
 * Chaos, Havoc, Revenge Protocol, ...) can still find every choice its printed
 * effects demand.
 *
 * Normal play defers this to `playCard`'s own target validation (see
 * `cardResolutionChoicesAreValid` and `slimeCommandTargetsAreValid`), which
 * can safely refuse an illegal choice and let the player try again. A forced
 * card has no "try again": once it becomes `startTurnProgress.forcedCard`,
 * that is the only card `playCard` will accept, so a target that can never
 * exist would deadlock combat rather than get rejected. Callers that create a
 * forced card must check this first and discard/skip the card instead when it
 * fails.
 */
export function cardCanBeForced(
  def: CardDef,
  state: CombatState,
  actor: Player,
  attachedGemId?: string,
  sourceCardUid?: string,
  requireAvailableSlimes = true,
): boolean {
  const effective = effectiveCombatCardDef(def, actor.guardianMode)
  const onPlayEffects = effective.type === 'power' && (effective.trigger || effective.activeAbility)
    ? [[]]
    : effective.modes
      ? effective.modes.flatMap((mode, index) => cardModeIsAvailable(
        effective, state, actor, index, actor.draw.length, sourceCardUid,
      ) ? [mode.effects] : [])
      : everyModeEffects(effective)
  const enemyCount = livingEnemies(state).length
  return onPlayEffects.some((effects) => {
    if (!forcedSlimeChoicesExist(effective, effects, state, actor, requireAvailableSlimes)) return false
    const modeOnly: CardDef = { ...effective, modes: undefined, effects }
    if (effects.some((effect) => effect.kind === 'hitChoices' && effect.distinct) &&
      cardEnemyChoiceCount(modeOnly, undefined, state, actor) > enemyCount) return false
    if (enemyCount > 0) return true
    return !cardNeedsEnemy(modeOnly, actor, true, undefined, false, attachedGemId, sourceCardUid) &&
      cardEnemyChoiceCount(modeOnly, undefined, state, actor) === 0 &&
      cardShivChoiceCount(modeOnly, actor) === 0 &&
      soulburnChoiceCount(effects, state, actor) === 0 &&
      slimeCommandEnemyChoiceCount(modeOnly, state, actor, [], 0, 0) === 0 &&
      !loadNeedsEnemy(effects, actor, sourceCardUid)
  })
}

/** Independent printed targets collected before an atomic card play. */
export function cardEnemyChoiceCount(
  def: CardDef,
  mode?: number,
  state?: CombatState,
  actor?: Player,
): number {
  const effects = def.modes ? def.modes[mode ?? -1]?.effects ?? [] : def.effects
  return effects.reduce((sum, effect) => sum + (
    state && actor && !effectIsActive(effect, state, actor) ? 0 :
    effect.kind === 'poisonChoices' || effect.kind === 'hitChoices' || effect.kind === 'weakChoices' ||
      effect.kind === 'vulnerableChoices' ? effect.targets : 0
  ), 0)
}

export function cardPlayerChoiceCount(def: CardDef, mode?: number): number {
  const effects = def.modes ? def.modes[mode ?? -1]?.effects ?? [] : def.effects
  const explicit = effects.reduce((sum, effect) => sum + (effect.kind === 'blockChoices' ? effect.targets : 0), 0)
  if (explicit > 0 || def.id !== 'guardian_stasis_field') return explicit
  return def.guardian?.sourceText.match(/\b1 \[block\]/g)?.length ?? 0
}

export function guardianCardNeedsAlly(
  def: CardDef,
  actor: Pick<Player, 'guardianMode'>,
  attachedGemId?: string,
): boolean {
  if (def.id === 'guardian_prismatic_barrier') return true
  if (attachedGemId === 'guardian_onyx') {
    return def.id !== 'guardian_prismatic_spray'
  }
  if (def.id === 'guardian_harden') return true
  if ((def.id === 'guardian_curl_up' || def.id === 'guardian_defend') &&
    def.guardian?.sourceText.includes('to any player')) return true
  if (def.id === 'guardian_spheric_shield') return actor.guardianMode === 'defense'
  return def.id === 'guardian_guardian_whirl' && def.type === 'skill'
}

export function cardModeIsAvailable(
  def: CardDef,
  state: CombatState,
  player: Player,
  mode: number,
  drawCount = player.draw.length,
  sourceCardUid?: string,
): boolean {
  const effects = def.modes?.[mode]?.effects
  return effects !== undefined &&
    (!effects.some((effect) => effect.kind === 'copyLastAllyAttack') ||
      Boolean(latestPlayableAllyAttack(state, player, sourceCardUid, drawCount)))
}

/** Mandatory targets for a card that spends every Shiv the actor currently holds. */
export function cardShivChoiceCount(
  def: CardDef,
  actor: Pick<Player, 'shivs'>,
  mode?: number,
): number {
  const effects = def.modes ? def.modes[mode ?? -1]?.effects ?? [] : def.effects
  return effects.some((effect) => effect.kind === 'useAllShivs') ? actor.shivs : 0
}

export function effectEvokePlan(
  effects: readonly Effect[],
  actor: Pick<Player, 'orbs'> & CountablePlayer,
  slots: readonly number[],
  die: number,
  energySpent = 0,
) {
  const orbs = [...actor.orbs]
  const chosen: OrbType[] = []
  let index = 0
  let next: EvokeChoice | null = null
  let invalid = false

  const evoke = (times = 1) => {
    const options = orbs.flatMap((orb, slot) => orb ? [{ slot, orb }] : [])
    if (options.length === 0) return true
    const slot = slots[index]
    if (slot === undefined) {
      next = { index, options }
      return false
    }
    const picked = options.find((option) => option.slot === slot)
    if (!picked) {
      invalid = true
      return false
    }
    chosen.push(...Array<OrbType>(times).fill(picked.orb))
    orbs[slot] = null
    index += 1
    return true
  }

  for (const effect of effects) {
    if (effect.when?.kind === 'orbsAtLeast' &&
      orbs.filter((orb) => orb !== null).length < effect.when.amount) continue
    if (effect.kind === 'channel' || effect.kind === 'channelDieOrb') {
      const amount = effect.kind === 'channel'
        ? typeof effect.amount === 'number'
          ? effect.amount
          : effect.amount.base + (effect.amount.per
            ? countOf(effect.amount.per, actor, undefined, energySpent) * (effect.amount.scale ?? 1)
            : 0)
        : 1
      for (let count = 0; count < amount; count++) {
        if (orbs.every((orb) => orb !== null) && !evoke()) return { chosen, index, next, invalid, orbs }
        const open = orbs.indexOf(null)
        if (open >= 0) orbs[open] = effect.kind === 'channel' ? effect.orb
          : die <= 2 ? 'lightning' : die <= 4 ? 'frost' : 'dark'
      }
    } else if (effect.kind === 'evokeAll') {
      // Slayer Pack: Aggregate: every Orb, in the order chosen, `times` each.
      while (orbs.some((orb) => orb !== null)) {
        if (!evoke(effect.times)) return { chosen, index, next, invalid, orbs }
      }
    } else if (effect.kind === 'evoke' || effect.kind === 'recurseOrb' ||
      (effect.kind === 'fission' && effect.evoke)) {
      if (effect.kind === 'fission') {
        while (orbs.some((orb) => orb !== null)) {
          if (!evoke()) return { chosen, index, next, invalid, orbs }
        }
        continue
      }
      if (effect.kind === 'recurseOrb') {
        if (!evoke()) return { chosen, index, next, invalid, orbs }
        const open = orbs.indexOf(null)
        const orb = chosen.at(-1)
        if (open >= 0 && orb) orbs[open] = orb
        continue
      }
      const times = typeof effect.times === 'number' ? effect.times : effect.times.base +
        (effect.times.per ? countOf(effect.times.per, actor, undefined, energySpent) : 0)
      if (times > 0 && !evoke(times)) return { chosen, index, next, invalid, orbs }
    }
  }
  return { chosen, index, next, invalid, orbs }
}

export function evokePlan(
  def: CardDef,
  actor: Pick<Player, 'orbs'> & CountablePlayer,
  slots: readonly number[],
  die: number,
  mode?: number,
  energySpent = 0,
) {
  const effects = def.type === 'power' && def.resolvesOnPlay !== true
    ? []
    : def.modes ? def.modes[mode ?? -1]?.effects ?? [] : def.effects
  return effectEvokePlan(effects, actor, slots, die, energySpent)
}

/** The next Orb choice a staged card needs, after its earlier choices. */
export function nextEvokeChoice(
  def: CardDef,
  actor: Pick<Player, 'orbs'> & CountablePlayer,
  slots: readonly number[],
  die: number,
  mode?: number,
  energySpent = 0,
): EvokeChoice | null {
  return evokePlan(def, actor, slots, die, mode, energySpent).next
}

/** Orb types already chosen by a staged play, including slots filled earlier in that same card. */
export function chosenEvokeOrbs(
  def: CardDef,
  actor: Pick<Player, 'orbs'> & CountablePlayer,
  slots: readonly number[],
  die: number,
  mode?: number,
  energySpent = 0,
): OrbType[] {
  return evokePlan(def, actor, slots, die, mode, energySpent).chosen
}

function cardRequiresChosenEnemy(
  def: CardDef,
  actor: Player,
  includeEvokes = true,
  energySpent?: number,
  mode?: number,
  attachedGemId?: string,
  sourceCardUid?: string,
  energyCharged = energySpent,
  sourceDeadOn = false,
): boolean {
  const effects = def.modes ? def.modes[mode ?? -1]?.effects : undefined
  return cardNeedsEnemy(effects ? { ...def, modes: undefined, effects } : def,
    actor, includeEvokes, energySpent, false, attachedGemId, sourceCardUid, energyCharged, sourceDeadOn)
}

export function needsChosenEnemy(
  state: CombatState,
  def: CardDef,
  chosenUid: string | null,
  actor: Player,
  includeEvokes = true,
  energySpent?: number,
  mode?: number,
  attachedGemId?: string,
  sourceCardUid?: string,
  energyCharged = energySpent,
  sourceDeadOn = false,
): boolean {
  if (!cardRequiresChosenEnemy(def, actor, includeEvokes, energySpent, mode, attachedGemId, sourceCardUid,
    energyCharged, sourceDeadOn)) return false
  return resolveEnemyTargets(state, def.target ?? 'enemy', chosenUid).length === 0
}

export function hasInvalidChosenPlayer(
  state: CombatState,
  def: CardDef,
  chosenId: unknown,
): boolean {
  if (def.supportTarget !== 'anyPlayer') return false
  const effects = def.modes?.flatMap((mode) => mode.effects) ?? def.effects
  if (!effects.some((effect) => 'toChosen' in effect && effect.toChosen)) return false
  if (chosenId === null) return false
  if (typeof chosenId !== 'string' || chosenId.length === 0) return true
  const chosen = findPlayer(state, chosenId)
  return !chosen || chosen.dead
}

export function hasInvalidRowSwitch(
  state: CombatState,
  effects: readonly Effect[],
  chosenId: unknown,
  actor: Player,
): boolean {
  if (!effects.some((effect) => effect.kind === 'switchRows') || chosenId === null || chosenId === undefined) {
    return false
  }
  if (typeof chosenId !== 'string') return true
  const chosen = findPlayer(state, chosenId)
  return !chosen || chosen.dead || chosen.id === actor.id
}

/**
 * Pressure Points: "If it's a Boss, this card costs 2 [Energy] instead." The
 * printed number is replaced before every other cost rule applies, so a
 * discount still reduces the Boss price.
 */
export function cardDefForTarget(def: CardDef, state: CombatState, enemyUid: string | null | undefined): CardDef {
  if (def.bossTargetCost === undefined) return def
  const target = livingEnemies(state).find((enemy) => enemy.uid === enemyUid)
  return target?.isBoss ? { ...def, cost: def.bossTargetCost } : def
}

/** How many adjacent enemies the player must pick for Bowling Bash; 0 when all of them take the damage. */
export function adjacentDamageChoiceCount(
  effects: readonly Effect[],
  state: CombatState,
  enemyUid: string | null | undefined,
): number {
  const effect = effects.find((candidate) => candidate.kind === 'damageAdjacent')
  if (effect?.kind !== 'damageAdjacent') return 0
  return adjacentEnemies(state, enemyUid).length > effect.targets ? effect.targets : 0
}

/**
 * Bowling Bash's chosen adjacent enemies. With no more candidates than the card
 * names, every one of them takes the damage and the play names none (or all of
 * them); otherwise it names exactly that many distinct candidates.
 */
export function adjacentDamageChoicesAreValid(
  effects: readonly Effect[],
  state: CombatState,
  context: Pick<PlayContext, 'enemyUid' | 'enemyUids'>,
): boolean {
  const effect = effects.find((candidate) => candidate.kind === 'damageAdjacent')
  if (effect?.kind !== 'damageAdjacent') return true
  const candidates = new Set(adjacentEnemies(state, context.enemyUid).map((enemy) => enemy.uid))
  const chosen = context.enemyUids ?? []
  if (new Set(chosen).size !== chosen.length || chosen.some((uid) => !candidates.has(uid))) return false
  return candidates.size <= effect.targets
    ? chosen.length === 0 || chosen.length === candidates.size
    : chosen.length === effect.targets
}
