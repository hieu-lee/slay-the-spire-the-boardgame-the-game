import { CARDS, faceOf, type CardDef, type Effect } from '../game/cards.ts'
import { assetPath } from '../game/assets.ts'
import { POTIONS } from '../game/relics.ts'
import type { CharacterId, OrbType } from '../game/types.ts'

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
  'deca',
])

export function bossAttackMotionFor(artId: string): 'melee' | 'ranged' {
  return MELEE_BOSS_ART.has(artId) ? 'melee' : 'ranged'
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
  'blood-red': '#d83344',
  'calm-white': '#eefcff',
  'chaos-green': '#7bd15c',
  'chaos-rainbow': '#ef7cff',
  'cleansing-blue': '#6cc8ff',
  'electric-cyan': '#61eaff',
  'electric-gold': '#ffd75a',
  'ember-orange': '#ff8a32',
  'energy-blue': '#4a9fff',
  'fairy-gold': '#ffe18a',
  'flame-orange': '#ff6b24',
  'focus-blue': '#41d1ff',
  'fortune-purple': '#aa6cff',
  'ghost-white': '#e8faff',
  'guard-blue': '#55b9ff',
  'impact-ochre': '#e7a43a',
  'mantra-cyan': '#62e8ff',
  'mantra-violet': '#bd7aff',
  'memory-blue': '#689cff',
  'prismatic': '#f28cff',
  'purity-white': '#fff6d8',
  'speed-cyan': '#51f2dc',
  'steel-green': '#70e7c4',
  'storm-cyan': '#39ddff',
  'storm-gold': '#f4c84c',
  'strength-red': '#ff5148',
  'tempest-cyan': '#38c8ff',
  'thunder-gold': '#ffd24d',
  'venom-green': '#83e044',
  'voltaic-blue': '#6abfff',
  'vulnerable-red': '#ff5f45',
  'weak-grey': '#aeb5c1',
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
  cunning_potion: recipe('shiv', 'drink', 'potion-burst', 'steel-green'),
  distilled_chaos: recipe('draw', 'drink', 'potion-burst', 'chaos-rainbow'),
  energy_potion: recipe('buff', 'drink', 'potion-burst', 'energy-blue'),
  entropic_brew: recipe('utility', 'drink', 'potion-burst', 'prismatic'),
  explosive_potion: recipe('projectile', 'throw', 'potion-burst', 'blast-orange'),
  fairy_in_a_bottle: recipe('buff', 'none', 'potion-burst', 'fairy-gold'),
  fire_potion: recipe('projectile', 'throw', 'potion-burst', 'flame-orange'),
  flex_potion: recipe('buff', 'drink', 'potion-burst', 'strength-red'),
  gamblers_brew: recipe('utility', 'drink', 'potion-burst', 'fortune-purple'),
  ghost_in_a_jar: recipe('buff', 'drink', 'potion-burst', 'ghost-white'),
  liquid_memories: recipe('draw', 'drink', 'potion-burst', 'memory-blue'),
  purity_potion: recipe('exhaust', 'drink', 'potion-burst', 'purity-white'),
  skill_potion: recipe('buff', 'drink', 'potion-burst', 'focus-blue'),
  snecko_oil: recipe('draw', 'drink', 'potion-burst', 'chaos-green'),
  swift_potion: recipe('draw', 'drink', 'potion-burst', 'speed-cyan'),
  vulnerable_potion: recipe('debuff', 'throw', 'potion-burst', 'vulnerable-red'),
  weak_potion: recipe('debuff', 'throw', 'potion-burst', 'weak-grey'),
}

const actorAttack: Record<CharacterId, VfxRecipe> = {
  ironclad: recipe('blunt', 'lunge', 'ironclad-strike', 'ember-orange'),
  silent: recipe('slash', 'lunge', 'silent-shiv', 'steel-green'),
  defect: recipe('projectile', 'cast', 'magic-burst', 'voltaic-blue'),
  watcher: recipe('blunt', 'lunge', 'magic-burst', 'astral-violet'),
}

const actorTone: Record<CharacterId, string> = {
  ironclad: 'ember-orange', silent: 'venom-green', defect: 'voltaic-blue', watcher: 'astral-violet',
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

function fallbackRecipe(character: CharacterId, def: CardDef, mode?: number): VfxRecipe {
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
  if (has('hit', 'hitChoices', 'hitPerExhaust')) return actorAttack[character]
  if (has('damage', 'damagePerAttackIntent', 'execute')) {
    return recipe('projectile', 'cast', 'magic-burst', actorTone[character])
  }
  if (has('block', 'blockChoices', 'gainBlockFromLastHit', 'gainBlockPerExhaust')) {
    return recipe('block', 'recoil', 'guard-bloom', actorTone[character])
  }
  if (has('channel', 'channelDieOrb')) return recipe('utility', 'cast', 'magic-burst', actorTone[character])
  if (has('applyWeak', 'applyVulnerable', 'clearTargetBlock')) {
    return recipe('debuff', 'cast', 'magic-burst', actorTone[character])
  }
  if (has('draw', 'drawThenDiscard', 'drawToHandSize', 'cycleHand', 'searchDraw', 'recoverDiscard', 'recoverExhaust')) {
    return recipe('draw', 'cast', 'magic-burst', actorTone[character])
  }
  if (has('discard', 'discardAny', 'discardNonRetain', 'topdeck')) {
    return recipe('discard', 'cast', 'magic-burst', actorTone[character])
  }
  if (has('exhaustFromHand', 'exhaustHand', 'exhaustDrawPile', 'removeAllOrbs')) {
    return recipe('exhaust', 'cast', 'magic-burst', actorTone[character])
  }
  if (def.type === 'attack') return actorAttack[character]
  if (def.type === 'power' || effects.length > 0) return recipe('buff', 'cast', 'magic-burst', actorTone[character])
  return recipe('utility', 'none', 'magic-burst', actorTone[character])
}

/** Resolve a card ID (optionally suffixed with `+`) against the acting character and chosen mode. */
export function cardVfxRecipe(
  character: CharacterId,
  cardId: string,
  mode?: number,
  upgraded = cardId.endsWith('+'),
): VfxRecipe {
  const baseId = cardId.endsWith('+') ? cardId.slice(0, -1) : cardId
  const base = CARDS[baseId]
  if (!base) throw new Error(`unknown card id: ${cardId}`)
  return CARD_OVERRIDES[baseId] ?? fallbackRecipe(character, faceOf(base, upgraded), mode)
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
