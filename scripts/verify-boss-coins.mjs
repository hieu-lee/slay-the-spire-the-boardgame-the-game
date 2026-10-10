// Boss victories in real runs pay the coins the economy promises: one award per
// boss (not per player), rolled from the run's seed, never on a Daily Climb,
// and fixed once rolled so a saved run resumes with the same coins.
import { suite, check, assert, assertEqual, assertDeepEqual, report } from './lib/harness.mjs'
import { postNeowRun } from './lib/post-neow-run.mjs'
import { chooseEvent, createRun, enterRoom, finishRun, resolveCombat, roomChoices, startPendingBoss } from '../src/game/run.ts'
import { bossCoinRange, coinsOwed, rollBossCoins } from '../src/game/coins.ts'
import { createCampaignProgress } from '../src/game/campaign.ts'
import { createEventRoom } from '../src/game/event-room.ts'
import { EVENT_CARDS } from '../src/game/events.ts'
import { BOSSES } from '../src/game/run/encounters.ts'
import { DOWNFALL_BOSSES } from '../src/game/downfall/enemies.ts'

const solo = [{ id: 'p1', name: 'Ann', character: 'ironclad' }]
const duo = [...solo, { id: 'p2', name: 'Bo', character: 'silent' }]

/** A real fight, moved into the act's boss room and won there. */
function winBossRoom(run) {
  const fighting = enterRoom(run, roomChoices(run)[0].id)
  assertEqual(fighting.phase, 'combat', 'precondition: a fight started')
  const boss = Object.values(fighting.map.rooms).find((room) => room.kind === 'boss')
  return resolveCombat(wonAt(fighting, boss.id))
}

function wonAt(run, roomId) {
  return {
    ...run,
    map: { ...run.map, position: roomId, rooms: { ...run.map.rooms, [roomId]: { ...run.map.rooms[roomId], visited: true } } },
    combat: {
      ...run.combat,
      phase: 'won',
      enemies: run.combat.enemies.map((enemy) => ({ ...enemy, hp: 0, dead: true, isBoss: true })),
    },
  }
}

suite('boss coins in real runs')

check('an Act I boss pays one rolled award at Ascension 0, solo', () => {
  const run = postNeowRun(101, solo)
  assertEqual(run.campaign.bossCoins, undefined, 'a fresh run holds no awards')
  const won = winBossRoom(run)
  assertEqual(won.campaign.bossCoins.length, 1)
  const [award] = won.campaign.bossCoins
  assertEqual(award.act, 1)
  assertEqual(award.coins, rollBossCoins(101, 0, 1, 0))
  const { min, max } = bossCoinRange(1, 0)
  assert(award.coins >= min && award.coins <= max, `${award.coins} is outside ${min}-${max}`)
})

check('a party earns one award per boss, which every player is owed in full', () => {
  const won = winBossRoom(postNeowRun(202, duo, 5))
  assertEqual(won.campaign.bossCoins.length, 1, 'not one award per player')
  assertEqual(won.campaign.bossCoins[0].coins, rollBossCoins(202, 0, 1, 5))
  assertEqual(coinsOwed(won.campaign.bossCoins), won.campaign.bossCoins[0].coins)
})

check('ordinary and elite fights pay nothing', () => {
  const run = postNeowRun(303, solo)
  const fighting = enterRoom(run, roomChoices(run)[0].id)
  const won = resolveCombat({ ...fighting, combat: { ...fighting.combat, phase: 'won',
    enemies: fighting.combat.enemies.map((enemy) => ({ ...enemy, hp: 0, dead: true })) } })
  assertEqual(won.campaign.bossCoins, undefined)
  assertEqual(won.campaign.bossesDefeated, 0)
})

check("Ascension 13's two Act III bosses each pay an Act III award", () => {
  let run = postNeowRun(404, duo, 13, { ...createCampaignProgress(), highestAscension: 13 })
  run = { ...run, act: 3, map: { ...run.map, act: 3 },
    campaign: { ...run.campaign, bossCoins: [{ act: 1, coins: 80 }, { act: 2, coins: 160 }] } }
  const fighting = enterRoom(run, roomChoices(run)[0].id)
  const boss = Object.values(fighting.map.rooms).find((room) => room.kind === 'boss')
  // The second Act III boss is drawn when the first is entered; reserve one here.
  const first = resolveCombat({ ...wonAt(fighting, boss.id), pendingBossDefId: 'time_eater' })
  assertEqual(first.phase === 'betweenCombat' || first.rewardDestination === 'betweenCombat', true,
    'precondition: the second boss is still to come')
  assertEqual(first.campaign.bossCoins.length, 3)
  assertDeepEqual(first.campaign.bossCoins[2], { act: 3, coins: rollBossCoins(404, 2, 3, 13) })
  const second = startPendingBoss({ ...first, phase: 'betweenCombat', rewards: [], rewardDestination: null })
  assertEqual(second.phase, 'combat', 'precondition: the reserved boss is fought')
  const done = resolveCombat(wonAt(second, second.map.position))
  assertEqual(done.campaign.bossCoins.length, 4)
  assertDeepEqual(done.campaign.bossCoins[3], { act: 3, coins: rollBossCoins(404, 3, 3, 13) })
  const { min, max } = bossCoinRange(3, 13)
  for (const award of done.campaign.bossCoins.slice(2)) assert(award.coins >= min && award.coins <= max)
})

check("a Mind Bloom boss pays by the Act of the boss it summons, not the Act it is fought in", () => {
  // The real event: Act III's Mind Bloom "War" option summons an Act I boss.
  const run = postNeowRun(505, duo, 2)
  const [first] = roomChoices(run)
  const atEvent = {
    ...run, act: 3, map: { ...run.map, act: 3, position: first.id }, phase: 'room',
    roomState: createEventRoom(EVENT_CARDS.find((card) => card.id === 'mind_bloom')),
  }
  let fighting = chooseEvent(atEvent, 'p1', { optionIds: ['war'] })
  fighting = chooseEvent(fighting, 'p2', { optionIds: ['war'] })
  assertEqual(fighting.phase, 'combat', 'precondition: Mind Bloom started its boss fight')
  assertEqual(fighting.eventCombat.mindBloom, true)
  assert(BOSSES[1].includes(fighting.eventCombat.bossDefId), `precondition: ${fighting.eventCombat.bossDefId} is an Act I boss`)
  const won = resolveCombat({ ...fighting, combat: { ...fighting.combat, phase: 'won',
    enemies: fighting.combat.enemies.map((enemy) => ({ ...enemy, hp: 0, dead: true })) } })
  assertDeepEqual(won.campaign.bossCoins, [{ act: 1, coins: rollBossCoins(505, 0, 1, 2) }])

  // A Downfall boss is looked up in its own roster; a boss in no roster keeps the Act.
  const fight = enterRoom(postNeowRun(506, solo), roomChoices(postNeowRun(506, solo))[0].id)
  const asBonus = (bossDefId) => resolveCombat({ ...fight, act: 3, eventCombat: { kind: 'boss', mindBloom: true, bossDefId },
    combat: { ...fight.combat, phase: 'won', enemies: fight.combat.enemies.map((enemy) => ({ ...enemy, hp: 0, dead: true })) } })
  assertEqual(asBonus(DOWNFALL_BOSSES[2][0]).campaign.bossCoins[0].act, 2)
  assertEqual(asBonus(undefined).campaign.bossCoins[0].act, 3)
})

check('a Daily Climb boss pays nothing', () => {
  const daily = createRun(1, solo, 0, createCampaignProgress(), false, false, { mode: 'daily', dailyDate: '2026-10-09' })
  const won = winBossRoom({ ...daily, phase: 'map', neow: null })
  assertEqual(won.campaign.bossesDefeated, 1, 'precondition: the boss was beaten')
  assertEqual(won.campaign.bossCoins, undefined)
})

check('a saved run resumes with its rolled coins, and the next boss rolls a fresh number', () => {
  const won = winBossRoom(postNeowRun(606, solo, 8))
  const resumed = JSON.parse(JSON.stringify(won))
  assertDeepEqual(resumed.campaign.bossCoins, won.campaign.bossCoins, 'the save keeps the award')
  const again = winBossRoom({ ...resumed, phase: 'map', rewards: [], rewardDestination: null,
    map: { ...resumed.map, position: null } })
  assertEqual(again.campaign.bossCoins[0].coins, won.campaign.bossCoins[0].coins, 'the first award is not re-rolled')
  assertDeepEqual(again.campaign.bossCoins[1], { act: 1, coins: rollBossCoins(606, 1, 1, 8) })
})

check('boss coins never touch the run RNG, so seeds play out as before', () => {
  const run = postNeowRun(707, solo)
  const fighting = enterRoom(run, roomChoices(run)[0].id)
  const boss = Object.values(fighting.map.rooms).find((room) => room.kind === 'boss')
  const won = resolveCombat(wonAt(fighting, boss.id))
  const withoutCoins = resolveCombat({ ...wonAt(fighting, boss.id), meta: { ...fighting.meta, dailyDate: '2026-10-09' } })
  assertDeepEqual(won.rng, withoutCoins.rng, 'rolling the award consumed run RNG')
})

check('recording the result keeps the awards it is about to pay', () => {
  const won = winBossRoom(postNeowRun(808, solo))
  const recorded = finishRun({ ...won, phase: 'victory', rewards: [], rewardDestination: null, roomState: null })
  assertEqual(recorded.campaign.finalized, true)
  assertDeepEqual(recorded.campaign.bossCoins, won.campaign.bossCoins, 'the wallet is paid from the finalized run')
})

report('boss coins')
