import { CARDS, faceOf, type CardDef, type Effect } from '../game/cards.ts'
import { assetPath } from '../game/assets.ts'
import { POTIONS } from '../game/relics.ts'
import type { CardType, CharacterId, OrbType } from '../game/types.ts'

export type VfxFamily =
  | 'slash' | 'blunt' | 'projectile' | 'poison' | 'shiv' | 'lightning' | 'frost' | 'dark'
  | 'block' | 'buff' | 'debuff' | 'draw' | 'discard' | 'exhaust' | 'stance' | 'mantra'
  | 'orb' | 'utility'

export type ActorMotion = 'none' | 'lunge' | 'recoil' | 'cast' | 'drink' | 'throw'

const MELEE_BOSS_ART = new Set([
  'slime_boss',
  'guardian_attack',
  'guardian_defensive',
  'the_champ',
  'bronze_automaton',
  'awakened_one_phase_1',
  'awakened_one_phase_2',
  'time_eater',
  'donu',
])

export function bossAttackMotionFor(artId: string): 'melee' | 'ranged' {
  return MELEE_BOSS_ART.has(artId) ? 'melee' : 'ranged'
}

// Per-asset presentation metadata. Scale is measured against the idle cutout's
// alpha height; contactLeft is the impact frame's first visible source pixel.
const BOSS_ATTACK_ART = new Map<string, readonly [scale: number, contactLeft: number]>([
  ['awakened_one_phase_1', [0.928, 35]],
  ['awakened_one_phase_2', [0.736, 34]],
  ['bronze_automaton', [1.095, 66]],
  ['corrupt_heart', [0.782, 24]],
  ['deca', [0.947, 25]],
  ['donu', [0.764, 24]],
  ['guardian_attack', [1.12, 24]],
  ['guardian_defensive', [1.091, 24]],
  ['hexaghost', [1.031, 24]],
  ['slime_boss', [1, 28]],
  ['the_champ', [1.059, 24]],
  ['the_collector', [1.072, 24]],
  ['time_eater', [0.836, 42]],
])

const SHORT_BOSS_ATTACK_ART = new Set([
  'downfall_corrupted', 'downfall_dark_core', 'downfall_demon', 'downfall_pc_defect',
  'downfall_pc_ironclad', 'downfall_pc_neow', 'downfall_pc_silent',
  'spire_shield',
])

export function bossAttackDurationFor(artId: string): number {
  return SHORT_BOSS_ATTACK_ART.has(artId) ? 580 : 1830
}

export function bossAttackScaleFor(artId: string): number {
  return BOSS_ATTACK_ART.get(artId)?.[0] ?? 1
}

export function bossAttackContactLeftFor(artId: string): number {
  return BOSS_ATTACK_ART.get(artId)?.[1] ?? 24
}

export type VfxRecipe = Readonly<{
  family: VfxFamily
  actorMotion: ActorMotion
  /** Filename without extension under public/assets/combat/vfx/actions/. */
  asset: string
  tone: string
}>

const TONE_COLORS: Readonly<Record<string, string>> = {
  'astral-cyan': '#72efff',
  'astral-violet': '#b58aff',
  'blast-orange': '#ff7a2a',
  'brew-amber': '#d8a844',
  'blood-red': '#d83344',
  'cactus-lime': '#9ecb45',
  'calm-white': '#eefcff',
  'chaos-green': '#7bd15c',
  'chaos-rainbow': '#ef7cff',
  'cleansing-blue': '#6cc8ff',
  'clever-teal': '#45c6b2',
  'cultist-crimson': '#b94e6d',
  'destiny-copper': '#c98255',
  'electric-cyan': '#61eaff',
  'electric-gold': '#ffd75a',
  'ember-orange': '#ff8a32',
  'energy-blue': '#4a9fff',
  'energy-mint': '#62dba2',
  'fairy-gold': '#ffe18a',
  'flame-orange': '#ff6b24',
  'focus-blue': '#41d1ff',
  'fortune-purple': '#aa6cff',
  'fruit-coral': '#f47f6b',
  'ghost-white': '#e8faff',
  'guard-blue': '#55b9ff',
  'impact-ochre': '#e7a43a',
  'greed-gold': '#dcb84c',
  'liquid-violet': '#8066d9',
  'mantra-cyan': '#62e8ff',
  'mantra-violet': '#bd7aff',
  'memory-blue': '#689cff',
  'mystery-indigo': '#6f7fd1',
  'nails-silver': '#bbc4d1',
  'pizzaz-pink': '#df65aa',
  'prismatic': '#f28cff',
  'purity-white': '#fff6d8',
  'speed-cyan': '#51f2dc',
  'steel-green': '#70e7c4',
  'storm-cyan': '#39ddff',
  'storm-gold': '#f4c84c',
  'strength-red': '#ff5148',
  'tempest-cyan': '#38c8ff',
  'transform-aqua': '#49bfc5',
  'thunder-gold': '#ffd24d',
  'venom-green': '#83e044',
  'voltaic-blue': '#6abfff',
  'vulnerable-red': '#ff5f45',
  'weak-grey': '#aeb5c1',
  'whale-navy': '#5275aa',
  'wrath-red': '#ff4438',
}

/** CSS colour for the semantic tone; compound fallback tones keep their family colour. */
export function vfxToneColor(tone: string): string {
  const exact = TONE_COLORS[tone]
  if (exact) return exact
  for (const [token, color] of Object.entries(TONE_COLORS)) {
    if (tone.endsWith(token)) return color
  }
  return '#f2d38c'
}

const recipe = (
  family: VfxFamily,
  actorMotion: ActorMotion,
  asset: string,
  tone: string,
): VfxRecipe => ({ family, actorMotion, asset, tone })

const lightningChannel = recipe('lightning', 'cast', 'lightning-channel', 'electric-gold')
const orbChannels: Readonly<Record<OrbType, VfxRecipe>> = {
  lightning: lightningChannel,
  frost: recipe('frost', 'cast', 'frost-channel', 'focus-blue'),
  dark: recipe('dark', 'cast', 'dark-channel', 'fortune-purple'),
}

export function orbVfxRecipe(orb: OrbType): VfxRecipe {
  return orbChannels[orb]
}
const calmStance = recipe('stance', 'cast', 'magic-burst', 'calm-white')
const wrathStance = recipe('stance', 'cast', 'magic-burst', 'wrath-red')
const neutralStance = recipe('stance', 'cast', 'magic-burst', 'astral-cyan')
const poison = recipe('poison', 'throw', 'silent-poison', 'venom-green')
const shiv = recipe('shiv', 'lunge', 'silent-shiv', 'steel-green')

export function shivVfxRecipe(): VfxRecipe {
  return shiv
}

const CARD_OVERRIDES: Readonly<Record<string, VfxRecipe>> = {
  strike_ironclad: recipe('slash', 'lunge', 'ironclad-strike', 'ember-orange'),
  bash: recipe('blunt', 'lunge', 'ironclad-bash', 'impact-ochre'),
  strike_hexaghost: recipe('projectile', 'cast', 'hexaghost-flame-impact', 'chaos-green'),

  thunder_strike: recipe('lightning', 'cast', 'lightning-channel', 'thunder-gold'),

  pray: recipe('mantra', 'cast', 'watcher-pray', 'mantra-cyan'),
  worship: recipe('mantra', 'cast', 'watcher-pray', 'mantra-violet'),
  prostrate: recipe('mantra', 'cast', 'watcher-pray', 'mantra-cyan'),
  eruption: wrathStance,
  crescendo: wrathStance,
  indignation: wrathStance,
  tantrum: wrathStance,
  vigilance: calmStance,
  inner_peace: calmStance,
  meditate: calmStance,
  tranquility: calmStance,
  fear_no_evil: calmStance,
  empty_body: neutralStance,
  empty_fist: neutralStance,
  empty_mind: neutralStance,

  deadly_poison: poison,
  poisoned_stab: poison,
  crippling_cloud: poison,
  malaise: poison,
  corpse_explosion: poison,
  noxious_fumes: poison,
  bouncing_flask: poison,
  catalyst: poison,
  blade_dance: shiv,
  cloak_and_dagger: shiv,
  infinite_blades: shiv,
  storm_of_steel: shiv,
  unload: shiv,
  riddle_with_holes: shiv,
}

const POTION_RECIPES: Readonly<Record<string, VfxRecipe>> = {
  ancient_potion: recipe('buff', 'drink', 'potion-burst', 'cleansing-blue'),
  attack_potion: recipe('buff', 'drink', 'potion-burst', 'ember-orange'),
  block_potion: recipe('block', 'drink', 'guard-bloom', 'guard-blue'),
  blood_potion: recipe('buff', 'drink', 'potion-burst', 'blood-red'),
  bottle_of_nails: recipe('projectile', 'throw', 'potion-burst', 'nails-silver'),
  cactus_juice: recipe('buff', 'drink', 'potion-burst', 'cactus-lime'),
  clever_concoction: recipe('utility', 'drink', 'potion-burst', 'clever-teal'),
  cultist_potion: recipe('buff', 'drink', 'potion-burst', 'cultist-crimson'),
  cunning_potion: recipe('shiv', 'drink', 'potion-burst', 'steel-green'),
  destiny_draught: recipe('draw', 'drink', 'potion-burst', 'destiny-copper'),
  distilled_chaos: recipe('draw', 'drink', 'potion-burst', 'chaos-rainbow'),
  energy_drink: recipe('buff', 'drink', 'potion-burst', 'energy-mint'),
  energy_potion: recipe('buff', 'drink', 'potion-burst', 'energy-blue'),
  entropic_brew: recipe('utility', 'drink', 'potion-burst', 'prismatic'),
  explosive_potion: recipe('projectile', 'throw', 'potion-burst', 'blast-orange'),
  fairy_in_a_bottle: recipe('buff', 'none', 'potion-burst', 'fairy-gold'),
  fire_potion: recipe('projectile', 'throw', 'potion-burst', 'flame-orange'),
  flex_potion: recipe('buff', 'drink', 'potion-burst', 'strength-red'),
  fruit_juice: recipe('buff', 'drink', 'potion-burst', 'fruit-coral'),
  gamblers_brew: recipe('utility', 'drink', 'potion-burst', 'fortune-purple'),
  ghost_in_a_jar: recipe('buff', 'drink', 'potion-burst', 'ghost-white'),
  greed_potion: recipe('projectile', 'throw', 'potion-burst', 'greed-gold'),
  liquid_memories: recipe('draw', 'drink', 'potion-burst', 'memory-blue'),
  liquid_void: recipe('exhaust', 'drink', 'potion-burst', 'liquid-violet'),
  mystery_potion: recipe('utility', 'drink', 'potion-burst', 'mystery-indigo'),
  pizzaz_potion: recipe('buff', 'drink', 'potion-burst', 'pizzaz-pink'),
  purity_potion: recipe('exhaust', 'drink', 'potion-burst', 'purity-white'),
  skill_potion: recipe('buff', 'drink', 'potion-burst', 'focus-blue'),
  snecko_oil: recipe('draw', 'drink', 'potion-burst', 'chaos-green'),
  swift_potion: recipe('draw', 'drink', 'potion-burst', 'speed-cyan'),
  transforming_brew: recipe('utility', 'drink', 'potion-burst', 'transform-aqua'),
  vulnerable_potion: recipe('debuff', 'throw', 'potion-burst', 'vulnerable-red'),
  weak_potion: recipe('debuff', 'throw', 'potion-burst', 'weak-grey'),
  whale_ale: recipe('buff', 'drink', 'potion-burst', 'whale-navy'),
}

const actorAttack: Record<CharacterId, VfxRecipe> = {
  ironclad: recipe('blunt', 'lunge', 'ironclad-strike', 'ember-orange'),
  silent: recipe('slash', 'lunge', 'silent-shiv', 'steel-green'),
  defect: recipe('projectile', 'cast', 'magic-burst', 'voltaic-blue'),
  watcher: recipe('blunt', 'lunge', 'magic-burst', 'astral-violet'),
  slime_boss: recipe('blunt', 'lunge', 'magic-burst', 'chaos-green'),
  guardian: recipe('blunt', 'lunge', 'guard-bloom', 'guard-blue'),
  hexaghost: recipe('projectile', 'cast', 'hexaghost-flame-impact', 'chaos-green'),
  hermit: recipe('projectile', 'lunge', 'magic-burst', 'impact-ochre'),
}

const actorTone: Record<CharacterId, string> = {
  ironclad: 'ember-orange', silent: 'venom-green', defect: 'voltaic-blue', watcher: 'astral-violet',
  slime_boss: 'chaos-green', guardian: 'guard-blue', hexaghost: 'chaos-green', hermit: 'impact-ochre',
}

function allEffects(def: CardDef, mode?: number): Effect[] {
  const selectedMode = mode === undefined ? undefined : def.modes?.[mode]
  return [
    ...def.effects,
    ...(def.persistentEffects ?? []),
    ...(selectedMode ? selectedMode.effects : (def.modes ?? []).flatMap((candidate) => candidate.effects)),
    ...(def.discardReaction?.effects ?? []),
    ...(def.exhaustReaction?.effects ?? []),
  ]
}

function fallbackRecipe(character: CharacterId, def: CardDef, mode?: number, resolvedType = def.type): VfxRecipe {
  const effects = allEffects(def, mode)
  const has = (...kinds: Effect['kind'][]) => effects.some((effect) => kinds.includes(effect.kind))

  if (has('evoke', 'recurseOrb', 'fission', 'triggerOrbEndTurn')) {
    return recipe('orb', 'cast', 'magic-burst', actorTone[character])
  }
  if (has('gainLightningEndTurnBonus', 'lightningTargetsRow')) return lightningChannel
  if (has('poison', 'poisonChoices', 'multiplyPoison', 'gainHitPoison', 'attachCorpseExplosion')) return poison
  if (has('gainShiv', 'gainShivPerDiscard', 'useAllShivs', 'gainShivDamageBonus')) return shiv
  if (has('enterStance')) return recipe('stance', 'cast', 'magic-burst', actorTone[character])
  if (has('gainMiracle')) return recipe('mantra', 'cast', 'watcher-pray', 'mantra-cyan')
  if (character === 'hexaghost' && resolvedType === 'attack') return actorAttack.hexaghost
  if (has('hit', 'rowHit', 'hitChoices', 'hitPerExhaust', 'copyLastAttack')) return actorAttack[character]
  if (has('damage', 'damagePerAttackIntent', 'execute')) {
    return recipe('projectile', 'cast', 'magic-burst', actorTone[character])
  }
  if (has('block', 'blockChoices', 'gainBlockFromLastHit', 'gainBlockPerExhaust')) {
    return recipe('block', 'recoil', 'guard-bloom', actorTone[character])
  }
  if (has('channel', 'channelDieOrb')) return recipe('utility', 'cast', 'magic-burst', actorTone[character])
  if (has('applyWeak', 'applyVulnerable', 'weakChoices', 'vulnerableChoices', 'clearTargetBlock')) {
    return recipe('debuff', 'cast', 'magic-burst', actorTone[character])
  }
  if (has('draw', 'drawThenDiscard', 'drawToHandSize', 'cycleHand', 'searchDraw', 'recoverDiscard', 'recoverExhaust', 'recoverExhaustToDraw')) {
    return recipe('draw', 'cast', 'magic-burst', actorTone[character])
  }
  if (has('discard', 'discardAny', 'discardNonRetain', 'topdeck')) {
    return recipe('discard', 'cast', 'magic-burst', actorTone[character])
  }
  if (has('exhaustFromHand', 'exhaustHand', 'exhaustDrawPile', 'removeAllOrbs', 'exhaustNextCard')) {
    return recipe('exhaust', 'cast', 'magic-burst', actorTone[character])
  }
  if (def.guardianVariableType && resolvedType === 'skill') {
    return recipe('block', 'recoil', 'guard-bloom', actorTone[character])
  }
  if (resolvedType === 'attack') return actorAttack[character]
  if (def.type === 'power' || effects.length > 0) return recipe('buff', 'cast', 'magic-burst', actorTone[character])
  return recipe('utility', 'none', 'magic-burst', actorTone[character])
}

/** Resolve a card ID (optionally suffixed with `+`) against the acting character and chosen mode. */
export function cardVfxRecipe(
  character: CharacterId,
  cardId: string,
  mode?: number,
  upgraded = cardId.endsWith('+'),
  resolvedType?: CardType,
): VfxRecipe {
  const baseId = cardId.endsWith('+') ? cardId.slice(0, -1) : cardId
  const base = CARDS[baseId]
  if (!base) throw new Error(`unknown card id: ${cardId}`)
  return CARD_OVERRIDES[baseId] ?? fallbackRecipe(character, faceOf(base, upgraded), mode, resolvedType)
}

export function potionVfxRecipe(potionId: string): VfxRecipe {
  if (!POTIONS[potionId]) throw new Error(`unknown potion id: ${potionId}`)
  const found = POTION_RECIPES[potionId]
  if (!found) throw new Error(`missing potion VFX recipe: ${potionId}`)
  return found
}

export function vfxAssetPath(recipe: Pick<VfxRecipe, 'asset'>): string {
  return assetPath(`combat/vfx/actions/${recipe.asset}.webp`)
}
