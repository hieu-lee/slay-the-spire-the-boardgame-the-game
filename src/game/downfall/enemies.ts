// Public-v1.47 Downfall bosses and every physical Summons card used by the
// official prototype. This module is intentionally registry-free: the run
// layer can merge these definitions and supplies when Downfall is selected.
import type { EnemyAction, EnemyDef, EnemyPattern, SummonSupply } from '../enemy-types.ts'
import type { EncounterCard } from '../run/types.ts'
import type { BaseCharacterId } from '../types.ts'

export type DownfallEnemyDef = EnemyDef

export type DownfallBossEncounter = EncounterCard & {
  act: 1 | 2 | 3 | 4
  rerollForCharacter?: BaseCharacterId
  ascensionReward?: { min: 10; goldReward: number }
}

export type DownfallPhysicalEnemyCard = {
  act: 1 | 2 | 3 | 4
  guid: string
  cardId: number
  index: number
  defId: string
  minAscension?: 10 | 11
}

const hp = (value: number): [number, number, number, number] => [value, value, value, value]
const pairs = (
  low: EnemyAction[],
  mid: EnemyAction[],
  high: EnemyAction[],
): Record<number, EnemyAction[]> => ({ 1: low, 2: low, 3: mid, 4: mid, 5: high, 6: high })
const halves = (low: EnemyAction[], high: EnemyAction[]): Record<number, EnemyAction[]> =>
  ({ 1: low, 2: low, 3: low, 4: high, 5: high, 6: high })
const die = (low: EnemyAction[], mid: EnemyAction[], high: EnemyAction[]): EnemyPattern =>
  ({ kind: 'die', byRoll: pairs(low, mid, high) })
const cube = (...slots: { actions: EnemyAction[]; once?: boolean }[]): EnemyPattern => ({ kind: 'cube', slots })
const single = (...actions: EnemyAction[]): EnemyPattern => ({ kind: 'single', actions })
const attack = (amount: number, extras: Omit<Extract<EnemyAction, { kind: 'attack' }>, 'kind' | 'amount'> = {}): EnemyAction =>
  ({ kind: 'attack', amount, ...extras })
const status = (card: 'burn' | 'slimed', amount: number, aoe = false): EnemyAction =>
  ({ kind: 'status', card, amount, ...(aoe ? { aoe: true } : {}) })
const boss = (
  id: string,
  name: string,
  act: 1 | 2 | 3 | 4,
  hpByPlayers: [number, number, number, number],
  pattern: EnemyPattern,
  extra: Partial<DownfallEnemyDef> = {},
): DownfallEnemyDef => ({ id, name, isBoss: true, bossAct: act, hpByPlayers, pattern, ...extra })
const enemy = (
  id: string,
  name: string,
  hpByPlayers: [number, number, number, number],
  pattern: EnemyPattern,
  extra: Partial<DownfallEnemyDef> = {},
): DownfallEnemyDef => ({ id, name, hpByPlayers, pattern, ...extra })

const witchPattern = (hard: boolean) => cube(
  { once: true, actions: [
    { kind: 'applyWeak', amount: 1, aoe: true },
    { kind: 'shuffleStatus', card: 'slimed', amount: 3 },
  ] },
  { actions: [attack(hard ? 4 : 3, { aoe: true }), status('slimed', 1, true)] },
  { actions: [{ kind: 'attackSequence', hits: [{ amount: 1, aoe: true }, { amount: 1 }] }] },
  { actions: [attack(2, { aoe: true }), { kind: 'gainStrength', amount: 1 }, status('slimed', hard ? 2 : 1, true)] },
)
const darkCorePattern = (hard: boolean) => cube(
  { once: true, actions: [attack(hard ? 3 : 2, { aoe: true }), { kind: 'summonUntil', defId: 'downfall_dark_orb', perPlayer: 1 }] },
  { actions: [attack(4, { aoe: true })] },
  { actions: [{ kind: 'attackSequence', hits: [{ amount: 1, aoe: true }, { amount: 1 }] }] },
  { actions: [attack(hard ? 4 : 3, { aoe: true }), { kind: 'block', amount: hard ? 4 : 3 }] },
  { actions: [{ kind: 'gainStrength', amount: 1 }, { kind: 'summonUntil', defId: 'downfall_dark_orb', perPlayer: 1 }] },
)
const wrathfulPattern = (hard: boolean) => cube(
  { once: true, actions: [attack(3, { aoe: true })] },
  { once: true, actions: [attack(hard ? 4 : 2, { aoe: true })] },
  { once: true, actions: [attack(3, { aoe: true }), { kind: 'transform', defId: 'downfall_wrathful_wrath' }] },
)
const orbMasterPattern = (hard: boolean) => cube(
  { actions: [attack(3, { aoe: true }), ...(hard ? [{ kind: 'gainStrength', amount: 1 } as const] : [])] },
  { actions: [attack(hard ? 4 : 3, { aoe: true }), ...(!hard ? [{ kind: 'gainStrength', amount: 1 } as const] : [])] },
  { actions: [attack(4, { aoe: true }), { kind: 'addAbilityCube', amount: 1, perPlayer: true }] },
  { actions: [{ kind: 'reviveMatching', defIds: ['downfall_lightning_orb', 'downfall_frost_orb', 'downfall_dark_orb_act2'] },
    { kind: 'gainStrength', amount: 1 }] },
)
const infernoPattern = (hard: boolean) => cube(
  { actions: [{ kind: 'attackSequence', hits: [{ amount: 2, aoe: true }, { amount: 2 }] }, status('burn', 3)] },
  { actions: [attack(hard ? 6 : 5, { aoe: true }), { kind: 'doubleNamedHp', defId: 'downfall_flame_barrier' }] },
  { actions: [attack(4, { aoe: true }), ...(hard ? [status('burn', 1, true)] : [])] },
  { actions: [{ kind: 'gainStrength', amount: 1 }] },
)
const tricksterPattern = cube(
  { actions: [status('slimed', 3, true)] },
  { actions: [attack(5, { aoe: true })] },
  { once: true, actions: [{ kind: 'applyVulnerable', amount: 1, aoe: true }] },
  { actions: [attack(3, { aoe: true }), { kind: 'gainStrength', amount: 1 }] },
)
const demonPattern = (hard: boolean) => cube(
  { once: true, actions: [attack(hard ? 4 : 2, { aoe: true }), { kind: 'applyVulnerable', amount: 1, aoe: true }] },
  { actions: [{ kind: 'attackSequence', hits: [{ amount: 2, aoe: true }, { amount: 2 }] }, { kind: 'gainStrength', amount: 1 }] },
  { actions: [attack(hard ? 6 : 5, { aoe: true }), status('burn', 2, true), { kind: 'gainStrength', amount: 1 }] },
)
const wraithPattern = (hard: boolean) => cube(
  { once: true, actions: [{ kind: 'summonUntil', defId: 'downfall_shiv', perPlayer: 3 }] },
  { actions: [{ kind: 'attackSequence', hits: [{ amount: 2, aoe: true }, { amount: 2 }] }, { kind: 'daze', amount: 1, aoe: true }] },
  { actions: [attack(5, { aoe: true }), status('slimed', hard ? 3 : 2, true)] },
  { actions: [attack(hard ? 8 : 7, { aoe: true }), { kind: 'gainStrength', amount: 1 }] },
  { actions: [{ kind: 'reviveMatching', defIds: ['downfall_shiv'] }] },
)
const blasphemerPattern = (hard: boolean) => cube(
  { actions: [attack(hard ? 6 : 5, { aoe: true })] },
  { actions: [{ kind: 'gainStrength', amount: 1 }] },
  { actions: [{ kind: 'attackSequence', hits: [{ amount: 2, aoe: true }, { amount: 2 }] }] },
)
const neowPattern = (hard: boolean) => cube(
  { once: true, actions: [{ kind: 'shuffleCurse', amount: 3, aoe: true }, { kind: 'daze', amount: hard ? 2 : 1, aoe: true }] },
  { actions: [{ kind: 'attackSequence', hits: [{ amount: 2, aoe: true }, { amount: 2 }] },
    { kind: 'healMatching', defIds: ['downfall_ironclad_slayer', 'downfall_silent_slayer',
      'downfall_defect_slayer', 'downfall_watcher_slayer'], amount: hard ? 15 : 10 }] },
  { actions: [attack(hard ? 6 : 5, { aoe: true,
    bonusIfNoLivingAlly: { defIds: ['downfall_ironclad_slayer', 'downfall_silent_slayer',
      'downfall_defect_slayer', 'downfall_watcher_slayer'], amount: 2 } })] },
  { actions: [{ kind: 'gainStrength', amount: 3 }] },
)

export const DOWNFALL_ENEMIES: Record<string, DownfallEnemyDef> = {
  downfall_witch: boss('downfall_witch', 'The Witch', 1, [35, 72, 111, 152], witchPattern(false), {
    abilities: [
      { kind: 'startCombatStatus', card: 'slimed', amount: 2 },
      { kind: 'slimedHandHpLoss', amount: 1 },
    ],
    ascension: [{
      min: 10,
      hpByPlayers: [38, 80, 118, 160],
      pattern: witchPattern(true),
      abilities: [
        { kind: 'startCombatStatus', card: 'slimed', amount: 3 },
        { kind: 'slimedHandHpLoss', amount: 1 },
      ],
    }],
  }),
  downfall_dark_core: boss('downfall_dark_core', 'The Dark Core', 1, [32, 66, 102, 140], darkCorePattern(false), {
    ascension: [{ min: 10, hpByPlayers: [35, 72, 111, 152], pattern: darkCorePattern(true),
      abilities: [{ kind: 'buffSummons', defIdPrefix: 'downfall_dark_orb', block: 1, strength: 1 }] }],
  }),
  downfall_wrathful: boss('downfall_wrathful', 'The Wrathful', 1, [44, 93, 147, 205], wrathfulPattern(false), {
    ability: { kind: 'blockFromUnblockedDamage' },
    ascension: [{ min: 10, hpByPlayers: [47, 100, 156, 218], pattern: wrathfulPattern(true) }],
  }),
  downfall_wrathful_wrath: boss('downfall_wrathful_wrath', 'The Wrathful — Wrath', 1, [44, 93, 147, 205],
    single({ kind: 'attackSequence', hits: [{ amount: 2, aoe: true }, { amount: 2 }] }, { kind: 'gainStrength', amount: 1 }), {
      artId: 'downfall_wrathful',
      abilities: [{ kind: 'blockFromUnblockedDamage' }, { kind: 'startRoundSelfVulnerable', amount: 1 }],
      ascension: [{ min: 10, hpByPlayers: [47, 100, 156, 218] }],
    }),
  downfall_orb_master: boss('downfall_orb_master', 'The Orb Master', 2, [45, 93, 144, 198], orbMasterPattern(false), {
    ability: { kind: 'buffer', initialPerPlayer: 1, max: 5 },
    ascension: [{ min: 10, hpByPlayers: [48, 100, 156, 216], pattern: orbMasterPattern(true) }],
  }),
  downfall_inferno: boss('downfall_inferno', 'The Inferno', 2, [43, 88, 140, 190], infernoPattern(false), {
    abilities: [{ kind: 'fireBreathing', burnDamage: 1 }, { kind: 'protectedBy', defIdPrefix: 'downfall_flame_barrier' }],
    ascension: [{ min: 10, hpByPlayers: [45, 92, 143, 200], pattern: infernoPattern(true),
      abilities: [{ kind: 'fireBreathing', burnDamage: 2 }, { kind: 'protectedBy', defIdPrefix: 'downfall_flame_barrier' }] }],
  }),
  downfall_trickster: boss('downfall_trickster', 'The Trickster', 2, [35, 72, 111, 152], tricksterPattern, {
    abilities: [{ kind: 'retainPlayerVulnerable' },
      { kind: 'deathTokenCleanup', token: 'vulnerable', amount: 1 }],
    ascension: [{ min: 10, hpByPlayers: [38, 80, 118, 160] }],
  }),
  downfall_demon: boss('downfall_demon', 'The Demon', 3, [50, 105, 165, 230], demonPattern(false), {
    ability: { kind: 'secondWind', defId: 'downfall_corrupted', transferStrength: true },
    ascension: [{ min: 10, hpByPlayers: [53, 114, 181, 256], pattern: demonPattern(true) }],
  }),
  downfall_wraith: boss('downfall_wraith', 'The Wraith', 3, [70, 145, 225, 310], wraithPattern(false), {
    abilities: [{ kind: 'immuneOnSlots', slots: [3] },
      { kind: 'reviveOnePerRow', defIdPrefix: 'downfall_shiv' },
      { kind: 'slimedHandHpLoss', amount: 1 }],
    ascension: [{ min: 10, pattern: wraithPattern(true), abilities: [{ kind: 'immuneOnSlots', slots: [3] },
      { kind: 'reviveOnePerRow', defIdPrefix: 'downfall_shiv' },
      { kind: 'slimedHandHpLoss', amount: 2 }] }],
  }),
  downfall_blasphemer: boss('downfall_blasphemer', 'The Blasphemer', 3, [90, 185, 285, 390], blasphemerPattern(false), {
    ability: { kind: 'blasphemy', defId: 'downfall_blasphemer_divinity' },
    ascension: [{ min: 10, hpByPlayers: [95, 200, 315, 440], pattern: blasphemerPattern(true) }],
  }),
  downfall_blasphemer_divinity: boss('downfall_blasphemer_divinity', 'The Blasphemer — Divinity', 3, [1, 1, 1, 1],
    cube({ once: true, actions: [{ kind: 'attackSequence', hits: [{ amount: 1, aoe: true }, { amount: 1 }, { amount: 1 }, { amount: 1 }] }, { kind: 'die' }] }), {
      artId: 'downfall_blasphemer',
      abilities: [{ kind: 'immuneOnSlots', slots: [0] }, { kind: 'immuneToWeak' }],
      ascension: [{ min: 10, pattern: cube({ once: true, actions: [
        { kind: 'attackSequence', hits: [{ amount: 1, aoe: true }, { amount: 1 }, { amount: 1 }, { amount: 1 }, { amount: 1 }] },
        { kind: 'die' },
      ] }) }],
    }),
  downfall_neow: boss('downfall_neow', 'Neow', 4, [75, 150, 225, 300], neowPattern(false), {
    ability: { kind: 'protectedUntilAllDead', defIds: ['downfall_ironclad_slayer', 'downfall_silent_slayer',
      'downfall_defect_slayer', 'downfall_watcher_slayer'] },
    ascension: [{ min: 11, hpByPlayers: [85, 170, 255, 340], pattern: neowPattern(true) }],
  }),

  downfall_flame_barrier: boss('downfall_flame_barrier', 'Flame Barrier', 2, [16, 32, 48, 64], cube(
    { actions: [{ kind: 'idle' }] },
    { actions: [status('burn', 2, true)] },
  ), {
    ability: { kind: 'burnOnAttackWhileSlot', slot: 0, amount: 1 },
    ascension: [{ min: 10, hpByPlayers: [20, 40, 60, 80] }],
  }),
  downfall_doppelganger: boss('downfall_doppelganger', 'Doppelganger', 2, [35, 72, 111, 152], cube(
    { actions: [{ kind: 'attackSequence', hits: [{ amount: 1, aoe: true }, { amount: 1 }] }] },
    { actions: [{ kind: 'daze', amount: 1, aoe: true }] },
    { actions: [{ kind: 'attackSequence', hits: [{ amount: 1, aoe: true }, { amount: 1 }, { amount: 1 }, { amount: 1 }] }, { kind: 'gainStrength', amount: 1 }] },
    { once: true, actions: [{ kind: 'applyWeak', amount: 1, aoe: true }] },
  ), {
    abilities: [{ kind: 'immuneToWeak' }, { kind: 'retainPlayerWeak' },
      { kind: 'deathTokenCleanup', token: 'weak', amount: 1 }],
    ascension: [{ min: 10, hpByPlayers: [38, 80, 118, 160], pattern: cube(
      { actions: [{ kind: 'attackSequence', hits: [{ amount: 1, aoe: true }, { amount: 1 }] }] },
      { actions: [{ kind: 'daze', amount: 2, aoe: true }] },
      { actions: [{ kind: 'attackSequence', hits: [{ amount: 1, aoe: true }, { amount: 1 }, { amount: 1 }, { amount: 1 }] }, { kind: 'gainStrength', amount: 1 }] },
      { once: true, actions: [{ kind: 'applyWeak', amount: 1, aoe: true }] },
    ) }],
  }),
  downfall_corrupted: boss('downfall_corrupted', 'The Corrupted', 3, [100, 210, 330, 460], cube(
    { once: true, actions: [attack(3, { aoe: true }), status('burn', 3, true)] },
    { actions: [attack(5, { aoe: true }), status('burn', 1, true)] },
    { actions: [{ kind: 'attackSequence', hits: [{ amount: 1, aoe: true }, { amount: 1 }] }, { kind: 'gainStrength', amount: 1 }] },
  ), {
    abilities: [{ kind: 'corruptSkills' }, { kind: 'berserkHpLossPerPlayer', amount: 5 }],
    ascension: [{ min: 10, hpByPlayers: [107, 228, 363, 512], pattern: cube(
      { once: true, actions: [attack(4, { aoe: true }), status('burn', 3, true)] },
      { actions: [attack(5, { aoe: true }), status('burn', 2, true)] },
      { actions: [{ kind: 'attackSequence', hits: [{ amount: 2, aoe: true }, { amount: 2 }] }, { kind: 'gainStrength', amount: 1 }] },
    ) }],
  }),

  downfall_gremlin_wizard: enemy('downfall_gremlin_wizard', 'Gremlin Wizard', hp(4), cube(
    { once: true, actions: [{ kind: 'idle' }] }, { actions: [attack(3)] },
  )),
  downfall_sneaky_gremlin: enemy('downfall_sneaky_gremlin', 'Sneaky Gremlin', hp(2), single(attack(2))),
  downfall_fat_gremlin: enemy('downfall_fat_gremlin', 'Fat Gremlin', hp(3), single(attack(1))),
  downfall_mad_gremlin: enemy('downfall_mad_gremlin', 'Mad Gremlin', hp(5), single(attack(1)), { ability: { kind: 'angry', strength: 1 } }),
  downfall_green_louse_1w2: enemy('downfall_green_louse_1w2', 'Green Louse', hp(3), die(
    [attack(1)], [{ kind: 'applyWeak', amount: 1 }], [attack(2)],
  ), { ability: { kind: 'curlUp', block: 2 } }),
  downfall_green_louse_21w: enemy('downfall_green_louse_21w', 'Green Louse', hp(3), die(
    [attack(2)], [attack(1)], [{ kind: 'applyWeak', amount: 1 }],
  ), { ability: { kind: 'curlUp', block: 2 } }),
  downfall_red_louse_21s: enemy('downfall_red_louse_21s', 'Red Louse', hp(3), die(
    [attack(2)], [attack(1)], [{ kind: 'gainStrength', amount: 1 }],
  ), { ability: { kind: 'curlUp', block: 2 } }),
  downfall_fungi_beast: enemy('downfall_fungi_beast', 'Fungi Beast', hp(5), die(
    [{ kind: 'gainStrength', amount: 2 }], [attack(2)], [attack(1), { kind: 'gainStrength', amount: 1 }],
  ), { ability: { kind: 'sporeCloud', vulnerable: 1 } }),
  downfall_sentry_a: enemy('downfall_sentry_a', 'Sentry A', hp(7),
    { kind: 'die', byRoll: halves([{ kind: 'daze', amount: 1 }], [attack(3)]) }),
  downfall_sentry_b: enemy('downfall_sentry_b', 'Sentry B', hp(8),
    { kind: 'die', byRoll: halves([attack(3)], [{ kind: 'daze', amount: 1 }]) }),
  downfall_large_slime_w4s: enemy('downfall_large_slime_w4s', 'Large Slime', hp(10), die(
    [attack(1), { kind: 'applyWeak', amount: 2 }], [attack(4)], [attack(3), status('slimed', 2)],
  )),
  downfall_large_slime_4sw: enemy('downfall_large_slime_4sw', 'Large Slime', hp(10), die(
    [attack(4)], [attack(3), status('slimed', 2)], [attack(1), { kind: 'applyWeak', amount: 2 }],
  )),
  downfall_large_slime_sw4: enemy('downfall_large_slime_sw4', 'Large Slime', hp(10), die(
    [attack(3), status('slimed', 2)], [attack(1), { kind: 'applyWeak', amount: 2 }], [attack(4)],
  )),
  downfall_acid_slime_2wd: enemy('downfall_acid_slime_2wd', 'Acid Slime', hp(5), die(
    [attack(2)], [{ kind: 'applyWeak', amount: 1 }], [attack(2), { kind: 'daze', amount: 1 }],
  )),
  downfall_acid_slime_d2w: enemy('downfall_acid_slime_d2w', 'Acid Slime', hp(5), die(
    [attack(2), { kind: 'daze', amount: 1 }], [attack(2)], [{ kind: 'applyWeak', amount: 1 }],
  )),
  downfall_acid_slime_wd2: enemy('downfall_acid_slime_wd2', 'Acid Slime', hp(5), die(
    [{ kind: 'applyWeak', amount: 1 }], [attack(2), { kind: 'daze', amount: 1 }], [attack(2)],
  )),
  downfall_acid_slime_w2d: enemy('downfall_acid_slime_w2d', 'Acid Slime', hp(5), die(
    [{ kind: 'applyWeak', amount: 1 }], [attack(2)], [attack(2), { kind: 'daze', amount: 1 }],
  )),
  downfall_spike_slime_vd2: enemy('downfall_spike_slime_vd2', 'Spike Slime', hp(5), die(
    [attack(1), { kind: 'applyVulnerable', amount: 1 }, { kind: 'actsLast' }], [attack(1), { kind: 'daze', amount: 1 }], [attack(2)],
  )),
  downfall_spike_slime_dv2: enemy('downfall_spike_slime_dv2', 'Spike Slime', hp(5), die(
    [attack(1), { kind: 'daze', amount: 1 }], [attack(1), { kind: 'applyVulnerable', amount: 1 }, { kind: 'actsLast' }], [attack(2)],
  )),
  downfall_spike_slime_v2d: enemy('downfall_spike_slime_v2d', 'Spike Slime', hp(5), die(
    [attack(1), { kind: 'applyVulnerable', amount: 1 }, { kind: 'actsLast' }], [attack(2)], [attack(1), { kind: 'daze', amount: 1 }],
  )),
  downfall_spike_slime_2dv: enemy('downfall_spike_slime_2dv', 'Spike Slime', hp(5), die(
    [attack(2)], [attack(1), { kind: 'daze', amount: 1 }], [attack(1), { kind: 'applyVulnerable', amount: 1 }, { kind: 'actsLast' }],
  )),
  downfall_dark_orb: enemy('downfall_dark_orb', 'Dark Orb', [8, 8, 10, 10], cube(
    { once: true, actions: [{ kind: 'idle' }] }, { once: true, actions: [attack(4), { kind: 'die' }] },
  )),

  downfall_byrd_s31: enemy('downfall_byrd_s31', 'Byrd', hp(4), die(
    [{ kind: 'gainStrength', amount: 1 }], [attack(3)], [attack(1, { times: 2 })],
  ), { ability: { kind: 'flying', maxDamagePerHit: 1 } }),
  downfall_byrd_31s: enemy('downfall_byrd_31s', 'Byrd', hp(4), die(
    [attack(3)], [attack(1, { times: 2 })], [{ kind: 'gainStrength', amount: 1 }],
  ), { ability: { kind: 'flying', maxDamagePerHit: 1 } }),
  downfall_byrd_s13: enemy('downfall_byrd_s13', 'Byrd', hp(4), die(
    [{ kind: 'gainStrength', amount: 1 }], [attack(1, { times: 2 })], [attack(3)],
  ), { ability: { kind: 'flying', maxDamagePerHit: 1 } }),
  downfall_cultist: enemy('downfall_cultist', 'Cultist', hp(9), single(attack(1), { kind: 'gainStrength', amount: 1 })),
  downfall_bronze_orb_3db: enemy('downfall_bronze_orb_3db', 'Bronze Orb', hp(19), die(
    [attack(3)], [attack(2), { kind: 'daze', amount: 1 }], [{ kind: 'blockNamed', defId: 'bronze_automaton', amount: 3 }],
  )),
  downfall_bronze_orb_3bd: enemy('downfall_bronze_orb_3bd', 'Bronze Orb', hp(19), die(
    [attack(3)], [{ kind: 'blockNamed', defId: 'bronze_automaton', amount: 3 }], [attack(2), { kind: 'daze', amount: 1 }],
  )),
  downfall_bronze_orb_db3: enemy('downfall_bronze_orb_db3', 'Bronze Orb', hp(19), die(
    [attack(2), { kind: 'daze', amount: 1 }], [{ kind: 'blockNamed', defId: 'bronze_automaton', amount: 3 }], [attack(3)],
  )),
  downfall_bronze_orb_b3d: enemy('downfall_bronze_orb_b3d', 'Bronze Orb', hp(19), die(
    [{ kind: 'blockNamed', defId: 'bronze_automaton', amount: 3 }], [attack(3)], [attack(2), { kind: 'daze', amount: 1 }],
  )),
  downfall_torch_head: enemy('downfall_torch_head', 'Torch Head', hp(9), single(attack(1))),
  downfall_mugger: enemy('downfall_mugger', 'Mugger', hp(12), cube(
    { once: true, actions: [attack(2), { kind: 'block', amount: 1 }] },
    { once: true, actions: [attack(2)] },
    { once: true, actions: [attack(4), { kind: 'block', amount: 2 }] },
    { once: true, actions: [{ kind: 'loseGold', amount: 2 }, { kind: 'leave' }] },
  )),
  downfall_mystic_h2s: enemy('downfall_mystic_h2s', 'Mystic', hp(12), die(
    [{ kind: 'healAllEnemies', amount: 3 }], [attack(2), { kind: 'applyWeak', amount: 1 }], [{ kind: 'strengthenAllEnemies', amount: 1 }, { kind: 'actsLast' }],
  )),
  downfall_mystic_2sh: enemy('downfall_mystic_2sh', 'Mystic', hp(12), die(
    [attack(2), { kind: 'applyWeak', amount: 1 }], [{ kind: 'strengthenAllEnemies', amount: 1 }, { kind: 'actsLast' }], [{ kind: 'healAllEnemies', amount: 3 }],
  )),
  downfall_blue_slaver_dw3: enemy('downfall_blue_slaver_dw3', 'Blue Slaver', hp(10), die(
    [attack(2), { kind: 'daze', amount: 1 }], [attack(2), { kind: 'applyWeak', amount: 1 }], [attack(3)],
  )),
  downfall_blue_slaver_w3d: enemy('downfall_blue_slaver_w3d', 'Blue Slaver', hp(10), die(
    [attack(2), { kind: 'applyWeak', amount: 1 }], [attack(3)], [attack(2), { kind: 'daze', amount: 1 }],
  )),
  downfall_blue_slaver_3wd: enemy('downfall_blue_slaver_3wd', 'Blue Slaver', hp(10), die(
    [attack(3)], [attack(2), { kind: 'applyWeak', amount: 1 }], [attack(2), { kind: 'daze', amount: 1 }],
  )),
  downfall_blue_slaver_wd3: enemy('downfall_blue_slaver_wd3', 'Blue Slaver', hp(10), die(
    [attack(2), { kind: 'applyWeak', amount: 1 }], [attack(2), { kind: 'daze', amount: 1 }], [attack(3)],
  )),
  downfall_red_slaver_dv3: enemy('downfall_red_slaver_dv3', 'Red Slaver', hp(10), die(
    [attack(2), { kind: 'daze', amount: 1 }], [attack(2), { kind: 'applyVulnerable', amount: 1 }], [attack(3)],
  ), { actsLast: true }),
  downfall_red_slaver_3dv: enemy('downfall_red_slaver_3dv', 'Red Slaver', hp(10), die(
    [attack(3)], [attack(2), { kind: 'daze', amount: 1 }], [attack(2), { kind: 'applyVulnerable', amount: 1 }],
  ), { actsLast: true }),
  downfall_red_slaver_3vd: enemy('downfall_red_slaver_3vd', 'Red Slaver', hp(10), die(
    [attack(3)], [attack(2), { kind: 'applyVulnerable', amount: 1 }], [attack(2), { kind: 'daze', amount: 1 }],
  ), { actsLast: true }),
  downfall_red_slaver_v3d: enemy('downfall_red_slaver_v3d', 'Red Slaver', hp(10), die(
    [attack(2), { kind: 'applyVulnerable', amount: 1 }], [attack(3)], [attack(2), { kind: 'daze', amount: 1 }],
  ), { actsLast: true }),
  downfall_fungi_beast_a7: enemy('downfall_fungi_beast_a7', 'Fungi Beast', hp(6), die(
    [{ kind: 'gainStrength', amount: 1 }], [attack(2)], [attack(1), { kind: 'gainStrength', amount: 1 }],
  ), { ability: { kind: 'sporeCloud', vulnerable: 1 } }),
  downfall_lightning_orb: enemy('downfall_lightning_orb', 'Lightning Orb', hp(9), single(attack(1)), {
    ability: { kind: 'focusFromAllyStrength', defId: 'downfall_orb_master' },
  }),
  downfall_frost_orb: enemy('downfall_frost_orb', 'Frost Orb', hp(9), single({ kind: 'idle' }), {
    ability: { kind: 'grantAllyBuffer', defId: 'downfall_orb_master', amount: 2 },
  }),
  downfall_dark_orb_act2: enemy('downfall_dark_orb_act2', 'Dark Orb', hp(9), cube(
    { once: true, actions: [{ kind: 'idle' }] }, { once: true, actions: [attack(5), { kind: 'die' }] },
  ), { ability: { kind: 'focusFromAllyStrength', defId: 'downfall_orb_master' } }),

  downfall_dagger: enemy('downfall_dagger', 'Dagger', hp(5), cube(
    { once: true, actions: [attack(2)] }, { once: true, actions: [attack(5), { kind: 'die' }] },
  )),
  downfall_jaw_worm_3b4: enemy('downfall_jaw_worm_3b4', 'Jaw Worm', hp(10), die(
    [attack(3), { kind: 'block', amount: 1 }], [attack(4)], [{ kind: 'block', amount: 3 }, { kind: 'gainStrength', amount: 1 }],
  )),
  downfall_jaw_worm_4b3: enemy('downfall_jaw_worm_4b3', 'Jaw Worm', hp(10), die(
    [attack(4)], [{ kind: 'block', amount: 3 }, { kind: 'gainStrength', amount: 1 }], [attack(3), { kind: 'block', amount: 1 }],
  )),
  downfall_exploder: enemy('downfall_exploder', 'Exploder', hp(10), cube(
    { once: true, actions: [attack(3)] }, { once: true, actions: [{ kind: 'idle' }] },
    { once: true, actions: [attack(10), { kind: 'die' }] },
  )),
  downfall_spiker_add: enemy('downfall_spiker_add', 'Spiker', hp(10),
    { kind: 'die', byRoll: halves([{ kind: 'addAbilityCube', amount: 1 }], [attack(2)]) },
    { ability: { kind: 'thorns', damagePerCube: 1, startingCubes: 1, maxCubes: 5 } }),
  downfall_spiker_attack: enemy('downfall_spiker_attack', 'Spiker', hp(10),
    { kind: 'die', byRoll: halves([attack(2)], [{ kind: 'addAbilityCube', amount: 1 }]) },
    { ability: { kind: 'thorns', damagePerCube: 1, startingCubes: 1, maxCubes: 5 } }),
  downfall_repulsor: enemy('downfall_repulsor', 'Repulsor', hp(7),
    { kind: 'die', byRoll: halves([attack(3)], [attack(1), { kind: 'daze', amount: 2 }]) }),
  downfall_spheric_guardian_a7: enemy('downfall_spheric_guardian_a7', 'Spheric Guardian', hp(5), cube(
    { actions: [attack(2), { kind: 'block', amount: 5 }] }, { actions: [attack(5)] },
  ), { startingBlock: 10, retainsBlock: true }),
  downfall_darkling_bha: enemy('downfall_darkling_bha', 'Darkling', hp(8), die(
    [{ kind: 'block', amount: 3 }, { kind: 'gainStrength', amount: 1 }], [attack(3), { kind: 'healSelf', amount: 2 }], [attack(2, { times: 2 })],
  ), { ability: { kind: 'regrow' } }),
  downfall_darkling_hab: enemy('downfall_darkling_hab', 'Darkling', hp(8), die(
    [attack(3), { kind: 'healSelf', amount: 2 }], [attack(2, { times: 2 })], [{ kind: 'block', amount: 3 }, { kind: 'gainStrength', amount: 1 }],
  ), { ability: { kind: 'regrow' } }),
  downfall_shiv: enemy('downfall_shiv', 'Shiv', hp(6), single(attack(1), status('slimed', 1))),

  downfall_ironclad_slayer: enemy('downfall_ironclad_slayer', 'Ironclad Slayer', hp(10), cube(
    { once: true, actions: [attack(3), { kind: 'applyVulnerable', amount: 1 }] },
    { actions: [{ kind: 'strengthenAllEnemies', amount: 1 }] },
    { actions: [attack(2, { times: 2 }), { kind: 'gainStrength', amount: 1 }] },
  ), { actsLast: true }),
  downfall_silent_slayer: enemy('downfall_silent_slayer', 'Silent Slayer', hp(10), cube(
    { once: true, actions: [attack(2), status('slimed', 4)] },
    { actions: [attack(1, { times: 2 }), { kind: 'applyWeak', amount: 1 }, { kind: 'gainStrength', amount: 1 }] },
    { actions: [attack(3)] },
  ), { ability: { kind: 'immuneOnSlots', slots: [2] } }),
  downfall_defect_slayer: enemy('downfall_defect_slayer', 'Defect Slayer', hp(10), cube(
    { once: true, actions: [{ kind: 'attackSequence', hits: [{ amount: 3 }, { amount: 2 }] }] },
    { actions: [attack(4)] },
    { actions: [{ kind: 'attackSequence', hits: [{ amount: 2 }, { amount: 2 }] }, { kind: 'gainStrength', amount: 1 }] },
  )),
  downfall_watcher_slayer: enemy('downfall_watcher_slayer', 'Watcher Slayer', hp(10), cube(
    { once: true, actions: [{ kind: 'blockAllEnemies', amount: 5 }] },
    { actions: [attack(3), { kind: 'gainStrength', amount: 1 }, { kind: 'gainSelfVulnerable', amount: 1 }] },
    { actions: [attack(1, { times: 3 })] },
  )),
  downfall_loot_chest: enemy('downfall_loot_chest', 'Loot Chest', hp(10), cube(
    { once: true, actions: [attack(2)] }, { once: true, actions: [{ kind: 'leave' }] },
  ), { ability: { kind: 'plunder', burns: 2, chests: 1 } }),
}

// Reuse shipped main-game cutouts for existing enemies. The four Slayers use
// their separate PC Downfall sprites; named bosses use official board-game art.
const DOWNFALL_ART_BY_NAME: Record<string, string> = {
  'Acid Slime': 'acid_slime',
  'Blue Slaver': 'blue_slaver',
  'Bronze Orb': 'bronze_orb',
  Byrd: 'byrd',
  Cultist: 'cultist',
  Dagger: 'dagger',
  Darkling: 'darkling',
  Exploder: 'exploder',
  'Fat Gremlin': 'fat_gremlin',
  'Fungi Beast': 'fungi_beast',
  'Green Louse': 'green_louse',
  'Gremlin Wizard': 'gremlin_wizard',
  'Jaw Worm': 'jaw_worm',
  'Large Slime': 'large_slime',
  'Mad Gremlin': 'mad_gremlin',
  Mugger: 'mugger',
  Mystic: 'mystic',
  'Red Louse': 'red_louse',
  'Red Slaver': 'red_slaver',
  Repulsor: 'repulsor',
  'Sentry A': 'sentry',
  'Sentry B': 'sentry',
  'Sneaky Gremlin': 'sneaky_gremlin',
  'Spheric Guardian': 'spheric_guardian',
  'Spike Slime': 'spike_slime',
  Spiker: 'spiker',
  'Torch Head': 'torch_head',
}

const DOWNFALL_ART_BY_ID: Record<string, string> = {
  downfall_witch: 'downfall_witch',
  downfall_wrathful: 'downfall_wrathful',
  downfall_wrathful_wrath: 'downfall_wrathful',
  downfall_dark_core: 'downfall_dark_core',
  downfall_orb_master: 'downfall_orb_master',
  downfall_inferno: 'downfall_inferno',
  downfall_trickster: 'downfall_trickster',
  downfall_flame_barrier: 'downfall_flame_barrier',
  downfall_doppelganger: 'downfall_doppelganger',
  downfall_demon: 'downfall_demon',
  downfall_wraith: 'downfall_wraith',
  downfall_blasphemer: 'downfall_blasphemer',
  downfall_blasphemer_divinity: 'downfall_blasphemer',
  downfall_corrupted: 'downfall_corrupted',
  downfall_neow: 'downfall_neow',
  downfall_dark_orb: 'downfall_dark_orb',
  downfall_dark_orb_act2: 'downfall_dark_orb',
  downfall_lightning_orb: 'downfall_lightning_orb',
  downfall_frost_orb: 'downfall_frost_orb',
  downfall_shiv: 'downfall_shiv',
  downfall_ironclad_slayer: 'downfall_pc_ironclad',
  downfall_silent_slayer: 'downfall_pc_silent',
  downfall_defect_slayer: 'downfall_pc_defect',
  downfall_watcher_slayer: 'downfall_pc_watcher',
  downfall_loot_chest: 'downfall_loot_chest',
}

for (const [id, def] of Object.entries(DOWNFALL_ENEMIES)) {
  def.artId = DOWNFALL_ART_BY_ID[id] ?? DOWNFALL_ART_BY_NAME[def.name] ?? def.artId
}

export function downfallEnemyDef(id: string, ascension = 0): DownfallEnemyDef {
  const def = DOWNFALL_ENEMIES[id]
  if (!def) throw new Error(`unknown Downfall enemy id: ${id}`)
  const variant = def.ascension
    ?.filter((candidate) => ascension >= candidate.min)
    .sort((a, b) => b.min - a.min)[0]
  return variant ? { ...def, ...variant, id: def.id, name: def.name } : def
}

export const DOWNFALL_BOSSES: Record<number, string[]> = {
  1: ['downfall_witch', 'downfall_dark_core', 'downfall_wrathful'],
  2: ['downfall_orb_master', 'downfall_inferno', 'downfall_trickster'],
  3: ['downfall_demon', 'downfall_wraith', 'downfall_blasphemer'],
  4: ['downfall_neow'],
}

/** Optional FAQ reroll: base-game characters may meet their own Downfall boss. */
export const DOWNFALL_SELF_BOSS_REROLLS: Partial<Record<BaseCharacterId, string[]>> = {
  ironclad: ['downfall_inferno', 'downfall_demon'],
  silent: ['downfall_witch', 'downfall_trickster', 'downfall_wraith'],
  defect: ['downfall_dark_core', 'downfall_orb_master'],
  watcher: ['downfall_wrathful', 'downfall_blasphemer'],
}

export const DOWNFALL_BOSS_ENCOUNTERS: Record<string, DownfallBossEncounter> = {
  downfall_witch: { act: 1, defId: 'downfall_witch', goldReward: 3, cardReward: 'normal', relicReward: true,
    ascensionReward: { min: 10, goldReward: 2 }, rerollForCharacter: 'silent' },
  downfall_dark_core: { act: 1, defId: 'downfall_dark_core', goldReward: 3, cardReward: 'normal', relicReward: true,
    ascensionReward: { min: 10, goldReward: 2 }, rerollForCharacter: 'defect' },
  downfall_wrathful: { act: 1, defId: 'downfall_wrathful', goldReward: 3, cardReward: 'normal', relicReward: true,
    ascensionReward: { min: 10, goldReward: 2 }, rerollForCharacter: 'watcher' },
  downfall_orb_master: { act: 2, defId: 'downfall_orb_master', goldReward: 3, cardReward: 'normal',
    relicReward: true, ascensionReward: { min: 10, goldReward: 2 },
    randomSummonsPerPlayer: { group: 'downfall_orb_master_orb', count: 2 }, rerollForCharacter: 'defect' },
  downfall_inferno: { act: 2, defId: 'downfall_inferno', goldReward: 3, cardReward: 'normal',
    relicReward: true, ascensionReward: { min: 10, goldReward: 2 },
    summons: ['downfall_flame_barrier'], rerollForCharacter: 'ironclad' },
  downfall_trickster: { act: 2, defId: 'downfall_trickster', goldReward: 3, cardReward: 'normal',
    relicReward: true, ascensionReward: { min: 10, goldReward: 2 },
    summons: ['downfall_doppelganger'], rerollForCharacter: 'silent' },
  downfall_demon: { act: 3, defId: 'downfall_demon', goldReward: 0, cardReward: null, rerollForCharacter: 'ironclad' },
  downfall_wraith: { act: 3, defId: 'downfall_wraith', goldReward: 0, cardReward: null, rerollForCharacter: 'silent' },
  downfall_blasphemer: { act: 3, defId: 'downfall_blasphemer', goldReward: 0, cardReward: null, rerollForCharacter: 'watcher' },
  downfall_neow: { act: 4, defId: 'downfall_neow', goldReward: 0, cardReward: null,
    summonsPerPlayer: ['downfall_loot_chest'],
    randomSummonsPerPlayer: { group: 'downfall_slayer', count: 1 } },
}

export const DOWNFALL_SUMMON_CARDS: SummonSupply = {
  downfall_gremlin: ['downfall_gremlin_wizard', 'downfall_sneaky_gremlin', 'downfall_fat_gremlin', 'downfall_mad_gremlin',
    'downfall_gremlin_wizard', 'downfall_sneaky_gremlin', 'downfall_fat_gremlin', 'downfall_mad_gremlin'],
  downfall_louse: ['downfall_green_louse_1w2', 'downfall_green_louse_21w', 'downfall_red_louse_21s'],
  downfall_fungi_beast: ['downfall_fungi_beast'],
  downfall_sentry: [...Array(6).fill('downfall_sentry_a'), ...Array(5).fill('downfall_sentry_b')],
  downfall_large_slime: ['downfall_large_slime_w4s', 'downfall_large_slime_4sw', 'downfall_large_slime_sw4', 'downfall_large_slime_w4s'],
  downfall_acid_slime: ['downfall_acid_slime_2wd', 'downfall_acid_slime_d2w', 'downfall_acid_slime_wd2', 'downfall_acid_slime_w2d'],
  downfall_spike_slime: ['downfall_spike_slime_vd2', 'downfall_spike_slime_dv2', 'downfall_spike_slime_v2d', 'downfall_spike_slime_2dv'],
  downfall_dark_orb: Array(4).fill('downfall_dark_orb'),
  downfall_byrd: ['downfall_byrd_s31', 'downfall_byrd_31s', 'downfall_byrd_s13'],
  downfall_cultist_act2: Array(4).fill('downfall_cultist'),
  downfall_bronze_orb: ['downfall_bronze_orb_3db', 'downfall_bronze_orb_3bd', 'downfall_bronze_orb_db3', 'downfall_bronze_orb_b3d'],
  downfall_torch_head: Array(8).fill('downfall_torch_head'),
  downfall_mugger: Array(2).fill('downfall_mugger'),
  downfall_mystic: ['downfall_mystic_h2s', 'downfall_mystic_2sh'],
  downfall_blue_slaver: ['downfall_blue_slaver_dw3', 'downfall_blue_slaver_w3d', 'downfall_blue_slaver_3wd', 'downfall_blue_slaver_wd3'],
  downfall_red_slaver: ['downfall_red_slaver_dv3', 'downfall_red_slaver_3dv', 'downfall_red_slaver_3vd', 'downfall_red_slaver_v3d'],
  downfall_fungi_beast_a7: ['downfall_fungi_beast_a7'],
  downfall_lightning_orb: Array(3).fill('downfall_lightning_orb'),
  downfall_frost_orb: Array(3).fill('downfall_frost_orb'),
  downfall_dark_orb_act2: Array(2).fill('downfall_dark_orb_act2'),
  downfall_dagger: Array(8).fill('downfall_dagger'),
  downfall_cultist_act3: Array(4).fill('downfall_cultist'),
  downfall_jaw_worm: ['downfall_jaw_worm_3b4', 'downfall_jaw_worm_4b3'],
  downfall_exploder: ['downfall_exploder'],
  downfall_spiker: ['downfall_spiker_add', 'downfall_spiker_attack'],
  downfall_repulsor: ['downfall_repulsor'],
  downfall_spheric_guardian_a7: ['downfall_spheric_guardian_a7'],
  downfall_darkling: ['downfall_darkling_bha', 'downfall_darkling_hab'],
  downfall_shiv: Array(12).fill('downfall_shiv'),
  downfall_slayer: ['downfall_ironclad_slayer', 'downfall_silent_slayer', 'downfall_defect_slayer', 'downfall_watcher_slayer'],
  downfall_loot_chest: Array(4).fill('downfall_loot_chest'),
  downfall_orb_master_orb: [
    ...Array(3).fill('downfall_lightning_orb'),
    ...Array(3).fill('downfall_frost_orb'),
    ...Array(2).fill('downfall_dark_orb_act2'),
  ],
  downfall_flame_barrier: ['downfall_flame_barrier'],
  downfall_doppelganger: ['downfall_doppelganger'],
  downfall_corrupted: Array(2).fill('downfall_corrupted'),
}

const physical = (
  act: 1 | 2 | 3 | 4,
  guid: string,
  cardIdBase: number,
  defIds: string[],
  minAscension?: 10 | 11,
): DownfallPhysicalEnemyCard[] => defIds.map((defId, index) => ({
  act, guid, cardId: cardIdBase + index, index, defId, ...(minAscension ? { minAscension } : {}),
}))

const act1Summons = [
  'downfall_gremlin_wizard', 'downfall_sneaky_gremlin', 'downfall_fat_gremlin', 'downfall_gremlin_wizard',
  'downfall_fat_gremlin', 'downfall_mad_gremlin', 'downfall_mad_gremlin', 'downfall_sneaky_gremlin',
  'downfall_green_louse_1w2', 'downfall_green_louse_21w', 'downfall_red_louse_21s', 'downfall_fungi_beast',
  'downfall_sentry_a', 'downfall_sentry_b', 'downfall_sentry_a', 'downfall_sentry_b', 'downfall_sentry_a', 'downfall_sentry_b',
  'downfall_sentry_a', 'downfall_sentry_b', 'downfall_sentry_a', 'downfall_sentry_b', 'downfall_sentry_a',
  'downfall_large_slime_w4s', 'downfall_large_slime_4sw', 'downfall_large_slime_sw4', 'downfall_large_slime_w4s',
  'downfall_acid_slime_2wd', 'downfall_acid_slime_d2w', 'downfall_acid_slime_wd2', 'downfall_acid_slime_w2d',
  'downfall_spike_slime_vd2', 'downfall_spike_slime_dv2', 'downfall_spike_slime_v2d', 'downfall_spike_slime_2dv',
  'downfall_dark_orb', 'downfall_dark_orb', 'downfall_dark_orb', 'downfall_dark_orb',
]
const act2Summons = [
  'downfall_byrd_s31', 'downfall_byrd_31s', 'downfall_byrd_s13',
  ...Array(4).fill('downfall_cultist'),
  'downfall_bronze_orb_3db', 'downfall_bronze_orb_3bd', 'downfall_bronze_orb_db3', 'downfall_bronze_orb_b3d',
  ...Array(8).fill('downfall_torch_head'), ...Array(2).fill('downfall_mugger'),
  'downfall_mystic_h2s', 'downfall_mystic_2sh',
  'downfall_blue_slaver_dw3', 'downfall_blue_slaver_w3d', 'downfall_blue_slaver_3wd', 'downfall_blue_slaver_wd3',
  'downfall_red_slaver_dv3', 'downfall_red_slaver_3dv', 'downfall_red_slaver_3vd', 'downfall_red_slaver_v3d',
  'downfall_fungi_beast_a7',
  ...Array(3).fill('downfall_lightning_orb'), ...Array(3).fill('downfall_frost_orb'), ...Array(2).fill('downfall_dark_orb_act2'),
]
const act3Summons = [
  ...Array(8).fill('downfall_dagger'), ...Array(4).fill('downfall_cultist'),
  'downfall_jaw_worm_3b4', 'downfall_jaw_worm_4b3', 'downfall_exploder', 'downfall_spiker_add',
  'downfall_spiker_attack', 'downfall_repulsor', 'downfall_spheric_guardian_a7',
  'downfall_darkling_bha', 'downfall_darkling_hab', ...Array(12).fill('downfall_shiv'),
]
const act4Summons = [
  'downfall_ironclad_slayer', 'downfall_silent_slayer', 'downfall_defect_slayer', 'downfall_watcher_slayer',
  ...Array(4).fill('downfall_loot_chest'),
]

export const DOWNFALL_SUMMON_DECKS: Record<number, string[]> = {
  1: act1Summons,
  2: act2Summons,
  3: act3Summons,
  4: act4Summons,
}

/** One entry per official TTS card, including identical physical copies. */
export const DOWNFALL_PHYSICAL_ENEMY_CARDS: DownfallPhysicalEnemyCard[] = [
  ...physical(1, 'e07486', 470000, DOWNFALL_BOSSES[1]!),
  ...physical(1, '4cc01d', 470100, DOWNFALL_BOSSES[1]!, 10),
  ...physical(2, 'f69a29', 469900, DOWNFALL_BOSSES[2]!),
  ...physical(2, 'e58442', 469600, DOWNFALL_BOSSES[2]!, 10),
  ...physical(3, '2a2330', 469800, DOWNFALL_BOSSES[3]!),
  ...physical(3, '20ba8f', 469700, DOWNFALL_BOSSES[3]!, 10),
  ...physical(4, 'dd3174', 468500, DOWNFALL_BOSSES[4]!),
  ...physical(4, '3076ab', 469500, DOWNFALL_BOSSES[4]!, 11),
  ...physical(2, 'd0c833', 470700, ['downfall_flame_barrier', 'downfall_doppelganger']),
  ...physical(2, 'b7a5e8', 470800, ['downfall_flame_barrier', 'downfall_doppelganger'], 10),
  ...physical(3, '18155b', 470400, ['downfall_corrupted', 'downfall_corrupted']),
  ...physical(3, '266706', 470300, ['downfall_corrupted', 'downfall_corrupted'], 10),
  ...physical(1, '66fbad', 467800, act1Summons),
  ...physical(2, '485ed8', 468000, act2Summons),
  ...physical(3, 'e49dd1', 468200, act3Summons),
  ...physical(4, 'e077d5', 470600, act4Summons),
]

/** The manifest contains exactly these normal-summon deck sizes. */
export const DOWNFALL_SUMMON_DECK_SIZES = { 1: 39, 2: 40, 3: 33, 4: 8 } as const
