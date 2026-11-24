// Trigger source lookup and trigger-choice inspection queries.
//
// Read-only (plus queue-id allocation) trigger discovery helpers used by
// `effects.ts`, `start-turn.ts`, and `end-turn.ts`.
import { combatRows, findPlayer, livingEnemies } from './board.ts'
import { amountOf, reachesEnemy, slimeCommandEnemyChoiceLabels } from './queries.ts'
import type { CombatState, PendingTrigger, PendingTriggerAbility, PlayContext, TriggerSource } from './types.ts'
import { cardDef, faceOf } from '../cards.ts'
import type { CardDef, Effect } from '../cards.ts'
import { relicAbilities, relicDef } from '../relics.ts'
import { triggerMatches } from '../triggers.ts'
import type { TriggerEvent } from '../triggers.ts'
import type { Player } from '../types.ts'

export function triggerSourceById(player: Player, id: string): TriggerSource | undefined {
  if (id.startsWith('relic:')) {
    const [indexText, abilityText] = id.slice(6).split(':')
    const index = Number(indexText)
    const held = Number.isInteger(index) ? player.relics[index] : undefined
    if (!held) return undefined
    const def = relicDef(held.defId)
    const ability = relicAbilities(def)[Number(abilityText ?? 0)]
    if (!ability) return undefined
    return {
      id,
      presentationSourceId: held.defId,
      trigger: ability.trigger,
      effects: ability.effects,
      name: `${player.name}'s ${def.name}`,
      scope: ability.target ?? 'enemy',
      supportScope: ability.supportTarget ?? 'self',
      oncePerTurn: false,
    }
  }
  if (!id.startsWith('power:')) return undefined
  const powerKey = id.slice(6)
  const extraAt = powerKey.lastIndexOf(':extra:')
  const powerUid = extraAt < 0 ? powerKey : powerKey.slice(0, extraAt)
  const held = player.powers.find((power) => power.uid === powerUid)
  if (!held) return undefined
  const def = faceOf(cardDef(held.defId), held.upgraded)
  const extraIndex = extraAt < 0 ? -1 : Number(powerKey.slice(extraAt + 7))
  const ability = extraIndex < 0
    ? def.trigger && { trigger: def.trigger, effects: def.effects }
    : def.additionalTriggers?.[extraIndex]
  if (!ability) return undefined
  return {
    id,
    presentationSourceId: held.defId,
    trigger: ability.trigger,
    effects: ability.effects,
    name: `${player.name}'s ${def.name}`,
    scope: def.target ?? 'enemy',
    supportScope: def.supportTarget ?? 'self',
    oncePerTurn: def.oncePerTurn === true,
    powerUid: held.uid,
  }
}

export function triggerSources(player: Player, event: TriggerEvent, excludeUid?: string): TriggerSource[] {
  const sources: TriggerSource[] = []
  for (const index of player.relics.keys()) {
    if (player.relics[index]!.defId === 'loaded_die' && player.relics[index]!.spent) continue
    if (player.relics[index]!.defId === 'dented_plate' && player.hp < 5) continue
    for (const abilityIndex of relicAbilities(relicDef(player.relics[index]!.defId)).keys()) {
      const source = triggerSourceById(player, `relic:${index}:${abilityIndex}`)
      if (source && triggerMatches(source.trigger, event)) sources.push(source)
    }
  }
  for (const held of player.powers) {
    if (held.uid === excludeUid) continue
    const source = triggerSourceById(player, `power:${held.uid}`)
    if (source && triggerMatches(source.trigger, event)) sources.push(source)
    const def = faceOf(cardDef(held.defId), held.upgraded)
    for (const index of def.additionalTriggers?.keys() ?? []) {
      const extra = triggerSourceById(player, `power:${held.uid}:extra:${index}`)
      if (extra && triggerMatches(extra.trigger, event)) sources.push(extra)
    }
  }
  return sources
}

export function queuedTriggers(
  state: CombatState,
  event: TriggerEvent,
  only?: Player,
  excludeUid?: string,
): PendingTrigger[] {
  state.nextTriggerId ??= 0
  return state.players.flatMap((player) => player.dead || (only && player.id !== only.id) ? [] :
    triggerSources(player, event, excludeUid).map((source) => ({
      id: state.nextTriggerId++, playerId: player.id, sourceId: source.id,
      enemyUid: event.enemyUid,
      ...(event.count === undefined ? {} : { count: event.count }),
    })))
}

export function triggerNeedsRowChoice(state: CombatState, player: Player, source: TriggerSource): boolean {
  return source.scope === 'row' && source.effects.some((effect) => reachesEnemy(effect, player)) &&
    combatRows(state).length > 1
}

export function triggerNeedsEnemyChoice(
  state: CombatState,
  player: Player,
  source: TriggerSource,
  enemyUid?: string,
): boolean {
  const targetedCurse = triggerHermitChoices(player, source)?.loadCards.some((card) =>
    ['hermit_grudge', 'hermit_malice', 'hermit_horror'].includes(card.defId)) === true
  return enemyUid === undefined && (triggerSourceReachesEnemy(player, source) ||
    (triggerNeedsHermitChoice(state, player, source) && targetedCurse)) && livingEnemies(state).length > 1
}

export function triggerSourceReachesEnemy(player: Player, source: TriggerSource): boolean {
  return source.scope === 'enemy' && source.effects.some((effect) => reachesEnemy(effect, player))
}

function hermitChoiceEffects(effects: readonly Effect[]): Effect[] {
  return effects.flatMap((effect) => effect.kind === 'deadOnEffects'
    ? hermitChoiceEffects(effect.effects) : [effect])
}

export function triggerHermitChoices(player: Player, source: TriggerSource):
  NonNullable<PendingTriggerAbility['hermitChoices']> | undefined {
  const effects = hermitChoiceEffects(source.effects)
  const load = effects.find((effect) => effect.kind === 'load') as Extract<Effect, { kind: 'load' }> | undefined
  const chamberEffects = effects.filter((effect) =>
    ['playChamber', 'discardChamber', 'discountChamber'].includes(effect.kind))
  const loadCards = load && player.chamberSlots > 0 ? [...player[load.source ?? 'hand']] : []
  const chamber = player.chamber ?? []
  const needsReplacement = loadCards.length > 0 && chamber.length >= player.chamberSlots
  const chamberCards = chamberEffects.length > 0 || needsReplacement
    ? chamber.filter((card) => chamberEffects.some((effect) =>
      effect.kind !== 'discardChamber' || !effect.curseOnly || faceOf(cardDef(card.defId), card.upgraded).type === 'curse') || needsReplacement)
    : []
  if (loadCards.length === 0 && chamberCards.length === 0) return undefined
  const loadAmount = load ? Math.min(load.amount, loadCards.length) : 0
  const chamberEffect = chamberEffects[0]
  const chamberRequested = chamberEffect?.kind === 'playChamber' && chamberEffect.amount === 'all'
    ? chamberCards.length : Number(chamberEffect && 'amount' in chamberEffect ? chamberEffect.amount : 0)
  const chamberBase = Math.min(chamberRequested, chamberCards.length)
  const thenDraw = chamberEffect?.kind === 'discardChamber'
    ? chamberEffect.then?.find((effect): effect is Extract<Effect, { kind: 'draw' }> => effect.kind === 'draw')?.amount
    : undefined
  const replacements = Math.max(0, loadAmount - Math.max(0, player.chamberSlots - player.chamber.length))
  const chamberAmount = Math.min(chamberCards.length, chamberBase + replacements)
  return {
    loadCards,
    chamberCards,
    loadAmount,
    loadMinimum: load?.upTo ? 0 : loadAmount,
    chamberAmount,
    chamberMinimum: chamberEffect?.kind === 'discardChamber' && chamberEffect.optional ? 0 : chamberAmount,
    loadDiscount: load?.discount === true,
    chamberThenDraw: typeof thenDraw === 'number' ? thenDraw : 0,
    chamberAction: chamberEffect?.kind === 'playChamber' ? 'play' : chamberEffect?.kind === 'discardChamber'
      ? 'discard' : chamberEffect?.kind === 'discountChamber' ? 'discount' : 'replace',
  }
}

export function triggerNeedsHermitChoice(_state: CombatState, player: Player, source: TriggerSource): boolean {
  if (source.presentationSourceId === 'hermit_combo' && player.chamberSlots > 0 &&
    player.hand.length + player.draw.length + player.discard.length > 0) return true
  return triggerHermitChoices(player, source) !== undefined
}

export function triggerSlimeChoice(state: CombatState, player: Player, source: TriggerSource):
  { cards: { uid: string; label: string }[]; amount: number; minimum: number } | undefined {
  const effect = source.effects.find((candidate) =>
    candidate.kind === 'growSlime' || candidate.kind === 'commandSlime' ||
    candidate.kind === 'gainSlimeVigor' || candidate.kind === 'tapSlime' || candidate.kind === 'rainOfGoop')
  const cards = (player.slimes ?? []).map((slime) => ({ uid: slime.card.uid, label: cardDef(slime.card.defId).name }))
  if (!effect || cards.length === 0 || effect.kind === 'commandSlime' && effect.all) return undefined
  if (effect.kind === 'rainOfGoop') {
    const held = source.powerUid ? player.powers.find((power) => power.uid === source.powerUid) : undefined
    return (held?.counter ?? 0) > 0 ? { cards, amount: 1, minimum: 0 } : undefined
  }
  const requested = effect.kind === 'commandSlime' && effect.upToDifferent === 99
    ? amountOf(effect.amount, state, player)
    : 'upToDifferent' in effect && effect.upToDifferent !== undefined ? effect.upToDifferent : 1
  const amount = Math.min(cards.length, requested)
  const upTo = 'upToDifferent' in effect && effect.upToDifferent !== undefined && effect.upToDifferent !== 99
  return cards.length > 1 || amount > 1 ? { cards, amount, minimum: upTo ? 0 : amount } : undefined
}

export function pendingTriggerSlimeEnemyChoiceCount(
  state: CombatState,
  triggerId: number,
  slimeUids: readonly string[],
): number {
  return pendingTriggerSlimeEnemyChoiceLabels(state, triggerId, slimeUids).length
}

export function pendingTriggerSlimeEnemyChoiceLabels(
  state: CombatState,
  triggerId: number,
  slimeUids: readonly string[],
): string[] {
  const pending = state.pendingTriggers?.find((trigger) => trigger.id === triggerId)
  const player = pending && findPlayer(state, pending.playerId)
  const source = player && pending ? triggerSourceById(player, pending.sourceId) : undefined
  if (!player || !source) return []
  const def: CardDef = {
    id: `trigger_${source.id}`, name: source.name, owner: 'colorless', type: 'skill', rarity: 'special', cost: 0,
    effects: source.effects,
  }
  const selected = slimeUids.length === 0 &&
    source.presentationSourceId !== 'slime_boss_rain_of_goop' &&
    !triggerSlimeChoice(state, player, source) && player.slimes.length === 1
    ? [player.slimes[0]!.card.uid]
    : slimeUids
  return slimeCommandEnemyChoiceLabels(def, state, player, selected)
}

export function triggerNeedsPlayerChoice(state: CombatState, source: TriggerSource): boolean {
  return source.supportScope === 'anyPlayer' &&
    state.players.filter((candidate) => !candidate.dead).length > 1
}

/** Every input a triggered ability may resolve with; absent fields take the source's defaults. */
export type TriggerResolutionOptions = {
  /** End of combat abilities still resolve after the combat is decided. */
  allowCombatOver?: boolean
  shivEnemyUids?: readonly (string | null)[]
  enemyUid?: string
  enemyRow?: number
  evokeSlots?: readonly number[]
  evokeEnemyUids?: readonly (string | null)[]
  scryDiscardUids?: readonly string[]
  targetPlayerId?: string
  exhaustUids?: readonly string[]
  /** Private Hermit/Slime choices and event-bound inputs copied into the resolution context. */
  hermitContext?: Pick<PlayContext, 'loadUids' | 'chamberUids' | 'hermitEnemyUids' | 'slimeUids' | 'slimeEnemyUids' |
    'triggerCount' | 'optionalSelfExhaust'>
}
