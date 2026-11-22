import { CARDS, faceOf, type CardDef, type Effect } from '../game/cards.ts'
import { actionsForEnemy, type EnemyAction } from '../game/enemies.ts'
import { playersInRowOf } from '../game/combat/board.ts'
import { assetPath } from '../game/assets.ts'
import rigMetadata from './rig-animation-metadata.json' with { type: 'json' }
import { POTIONS } from '../game/relics.ts'
import type { CombatState, TurnEffectPresentation } from '../game/combat/types.ts'
import { characterOfSkin, isSkinId, type SkinId } from '../game/skins.ts'
import type { CardType, CharacterId, OrbType, Enemy } from '../game/types.ts'

export type VfxFamily =
  | 'slash' | 'blunt' | 'projectile' | 'poison' | 'shiv' | 'lightning' | 'frost' | 'dark'
  | 'block' | 'buff' | 'debuff' | 'draw' | 'discard' | 'exhaust' | 'stance' | 'mantra'
  | 'orb' | 'utility'

type ActorMotion = 'none' | 'lunge' | 'recoil' | 'cast' | 'drink' | 'throw'

const MELEE_BOSS_ART = new Set([
  'gremlin_nob',
  'lagavulin', 'book_of_stabbing', 'gremlin_leader', 'taskmaster',
  'nemesis', 'spire_shield', 'spire_spear', 'blue_slaver', 'red_slaver',
  'slime_boss',
  'guardian_attack',
  'guardian_defensive',
  'the_champ',
  'bronze_automaton',
  'awakened_one_phase_1',
  'awakened_one_phase_2',
  'time_eater',
  'donu',
  'downfall_demon',
  'downfall_doppelganger',
  'downfall_trickster',
  'downfall_wrathful',
])

/** Mirror the attack's row, facing and area targeting for visual effects. */
export function enemyAttackTargetPlayerIds(state: CombatState, enemy: Enemy): string[] {
  const actions = actionsForEnemy(enemy, state.die)
  const rowTargets = playersInRowOf(state, enemy)
  return state.players.filter(player => !player.dead && actions.some(action => {
    if (action.kind === 'attack') return action.aoe || (action.facing
      ? player.facingEnemyUid === enemy.uid : rowTargets.includes(player))
    return action.kind === 'attackSequence' && action.hits.some(hit =>
      hit.aoe || rowTargets.includes(player))
  })).map(player => player.id)
}

/** One signature per boss turn that hits hardest; Donu and Deca have no such turn. */
export type BossHeavyAttack =
  | 'slime-crush' | 'hexaghost-inferno' | 'automaton-beam' | 'guardian-bash' | 'collector-fireball'
  | 'champ-execute' | 'champ-flurry' | 'awakened-rend' | 'awakened-eruption' | 'time-crush' | 'heart-pulse'
  | 'witch-hex' | 'dark-core-nova' | 'wrathful-awakening' | 'wrathful-fury' | 'orb-master-overload'
  | 'inferno-blaze' | 'trickster-ambush' | 'demon-slam' | 'wraith-reap' | 'blasphemer-smite'
  | 'divinity-ruin' | 'neow-judgement' | 'doppelganger-barrage' | 'corrupted-ruin'

type HeavyRule = Readonly<{
  kind: BossHeavyAttack
  /** Smallest printed hit (or, for a sequence, total of its hits) that counts. */
  min: number
  times?: number
  sequence?: true
  /** Rotations that share a hit size are told apart by what else the turn does. */
  with?: EnemyAction['kind']
  without?: EnemyAction['kind']
}>

/** A Boss may have several turns that earn its signature; the first matching rule decides. */
const HEAVY_ATTACK_RULES: Readonly<Record<string, HeavyRule | readonly [HeavyRule, ...HeavyRule[]]>> = {
  slime_boss: { kind: 'slime-crush', min: 6 },
  hexaghost: { kind: 'hexaghost-inferno', min: 3, times: 2 },
  bronze_automaton: { kind: 'automaton-beam', min: 7 },
  guardian_defensive: { kind: 'guardian-bash', min: 4 },
  the_collector: { kind: 'collector-fireball', min: 5 },
  the_champ: { kind: 'champ-execute', min: 5 },
  the_champ_fury: { kind: 'champ-flurry', min: 4, times: 2 },
  awakened_one_phase_1: { kind: 'awakened-rend', min: 5 },
  awakened_one_phase_2: { kind: 'awakened-eruption', min: 6 },
  time_eater: { kind: 'time-crush', min: 6 },
  corrupt_heart: { kind: 'heart-pulse', min: 5 },
  downfall_witch: { kind: 'witch-hex', min: 3 },
  downfall_dark_core: { kind: 'dark-core-nova', min: 4, without: 'block' },
  downfall_wrathful: [{ kind: 'wrathful-awakening', min: 3, with: 'transform' }, { kind: 'wrathful-awakening', min: 4 }],
  downfall_wrathful_wrath: { kind: 'wrathful-fury', min: 4, sequence: true },
  downfall_orb_master: { kind: 'orb-master-overload', min: 4, with: 'addAbilityCube' },
  downfall_inferno: { kind: 'inferno-blaze', min: 5 },
  downfall_trickster: { kind: 'trickster-ambush', min: 5 },
  downfall_demon: { kind: 'demon-slam', min: 5 },
  downfall_wraith: { kind: 'wraith-reap', min: 7 },
  downfall_blasphemer: { kind: 'blasphemer-smite', min: 5 },
  downfall_blasphemer_divinity: { kind: 'divinity-ruin', min: 4, sequence: true },
  downfall_neow: { kind: 'neow-judgement', min: 5 },
  downfall_doppelganger: { kind: 'doppelganger-barrage', min: 4, sequence: true },
  downfall_corrupted: { kind: 'corrupted-ruin', min: 5 },
}

const ACTIONS = 'combat/vfx/actions/'
const HEAVY_ATTACK_ART: Readonly<Record<BossHeavyAttack, readonly string[]>> = {
  'slime-crush': [`${ACTIONS}turn-poison-impact.webp`],
  'hexaghost-inferno': [`${ACTIONS}hexaghost-flame.webp`, `${ACTIONS}hexaghost-flame-impact.webp`],
  'automaton-beam': ['combat/vfx/hit-burst.webp'],
  'guardian-bash': [`${ACTIONS}ironclad-bash.webp`],
  'collector-fireball': [`${ACTIONS}hexaghost-flame.webp`, `${ACTIONS}ironclad-bash.webp`, `${ACTIONS}hexaghost-flame-impact.webp`],
  'champ-execute': [`${ACTIONS}ironclad-strike.webp`],
  'champ-flurry': [`${ACTIONS}ironclad-strike.webp`, `${ACTIONS}speed-trail.webp`],
  'awakened-rend': [`${ACTIONS}awakened-claw-scratch.webp`],
  'awakened-eruption': [`${ACTIONS}awakened-blue-fire.webp`],
  'time-crush': [`${ACTIONS}turn-countdown-impact.webp`, 'combat/vfx/hit-burst.webp'],
  'heart-pulse': [`${ACTIONS}turn-damage-impact.webp`],
  'witch-hex': [`${ACTIONS}magic-burst.webp`, `${ACTIONS}turn-poison-impact.webp`],
  'dark-core-nova': [`${ACTIONS}dark-channel.webp`],
  'wrathful-awakening': [`${ACTIONS}ironclad-bash.webp`, `${ACTIONS}watcher-wrath-aura.webp`],
  'wrathful-fury': [`${ACTIONS}ironclad-strike.webp`, `${ACTIONS}speed-trail.webp`],
  'orb-master-overload': [`${ACTIONS}turn-lightning-strike.webp`, `${ACTIONS}lightning-channel.webp`, `${ACTIONS}frost-channel.webp`],
  'inferno-blaze': [`${ACTIONS}awakened-blue-fire.webp`, `${ACTIONS}hexaghost-flame-impact.webp`],
  'trickster-ambush': [`${ACTIONS}silent-knife.webp`, `${ACTIONS}silent-shiv.webp`],
  'demon-slam': [`${ACTIONS}watcher-meteor.webp`, `${ACTIONS}watcher-meteor-impact.webp`],
  'wraith-reap': [`${ACTIONS}ironclad-strike.webp`],
  'blasphemer-smite': ['combat/vfx/hit-burst.webp'],
  'divinity-ruin': ['combat/vfx/hit-burst.webp'],
  'neow-judgement': [`${ACTIONS}watcher-pray.webp`, `${ACTIONS}magic-burst.webp`, 'combat/vfx/hit-burst.webp'],
  'doppelganger-barrage': [`${ACTIONS}silent-knife.webp`, `${ACTIONS}silent-shiv.webp`],
  'corrupted-ruin': [`${ACTIONS}turn-vulnerable-impact.webp`, `${ACTIONS}turn-burn-impact.webp`],
}

/** Artwork the boss's big-hit effect paints, so no frame of it waits on the network. */
export function bossHeavyArtFor(defId: string): string[] {
  const rule = rulesFor(defId)[0]
  return rule ? HEAVY_ATTACK_ART[rule.kind].map(path => assetPath(path)) : []
}

/** The baked boss swing lands at 730ms; each extra beat follows after this gap. */
export const BOSS_CONTACT_MS = 730
export const BOSS_HEAVY_HIT_GAP_MS = 320

/**
 * The printed rotation decides it, so Strength changes the number but never the
 * spectacle. `hits` counts presentation beats: a four-hit barrage still lands as
 * two so it fits inside the swing.
 */
export function bossHeavyAttackFor(
  defId: string,
  actions: readonly EnemyAction[],
): Readonly<{ kind: BossHeavyAttack; hits: number }> | undefined {
  for (const rule of rulesFor(defId)) {
    if (rule.with && !actions.some(action => action.kind === rule.with)) continue
    if (rule.without && actions.some(action => action.kind === rule.without)) continue
    for (const action of actions) {
      if (rule.sequence && action.kind === 'attackSequence' &&
        action.hits.reduce((total, hit) => total + hit.amount, 0) >= rule.min) {
        return { kind: rule.kind, hits: Math.min(2, action.hits.length) }
      }
      if (!rule.sequence && action.kind === 'attack' && action.amount >= rule.min && (action.times ?? 1) >= (rule.times ?? 1)) {
        return { kind: rule.kind, hits: Math.min(2, action.times ?? 1) }
      }
    }
  }
  return undefined
}

function rulesFor(defId: string): readonly HeavyRule[] {
  const rules = HEAVY_ATTACK_RULES[defId]
  return rules === undefined ? [] : 'kind' in rules ? [rules] : rules
}

export function bossAttackMotionFor(artId: string): 'melee' | 'ranged' {
  return (rigMetadata as Record<string, { attackMotion?: 'melee' | 'ranged' }>)[artId]?.attackMotion
    ?? (MELEE_BOSS_ART.has(artId) ? 'melee' : 'ranged')
}

const BOSS_PROJECTILE_ART = new Set([
  'downfall_blasphemer', 'downfall_corrupted', 'downfall_dark_core', 'downfall_inferno',
  'downfall_neow', 'downfall_orb_master', 'downfall_witch', 'downfall_wraith',
])

export function bossProjectileImagePath(artId: string): string | undefined {
  const projectile = (rigMetadata as Record<string, { projectile?: string }>)[artId]?.projectile
  if (projectile === 'cultist-sticks') return assetPath('combat/enemies/props/cultist-sticks.webp')
  if (projectile === 'reptomancer-dagger') return assetPath('combat/enemies/dagger.webp')
  if (projectile) return assetPath(`combat/vfx/actions/${projectile}.webp`)
  return BOSS_PROJECTILE_ART.has(artId)
    ? assetPath(`combat/enemies/projectiles/${artId}.webp`)
    : undefined
}

export function enemyProjectileImpactPath(artId: string): string | undefined {
  const impact = (rigMetadata as Record<string, { impact?: string }>)[artId]?.impact
  return impact ? assetPath(`combat/vfx/actions/${impact}.webp`) : undefined
}

export function enemyProjectileOriginFor(artId: string): [number, number] | undefined {
  const origin = (rigMetadata as Record<string, { origin?: number[] }>)[artId]?.origin
  return origin?.length === 2 ? [origin[0]!, origin[1]!] : undefined
}

export function enemyAttackAnimationFor(artId: string): string | undefined {
  return (rigMetadata as Record<string, { rootMotion?: string }>)[artId]?.rootMotion
}

export function bossAttackDurationFor(_artId: string): number {
  return 1830
}

export function enemyAttackArrivalMsFor(artId: string): number | undefined {
  if (artId === 'cultist') return 530
  return ['lagavulin', 'gremlin_leader', 'reptomancer', 'guardian_attack', 'guardian_defensive'].includes(artId)
    ? 730 : undefined
}

export function enemyArtScaleFor(artId: string): number {
  return (rigMetadata as Record<string, { scale?: number }>)[artId]?.scale ?? 1
}

export function bossAttackContactLeftFor(artId: string): number {
  if (artId === 'downfall_demon') return 38
  return (rigMetadata as Record<string, { contactLeft: number }>)[artId]?.contactLeft ?? 48
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

const orbTurnImpacts: Readonly<Record<OrbType, VfxRecipe>> = {
  lightning: recipe('lightning', 'none', 'turn-lightning-passive-impact', 'electric-gold'),
  frost: recipe('frost', 'none', 'turn-frost-passive-impact', 'focus-blue'),
  dark: recipe('dark', 'none', 'turn-dark-evoke-impact', 'fortune-purple'),
}

export function orbVfxRecipe(orb: OrbType, sourceId?: string): VfxRecipe {
  return sourceId === 'orb-end-turn' || sourceId === 'orb-evoke' ? orbTurnImpacts[orb] : orbChannels[orb]
}

const turnEffectRecipes: Readonly<Record<TurnEffectPresentation, VfxRecipe>> = {
  block: recipe('block', 'none', 'turn-block-impact', 'guard-blue'),
  damage: recipe('projectile', 'none', 'turn-damage-impact', 'blast-orange'),
  burn: recipe('debuff', 'none', 'turn-burn-impact', 'blast-orange'),
  poison: recipe('poison', 'none', 'turn-poison-impact', 'venom-green'),
  weak: recipe('debuff', 'none', 'turn-weak-impact', 'weak-grey'),
  vulnerable: recipe('debuff', 'none', 'turn-vulnerable-impact', 'vulnerable-red'),
  draw: recipe('draw', 'none', 'turn-draw-impact', 'memory-blue'),
  discard: recipe('discard', 'none', 'turn-discard-impact', 'destiny-copper'),
  exhaust: recipe('exhaust', 'none', 'turn-exhaust-impact', 'liquid-violet'),
  buff: recipe('buff', 'none', 'turn-buff-impact', 'fairy-gold'),
  strength: recipe('buff', 'none', 'turn-strength-impact', 'strength-red'),
  blockLoss: recipe('debuff', 'none', 'turn-block-loss-impact', 'impact-ochre'),
  strengthLoss: recipe('debuff', 'none', 'turn-strength-loss-impact', 'weak-grey'),
  heal: recipe('buff', 'none', 'turn-heal-impact', 'steel-green'),
  countdown: recipe('utility', 'none', 'turn-countdown-impact', 'fortune-purple'),
}

export function turnEffectVfxRecipe(effect: TurnEffectPresentation): VfxRecipe {
  return turnEffectRecipes[effect]
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
  // Slayer Pack: The unplayable egg has no effects; both faces read as the hatched dragon.
  slayer_companion: recipe('projectile', 'cast', 'magic-burst', 'ember-orange'),
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

/** A skin's own feel; a skin without an entry looks like the hero it dresses. */
const skinAttack: Partial<Record<SkinId, VfxRecipe>> = {
  kratos: recipe('slash', 'lunge', 'kratos/impact', 'ember-orange'),
  monogatari_silent: recipe('slash', 'lunge', 'monogatari_silent/impact', 'venom-green'),
  monogatari_watcher: recipe('blunt', 'lunge', 'monogatari_watcher/impact', 'astral-violet'),
  anime_slime_boss: recipe('blunt', 'lunge', 'anime_slime_boss/impact', 'chaos-green'),
}

const actorTone: Record<CharacterId, string> = {
  ironclad: 'ember-orange', silent: 'venom-green', defect: 'voltaic-blue', watcher: 'astral-violet',
  slime_boss: 'chaos-green', guardian: 'guard-blue', hexaghost: 'chaos-green', hermit: 'impact-ochre',
}

const attackRecipe = (visual: CharacterId | SkinId): VfxRecipe =>
  skinAttack[visual as SkinId] ?? actorAttack[isSkinId(visual) ? characterOfSkin(visual) : visual]
const toneOf = (visual: CharacterId | SkinId): string =>
  actorTone[isSkinId(visual) ? characterOfSkin(visual) : visual]

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

function fallbackRecipe(character: CharacterId | SkinId, def: CardDef, mode?: number, resolvedType = def.type): VfxRecipe {
  const effects = allEffects(def, mode)
  const has = (...kinds: Effect['kind'][]) => effects.some((effect) => kinds.includes(effect.kind))

  if (has('evoke', 'recurseOrb', 'fission', 'triggerOrbEndTurn')) {
    return recipe('orb', 'cast', 'magic-burst', toneOf(character))
  }
  if (has('gainLightningEndTurnBonus', 'lightningTargetsRow')) return lightningChannel
  if (has('poison', 'poisonChoices', 'multiplyPoison', 'gainHitPoison', 'attachCorpseExplosion')) return poison
  if (has('gainShiv', 'gainShivPerDiscard', 'useAllShivs', 'gainShivDamageBonus')) return shiv
  if (has('enterStance')) return recipe('stance', 'cast', 'magic-burst', toneOf(character))
  if (has('gainMiracle')) return recipe('mantra', 'cast', 'watcher-pray', 'mantra-cyan')
  if (character === 'hexaghost' && resolvedType === 'attack') return actorAttack.hexaghost
  if (has('hit', 'rowHit', 'hitChoices', 'hitPerExhaust', 'copyLastAttack')) return attackRecipe(character)
  if (has('damage', 'damagePerAttackIntent', 'execute')) {
    return recipe('projectile', 'cast', 'magic-burst', toneOf(character))
  }
  if (has('block', 'blockChoices', 'gainBlockFromLastHit', 'gainBlockPerExhaust')) {
    return recipe('block', 'recoil', 'guard-bloom', toneOf(character))
  }
  if (has('channel', 'channelDieOrb')) return recipe('utility', 'cast', 'magic-burst', toneOf(character))
  if (has('applyWeak', 'applyVulnerable', 'weakChoices', 'vulnerableChoices', 'clearTargetBlock')) {
    return recipe('debuff', 'cast', 'magic-burst', toneOf(character))
  }
  if (has('draw', 'drawThenDiscard', 'drawToHandSize', 'cycleHand', 'searchDraw', 'recoverDiscard', 'recoverExhaust', 'recoverExhaustToDraw')) {
    return recipe('draw', 'cast', 'magic-burst', toneOf(character))
  }
  if (has('discard', 'discardAny', 'discardNonRetain', 'topdeck')) {
    return recipe('discard', 'cast', 'magic-burst', toneOf(character))
  }
  if (has('exhaustFromHand', 'exhaustHand', 'exhaustDrawPile', 'removeAllOrbs', 'exhaustNextCard')) {
    return recipe('exhaust', 'cast', 'magic-burst', toneOf(character))
  }
  if (def.guardianVariableType && resolvedType === 'skill') {
    return recipe('block', 'recoil', 'guard-bloom', toneOf(character))
  }
  if (resolvedType === 'attack') return attackRecipe(character)
  if (def.type === 'power' || effects.length > 0) return recipe('buff', 'cast', 'magic-burst', toneOf(character))
  return recipe('utility', 'none', 'magic-burst', toneOf(character))
}

/** Resolve a card ID (optionally suffixed with `+`) against the acting character and chosen mode. */
/** `character` is the visual id: a worn skin's id, else the character's. */
export function cardVfxRecipe(
  character: CharacterId | SkinId,
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
