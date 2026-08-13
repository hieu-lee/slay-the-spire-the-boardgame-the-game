import {
  ACT_IV_UNLOCK_BOXES,
  CHARACTER_UNLOCKS,
  COLORLESS_UNLOCK,
  allocateSharedMarks,
  awardCampaignMarks,
  canClaimKey,
  canEnterActIV,
  characterUnlockLevel,
  claimKey,
  createCampaignProgress,
  createSpireKeys,
  finishCampaign,
  isActIVUnlocked,
  isColorlessUnlocked,
  parseCampaignProgress,
  unlockedCharacterComponents,
} from '../src/game/campaign.ts'
import { suite, check, assert, assertEqual, assertDeepEqual, assertThrows, report } from './lib/harness.mjs'

suite('campaign progression')

const componentTuple = (item) => item.kind === 'card'
  ? `${item.cardId}:${item.copies}`
  : `golden-ticket-${item.character}:${item.copies}`

check('every physical character pack has the exact threshold, card ids, and copies', () => {
  assertDeepEqual(
    Object.fromEntries(Object.entries(CHARACTER_UNLOCKS).map(([character, unlocks]) => [
      character,
      unlocks.map((unlock) => [unlock.boxes, unlock.components.map(componentTuple)]),
    ])),
    {
      ironclad: [
        [1, ['immolate:1', 'evolve:1', 'fire_breathing:1', 'power_through:1']],
        [4, ['golden-ticket-ironclad:1', 'havoc:2', 'corruption:1', 'rampage:1']],
        [8, ['barricade:1', 'dark_embrace:1', 'entrench:1', 'second_wind:1']],
      ],
      silent: [
        [1, ['prepared:2', 'grand_finale:1', 'reflex:1', 'tactician:1']],
        [4, ['golden-ticket-silent:1', 'corpse_explosion:1', 'choke:1', 'distraction:1']],
        [8, ['doppelganger:1', 'concentrate:1', 'expertise:1', 'outmaneuver:1']],
      ],
      defect: [
        [1, ['turbo:2', 'echo_form:1', 'overclock:1', 'sunder:1']],
        [4, ['golden-ticket-defect:1', 'defragment:1', 'consume:1', 'heatsinks:1']],
        [8, ['fission:1', 'double_energy:1', 'equilibrium:1', 'recycle:1']],
      ],
      watcher: [
        [1, ['flurry_of_blows:2', 'blasphemy:1', 'worship:1']],
        [4, ['golden-ticket-watcher:1', 'conjure_blade:1', 'foresight:1', 'nirvana:1', 'weave:1']],
        [8, ['omniscience:1', 'meditate:1', 'perseverance:1', 'wreath_of_flame:1']],
      ],
    },
  )
})

check('Concentrate is in the corrected third Silent pack', () => {
  assert(!CHARACTER_UNLOCKS.silent[1].components.some((item) => item.kind === 'card' && item.cardId === 'concentrate'))
  assert(CHARACTER_UNLOCKS.silent[2].components.some((item) => item.kind === 'card' && item.cardId === 'concentrate'))
})

check('the shared Colorless unlock contains the exact 22 physical cards, six Neow cards, and Event', () => {
  assertDeepEqual(COLORLESS_UNLOCK.cards.map(componentTuple), [
    'apotheosis:1', 'hand_of_greed:1', 'master_of_strategy:1', 'mayhem:1', 'the_bomb:1',
    'apparition:1', 'blind:1', 'dark_shackles:1', 'dramatic_entrance:1', 'finesse:1',
    'flash_of_steel:1', 'good_instincts:1', 'impatience:1', 'madness:1', 'mind_blast:1',
    'panacea:1', 'panache:1', 'purity:1', 'sadistic_nature:1', 'swift_strike:1',
    'thinking_ahead:1', 'trip:1',
  ])
  assertEqual(COLORLESS_UNLOCK.neowCards, 6)
  assertDeepEqual(COLORLESS_UNLOCK.event, { id: 'event-27', name: 'Sensory Stone', copies: 1 })
})

check('marks fill the played character and preserve shared overflow for an explicit track choice', () => {
  const start = createCampaignProgress()
  const first = awardCampaignMarks(start, 'silent', 5)
  assertDeepEqual(first.allocation, { character: 5, pending: 0, unused: 0 })
  assertEqual(start.characters.silent, 0, 'award mutated its input')
  const overflow = awardCampaignMarks({ ...first.progress, characters: { ...first.progress.characters, silent: 7 } }, 'silent', 10)
  assertDeepEqual(overflow.allocation, { character: 1, pending: 8, unused: 1 })
  assertEqual(overflow.progress.unspentMarks, 8)
  const colorlessFirst = allocateSharedMarks(overflow.progress, 3, 0)
  assert(isColorlessUnlocked(colorlessFirst))
  assert(!isActIVUnlocked(colorlessFirst))
  const actFirst = allocateSharedMarks(overflow.progress, 0, 5)
  assert(!isColorlessUnlocked(actFirst))
  assert(isActIVUnlocked(actFirst))
  assertEqual(characterUnlockLevel(actFirst, 'silent'), 3)
  assertEqual(unlockedCharacterComponents(actFirst, 'silent').reduce((sum, item) => sum + item.copies, 0), 13)
  assertThrows(() => allocateSharedMarks(actFirst, 0, 1), 'full Act IV track accepted another mark')
})

check('a finish awards boss count plus one to every character and is idempotent by run id', () => {
  const start = createCampaignProgress()
  const finish = { runId: 'run-42', characters: ['ironclad', 'silent'], bossesDefeated: 2, highestBossActDefeated: 2, ascensionPlayed: 0 }
  const once = finishCampaign(start, finish)
  assertEqual(once.characters.ironclad, 3)
  assertEqual(once.characters.silent, 3)
  assertEqual(once.highestAscension, 1, 'multiplayer Act II boss should unlock the next Ascension')
  assertEqual(finishCampaign(once, finish), once, 'duplicate delivery should return the saved state unchanged')
})

check('solo needs an Act III boss for Ascension while multiplayer needs Act II', () => {
  const start = createCampaignProgress()
  const soloActTwo = finishCampaign(start, { runId: 'solo-2', characters: ['defect'], bossesDefeated: 2, highestBossActDefeated: 2, ascensionPlayed: 0 })
  assertEqual(soloActTwo.highestAscension, 0)
  const soloActThree = finishCampaign(soloActTwo, { runId: 'solo-3', characters: ['defect'], bossesDefeated: 3, highestBossActDefeated: 3, ascensionPlayed: 0 })
  assertEqual(soloActThree.highestAscension, 1)
  let capped = { ...soloActThree, highestAscension: 13 }
  capped = finishCampaign(capped, { runId: 'cap', characters: ['watcher'], bossesDefeated: 3, highestBossActDefeated: 3, ascensionPlayed: 13 })
  assertEqual(capped.highestAscension, 13)
})

check('replaying below the current highest Ascension cannot unlock the next level', () => {
  const progress = { ...createCampaignProgress(), highestAscension: 3 }
  const lower = finishCampaign(progress, { runId: 'lower', characters: ['ironclad', 'silent'], bossesDefeated: 2, highestBossActDefeated: 2, ascensionPlayed: 2 })
  assertEqual(lower.highestAscension, 3)
  const current = finishCampaign(lower, { runId: 'current', characters: ['ironclad', 'silent'], bossesDefeated: 2, highestBossActDefeated: 2, ascensionPlayed: 3 })
  assertEqual(current.highestAscension, 4)
})

check('invalid finish input cannot mint campaign progress', () => {
  const start = createCampaignProgress()
  assertThrows(() => finishCampaign(start, { runId: '', characters: ['silent'], bossesDefeated: 1, highestBossActDefeated: 1, ascensionPlayed: 0 }))
  assertThrows(() => finishCampaign(start, { runId: 'x', characters: [], bossesDefeated: 1, highestBossActDefeated: 1, ascensionPlayed: 0 }))
  assertThrows(() => finishCampaign(start, { runId: 'x', characters: ['silent'], bossesDefeated: 1, highestBossActDefeated: 1, ascensionPlayed: 1 }))
  assertThrows(() => finishCampaign(start, { runId: 'x', characters: ['silent', 'silent'], bossesDefeated: 1, highestBossActDefeated: 1, ascensionPlayed: 0 }))
  assertThrows(() => finishCampaign(start, { runId: 'x', characters: ['attacker'], bossesDefeated: 1, highestBossActDefeated: 1, ascensionPlayed: 0 }))
  assertThrows(() => finishCampaign(start, { runId: 'x', characters: ['silent'], bossesDefeated: 0, highestBossActDefeated: 2, ascensionPlayed: 0 }))
  assertThrows(() => finishCampaign(start, { runId: 'x', characters: ['silent'], bossesDefeated: 5, highestBossActDefeated: 1, ascensionPlayed: 0 }))
  assertThrows(() => awardCampaignMarks(start, 'silent', -1))
})

check('Boss count accepts Mind Bloom and the A13 second Act III Boss only when reachable', () => {
  const a13 = { ...createCampaignProgress(), highestAscension: 13 }
  const maximum = finishCampaign(a13, { runId: 'six-bosses', characters: ['watcher'], bossesDefeated: 6, highestBossActDefeated: 4, ascensionPlayed: 13 })
  assertEqual(maximum.characters.watcher, 7)
  assertThrows(() => finishCampaign(createCampaignProgress(), { runId: 'early-double', characters: ['watcher'], bossesDefeated: 5, highestBossActDefeated: 3, ascensionPlayed: 0 }))
  const mindBloom = finishCampaign(createCampaignProgress(), { runId: 'mind-bloom', characters: ['watcher'], bossesDefeated: 3, highestBossActDefeated: 2, ascensionPlayed: 0 })
  assertEqual(mindBloom.characters.watcher, 4)
})

suite('spire keys and Act IV')

check('Ruby and Sapphire require every seat, including a disconnected seat, to skip together', () => {
  const players = ['p1', 'p2', 'p3', 'p4']
  assert(!canClaimKey({ key: 'ruby', playerIds: players, skippedPlayerIds: ['p1', 'p2', 'p3'] }))
  assert(canClaimKey({ key: 'ruby', playerIds: players, skippedPlayerIds: players }))
  assert(!canClaimKey({ key: 'sapphire', playerIds: players, skippedPlayerIds: ['p1', 'p2', 'p3', 'attacker'] }))
  assert(canClaimKey({ key: 'sapphire', playerIds: players, skippedPlayerIds: [...players].reverse() }))
})

check('Emerald requires the Burning Elite win and exactly two Burns shuffled for every player', () => {
  const base = { key: 'emerald', playerIds: ['p1', 'p2', 'p3'], burningEliteDefeated: true }
  assert(!canClaimKey({ ...base, burnsShuffledByPlayer: { p1: 2, p2: 2 } }))
  assert(!canClaimKey({ ...base, burnsShuffledByPlayer: { p1: 2, p2: 2, p3: 1 } }))
  assert(!canClaimKey({ ...base, burningEliteDefeated: false, burnsShuffledByPlayer: { p1: 2, p2: 2, p3: 2 } }))
  assert(canClaimKey({ ...base, burnsShuffledByPlayer: { p1: 2, p2: 2, p3: 2 } }))
})

check('keys claim once and Act IV opens only after Act III with its unlock and all keys', () => {
  const players = ['p1', 'p2']
  let keys = createSpireKeys()
  assertThrows(() => claimKey(keys, { key: 'ruby', playerIds: players, skippedPlayerIds: ['p1'] }))
  keys = claimKey(keys, { key: 'ruby', playerIds: players, skippedPlayerIds: players })
  assertEqual(claimKey(keys, { key: 'ruby', playerIds: [], skippedPlayerIds: [] }), keys, 'claimed key should be idempotent')
  keys = claimKey(keys, { key: 'sapphire', playerIds: players, skippedPlayerIds: players })
  keys = claimKey(keys, { key: 'emerald', playerIds: players, burningEliteDefeated: true, burnsShuffledByPlayer: { p1: 2, p2: 2 } })
  const locked = createCampaignProgress()
  const unlocked = { ...locked, actIV: ACT_IV_UNLOCK_BOXES }
  assert(!canEnterActIV(locked, keys, 3))
  assert(!canEnterActIV(unlocked, keys, 2))
  assert(canEnterActIV(unlocked, keys, 3))
})

check('campaign persistence accepts only a complete bounded versioned shape', () => {
  const valid = { ...createCampaignProgress(), characters: { ironclad: 8, silent: 4, defect: 1, watcher: 0 }, highestAscension: 3 }
  assertDeepEqual(parseCampaignProgress(valid), valid)
  for (const corrupt of [null, {}, { ...valid, characters: null }, { ...valid, characters: {} }, { ...valid, colorless: 99 }, { ...valid, colorless: 3, actIV: 5, unspentMarks: 1 }, { ...valid, finishedRunIds: [7] }]) {
    assertDeepEqual(parseCampaignProgress(corrupt), createCampaignProgress())
  }
})

report('campaign')
