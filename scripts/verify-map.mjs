import { generateMap, addBurningElite, availableMoves, moveTo, currentRoom, isActComplete } from '../src/game/map.ts'
import { createRng } from '../src/game/rng.ts'
import { visibleMap } from '../src/game/run/rooms.ts'
import { suite, check, assert, assertEqual, assertDeepEqual, assertThrows, report } from './lib/harness.mjs'

const build = (seed = 1, act = 1, ascension = 0) =>
  generateMap(createRng(seed), act, ascension)

const topology = (map) => map.rows.map((row) => row.map((id) => {
  const room = map.rooms[id]
  return [room.tokenBack ?? room.kind, room.exits.map((exit) => map.rooms[exit].column)]
}))

const RETAIL_TOPOLOGY = {
  1: [
    [['encounter', [0, 1, 2]]],
    [['event', [0]], ['event', [1]], ['event', [2]]],
    [['encounter', [0, 1]], ['encounter', [1, 2]], ['event', [3]]],
    [['merchant', [0]], ['light', [1]], ['event', [2]], ['encounter', [3]]],
    [['dark', [0]], ['encounter', [0, 1]], ['light', [1, 2]], ['light', [2, 3]]],
    [['event', [0]], ['dark', [0, 1]], ['encounter', [1, 2]], ['dark', [2, 3]]],
    [['treasure', [0, 1]], ['treasure', [1]], ['treasure', [2]], ['treasure', [2]]],
    [['encounter', [0, 1]], ['dark', [1, 2]], ['dark', [2, 3]]],
    [['light', [0]], ['event', [1]], ['light', [2, 3]], ['light', [3]]],
    [['encounter', [0]], ['light', [1, 2]], ['event', [2]], ['dark', [3]]],
    [['event', [0]], ['dark', [1]], ['dark', [2]], ['event', [3]]],
    [['campfire', [0]], ['campfire', [0]], ['campfire', [0]], ['campfire', [0]]],
    [['boss', []]],
  ],
  2: [
    [['encounter', [0, 1, 2]]],
    [['encounter', [0]], ['event', [1]], ['event', [2]]],
    [['merchant', [0, 1]], ['light', [1, 2]], ['encounter', [2, 3]]],
    [['dark', [0]], ['dark', [0, 1]], ['encounter', [1, 2]], ['light', [2, 3]]],
    [['light', [0, 1]], ['light', [1]], ['dark', [2]], ['dark', [2, 3]]],
    [['dark', [0]], ['dark', [1, 2]], ['light', [2, 3]], ['light', [3]]],
    [['event', [0]], ['light', [0, 1]], ['event', [2, 3]], ['event', [3]]],
    [['dark', [0]], ['encounter', [1]], ['event', [2]], ['elite', [3]]],
    [['campfire', [0]], ['campfire', [0]], ['campfire', [0]], ['campfire', [0]]],
    [['boss', []]],
  ],
  3: [
    [['encounter', [0, 1, 2]]],
    [['event', [0]], ['event', [1, 2]], ['encounter', [3]]],
    [['light', [0]], ['light', [0, 1]], ['dark', [2]], ['event', [3]]],
    [['dark', [0, 1]], ['event', [0, 1]], ['light', [2]], ['light', [2, 3]]],
    [['encounter', [0, 1]], ['light', [1, 2]], ['dark', [2, 3]], ['dark', [3, 4]]],
    [['light', [0]], ['dark', [1]], ['encounter', [1, 2]], ['light', [2, 3]], ['event', [3]]],
    [['dark', [0]], ['merchant', [1]], ['dark', [2]], ['dark', [3]]],
    [['campfire', [0]], ['campfire', [0]], ['campfire', [0]], ['campfire', [0]]],
    [['boss', []]],
  ],
}

const ACT_I_RETAIL_TOPOLOGIES = [
  RETAIL_TOPOLOGY[1],
  [
    [['encounter', [0, 1, 2]]],
    [['event', [0]], ['event', [1]], ['event', [2]]],
    [['event', [0]], ['encounter', [1, 2]], ['encounter', [2, 3]]],
    [['encounter', [0, 1]], ['light', [1, 2]], ['event', [2]], ['event', [3]]],
    [['dark', [0]], ['encounter', [0, 1]], ['dark', [1]], ['light', [2]]],
    [['light', [0, 1]], ['light', [1, 2]], ['dark', [2]]],
    [['treasure', [0]], ['treasure', [1, 2]], ['treasure', [2, 3]]],
    [['encounter', [0]], ['event', [0, 1]], ['dark', [1]], ['encounter', [2]]],
    [['dark', [0, 1]], ['light', [1, 2]], ['dark', [3]]],
    [['light', [0]], ['encounter', [1]], ['event', [2]], ['light', [2, 3]]],
    [['dark', [0]], ['merchant', [1]], ['dark', [2]], ['event', [3]]],
    [['campfire', [0]], ['campfire', [0]], ['campfire', [0]], ['campfire', [0]]],
    [['boss', []]],
  ],
]

suite('map')

check('the same seed always generates the same map', () => {
  assertDeepEqual(build(99), build(99), 'map generation must be reproducible from its seed')
})

check('different seeds generate different maps', () => {
  const a = JSON.stringify(build(1))
  const b = JSON.stringify(build(2))
  assert(a !== b, 'two seeds should not produce identical maps')
})

check('each act uses the exact printed retail rooms and paths', () => {
  for (const act of [2, 3]) {
    assertDeepEqual(topology(build(1, act)), RETAIL_TOPOLOGY[act], `Act ${act} topology drifted`)
  }
  const seen = new Set()
  for (let seed = 0; seed < 100; seed++) {
    const generated = JSON.stringify(topology(build(seed, 1)))
    const variant = ACT_I_RETAIL_TOPOLOGIES.findIndex((expected) => JSON.stringify(expected) === generated)
    assert(variant >= 0, `Act I seed ${seed} generated a non-retail topology`)
    seen.add(variant)
  }
  assertEqual(seen.size, 2, 'Act I did not randomly choose both retail map faces')
})

check('printed paths preserve the retail light-dark adjacency rules', () => {
  for (let seed = 0; seed < 10; seed++) {
    for (const act of [1, 2, 3]) {
      const map = build(seed, act)
      for (const room of Object.values(map.rooms)) {
        for (const exit of room.exits) {
          const target = map.rooms[exit]
          if (room.tokenBack === 'light') {
            assert(target.tokenBack !== 'light' && !['merchant', 'campfire'].includes(target.kind),
              `${room.id} light socket links to ${target.id} ${target.tokenBack ?? target.kind}`)
          }
          if (room.tokenBack === 'dark') {
            assert(target.tokenBack !== 'dark' && target.kind !== 'elite',
              `${room.id} dark socket links to ${target.id} ${target.tokenBack ?? target.kind}`)
          }
        }
      }
    }
  }
})

check('map tokens come from the finite retail inventories without replacement', () => {
  const limits = {
    dark: { encounter: 3, elite: 3, event: 2 },
    light: { campfire: 3, merchant: 2, treasure: 2 },
  }
  for (let seed = 0; seed < 100; seed++) {
    for (const act of [1, 2, 3]) {
      const map = build(seed, act)
      for (const back of ['dark', 'light']) {
        const rooms = Object.values(map.rooms).filter((room) => room.tokenBack === back)
        const expectedCount = act === 2 ? 7 : (back === 'dark' ? 8 : 7)
        assertEqual(rooms.length, expectedCount, `Act ${act} has the wrong ${back} socket count`)
        for (const [kind, limit] of Object.entries(limits[back])) {
          const count = rooms.filter((room) => room.kind === kind).length
          assert(count <= limit, `Act ${act} used ${count}/${limit} ${back} ${kind} tokens`)
          if (act !== 2) assertEqual(count, limit, `Act ${act} must use every ${back} ${kind} token`)
        }
        assert(rooms.every((room) => room.kind in limits[back]), `${back} token had an impossible face`)
      }
    }
  }
})

check('the Burning Elite replaces one of three physical dark Encounter tokens before setup', () => {
  let actTwoHasBurning = false
  let actTwoLeavesBurningUnused = false
  for (let seed = 0; seed < 100; seed++) {
    for (const act of [1, 2, 3]) {
      const rng = createRng(seed)
      const map = generateMap(rng, act)
      const originalKinds = Object.fromEntries(Object.values(map.rooms).map((room) => [room.id, room.kind]))
      const burning = Object.values(addBurningElite(rng, map).rooms).filter((room) => room.burning)
      if (act === 2) {
        assert(burning.length <= 1, `Act II seed ${seed} has multiple Burning Elites`)
        actTwoHasBurning ||= burning.length === 1
        actTwoLeavesBurningUnused ||= burning.length === 0
      } else {
        assertEqual(burning.length, 1, `Act ${act} seed ${seed} has no unique Burning Elite`)
      }
      if (burning[0]) {
        assertEqual(burning[0].kind, 'elite')
        assertEqual(burning[0].tokenBack, 'dark')
        assertEqual(originalKinds[burning[0].id], 'encounter', `Act ${act} seed ${seed} replaced a non-Encounter`)
      }
    }
  }
  assert(actTwoHasBurning, 'Act II never dealt the Burning Elite')
  assert(actTwoLeavesBurningUnused, 'Act II never left the Burning Elite unused')
})

check('Uncertain Future hides map tokens but leaves printed rooms visible', () => {
  const map = addBurningElite(createRng(11), build(11))
  const shown = visibleMap({ meta: { modifierIds: ['uncertain_future'] }, map })
  for (const room of Object.values(shown.rooms)) {
    if (room.tokenBack) {
      assert(room.hidden, `${room.id} token face leaked`)
      assertEqual(room.kind, 'encounter')
      assertEqual(room.burning, undefined)
    } else {
      assert(!room.hidden, `${room.id} printed room was hidden`)
      assertEqual(room.kind, map.rooms[room.id].kind)
    }
  }
})

check('Uncertain Future keeps legacy saved maps redacted after reconnect', () => {
  const map = build(19)
  for (const room of Object.values(map.rooms)) delete room.tokenBack
  map.rooms[map.rows[0][0]].visited = true
  const shown = visibleMap({ meta: { modifierIds: ['uncertain_future'] }, map })
  for (const room of Object.values(shown.rooms)) {
    assertEqual(Boolean(room.hidden), !room.visited, `${room.id} legacy visibility changed`)
  }
})

check('every room is reachable from the row below it', () => {
  for (let seed = 0; seed < 10; seed++) {
    for (const act of [1, 2, 3]) {
      const map = build(seed, act)
      for (let row = 1; row < map.rows.length; row++) {
        const reached = new Set(map.rows[row - 1].flatMap((id) => map.rooms[id].exits))
        for (const id of map.rows[row]) {
          assert(reached.has(id), `${id} on row ${row} has nothing leading to it`)
        }
      }
    }
  }
})

check('every room below the top has somewhere to go', () => {
  for (let seed = 0; seed < 10; seed++) {
    for (const act of [1, 2, 3]) {
      const map = build(seed, act)
      for (let row = 0; row < map.rows.length - 1; row++) {
        for (const id of map.rows[row]) {
          assert(map.rooms[id].exits.length > 0, `${id} is a dead end`)
        }
      }
    }
  }
})

check('exits only ever point at the row directly above', () => {
  for (let seed = 0; seed < 10; seed++) {
    for (const act of [1, 2, 3]) {
      const map = build(seed, act)
      for (const room of Object.values(map.rooms)) {
        for (const exit of room.exits) {
          assertEqual(
            map.rooms[exit].row,
            room.row + 1,
            `${room.id} exits to ${exit}, which is not on the next row up`,
          )
        }
      }
    }
  }
})

check('the party starts off the map and enters at the first room', () => {
  const map = build()
  assertEqual(map.position, null, 'the boot starts beside the map, not on it')
  const moves = availableMoves(map)
  assertEqual(moves.length, 1, 'only the opening encounter is available')
  assertEqual(moves[0].id, map.rows[0][0])
})

check('moving marks the room visited and advances the boot', () => {
  const map = build()
  const first = map.rows[0][0]
  const moved = moveTo(map, first)
  assertEqual(moved.position, first)
  assert(moved.rooms[first].visited, 'the room should be marked visited')
  assert(!map.rooms[first].visited, 'and the original map must not be mutated')
})

check('an illegal move returns the very same map reference', () => {
  const map = moveTo(build(), build().rows[0][0])
  const faraway = map.rows[map.rows.length - 1][0]
  assert(moveTo(map, faraway) === map, 'jumping to the boss must be refused')
  assert(moveTo(map, 'nonsense') === map, 'an unknown room must be refused')
})

check('only connected rooms are offered', () => {
  const map = moveTo(build(), build().rows[0][0])
  const offered = availableMoves(map).map((room) => room.id)
  assertDeepEqual(offered, map.rooms[map.position].exits, 'the offer is exactly the exits')
  for (const id of offered) {
    assert(moveTo(map, id) !== map, `${id} is offered so it must be legal`)
  }
})

check('a full climb from the bottom reaches the boss', () => {
  for (const act of [1, 2, 3, 4]) {
    let map = build(1, act)
    let steps = 0
    while (!isActComplete(map) && steps < 50) {
      const moves = availableMoves(map)
      assert(moves.length > 0, `Act ${act}: stranded at ${map.position} with no moves`)
      map = moveTo(map, moves[0].id)
      steps++
    }
    assert(isActComplete(map), `Act ${act}: never reached the boss in ${steps} steps`)
    assertEqual(currentRoom(map).kind, 'boss')
  }
})

check('the act is only complete once the boss room is actually entered', () => {
  const map = build()
  assert(!isActComplete(map), 'a fresh map is not complete')
  const entered = moveTo(map, map.rows[0][0])
  assert(!isActComplete(entered), 'standing on the first encounter is not complete either')

  // Standing ON the boss room without having visited it must not count, which is
  // what separates "arrived" from "cleared".
  const bossId = map.rows[map.rows.length - 1][0]
  const parked = { ...map, position: bossId }
  assert(!isActComplete(parked), 'an unvisited boss room does not complete the act')
  const cleared = {
    ...parked,
    rooms: { ...map.rooms, [bossId]: { ...map.rooms[bossId], visited: true } },
  }
  assert(isActComplete(cleared), 'a visited boss room does')
})

check('every generated room kind is one the game knows', () => {
  const known = new Set(['encounter', 'elite', 'event', 'campfire', 'treasure', 'merchant', 'boss'])
  for (let seed = 0; seed < 30; seed++) {
    for (const room of Object.values(build(seed).rooms)) {
      assert(known.has(room.kind), `unknown room kind ${room.kind}`)
    }
  }
})

check('maps carry their act number', () => {
  assertEqual(build(1, 3).act, 3)
})

check('Act IV follows its Boss card and Ascension 11 inserts Shield and Spear', () => {
  const base = build(11, 4)
  assertDeepEqual(base.rows.map((row) => base.rooms[row[0]].kind), ['campfire', 'merchant', 'boss'])

  const harder = build(11, 4, 11)
  assertDeepEqual(harder.rows.map((row) => harder.rooms[row[0]].kind), ['campfire', 'merchant', 'elite', 'boss'])
})

check('unsupported acts are rejected instead of inventing a map', () => {
  assertThrows(() => build(1, 0))
  assertThrows(() => build(1, 5))
})

// A run crashed at runtime because the encounter pool named an enemy that was
// never defined. Nothing caught it until the browser threw.
import { ENEMIES, enemyDef, startingHp } from '../src/game/enemies.ts'
import { CARDS } from '../src/game/cards.ts'
import {
  advanceAct,
  acquireRelic,
  chooseRelicReward,
  enterRoom,
  GOLDEN_TICKET,
  drawTransformReward,
  revealCardReward,
  revealRelicReward,
  pendingRelicPreview,
  resolveRelicReward,
  resolveBossRelicReward,
  resolvePendingRelic,
  resolvePotionReward,
  resolveCampfire,
  resolveCardRewards,
  roomChoices,
  resolveCombat,
  startPendingBoss,
  switchBetweenCombatRow,
  tradePotion,
  usePotionOutsideCombat,
  finishRun,
  MAX_HP,
} from '../src/game/run.ts'
import { BOSS_RELIC_IDS, ORDINARY_RELIC_IDS, RELICS, POTIONS, STARTING_RELIC } from '../src/game/relics.ts'
import { activatePotion } from '../src/game/combat.ts'
import { createCampaignProgress } from '../src/game/campaign.ts'
import { postNeowRun } from './lib/post-neow-run.mjs'

suite('run')

check('physical Relic decks are complete, seeded, face down, and shared by every room system', () => {
  const first = postNeowRun(901, [{ id: 'p1', name: 'Ironclad', character: 'ironclad' }])
  const same = postNeowRun(901, [{ id: 'p1', name: 'Ironclad', character: 'ironclad' }])
  assertEqual(ORDINARY_RELIC_IDS.length, 58)
  assertEqual(BOSS_RELIC_IDS.length, 20)
  assertDeepEqual(first.relicDeck, same.relicDeck)
  assertDeepEqual(first.bossRelicDeck, same.bossRelicDeck)
  assertDeepEqual(first.relicDeck, first.itemDecks.relics)
  assertDeepEqual(first.potionDeck, first.itemDecks.potions)
  assert(first.relicDeck.every((id) => !first.bossRelicDeck.includes(id)), 'ordinary and boss decks overlap')
})

check('Wing Boots marks every ignored-path destination visited', () => {
  const run = postNeowRun(922, [{ id: 'p1', name: 'Ironclad', character: 'ironclad' }])
  let from
  let target
  for (let row = 0; row < run.map.rows.length - 1 && !target; row++) {
    from = run.map.rows[row][0]
    target = run.map.rows[row + 1].find((id) => !run.map.rooms[from].exits.includes(id))
  }
  assert(from && target, 'fixture needs an off-path room in the next row')
  run.phase = 'map'
  run.map.position = from
  run.map.rooms[from] = { ...run.map.rooms[from], visited: true }
  run.players[0].relics.push({ defId: 'wing_boots', spent: false, uses: 3 })
  const entered = enterRoom(run, target, 'p1')
  assertEqual(entered.map.position, target)
  assertEqual(entered.map.rooms[target].visited, true)
  assertEqual(entered.players[0].relics.find((relic) => relic.defId === 'wing_boots').uses, 2)
})

check('Calling Bell applies Old Coin immediately instead of keeping it', () => {
  const run = postNeowRun(904, [{ id: 'p1', name: 'Ironclad', character: 'ironclad' }])
  run.relicDeck = ['old_coin', 'anchor', 'happy_flower', ...run.relicDeck.filter((id) =>
    !['old_coin', 'anchor', 'happy_flower'].includes(id))]
  run.itemDecks.curses = ['regret', 'injury']
  const gold = run.players[0].gold
  const acquired = acquireRelic(run, 'p1', 'calling_bell')
  assertEqual(acquired.players[0].gold, gold + 10)
  assert(!acquired.players[0].relics.some((relic) => relic.defId === 'old_coin'), 'Old Coin was kept')
  assertDeepEqual(acquired.players[0].relics.slice(-2).map((relic) => relic.defId), ['anchor', 'happy_flower'])
  assertEqual(acquired.players[0].deck.at(-1).defId, 'regret', 'Calling Bell did not draw the top Curse')
  assertDeepEqual(acquired.itemDecks.curses, ['injury'])
  assertEqual(acquired.relicDeck.at(-1), 'old_coin', 'Calling Bell did not bottom Old Coin')
  assertEqual(acquired.relicDeck.filter((id) => id === 'old_coin').length, 1)
  assertDeepEqual(acquired.relicDeck, acquired.itemDecks.relics, 'Calling Bell consumed a second Relic supply')
})

check('Cursed Key consumes the finite Curse deck while Omamori leaves it untouched', () => {
  const run = postNeowRun(905, [{ id: 'p1', name: 'Ironclad', character: 'ironclad' }])
  run.itemDecks.curses = ['regret', 'injury', 'clumsy']
  const before = JSON.stringify(run)
  const cursed = acquireRelic(run, 'p1', 'cursed_key')
  assertDeepEqual(cursed.players[0].deck.slice(-2).map((card) => card.defId), ['regret', 'injury'])
  assertDeepEqual(cursed.itemDecks.curses, ['clumsy'])
  assertEqual(JSON.stringify(run), before, 'Relic acquisition mutated the prior run')

  const protectedRun = postNeowRun(906, [{ id: 'p1', name: 'Ironclad', character: 'ironclad' }])
  protectedRun.itemDecks.curses = ['regret', 'injury']
  protectedRun.players[0].relics.push({ defId: 'omamori', spent: false })
  const protectedDeck = protectedRun.players[0].deck.length
  const protectedResult = acquireRelic(protectedRun, 'p1', 'cursed_key')
  assertEqual(protectedResult.players[0].deck.length, protectedDeck)
  assertDeepEqual(protectedResult.itemDecks.curses, ['regret', 'injury'])
})

check('direct Old Coin acquisition always returns its unique card to the Relic deck bottom', () => {
  const run = postNeowRun(909, [{ id: 'p1', name: 'Ironclad', character: 'ironclad' }])
  run.relicDeck = run.relicDeck.filter((id) => id !== 'old_coin')
  run.itemDecks.relics = [...run.relicDeck]
  const acquired = acquireRelic(run, 'p1', 'old_coin')
  assertEqual(acquired.relicDeck.at(-1), 'old_coin')
  assertEqual(acquired.relicDeck.filter((id) => id === 'old_coin').length, 1)
  assertDeepEqual(acquired.relicDeck, acquired.itemDecks.relics)
})

check("one-shot Relics cannot remove Ascender's Bane or count the starter twice", () => {
  let run = postNeowRun(907, [{ id: 'p1', name: 'Ironclad', character: 'ironclad' }], 5)
  run = acquireRelic(run, 'p1', 'empty_cage')
  const bane = run.players[0].deck.find((card) => card.defId === 'ascenders_bane')
  const other = run.players[0].deck.find((card) => card.uid !== bane.uid)
  assertEqual(resolvePendingRelic(run, 'p1', [bane.uid, other.uid]), run)

  run.players[0].relics = run.players[0].relics.filter((relic) => !relic.pending)
  run = acquireRelic(run, 'p1', 'war_paint')
  const starter = run.players[0].deck.find((card) => card.defId.startsWith('defend_') && !card.upgraded)
  assertEqual(resolvePendingRelic(run, 'p1', [starter.uid]), run)
})

check('Empty Cage applies the printed Parasite maximum-HP loss', () => {
  let run = postNeowRun(908, [{ id: 'p1', name: 'Ironclad', character: 'ironclad' }])
  run.players[0].deck[0] = { ...run.players[0].deck[0], defId: 'parasite' }
  run.players[0].hp = run.players[0].maxHp
  const beforeMaxHp = run.players[0].maxHp
  run = acquireRelic(run, 'p1', 'empty_cage')
  const parasite = run.players[0].deck.find((card) => card.defId === 'parasite')
  const other = run.players[0].deck.find((card) => card.uid !== parasite.uid)
  const resolved = resolvePendingRelic(run, 'p1', [parasite.uid, other.uid])
  assertEqual(resolved.players[0].maxHp, beforeMaxHp - 2)
  assertEqual(resolved.players[0].hp, beforeMaxHp - 2)
})

check('Tiny House reveals its Potion for replacement at the slot cap', () => {
  let run = postNeowRun(908, [{ id: 'p1', name: 'Ironclad', character: 'ironclad' }], 4)
  run.phase = 'reward'
  run.rewardDestination = 'map'
  run.players[0].potions = ['block_potion', 'fire_potion']
  run.potionDeck = ['weak_potion', ...run.potionDeck.filter((id) => id !== 'weak_potion')]
  run.rewards = [{ playerId: 'p1', cardReward: false, choices: null, upgraded: false,
    potion: false, bossRelics: false }]
  run = acquireRelic(run, 'p1', 'tiny_house')
  assertEqual(run.rewards[0].potion, 'weak_potion')
  const upgrade = run.players[0].deck.find((card) => !card.upgraded && CARDS[card.defId]?.upgrade)
  run = resolvePendingRelic(run, 'p1', [upgrade.uid], [-1])
  const gained = resolvePotionReward(run, 'p1', { kind: 'replace', potionId: 'block_potion' })
  assertDeepEqual(gained.players[0].potions, ['fire_potion', 'weak_potion'])
})

check('independent Potion rewards queue without overwriting each other', () => {
  let run = postNeowRun(917, [{ id: 'p1', name: 'Ironclad', character: 'ironclad' }])
  run.players[0].relics.push({ defId: 'white_beast_statue', spent: false })
  const entered = enterRoom(run, roomChoices(run)[0].id)
  const won = {
    ...entered,
    combat: {
      ...entered.combat,
      phase: 'won',
      enemies: entered.combat.enemies.map((enemy) => ({ ...enemy, dead: true, hp: 0, potionReward: true })),
    },
  }
  run = resolveCombat(won)
  assertEqual(run.rewards[0].potion, null)
  assertDeepEqual(run.rewards[0].potionQueue, [null])
  run = resolvePotionReward(run, 'p1', { kind: 'skip' })
  assertEqual(run.rewards[0].potion, null)
  run = resolvePotionReward(run, 'p1', { kind: 'skip' })
  assertEqual(run.rewards[0].potion, false)

  run = postNeowRun(918, [{ id: 'p1', name: 'Ironclad', character: 'ironclad' }])
  run.phase = 'reward'
  run.rewardDestination = 'map'
  run.rewards = [{ playerId: 'p1', cardReward: false, choices: null, upgraded: false,
    potion: null, bossRelics: false }]
  const tinyPotion = run.potionDeck[0]
  run = acquireRelic(run, 'p1', 'tiny_house')
  assertDeepEqual(run.rewards[0].potionQueue, [tinyPotion])
})

check('Eggs upgrade and spend uses on one-shot Relic card gains', () => {
  let run = postNeowRun(909, [{ id: 'p1', name: 'Ironclad', character: 'ironclad' }])
  // Persisted rooms from before finite-use automation may omit `uses`; the
  // printed Relic value remains authoritative when restoring them.
  run.players[0].relics.push({ defId: 'molten_egg', spent: false })
  run.players[0].cardRewards = [
    'anger', 'defend_ironclad', 'shrug_it_off',
    'defend_ironclad', 'shrug_it_off', 'armaments',
    'defend_ironclad', 'shrug_it_off', 'armaments',
    'defend_ironclad', 'shrug_it_off', 'armaments',
  ]
  run = acquireRelic(run, 'p1', 'orrery')
  run = resolvePendingRelic(run, 'p1', [], [0, 0, 0, 0])
  assert(run.players[0].deck.some((card) => card.defId === 'anger' && card.upgraded), 'Egg did not upgrade Orrery gain')
  assertEqual(run.players[0].relics.find((relic) => relic.defId === 'molten_egg').uses, 2)
})

check('persisted Eggs upgrade normal card rewards with their printed uses', () => {
  let run = postNeowRun(910, [{ id: 'p1', name: 'Ironclad', character: 'ironclad' }])
  run.players[0].relics.push({ defId: 'molten_egg', spent: false })
  run.players[0].cardRewards = ['anger', 'defend_ironclad', 'shrug_it_off']
  run.phase = 'reward'
  run.rewardDestination = 'map'
  run.rewards = [{ playerId: 'p1', cardReward: true, choices: null, upgraded: false,
    potion: false, relic: false, bossRelics: false }]
  run = resolveCardRewards(revealCardReward(run, 'p1'), { p1: 0 })
  assert(run.players[0].deck.some((card) => card.defId === 'anger' && card.upgraded))
  assertEqual(run.players[0].relics.find((relic) => relic.defId === 'molten_egg').uses, 2)
})

check('one-shot Relic card rewards may be skipped and settle exhausted decks', () => {
  let run = postNeowRun(915, [{ id: 'p1', name: 'Ironclad', character: 'ironclad' }])
  const deckSize = run.players[0].deck.length
  const shown = run.players[0].rareRewards.slice(0, 5)
  run = acquireRelic(run, 'p1', 'enchiridion')
  run = resolvePendingRelic(run, 'p1', [], [-1])
  assertEqual(run.players[0].deck.length, deckSize)
  assertDeepEqual(run.players[0].rareRewards.slice(-shown.length), shown)
  assert(!run.players[0].relics.some((relic) => relic.pending), 'skipped Enchiridion stayed pending')

  run.players[0].cardRewards = []
  run.players[0].rareRewards = []
  run = acquireRelic(run, 'p1', 'orrery')
  run = resolvePendingRelic(run, 'p1', [], [-1, -1, -1, -1])
  assert(!run.players[0].relics.some((relic) => relic.pending), 'exhausted Orrery stayed pending')
})

check("Pandora's Box rejects every Curse, not only Ascender's Bane", () => {
  let run = postNeowRun(910, [{ id: 'p1', name: 'Ironclad', character: 'ironclad' }])
  run.players[0].deck.push({ uid: 'pandora-curse', defId: 'regret', upgraded: false })
  run = acquireRelic(run, 'p1', 'pandoras_box')
  const choices = ['pandora-curse', ...run.players[0].deck.filter((card) => card.defId !== 'regret').slice(0, 2).map((card) => card.uid)]
  assertEqual(resolvePendingRelic(run, 'p1', choices), run)
})

check('Relic upgrades reject Curse cards without a physical upgraded face', () => {
  let run = postNeowRun(920, [{ id: 'p1', name: 'Ironclad', character: 'ironclad' }])
  run.players[0].deck.push({ uid: 'upgrade-curse', defId: 'regret', upgraded: false })
  run = acquireRelic(run, 'p1', 'astrolabe')
  const valid = run.players[0].deck.filter((card) => card.uid !== 'upgrade-curse').slice(0, 2)
  assertEqual(resolvePendingRelic(run, 'p1', ['upgrade-curse', ...valid.map((card) => card.uid)]), run)
})

check('Orrery expands Golden Tickets through the rare deck and bottoms both physical cards', () => {
  let run = postNeowRun(902, [{ id: 'p1', name: 'Ironclad', character: 'ironclad' }])
  const player = run.players[0]
  player.cardRewards = [
    GOLDEN_TICKET, GOLDEN_TICKET, 'anger',
    'battle_trance', 'blood_for_blood', 'bloodletting',
    'body_slam', 'clash', 'cleave',
    'clothesline', 'combust', 'dark_embrace',
  ]
  player.rareRewards = ['bludgeon', 'barricade', 'berserk']
  run = acquireRelic(run, player.id, 'orrery')
  const preview = pendingRelicPreview(run, player.id)
  assertDeepEqual(preview.rewardChoices[0], ['bludgeon', 'barricade', 'anger'])
  run = resolvePendingRelic(run, player.id, [], [0, 0, 0, 0])
  const settled = run.players[0]
  assert(settled.deck.some((card) => card.defId === 'bludgeon'), 'the Ticket did not grant the rare card')
  assertEqual(settled.cardRewards.filter((defId) => defId === GOLDEN_TICKET).length, 2,
    'the physical Tickets were not bottomed')
  assertEqual(settled.rareRewards.at(-1), 'barricade', 'the unchosen revealed rare was not bottomed')
})

check('pending Relic preview tolerates a compatibility snapshot without players', () => {
  assertEqual(pendingRelicPreview({}, 'p1'), null)
})

check('one-shot rewards keep visible indices when a Golden Ticket has no rare card', () => {
  for (const relicId of ['orrery', 'tiny_house']) {
    let run = postNeowRun(916, [{ id: 'p1', name: 'Ironclad', character: 'ironclad' }])
    run.players[0].cardRewards = [GOLDEN_TICKET, 'anger']
    run.players[0].rareRewards = []
    run = acquireRelic(run, 'p1', relicId)
    const preview = pendingRelicPreview(run, 'p1')
    assertDeepEqual(preview.rewardChoices[0], ['anger'])
    const decisions = preview.rewardChoices.map((_choices, index) => index === 0 ? 0 : -1)
    const cards = relicId === 'tiny_house' ? [run.players[0].deck.find((card) => !card.upgraded).uid] : []
    run = resolvePendingRelic(run, 'p1', cards, decisions)
    assert(run.players[0].deck.some((card) => card.defId === 'anger'), `${relicId} did not gain visible Anger`)
    assert(!run.players[0].deck.some((card) => !card.defId), `${relicId} added an invalid card`)
  }
})

check('Entropic Brew can replace a held Potion outside combat at the physical slot cap', () => {
  const run = postNeowRun(903, [{ id: 'p1', name: 'Ironclad', character: 'ironclad' }], 4)
  run.players[0].potions = ['entropic_brew', 'block_potion']
  run.potionDeck = ['fire_potion', 'skill_potion', 'weak_potion']
  assertEqual(usePotionOutsideCombat(run, 'p1', 'entropic_brew'), run, 'replacement must be explicit')
  const used = usePotionOutsideCombat(run, 'p1', 'entropic_brew', 'block_potion')
  assertDeepEqual(used.players[0].potions, ['fire_potion', 'skill_potion'])
  assertDeepEqual(used.potionDeck, ['weak_potion', 'entropic_brew', 'block_potion'])
})

check('Sozu still allows Entropic Brew outside combat without gaining Potions', () => {
  const run = postNeowRun(903, [{ id: 'p1', name: 'Ironclad', character: 'ironclad' }], 4)
  run.players[0].potions = ['entropic_brew', 'block_potion']
  run.players[0].relics.push({ defId: 'sozu', spent: false })
  run.potionDeck = ['fire_potion', 'skill_potion']
  const used = usePotionOutsideCombat(run, 'p1', 'entropic_brew')
  assertDeepEqual(used.players[0].potions, ['block_potion'], 'Sozu preserves the other held Potion')
  assertDeepEqual(used.potionDeck, ['fire_potion', 'skill_potion', 'entropic_brew'],
    'the Brew is bottomed without drawing from the Potion deck')
  assertDeepEqual(used.itemDecks.potions, used.potionDeck, 'the legacy Potion supply remains mirrored')
})

check('Treasure reveals one Relic per player and gain/skip preserves deck circulation', () => {
  const base = postNeowRun(902, [
    { id: 'p1', name: 'Ironclad', character: 'ironclad' },
    { id: 'p2', name: 'Silent', character: 'silent' },
  ])
  const treasure = Object.values(base.map.rooms).find((room) => room.kind === 'treasure')
  const approach = Object.values(base.map.rooms).find((room) => room.exits.includes(treasure?.id))
  assert(treasure && approach)
  let reward = enterRoom({ ...base, map: { ...base.map, position: approach.id } }, treasure.id)
  assertEqual(reward.phase, 'room')
  assertDeepEqual(reward.relicDeck, reward.itemDecks.relics)
  const top = reward.roomState.offers.p1
  reward = chooseRelicReward(reward, 'p1', 'take')
  reward = chooseRelicReward(reward, 'p2', 'skip')
  assertEqual(reward.players[0].relics.at(-1).defId, top)
  assertEqual(reward.phase, 'map', 'every player resolves the physical Treasure room')
  assertDeepEqual(reward.relicDeck, reward.itemDecks.relics)
})

check('an Elite grants exactly one ordinary Relic from the shared physical deck per living player', () => {
  let run = postNeowRun(915, [
    { id: 'p1', name: 'Ironclad', character: 'ironclad' },
    { id: 'p2', name: 'Silent', character: 'silent' },
  ])
  const room = roomChoices(run)[0]
  run.map.rooms[room.id] = { ...room, kind: 'elite' }
  const expected = run.relicDeck.slice(0, 2)
  run = enterRoom(run, room.id)
  run = resolveCombat({ ...run, combat: { ...run.combat, phase: 'won', enemies: run.combat.enemies.map((enemy) => ({ ...enemy, hp: 0, dead: true })) } })
  assert(run.rewards.every((offer) => offer.relic === false), 'the removed legacy Elite Relic reward returned')
  assertDeepEqual(Object.values(run.roomState.offers), expected)
  assertDeepEqual(run.relicDeck, run.itemDecks.relics)
  run = resolveCardRewards(run, { p1: null, p2: null })
  assertEqual(run.phase, 'room')
  run = chooseRelicReward(run, 'p1', 'take')
  run = chooseRelicReward(run, 'p2', 'take')
  assertEqual(run.phase, 'map')
  assertDeepEqual(run.players.map((player) => player.relics.at(-1).defId), expected)
  assertDeepEqual(run.relicDeck, run.itemDecks.relics)
})

const skipRewards = (run) => run.phase === 'reward'
  ? resolveCardRewards(run, Object.fromEntries(run.rewards.map((offer) => [offer.playerId, null])))
  : run

check('every enemy the run can spawn actually exists', () => {
  // Reach into the module's pools by walking a lot of runs and spawning rooms.
  for (let seed = 0; seed < 30; seed++) {
    let run = postNeowRun(seed, [
      { id: 'p1', name: 'Ironclad', character: 'ironclad' },
      { id: 'p2', name: 'Silent', character: 'silent' },
    ])
    for (let step = 0; step < 12 && run.phase !== 'defeat' && run.phase !== 'victory'; step++) {
      if (run.phase === 'map') {
        const choices = roomChoices(run)
        if (choices.length === 0) break
        run = enterRoom(run, choices[0].id)
      } else if (run.phase === 'combat') {
        for (const enemy of run.combat.enemies) {
          assert(ENEMIES[enemy.defId] !== undefined, `spawned unknown enemy "${enemy.defId}"`)
          assert(enemyDef(enemy.defId).id === enemy.defId, 'enemy def id should round-trip')
        }
        // Concede so the walk continues past the fight.
        run = resolveCombat({ ...run, combat: { ...run.combat, phase: 'lost' } })
      } else {
        run = { ...run, phase: 'map' }
      }
    }
  }
})

check('reward stacks contain only live cards of their character and rarity', () => {
  const progress = { ...createCampaignProgress(), characters: { ironclad: 4, silent: 4, defect: 4, watcher: 4 } }
  const run = postNeowRun(100, [
    { id: 'p1', name: 'Ironclad', character: 'ironclad' },
    { id: 'p2', name: 'Silent', character: 'silent' },
    { id: 'p3', name: 'Defect', character: 'defect' },
    { id: 'p4', name: 'Watcher', character: 'watcher' },
  ], 0, progress)
  for (const player of run.players) {
    assert(player.cardRewards.length >= 3, `${player.name} cannot reveal three cards`)
    assertEqual(player.cardRewards.filter((id) => id === GOLDEN_TICKET).length, 2,
      `${player.name} needs both physical Golden Tickets`)
    for (const id of player.cardRewards) {
      if (id === GOLDEN_TICKET) continue
      const def = CARDS[id]
      assert(def, `reward card ${id} is not implemented`)
      assertEqual(def.owner, player.character)
      assert(def.rarity === 'common' || def.rarity === 'uncommon', `${id} has rarity ${def.rarity}`)
    }
    if (player.character === 'defect') {
      assertEqual(player.cardRewards.filter((id) => id === 'claw_claw_pack').length, 8,
        'the Collector Claw pack contributes all eight physical copies')
      assertEqual(player.cardRewards.filter((id) => id === 'claw').length, 2,
        'the retail Claw keeps the standard common-card count')
    }
  }
})

check('every enemy has a sane HP track', () => {
  for (const def of Object.values(ENEMIES)) {
    assertEqual(def.hpByPlayers.length, 4, `${def.id} needs an HP value per player count`)
    for (const hp of def.hpByPlayers) {
      assert(hp > 0, `${def.id} has a non-positive HP entry`)
    }
    // Single-card elites use the HP board. Sentries scale through extra cards.
    if (def.elite && def.id !== 'sentries') {
      assert(
        def.hpByPlayers[3] > def.hpByPlayers[0],
        `${def.id} is an elite so its HP should scale with the party`,
      )
    }
  }
})

check('a run starts every character at the HP their board prints', () => {
  const run = postNeowRun(1, [
    { id: 'p1', name: 'Ironclad', character: 'ironclad' },
    { id: 'p2', name: 'Silent', character: 'silent' },
    { id: 'p3', name: 'Defect', character: 'defect' },
    { id: 'p4', name: 'Watcher', character: 'watcher' },
  ])
  for (const player of run.players) {
    assertEqual(player.hp, MAX_HP[player.character], `${player.character} should start at full HP`)
    assertEqual(player.relics.length, 1, 'and with exactly one starting relic')
  }
})

check('a solo run starts with two extra gold AND the Loaded Die', () => {
  const solo = postNeowRun(1, [{ id: 'p1', name: 'Ironclad', character: 'ironclad' }])
  assertEqual(solo.players[0].gold, 2, 'p.4 step 12 grants gold, not potions')
  assert(
    solo.players[0].relics.some((relic) => relic.defId === 'loaded_die'),
    'solo also gets the Loaded Die relic (p.4 step 12)',
  )
  assertEqual(solo.players[0].relics.length, 2, 'the starting relic plus the Loaded Die')

  const duo = postNeowRun(1, [
    { id: 'p1', name: 'Ironclad', character: 'ironclad' },
    { id: 'p2', name: 'Silent', character: 'silent' },
  ])
  assertEqual(duo.players[0].gold, 0, 'a party of two gets no solo bonus')
  assert(
    !duo.players[0].relics.some((relic) => relic.defId === 'loaded_die'),
    'and no Loaded Die',
  )
})

check('every relic and potion a run can hand out actually exists', () => {
  for (const character of Object.keys(MAX_HP)) {
    const id = STARTING_RELIC[character]
    assert(RELICS[id] !== undefined, `${character}'s starting relic "${id}" is not defined`)
  }
  for (const [id, def] of Object.entries(RELICS)) {
    assertEqual(def.id, id, `relic key ${id} disagrees with its id ${def.id}`)
    assert(def.text.length > 0, `${id} needs text for the UI`)
  }
  for (const [id, def] of Object.entries(POTIONS)) {
    assertEqual(def.id, id, `potion key ${id} disagrees with its id ${def.id}`)
    assert(def.text.length > 0, `${id} needs its printed text for the reward UI`)
  }
})

check('entering a room is refused unless it is reachable', () => {
  const run = postNeowRun(7, [{ id: 'p1', name: 'Ironclad', character: 'ironclad' }])
  assert(enterRoom(run, 'nowhere') === run, 'an unknown room must return the same reference')
  const far = run.map.rows[run.map.rows.length - 1][0]
  assert(enterRoom(run, far) === run, 'jumping to the boss must be refused')
})

check('the first room starts a combat with one enemy per player', () => {
  const run = postNeowRun(3, [
    { id: 'p1', name: 'Ironclad', character: 'ironclad' },
    { id: 'p2', name: 'Silent', character: 'silent' },
  ])
  const entered = enterRoom(run, roomChoices(run)[0].id)
  const mainEnemies = entered.combat.enemies.filter((enemy) => !enemy.uid.includes('-summon'))
  assertEqual(entered.phase, 'combat')
  assertEqual(mainEnemies.length, 2, 'one encounter card per player row (p.10)')
  assertEqual(new Set(mainEnemies.map((e) => e.row)).size, 2, 'one main enemy per row')
})

check('the four fixed-opening cards are dealt once each, with their summons', () => {
  const run = postNeowRun(3, [
    { id: 'p1', name: 'Ironclad', character: 'ironclad' },
    { id: 'p2', name: 'Silent', character: 'silent' },
    { id: 'p3', name: 'Defect', character: 'defect' },
    { id: 'p4', name: 'Watcher', character: 'watcher' },
  ])
  const enemies = enterRoom(run, roomChoices(run)[0].id).combat.enemies
  const mains = enemies.filter((enemy) => !enemy.uid.includes('-summon'))
  assertDeepEqual(
    [...mains.map((enemy) => enemy.defId)].sort(),
    ['cultist', 'jaw_worm_first', 'red_louse_first', 'small_slime'],
    'the physical opening deck is dealt without replacement',
  )
  const expected = {
    cultist: [],
    jaw_worm_first: [],
    red_louse_first: ['Green Louse'],
    small_slime: ['Acid Slime'],
  }
  for (const main of mains) {
    const summons = enemies
      .filter((enemy) => enemy.uid.startsWith(`${main.uid}-summon`))
    assertDeepEqual(summons.map((enemy) => enemyDef(enemy.defId).name), expected[main.defId], `${main.defId} summon box`)
    for (const summon of summons) {
      assertEqual(summon.row, main.row, 'the summon is placed to the right in the same row')
      assertEqual(summon.goldReward, 0, 'summons do not add a second reward')
      assertEqual(summon.cardReward, null, 'summons do not add a second card reward')
    }
  }
})

check('the fixed opening encounter uses its own printed rewards', () => {
  const run = postNeowRun(2, [{ id: 'p1', name: 'Ironclad', character: 'ironclad' }])
  const entered = enterRoom(run, roomChoices(run)[0].id)
  const enemy = entered.combat.enemies[0]
  const printed = {
    cultist: [1, 'normal'],
    jaw_worm_first: [1, 'normal'],
    red_louse_first: [1, null],
    small_slime: [0, 'normal'],
  }
  const reward = printed[enemy.defId]
  assert(reward, `${enemy.defId} is not a fixed-opening enemy`)
  assertEqual(enemy.goldReward, reward[0], `${enemy.defId} grants its printed gold`)
  assertEqual(enemy.cardReward, reward[1], `${enemy.defId} grants its printed card reward`)
})

check('winning a combat carries HP forward into the run', () => {
  const run = postNeowRun(3, [{ id: 'p1', name: 'Ironclad', character: 'ironclad' }])
  const entered = enterRoom(run, roomChoices(run)[0].id)
  // Bloody the player inside the combat, then win it.
  const wounded = {
    ...entered,
    combat: {
      ...entered.combat,
      phase: 'won',
      players: entered.combat.players.map((p) => ({ ...p, hp: 4 })),
      enemies: entered.combat.enemies.map((e) => ({ ...e, dead: true, hp: 0 })),
    },
  }
  const after = resolveCombat(wounded)
  assertEqual(after.players[0].hp, 4, 'damage taken in combat must persist into the run')
  const foe = entered.combat.enemies.find((enemy) => enemy.row === entered.players[0].row)
  const printedGold = foe.goldReward
  assertEqual(after.players[0].gold, run.players[0].gold + printedGold, 'the printed gold reward is paid')
})

check('a potion consumed in combat returns to the bottom of its deck', () => {
  const run = postNeowRun(3, [{ id: 'p1', name: 'Ironclad', character: 'ironclad' }])
  const stocked = {
    ...run,
    players: run.players.map((player) => ({ ...player, potions: ['fire_potion'] })),
    itemDecks: { ...run.itemDecks, potions: run.itemDecks.potions.filter((id) => id !== 'fire_potion') },
  }
  const entered = enterRoom(stocked, roomChoices(stocked)[0].id)
  const target = entered.combat.enemies[0]
  const prepared = {
    ...entered.combat,
    phase: 'player',
    enemies: entered.combat.enemies.map((enemy, index) => index === 0
      ? { ...enemy, hp: 4, maxHp: 4, block: 0, dead: false }
      : { ...enemy, hp: 0, dead: true }),
  }
  const won = activatePotion(prepared, 'p1', 'fire_potion', { enemyUid: target.uid })
  assertEqual(won.phase, 'won')
  const after = resolveCombat({ ...entered, combat: won })
  assertDeepEqual(after.players[0].potions, [])
  assertEqual(after.itemDecks.potions.at(-1), 'fire_potion')
})

check('a combat card reward reveals three and persists exactly one chosen card', () => {
  const run = postNeowRun(104, [{ id: 'p1', name: 'Ironclad', character: 'ironclad' }])
  const entered = enterRoom(run, roomChoices(run)[0].id)
  const won = resolveCombat({
    ...entered,
    combat: {
      ...entered.combat,
      phase: 'won',
      enemies: entered.combat.enemies.map((enemy) => ({
        ...enemy, hp: 0, dead: true, cardReward: 'normal', potionReward: false,
      })),
    },
  })
  assertEqual(won.phase, 'reward', 'rewards are chosen before returning to the map')
  assertEqual(won.rewards.length, 1)
  assertEqual(won.rewards[0].choices, null, 'the deck stays face down until the player reveals it')
  const revealed = revealCardReward(won, 'p1')
  assertEqual(revealed.rewards[0].choices.length, 3, 'the top three are revealed (p.8)')
  const before = revealed.players[0]
  const chosen = revealed.rewards[0].choices[1]
  const after = resolveCardRewards(revealed, { p1: 1 })
  assertEqual(after.phase, 'map')
  assertEqual(after.players[0].deck.length, before.deck.length + 1)
  assertEqual(after.players[0].deck.at(-1).defId, chosen, 'the selected copy enters the deck')
  assertDeepEqual(
    after.players[0].cardRewards.slice(-2),
    [revealed.rewards[0].choices[0], revealed.rewards[0].choices[2]],
    'unchosen cards return to the bottom in revealed order',
  )
})

check('combat Prismatic rewards follow the held relic and live shared decks', () => {
  const win = (run) => {
    const entered = enterRoom(run, roomChoices(run)[0].id)
    return resolveCombat({
      ...entered,
      combat: {
        ...entered.combat,
        phase: 'won',
        enemies: entered.combat.enemies.map((enemy) => ({
          ...enemy, hp: 0, dead: true, cardReward: 'normal', potionReward: false,
        })),
      },
    })
  }
  const options = { mode: 'custom', modifiers: ['prismatic_shard'] }
  const base = postNeowRun(1041, [{ id: 'p1', name: 'Ironclad', character: 'ironclad' }], 0, undefined, false, false, options)
  const sharedOnly = win({
    ...base,
    players: base.players.map((player) => ({ ...player, cardRewards: [] })),
    itemDecks: {
      ...base.itemDecks,
      characterCards: {
        ...base.itemDecks.characterCards,
        silent: ['acrobatics'],
        defect: ['claw'],
        watcher: ['cut_through_fate'],
      },
    },
  })
  assertEqual(sharedOnly.rewards.length, 1)
  assertEqual(sharedOnly.rewards[0].prismatic, true)
  assertDeepEqual(sharedOnly.rewards[0].availableSources, ['silent', 'defect', 'watcher', 'colorless'])

  const exhaustedTicket = win({
    ...base,
    players: base.players.map((player) => ({ ...player, cardRewards: [GOLDEN_TICKET], rareRewards: [] })),
  })
  assert(!exhaustedTicket.rewards[0].availableSources.includes('ironclad'))
  const revealed = revealCardReward(exhaustedTicket, 'p1', ['silent', 'defect', 'watcher'])
  assertEqual(revealed.rewards[0].choices.length, 3)

  const withoutRelic = win({
    ...base,
    players: base.players.map((player) => ({
      ...player,
      relics: player.relics.filter((relic) => relic.defId !== 'prismatic_shard'),
    })),
  })
  assertEqual(withoutRelic.rewards.length, 1)
  assertEqual(withoutRelic.rewards[0].prismatic, false)
  assertEqual(withoutRelic.rewards[0].availableSources, undefined)
})

check('a short combat reward deck still offers every available physical card', () => {
  const run = postNeowRun(105, [{ id: 'p1', name: 'Ironclad', character: 'ironclad' }])
  const entered = enterRoom({ ...run, players: run.players.map((player) => ({ ...player, cardRewards: ['anger'], rareRewards: [] })) }, roomChoices(run)[0].id)
  const won = resolveCombat({
    ...entered,
    combat: {
      ...entered.combat,
      phase: 'won',
      enemies: entered.combat.enemies.map((enemy) => ({ ...enemy, hp: 0, dead: true, cardReward: 'normal' })),
    },
  })
  assertEqual(won.phase, 'reward')
  const revealed = revealCardReward(won, 'p1')
  assertDeepEqual(revealed.rewards[0].choices, ['anger'])
})

check('skipping a card reward unseen leaves the face-down deck untouched', () => {
  const run = postNeowRun(104, [{ id: 'p1', name: 'Ironclad', character: 'ironclad' }])
  const entered = enterRoom(run, roomChoices(run)[0].id)
  const won = resolveCombat({
    ...entered,
    combat: {
      ...entered.combat,
      phase: 'won',
      enemies: entered.combat.enemies.map((enemy) => ({ ...enemy, cardReward: 'normal', potionReward: false })),
    },
  })
  assertEqual(won.phase, 'reward', 'precondition: this test is skipping a real reward')
  const before = won.players[0]
  const after = resolveCardRewards(won, { p1: null })
  assertEqual(after.players[0].deck.length, before.deck.length, 'skip adds no card')
  assertDeepEqual(after.players[0].cardRewards, before.cardRewards, 'an unseen skip draws no reward cards (p.8)')
})

check('skipping after reveal returns all three cards to the bottom', () => {
  const run = postNeowRun(104, [{ id: 'p1', name: 'Ironclad', character: 'ironclad' }])
  const entered = enterRoom(run, roomChoices(run)[0].id)
  const won = resolveCombat({
    ...entered,
    combat: {
      ...entered.combat,
      phase: 'won',
      enemies: entered.combat.enemies.map((enemy) => ({ ...enemy, cardReward: 'normal', potionReward: false })),
    },
  })
  const revealed = revealCardReward(won, 'p1')
  const shown = revealed.rewards[0].choices
  const after = resolveCardRewards(revealed, { p1: null })
  assertDeepEqual(after.players[0].cardRewards.slice(-3), shown, 'revealed cards return to the bottom in order')
})

check('Golden Tickets reveal rares and cycle each source stack independently', () => {
  const base = postNeowRun(204, [{ id: 'p1', name: 'Silent', character: 'silent' }])
  const player = {
    ...base.players[0],
    cardRewards: ['prepared', GOLDEN_TICKET, 'acrobatics', 'backflip'],
    rareRewards: ['adrenaline', 'die_die_die', 'corpse_explosion'],
  }
  const offered = {
    ...base,
    phase: 'reward',
    players: [player],
    rewards: [{ playerId: 'p1', cardReward: true, choices: null, upgraded: true, potion: false }],
    rewardDestination: 'map',
  }
  const revealed = revealCardReward(offered, 'p1')
  assertDeepEqual(revealed.rewards[0].choices, ['prepared', 'acrobatics', 'adrenaline'])
  assertDeepEqual(revealed.rewards[0].rareChoiceIndices, [2])

  const rare = resolveCardRewards(revealed, { p1: 2 })
  assertEqual(rare.players[0].deck.at(-1).defId, 'adrenaline')
  assertEqual(rare.players[0].deck.at(-1).upgraded, true, 'upgraded rewards upgrade the rare too')
  assertDeepEqual(rare.players[0].cardRewards, ['backflip', 'prepared', GOLDEN_TICKET, 'acrobatics'])
  assertDeepEqual(rare.players[0].rareRewards, ['die_die_die', 'corpse_explosion'])

  const skipped = resolveCardRewards(revealed, { p1: null })
  assertDeepEqual(skipped.players[0].cardRewards, ['backflip', 'prepared', GOLDEN_TICKET, 'acrobatics'])
  assertDeepEqual(skipped.players[0].rareRewards, ['die_die_die', 'corpse_explosion', 'adrenaline'])
})

check('two Golden Tickets reveal two rares and transform resolves a Ticket blindly', () => {
  const base = postNeowRun(205, [{ id: 'p1', name: 'Defect', character: 'defect' }])
  const player = {
    ...base.players[0],
    cardRewards: [GOLDEN_TICKET, 'ball_lightning', GOLDEN_TICKET, 'charge_battery'],
    rareRewards: ['thunder_strike', 'multi_cast', 'buffer'],
  }
  const offered = revealCardReward({
    ...base,
    phase: 'reward',
    players: [player],
    rewards: [{ playerId: 'p1', cardReward: true, choices: null, upgraded: false, potion: false }],
    rewardDestination: 'map',
  }, 'p1')
  assertDeepEqual(offered.rewards[0].choices, ['ball_lightning', 'thunder_strike', 'multi_cast'])
  assertDeepEqual(offered.rewards[0].rareChoiceIndices, [1, 2])

  const transformed = drawTransformReward(player)
  assertEqual(transformed.defId, 'thunder_strike')
  assertDeepEqual(transformed.player.cardRewards,
    ['ball_lightning', GOLDEN_TICKET, 'charge_battery', GOLDEN_TICKET])
  assertDeepEqual(transformed.player.rareRewards, ['multi_cast', 'buffer'])
})

check('every living player must make a valid card reward decision', () => {
  const run = postNeowRun(105, [
    { id: 'p1', name: 'Ironclad', character: 'ironclad' },
    { id: 'p2', name: 'Silent', character: 'silent' },
  ])
  const entered = enterRoom(run, roomChoices(run)[0].id)
  const won = resolveCombat({
    ...entered,
    combat: {
      ...entered.combat,
      phase: 'won',
      enemies: entered.combat.enemies.map((enemy) => ({ ...enemy, cardReward: 'normal' })),
    },
  })
  assert(resolveCardRewards(won, { p1: null }) === won, 'one player cannot decide for the table')
  assert(resolveCardRewards(won, { p1: 99, p2: null }) === won, 'an unrevealed card is refused')
  assert(resolveCardRewards(won, { p1: undefined, p2: null }) === won, 'undefined is not an unseen skip')
})

check('reward card ids stay unique even when another run starts meanwhile', () => {
  const first = postNeowRun(106, [{ id: 'p1', name: 'Ironclad', character: 'ironclad' }])
  const entered = enterRoom(first, roomChoices(first)[0].id)
  const offered = revealCardReward(
    resolveCombat({
      ...entered,
      combat: {
        ...entered.combat,
        phase: 'won',
        enemies: entered.combat.enemies.map((enemy) => ({ ...enemy, cardReward: 'normal' })),
      },
    }),
    'p1',
  )
  postNeowRun(107, [{ id: 'p1', name: 'Silent', character: 'silent' }])
  const after = resolveCardRewards(offered, { p1: 0 })
  const ids = after.players[0].deck.map((card) => card.uid)
  assertEqual(new Set(ids).size, ids.length, 'another room rewound this run\'s card ids')
})

check('advancing an act heals the party and builds a new map', () => {
  const run = postNeowRun(9, [
    { id: 'p1', name: 'Ironclad', character: 'ironclad' },
    { id: 'p2', name: 'Silent', character: 'silent' },
  ])
  // Stand the party on the boss room, wounded, with the act won.
  const bossId = run.map.rows[run.map.rows.length - 1][0]
  const won = {
    ...run,
    phase: 'victory',
    players: run.players.map((p) => ({ ...p, hp: 2 })),
    map: { ...run.map, position: bossId, rooms: { ...run.map.rooms, [bossId]: { ...run.map.rooms[bossId], visited: true } } },
  }
  const next = advanceAct(won)
  assertEqual(next.act, 2, 'the act advances')
  assertEqual(next.phase, 'map', 'and the party is back on a map')
  for (const player of next.players) {
    assertEqual(player.hp, player.maxHp, 'every player heals to full at the start of Act II (p.4)')
  }
  assert(next.map !== won.map, 'a new act builds a new map')
  assertEqual(next.map.position, null, 'and the boot starts beside it again')
  assertDeepEqual(
    [...next.players[0].cardRewards].sort(),
    [...run.players[0].cardRewards].sort(),
    'the same skipped reward cards are reshuffled into the next Act',
  )
  assertDeepEqual(next.players[0].rareRewards, run.players[0].rareRewards, 'rare rewards are not shuffled')
})

check('the inter-Act victory pause permits outside-combat Potion actions', () => {
  const run = postNeowRun(921, [
    { id: 'p1', name: 'Ironclad', character: 'ironclad' },
    { id: 'p2', name: 'Silent', character: 'silent' },
  ])
  const bossId = run.map.rows.at(-1)[0]
  const victory = { ...run, phase: 'victory', map: { ...run.map, position: bossId,
    rooms: { ...run.map.rooms, [bossId]: { ...run.map.rooms[bossId], visited: true } } },
    players: run.players.map((player, index) => ({ ...player, hp: player.maxHp - 2,
      potions: index === 0 ? ['blood_potion', 'fire_potion'] : [] })) }
  const healed = usePotionOutsideCombat(victory, 'p1', 'blood_potion')
  assertEqual(healed.players[0].hp, healed.players[0].maxHp)
  assert(tradePotion(victory, 'p1', 'p2', 'fire_potion') !== victory)
  const terminal = { ...victory, lastStand: true, players: victory.players.map((player, index) => ({ ...player, dead: index === 1 })) }
  assertEqual(usePotionOutsideCombat(terminal, 'p1', 'blood_potion'), terminal)
  assertEqual(tradePotion(terminal, 'p1', 'p2', 'fire_potion'), terminal)
})

check('pending immediate Relics block progression and between-boss item actions', () => {
  const run = postNeowRun(919, [
    { id: 'p1', name: 'Ironclad', character: 'ironclad' },
    { id: 'p2', name: 'Silent', character: 'silent' },
  ])
  const bossId = run.map.rows.at(-1)[0]
  let won = { ...run, phase: 'victory', map: { ...run.map, position: bossId,
    rooms: { ...run.map.rooms, [bossId]: { ...run.map.rooms[bossId], visited: true } } } }
  won = acquireRelic(won, 'p1', 'orrery')
  const preview = pendingRelicPreview(won, 'p1')
  assertEqual(advanceAct(won), won)
  assertDeepEqual(pendingRelicPreview(won, 'p1'), preview, 'advancing rerolled a pending Relic preview')

  const between = { ...won, phase: 'betweenCombat', pendingBossDefId: 'time_eater',
    players: won.players.map((player, index) => ({ ...player,
      potions: index === 0 ? ['blood_potion'] : [] })) }
  assertEqual(startPendingBoss(between), between)
  assertEqual(tradePotion(between, 'p1', 'p2', 'blood_potion'), between)
  assertEqual(usePotionOutsideCombat(between, 'p1', 'blood_potion'), between)

  const resolved = resolvePendingRelic(between, 'p1', [], [-1, -1, -1, -1])
  assert(tradePotion(resolved, 'p1', 'p2', 'blood_potion') !== resolved,
    'between-boss Potion trade stayed blocked after acquisition resolution')
})

check('Ascension 6 heals 4 instead of to full', () => {
  const run = postNeowRun(9, [{ id: 'p1', name: 'Ironclad', character: 'ironclad' }], 6)
  const bossId = run.map.rows[run.map.rows.length - 1][0]
  const won = {
    ...run,
    phase: 'victory',
    players: run.players.map((p) => ({ ...p, hp: 2 })),
    map: { ...run.map, position: bossId, rooms: { ...run.map.rooms, [bossId]: { ...run.map.rooms[bossId], visited: true } } },
  }
  const next = advanceAct(won)
  assertEqual(next.players[0].hp, 6, 'Ascension 6 heals 4 HP rather than to full')
})

check('Mark of Pain caps outside-combat and Act-transition healing at 6', () => {
  const run = postNeowRun(905, [{ id: 'p1', name: 'Ironclad', character: 'ironclad' }])
  run.players[0].hp = 5
  run.players[0].relics.push({ defId: 'mark_of_pain', spent: false })
  run.players[0].potions = ['blood_potion']
  assertEqual(usePotionOutsideCombat(run, 'p1', 'blood_potion').players[0].hp, 6)
  const capped = usePotionOutsideCombat(run, 'p1', 'blood_potion')
  capped.players[0].potions = ['blood_potion']
  assertEqual(usePotionOutsideCombat(capped, 'p1', 'blood_potion'), capped,
    'Blood Potion was consumed at Mark of Pain\'s effective HP cap')
  const bossId = run.map.rows.at(-1)[0]
  const won = { ...run, phase: 'victory', map: { ...run.map, position: bossId,
    rooms: { ...run.map.rooms, [bossId]: { ...run.map.rooms[bossId], visited: true } } } }
  assertEqual(advanceAct(won).players[0].hp, 6)

  const reduced = postNeowRun(906, [{ id: 'p1', name: 'Silent', character: 'silent' }])
  reduced.players[0].hp = 4
  reduced.players[0].maxHp = 5
  reduced.players[0].relics.push({ defId: 'mark_of_pain', spent: false })
  reduced.players[0].potions = ['blood_potion']
  assertEqual(usePotionOutsideCombat(reduced, 'p1', 'blood_potion').players[0].hp, 5,
    'Blood Potion healed above reduced maximum HP')
  const entered = enterRoom(reduced, roomChoices(reduced)[0].id)
  const returned = resolveCombat({
    ...entered,
    combat: {
      ...entered.combat,
      phase: 'won',
      players: entered.combat.players.map((player) => ({ ...player, hp: 6, maxHp: 5 })),
      enemies: entered.combat.enemies.map((enemy) => ({ ...enemy, hp: 0, dead: true })),
    },
  })
  assertEqual(returned.players[0].hp, 5, 'combat resolution preserved HP above reduced maximum')
  const reducedBoss = reduced.map.rows.at(-1)[0]
  const reducedWon = { ...reduced, phase: 'victory', map: { ...reduced.map, position: reducedBoss,
    rooms: { ...reduced.map.rooms, [reducedBoss]: { ...reduced.map.rooms[reducedBoss], visited: true } } } }
  assertEqual(advanceAct(reducedWon).players[0].hp, 5, 'Act transition healed above reduced maximum HP')
})

check('Ectoplasm suppresses rewards without restoring stolen combat gold', () => {
  const run = postNeowRun(912, [{ id: 'p1', name: 'Ironclad', character: 'ironclad' }])
  const entered = enterRoom(run, roomChoices(run)[0].id)
  entered.players[0].relics.push({ defId: 'ectoplasm', spent: false })
  entered.combat.players[0].relics.push({ defId: 'ectoplasm', spent: false })
  entered.players[0].gold = 5
  entered.combat.players[0].gold = 3
  entered.combat.phase = 'won'
  const resolved = resolveCombat(entered)
  assertEqual(resolved.players[0].gold, 3)
})

check('defeating the Corrupt Heart ends without an unusable boss Relic reward', () => {
  const run = postNeowRun(911, [{ id: 'p1', name: 'Ironclad', character: 'ironclad' }])
  const bossId = run.map.rows.at(-1)[0]
  const won = { ...run, act: 4, phase: 'combat', map: { ...run.map, position: bossId }, combat: {
    ...enterRoom(run, roomChoices(run)[0].id).combat,
    phase: 'won',
    enemies: [{ ...enterRoom(run, roomChoices(run)[0].id).combat.enemies[0], isBoss: true }],
  } }
  const resolved = resolveCombat(won)
  assertEqual(resolved.phase, 'victory')
  assertDeepEqual(resolved.rewards, [])
})

check('Act I and II bosses pay every player their printed gold, Rare, and Boss Relic rewards', () => {
  const seats = [
    { id: 'p1', name: 'Ironclad', character: 'ironclad' },
    { id: 'p2', name: 'Silent', character: 'silent' },
    { id: 'p3', name: 'Defect', character: 'defect' },
    { id: 'p4', name: 'Watcher', character: 'watcher' },
  ]
  for (const [act, boss] of [[1, 'slime_boss'], [2, 'the_collector']]) for (const ascension of [0, 10]) for (let count = 1; count <= 4; count++) {
    const run = postNeowRun(940 + ascension + count, seats.slice(0, count), ascension)
    const bossId = run.map.rows.at(-1)[0]
    const entered = enterRoom({
      ...run,
      act,
      actBossDefId: boss,
      map: { ...run.map, position: run.map.rows.at(-2)[0] },
    }, bossId)
    const goldBefore = entered.players.map((player) => player.gold)
    entered.combat.phase = 'won'
    entered.combat.enemies = entered.combat.enemies.map((enemy) => ({ ...enemy, hp: 0, dead: true }))
    const resolved = resolveCombat(entered)
    const gold = ascension >= 10 ? 2 : 3
    assertDeepEqual(resolved.players.map((player, index) => player.gold - goldBefore[index]),
      Array(count).fill(gold), `Act ${act} ${count}P A${ascension} boss gold`)
    assertEqual(resolved.rewards.length, count, `${count}P A${ascension} reward owners`)
    for (const reward of resolved.rewards) {
      assertEqual(reward.cardReward, true, 'the Rare Reward is present')
      assertEqual(reward.cardSource, 'rare')
      assertEqual(reward.upgraded, false)
      assert(reward.bossRelics.length > 0, 'the shared Boss Relic offer is present')
    }
    let revealed = resolved
    for (const player of resolved.players) {
      const expected = player.rareRewards.slice(0, 3)
      revealed = revealCardReward(revealed, player.id)
      assertDeepEqual(revealed.rewards.find((reward) => reward.playerId === player.id).choices, expected,
        `${player.name} was not offered the top three character rares`)
    }
  }
})

check('boss Rare and Prismatic reveals reserve shared physical cards in either reveal order', () => {
  const run = postNeowRun(967, [
    { id: 'p1', name: 'Ironclad', character: 'ironclad' },
    { id: 'p2', name: 'Silent', character: 'silent' },
  ])
  const bossId = run.map.rows.at(-1)[0]
  const entered = enterRoom({
    ...run,
    actBossDefId: 'slime_boss',
    players: run.players.map((player) => player.id === 'p2' ? {
      ...player, relics: [...player.relics, { defId: 'prismatic_shard', spent: false }],
    } : player),
    map: { ...run.map, position: run.map.rows.at(-2)[0] },
  }, bossId)
  entered.combat.phase = 'won'
  entered.combat.enemies = entered.combat.enemies.map((enemy) => ({ ...enemy, hp: 0, dead: true }))
  const offered = resolveCombat(entered)
  const originalRares = offered.players.map((player) => [...player.rareRewards].sort())
  for (const order of [['p1', 'p2'], ['p2', 'p1']]) {
    let revealed = structuredClone(offered)
    for (const playerId of order) revealed = playerId === 'p2'
      ? revealCardReward(revealed, playerId, ['ironclad', 'silent', 'defect'])
      : revealCardReward(revealed, playerId)
    const red = revealed.rewards.find((reward) => reward.playerId === 'p1').choices
    const prism = revealed.rewards.find((reward) => reward.playerId === 'p2').choices
    assertEqual(red.some((card) => prism.includes(card)), false, `${order.join(' then ')} duplicated a physical rare`)
    const settled = resolveCardRewards(revealed, { p1: null, p2: null })
    assertDeepEqual(settled.players.map((player) => [...player.rareRewards].sort()), originalRares,
      `${order.join(' then ')} did not conserve character rare decks`)
  }
})

check('revealing the last Rare refreshes Prismatic sources and stale submissions are atomic', () => {
  const run = postNeowRun(968, [
    { id: 'p1', name: 'Ironclad', character: 'ironclad' },
    { id: 'p2', name: 'Silent', character: 'silent' },
  ])
  const bossId = run.map.rows.at(-1)[0]
  const entered = enterRoom({
    ...run,
    actBossDefId: 'slime_boss',
    players: run.players.map((player) => player.id === 'p1' ? { ...player, rareRewards: ['feed'] } : player.id === 'p2' ? {
      ...player, relics: [...player.relics, { defId: 'prismatic_shard', spent: false }],
    } : player),
    map: { ...run.map, position: run.map.rows.at(-2)[0] },
  }, bossId)
  entered.combat.phase = 'won'
  entered.combat.enemies = entered.combat.enemies.map((enemy) => ({ ...enemy, hp: 0, dead: true }))
  const offered = resolveCombat(entered)
  assert(offered.rewards.find((reward) => reward.playerId === 'p2').availableSources.includes('ironclad'))
  const revealed = revealCardReward(offered, 'p1')
  assertEqual(revealed.rewards.find((reward) => reward.playerId === 'p2').availableSources.includes('ironclad'), false)
  assertEqual(revealCardReward(revealed, 'p2', ['ironclad', 'silent', 'defect']), revealed,
    'a stale source selection partially reserved cards')
})

check('persisted pre-fix boss combats receive their printed rewards on resolution', () => {
  const run = postNeowRun(962, [{ id: 'p1', name: 'Ironclad', character: 'ironclad' }])
  const bossId = run.map.rows.at(-1)[0]
  const entered = enterRoom({
    ...run,
    actBossDefId: 'slime_boss',
    map: { ...run.map, position: run.map.rows.at(-2)[0] },
  }, bossId)
  const gold = entered.players[0].gold
  const rares = entered.players[0].rareRewards.slice(0, 3)
  entered.combat.phase = 'won'
  entered.combat.enemies = entered.combat.enemies.map((enemy) => ({
    ...enemy, hp: 0, dead: true, goldReward: 0, cardReward: null,
  }))
  const resolved = resolveCombat(entered)
  assertEqual(resolved.players[0].gold, gold + 3)
  assertEqual(resolved.rewards[0].cardReward, true)
  assertEqual(resolved.rewards[0].cardSource, 'rare')
  assert(resolved.rewards[0].bossRelics.length > 0)
  assertDeepEqual(revealCardReward(resolved, 'p1').rewards[0].choices, rares)
})

check('boss Rare Rewards and Orrery settle in either order without corrupting reward decks', () => {
  const run = postNeowRun(965, [{ id: 'p1', name: 'Ironclad', character: 'ironclad' }])
  const bossId = run.map.rows.at(-1)[0]
  const entered = enterRoom({
    ...run,
    actBossDefId: 'slime_boss',
    bossRelicDeck: ['orrery', ...run.bossRelicDeck.filter((id) => id !== 'orrery')],
    map: { ...run.map, position: run.map.rows.at(-2)[0] },
  }, bossId)
  entered.combat.phase = 'won'
  entered.combat.enemies = entered.combat.enemies.map((enemy) => ({ ...enemy, hp: 0, dead: true }))
  const offered = resolveCombat(entered)
  const deckSize = offered.players[0].deck.length

  let cardFirst = revealCardReward(structuredClone(offered), 'p1')
  cardFirst = resolveCardRewards(cardFirst, { p1: 0 })
  assertEqual(cardFirst.rewards[0].cardReward, false, 'Boss Relics blocked the printed Card Reward')
  cardFirst = resolveBossRelicReward(cardFirst, 'p1', 'orrery')
  const cardFirstChoices = pendingRelicPreview(cardFirst, 'p1').rewardChoices
  cardFirst = resolvePendingRelic(cardFirst, 'p1', [], [0, 0, 0, 0])

  let relicFirst = revealCardReward(structuredClone(offered), 'p1')
  relicFirst = resolveBossRelicReward(relicFirst, 'p1', 'orrery')
  relicFirst = structuredClone(relicFirst)
  const relicFirstChoices = pendingRelicPreview(relicFirst, 'p1').rewardChoices
  assertDeepEqual(relicFirstChoices, cardFirstChoices, 'Orrery reused the already revealed boss cards')
  relicFirst = resolvePendingRelic(relicFirst, 'p1', [], [0, 0, 0, 0])
  relicFirst = resolveCardRewards(relicFirst, { p1: 0 })

  assertDeepEqual([...relicFirst.players[0].cardRewards].sort(), [...cardFirst.players[0].cardRewards].sort())
  assertDeepEqual([...relicFirst.players[0].rareRewards].sort(), [...cardFirst.players[0].rareRewards].sort())
  assertDeepEqual(
    relicFirst.players[0].deck.slice(deckSize).map((card) => card.defId).sort(),
    cardFirst.players[0].deck.slice(deckSize).map((card) => card.defId).sort(),
    'reward order duplicated or discarded a gained card',
  )
})

check('Transformed does not replace a boss Rare Reward', () => {
  const run = postNeowRun(966, [{ id: 'p1', name: 'Ironclad', character: 'ironclad' }])
  const bossId = run.map.rows.at(-1)[0]
  const entered = enterRoom({
    ...run,
    meta: { mode: 'custom', modifierIds: ['transformed'] },
    actBossDefId: 'slime_boss',
    map: { ...run.map, position: run.map.rows.at(-2)[0] },
  }, bossId)
  entered.combat.phase = 'won'
  entered.combat.enemies = entered.combat.enemies.map((enemy) => ({ ...enemy, hp: 0, dead: true }))
  const resolved = resolveCombat(entered)
  assertEqual(resolved.rewards[0].cardSource, 'rare')
  assertEqual(resolved.rewards[0].transformReward, false)
})

check('Act III bosses have no unprinted Boss Relic reward', () => {
  const run = postNeowRun(963, [{ id: 'p1', name: 'Ironclad', character: 'ironclad' }])
  const bossId = run.map.rows.at(-1)[0]
  const entered = enterRoom({
    ...run,
    act: 3,
    actBossDefId: 'time_eater',
    map: { ...run.map, position: run.map.rows.at(-2)[0] },
  }, bossId)
  const bossRelics = [...entered.bossRelicDeck]
  entered.combat.phase = 'won'
  entered.combat.enemies = entered.combat.enemies.map((enemy) => ({ ...enemy, hp: 0, dead: true }))
  const resolved = resolveCombat(entered)
  assertDeepEqual(resolved.rewards, [])
  assertDeepEqual(resolved.bossRelicDeck, bossRelics, 'the unprinted reward did not consume the deck')
})

check('the Act IV elite grants every player an upgraded Card Reward and the shared Relic', () => {
  const run = postNeowRun(964, [
    { id: 'p1', name: 'Ironclad', character: 'ironclad' },
    { id: 'p2', name: 'Silent', character: 'silent' },
  ], 11)
  const eliteRoom = Object.values(run.map.rooms).find((room) => room.kind === 'elite')
  const approach = Object.values(run.map.rooms).find((room) => room.exits.includes(eliteRoom?.id))
  assert(eliteRoom && approach, 'the fixture needs a reachable elite room')
  const entered = enterRoom({
    ...run,
    act: 4,
    enemyDecks: { act: 4, first: [], encounter: [], elite: [
      { defId: 'spire_shield', goldReward: 0, cardReward: 'upgraded' },
    ] },
    map: { ...run.map, position: approach.id },
  }, eliteRoom.id)
  assertDeepEqual(entered.combat.enemies.map((enemy) => enemy.defId).sort(), ['spire_shield', 'spire_spear'])
  entered.combat.phase = 'won'
  entered.combat.enemies = entered.combat.enemies.map((enemy) => ({ ...enemy, hp: 0, dead: true }))
  const resolved = resolveCombat(entered)
  assertEqual(resolved.rewards.length, 2)
  assert(resolved.rewards.every((reward) => reward.cardReward && reward.upgraded),
    'each living player gets the printed upgraded Card Reward')
  assertEqual(resolved.roomState?.kind, 'elite', 'the shared elite Relic remains queued')
})

check('White Beast Statue offers its Potion after the first A13 boss before regrouping', () => {
  const run = postNeowRun(913, [{ id: 'p1', name: 'Ironclad', character: 'ironclad' }], 13)
  const bossId = run.map.rows.at(-1)[0]
  const entered = enterRoom(run, roomChoices(run)[0].id)
  const won = { ...run, phase: 'combat', map: { ...run.map, position: bossId }, pendingBossDefId: 'time_eater',
    players: run.players.map((player) => ({ ...player, relics: [...player.relics,
      { defId: 'white_beast_statue', spent: false }] })), combat: {
      ...entered.combat,
      phase: 'won',
      players: entered.combat.players.map((player) => ({ ...player, relics: [...player.relics,
        { defId: 'white_beast_statue', spent: false }] })),
      enemies: [{ ...entered.combat.enemies[0], isBoss: true }],
    } }
  const offered = resolveCombat(won)
  assertEqual(offered.phase, 'reward')
  assertEqual(offered.rewardDestination, 'betweenCombat')
  assertEqual(offered.rewards[0].potion, null)
  const skipped = resolvePotionReward(offered, 'p1', { kind: 'skip' })
  assertEqual(skipped.phase, 'betweenCombat')
  assertEqual(skipped.pendingBossDefId, 'time_eater')
})

check('The Last Stand ends A13 after the first boss instead of starting the second', () => {
  const party = [
    { id: 'p1', name: 'Ironclad', character: 'ironclad' },
    { id: 'p2', name: 'Silent', character: 'silent' },
  ]
  const run = postNeowRun(916, party, 13, undefined, false, true)
  const bossId = run.map.rows.at(-1)[0]
  const entered = enterRoom(run, roomChoices(run)[0].id)
  const offered = resolveCombat({
    ...run,
    act: 3,
    phase: 'combat',
    map: { ...run.map, position: bossId },
    pendingBossDefId: 'time_eater',
    combat: {
      ...entered.combat,
      phase: 'won',
      players: entered.combat.players.map((player, index) => index === 0
        ? { ...player, hp: 0, dead: true }
        : player),
      enemies: entered.combat.enemies.map((enemy) => ({ ...enemy, hp: 0, dead: true, isBoss: true })),
    },
  })
  assertEqual(offered.rewardDestination, null)
  assertEqual(offered.pendingBossDefId, null)
  assertEqual(offered.phase, 'victory')
  assertDeepEqual(offered.rewards, [])
})

check('one-shot Relics resolve with all remaining legal cards when the deck is depleted', () => {
  let run = postNeowRun(914, [{ id: 'p1', name: 'Ironclad', character: 'ironclad' }])
  run.phase = 'map'
  let keptDefend = false
  run.players[0].deck = run.players[0].deck.map((card) => {
    if (card.defId.startsWith('defend_') && !keptDefend) { keptDefend = true; return card }
    return { ...card, upgraded: true }
  })
  run = acquireRelic(run, 'p1', 'war_paint')
  const resolved = resolvePendingRelic(run, 'p1', [])
  assert(!resolved.players[0].relics.some((relic) => relic.pending), 'depleted War Paint stayed pending')
  assert(resolved.players[0].deck.find((card) => card.defId.startsWith('defend_')).upgraded,
    'the automatic starter Defend was not upgraded')
})

check('a pending Relic freezes local reward settlement at acquisition time', () => {
  let run = postNeowRun(920, [{ id: 'p1', name: 'Ironclad', character: 'ironclad' }])
  run.phase = 'reward'
  run.rewardDestination = 'map'
  run.players[0].deck.push({ uid: 'local-reward-order-skill', defId: 'shrug_it_off', upgraded: false })
  run.rewards = [{ playerId: 'p1', cardReward: true, choices: null, upgraded: false,
    potion: false, relic: 'war_paint', bossRelics: false }]
  run = resolveRelicReward(run, 'p1', true)
  const deckBefore = run.players[0].deck.map((card) => card.uid)
  assert(run.players[0].relics.some((relic) => relic.defId === 'war_paint' && relic.pending))
  assertEqual(revealCardReward(run, 'p1'), run, 'a local card reward bypassed the pending Relic')
  assertEqual(resolveCardRewards(run, { p1: null }), run, 'a local skip bypassed the pending Relic')
  assertDeepEqual(run.players[0].deck.map((card) => card.uid), deckBefore)

  const target = run.players[0].deck.find((card) => card.uid === 'local-reward-order-skill')
  run = resolvePendingRelic(run, 'p1', [target.uid])
  assertEqual(revealCardReward(run, 'p1').rewards[0].choices.length, 3)
})

check("Ascension 5 adds Ascender's Bane to every starter deck", () => {
  const party = [
    { id: 'p1', name: 'Ironclad', character: 'ironclad' },
    { id: 'p2', name: 'Silent', character: 'silent' },
    { id: 'p3', name: 'Defect', character: 'defect' },
    { id: 'p4', name: 'Watcher', character: 'watcher' },
  ]
  const below = postNeowRun(5, party, 4)
  const ascended = postNeowRun(5, party, 5)
  for (let index = 0; index < party.length; index++) {
    assertEqual(below.players[index].deck.some((card) => card.defId === 'ascenders_bane'), false)
    assertEqual(ascended.players[index].deck.filter((card) => card.defId === 'ascenders_bane').length, 1)
    assertEqual(ascended.players[index].draw.filter((card) => card.defId === 'ascenders_bane').length, 1)
  }
})

check('Ascension 2 and 9 apply their cumulative setup HP losses', () => {
  const party = [
    { id: 'p1', name: 'Ironclad', character: 'ironclad' },
    { id: 'p2', name: 'Silent', character: 'silent' },
    { id: 'p3', name: 'Defect', character: 'defect' },
    { id: 'p4', name: 'Watcher', character: 'watcher' },
  ]
  const base = postNeowRun(12, party, 0)
  const a2 = postNeowRun(12, party, 2)
  const a9 = postNeowRun(12, party, 9)
  for (let index = 0; index < party.length; index++) {
    assertEqual(a2.players[index].maxHp, base.players[index].maxHp - 1, 'A2 loses 1 max HP')
    assertEqual(a2.players[index].hp, a2.players[index].maxHp, 'A2 still starts at full HP')
    assertEqual(a9.players[index].maxHp, a2.players[index].maxHp, 'A9 does not lose more max HP')
    assertEqual(a9.players[index].hp, a9.players[index].maxHp - 1, 'A9 starts 1 HP damaged')
  }
})

check('a boss room stands up a single boss that acts last', () => {
  const run = postNeowRun(4, [
    { id: 'p1', name: 'Ironclad', character: 'ironclad' },
    { id: 'p2', name: 'Silent', character: 'silent' },
  ])
  const bossId = run.map.rows[run.map.rows.length - 1][0]
  // Walk the boot to the boss room directly, then enter it.
  const atCampfire = { ...run, map: { ...run.map, position: run.map.rows[run.map.rows.length - 2][0] } }
  const entered = enterRoom(atCampfire, bossId)
  assertEqual(entered.phase, 'combat')
  assertEqual(entered.combat.enemies.length, 1, 'a boss stands alone (p.11)')
  assert(entered.combat.enemies[0].isBoss, 'and is marked as a boss so it acts last')
})

check('an elite room places one elite, not one per player', () => {
  const fixture = postNeowRun(0, [
    { id: 'p1', name: 'Ironclad', character: 'ironclad' },
    { id: 'p2', name: 'Silent', character: 'silent' },
  ])
  const choice = Object.values(fixture.map.rooms).find((room) => room.kind === 'elite')
  const from = Object.values(fixture.map.rooms).find((room) => room.exits.includes(choice.id))
  fixture.phase = 'map'
  fixture.map.position = from.id
  fixture.map.rooms[from.id].visited = true
  const elite = enterRoom(fixture, choice.id)
  const main = elite.combat.enemies.find((enemy) => enemy.uid === 'elite')
  assert(main && !main.isBoss, 'the main elite card is not a boss')
  assertEqual(main.goldReward, 2, 'an Act I elite grants 2 gold')
  assertEqual(main.cardReward, 'normal', 'an Act I elite grants a normal card')

  for (const act of [2, 3]) {
    const eliteCard = act === 2
      ? { defId: 'book_of_stabbing', goldReward: 2, cardReward: 'upgraded' }
      : { defId: 'giant_head', goldReward: 3, cardReward: 'upgraded' }
    const later = enterRoom({
      ...fixture,
      act,
      enemyDecks: { act, first: [], encounter: [], elite: [eliteCard] },
    }, choice.id)
    const foe = later.combat.enemies.find((enemy) => enemy.uid === 'elite')
    assertEqual(foe.goldReward, act === 3 ? 3 : 2, `Act ${act} elite gold`)
    assertEqual(foe.cardReward, 'upgraded', `Act ${act} elite upgraded-card reward`)
    const offered = resolveCombat({ ...later, combat: { ...later.combat, phase: 'won' } })
    assert(offered.rewards.every((offer) => offer.upgraded), `Act ${act} offer is upgraded`)
    const revealed = revealCardReward(offered, 'p1')
    const collected = resolveCardRewards(revealed, { p1: 0, p2: null })
    assert(collected.players[0].deck.at(-1).upgraded, `Act ${act} elite adds the upgraded face`)
  }
  for (const enemyDecks of [fixture.enemyDecks, { act: 3, first: [], encounter: [], elite: [] }]) {
    const recovered = enterRoom({ ...fixture, act: 3, enemyDecks }, choice.id)
    assert(['reptomancer', 'nemesis', 'giant_head'].includes(
      recovered.combat.enemies.find((enemy) => enemy.uid === 'elite').defId,
    ), 'a stale or empty Act III Elite deck produced an Elite from another Act')
    assertEqual(recovered.enemyDecks.act, 3)
    assertEqual(recovered.enemyDecks.elite.length, 3)
  }
})

// Transcribed from the enemy card scans. Comparing a definition to itself is a
// tautology, so the numbers are pinned here against the printed cards instead.
const PRINTED_HP = {
  small_slime: [3, 3, 3, 3],
  acid_slime: [5, 5, 5, 5],
  acid_slime_daw: [5, 5, 5, 5],
  acid_slime_wda: [5, 5, 5, 5],
  acid_slime_wad: [5, 5, 5, 5],
  cultist: [9, 9, 9, 9],
  jaw_worm: [10, 10, 10, 10],
  jaw_worm_first: [7, 7, 7, 7],
  jaw_worm_a7: [7, 7, 7, 7],
  green_louse: [3, 3, 3, 3],
  green_louse_21w: [3, 3, 3, 3],
  red_louse: [4, 4, 4, 4],
  red_louse_first: [3, 3, 3, 3],
  red_louse_summon: [3, 3, 3, 3],
  spike_slime: [5, 5, 5, 5],
  spike_slime_dv2: [5, 5, 5, 5],
  spike_slime_v2d: [5, 5, 5, 5],
  spike_slime_2dv: [5, 5, 5, 5],
  fungi_beast: [6, 6, 6, 6],
  fungi_beast_summon: [5, 5, 5, 5],
  blue_slaver: [10, 10, 10, 10],
  red_slaver: [10, 10, 10, 10],
  looter: [9, 9, 9, 9],
  large_slime: [8, 8, 8, 8],
  large_slime_summon_w4s: [10, 10, 10, 10],
  large_slime_summon_4sw: [10, 10, 10, 10],
  large_slime_summon_sw4: [10, 10, 10, 10],
  mad_gremlin: [4, 4, 4, 4],
  sneaky_gremlin: [2, 2, 2, 2],
  gremlin_wizard: [4, 4, 4, 4],
  fat_gremlin: [3, 3, 3, 3],
  sentry_a: [7, 7, 7, 7],
  sentry_b: [8, 8, 8, 8],
  sentries: [7, 7, 7, 7],
  gremlin_nob: [14, 28, 42, 56],
  lagavulin: [22, 44, 66, 88],
  chosen_14: [14, 14, 14, 14],
  chosen_16: [16, 16, 16, 16],
  looter_hard: [10, 10, 10, 10],
  mugger: [12, 12, 12, 12],
  centurion_b3: [15, 15, 15, 15],
  centurion_3b: [15, 15, 15, 15],
  mystic: [10, 10, 10, 10],
  mystic_2sh: [10, 10, 10, 10],
  byrd_encounter: [5, 5, 5, 5],
  byrd_s13: [4, 4, 4, 4],
  byrd_s31: [4, 4, 4, 4],
  byrd_31s: [4, 4, 4, 4],
  snake_plant: [17, 17, 17, 17],
  shelled_parasite: [18, 18, 18, 18],
  fungi_beast_a7: [6, 6, 6, 6],
  snecko: [23, 23, 23, 23],
  spheric_guardian: [5, 5, 5, 5],
  blue_slaver_wd3: [10, 10, 10, 10],
  blue_slaver_w3d: [10, 10, 10, 10],
  blue_slaver_dw3: [10, 10, 10, 10],
  blue_slaver_3wd: [10, 10, 10, 10],
  red_slaver_dv3: [10, 10, 10, 10],
  red_slaver_3dv: [10, 10, 10, 10],
  red_slaver_3vd: [10, 10, 10, 10],
  red_slaver_v3d: [10, 10, 10, 10],
  book_of_stabbing: [30, 60, 90, 120],
  gremlin_leader: [30, 60, 90, 120],
  taskmaster: [13, 28, 42, 56],
  jaw_worm_act3: [10, 10, 10, 10],
  jaw_worm_summon: [10, 10, 10, 10],
  jaw_worm_summon_3b4: [10, 10, 10, 10],
  spire_growth: [17, 17, 17, 17],
  repulsor: [7, 7, 7, 7],
  repulsor_summon: [7, 7, 7, 7],
  exploder: [8, 8, 8, 8],
  exploder_summon: [8, 8, 8, 8],
  orb_walker_3ws: [22, 22, 22, 22],
  orb_walker_2s: [22, 22, 22, 22],
  transient: [99, 99, 99, 99],
  maw: [28, 28, 28, 28],
  writhing_mass: [17, 17, 17, 17],
  darkling: [8, 8, 8, 8],
  darkling_bha: [8, 8, 8, 8],
  darkling_hab: [8, 8, 8, 8],
  spiker_add: [10, 10, 10, 10],
  spiker_attack: [10, 10, 10, 10],
  dagger: [5, 5, 5, 5],
  giant_head: [80, 160, 240, 320],
  nemesis: [30, 60, 90, 120],
  reptomancer: [35, 70, 105, 140],
  slime_boss: [22, 44, 66, 88],
  guardian_attack: [40, 80, 120, 160],
  guardian_defensive: [40, 80, 120, 160],
  hexaghost: [36, 75, 112, 150],
  the_collector: [57, 114, 171, 228],
  torch_head: [9, 9, 9, 9],
  the_champ: [40, 80, 120, 160],
  the_champ_fury: [40, 80, 120, 160],
  bronze_automaton: [55, 110, 165, 220],
  bronze_orb: [19, 19, 19, 19],
  bronze_orb_db3: [19, 19, 19, 19],
  bronze_orb_3bd: [19, 19, 19, 19],
  bronze_orb_b3d: [19, 19, 19, 19],
  awakened_one_phase_1: [50, 100, 150, 200],
  awakened_one_phase_2: [50, 100, 150, 200],
  time_eater: [60, 120, 180, 240],
  donu: [50, 100, 150, 200],
  deca: [50, 100, 150, 200],
  spire_shield: [30, 60, 90, 120],
  spire_spear: [42, 84, 126, 168],
  corrupt_heart: [100, 200, 300, 400],
}

check('main-enemy rewards come from the Act-specific encounter card', () => {
  const firstCardReward = {
    red_louse_first: null,
    jaw_worm_first: 'normal',
    cultist: 'normal',
    small_slime: 'normal',
  }
  const actOneGold = {
    red_louse_first: 1,
    jaw_worm_first: 1,
    cultist: 1,
    small_slime: 0,
    blue_slaver: 2,
    fungi_beast: 1,
  }
  for (let seed = 0; seed < 30; seed++) {
    const run = postNeowRun(seed, [{ id: 'p1', name: 'Watcher', character: 'watcher' }])
    const enemy = enterRoom(run, roomChoices(run)[0].id).combat.enemies[0]
    assertEqual(enemy.goldReward, actOneGold[enemy.defId], `${enemy.defId} Act I gold`)
    assertEqual(enemy.cardReward, firstCardReward[enemy.defId], `${enemy.defId} opening card reward`)
  }

  const base = postNeowRun(80, [{ id: 'p1', name: 'Watcher', character: 'watcher' }])
  const source = Object.values(base.map.rooms).find((room) =>
    room.exits.some((id) => base.map.rooms[id]?.kind === 'encounter'))
  const target = source?.exits.find((id) => base.map.rooms[id]?.kind === 'encounter')
  assert(source && target, 'the regression map needs a reachable ordinary encounter')
  const ordinary = enterRoom({ ...base, map: { ...base.map, position: source.id } }, target).combat.enemies[0]
  assertEqual(ordinary.cardReward, 'normal', 'an ordinary Act I encounter grants its printed card reward')

  for (const [act, card] of [
    [2, { defId: 'cultist', goldReward: 2, cardReward: 'normal' }],
    [3, { defId: 'jaw_worm_act3', goldReward: 2, cardReward: 'normal' }],
  ]) {
    const base = postNeowRun(71 + act, [{ id: 'p1', name: 'Watcher', character: 'watcher' }])
    const run = { ...base, act, enemyDecks: { act, first: [], encounter: [card], elite: [] } }
    const enemy = enterRoom(run, roomChoices(run)[0].id).combat.enemies[0]
    assertEqual(enemy.defId, card.defId, `Act ${act} uses the drawn main-enemy card`)
    assertEqual(enemy.goldReward, 2, `Act ${act} printed gold`)
    assertEqual(enemy.cardReward, 'normal', `Act ${act} normal card reward`)
  }
})

check('the reduced live reward deck supports every reward fight across three Acts', () => {
  const progress = createCampaignProgress()
  progress.characters.watcher = 8
  let run = postNeowRun(141, [{ id: 'p1', name: 'Watcher', character: 'watcher' }], 0, progress)
  for (let fight = 0; fight < 21; fight++) {
    const fixture = postNeowRun(200 + fight, [{ id: 'p1', name: 'Watcher', character: 'watcher' }], 0, progress)
    const entered = enterRoom(fixture, roomChoices(fixture)[0].id)
    run = {
      ...run,
      phase: 'combat',
      combat: {
        ...entered.combat,
        phase: 'won',
        players: run.players,
        enemies: [{
          ...entered.combat.enemies[0],
          goldReward: 1,
          cardReward: 'normal',
        }],
      },
    }
    const offered = resolveCombat(run)
    assertEqual(offered.phase, 'reward', `fight ${fight + 1} still reveals a reward`)
    const revealed = revealCardReward(offered, 'p1')
    assert(revealed.rewards[0].choices.length > 0 && revealed.rewards[0].choices.length <= 3,
      `fight ${fight + 1} reveals every remaining physical reward card`)
    run = resolveCardRewards(revealed, { p1: 0 })
    if ((fight === 6 || fight === 13)) {
      const bossId = run.map.rows.at(-1)[0]
      run = advanceAct({
        ...run,
        phase: 'victory',
        map: {
          ...run.map,
          position: bossId,
          rooms: { ...run.map.rooms, [bossId]: { ...run.map.rooms[bossId], visited: true } },
        },
      })
    }
  }
})

check('every enemy HP track matches the number printed on its card', () => {
  for (const [id, expected] of Object.entries(PRINTED_HP)) {
    const def = ENEMIES[id]
    assert(def !== undefined, `${id} is missing from ENEMIES`)
    assertDeepEqual(def.hpByPlayers, expected, `${id}'s HP track does not match its card`)
  }
  assertEqual(
    Object.keys(ENEMIES).length,
    Object.keys(PRINTED_HP).length,
    'an enemy was added or removed without updating the printed-HP table',
  )
})

check('encounter HP comes from the enemy definition, not a fixture', () => {
  const run = postNeowRun(3, [{ id: 'p1', name: 'Ironclad', character: 'ironclad' }])
  const entered = enterRoom(run, roomChoices(run)[0].id)
  for (const spawned of entered.combat.enemies) {
    assertEqual(
      spawned.maxHp,
      PRINTED_HP[spawned.defId][0],
      `${spawned.defId} should spawn at the solo HP printed on its card`,
    )
  }
})

// A campfire lets each player Rest (heal 3) or Smith (upgrade a card), p.9.
function atCampfire(seed = 11) {
  const run = postNeowRun(seed, [
    { id: 'p1', name: 'Ironclad', character: 'ironclad' },
    { id: 'p2', name: 'Silent', character: 'silent' },
  ])
  // Park the party on a campfire directly; the row below the boss is all campfires.
  const campfireId = run.map.rows[run.map.rows.length - 2][0]
  return {
    ...run,
    phase: 'room',
    players: run.players.map((p) => ({ ...p, hp: 4 })),
    map: { ...run.map, position: campfireId },
  }
}

check('Rest heals 3 and never past the maximum', () => {
  const next = resolveCampfire(atCampfire(), {
    p1: { choice: 'rest' },
    p2: { choice: 'rest' },
  })
  assertEqual(next.players[0].hp, 7, 'the Ironclad heals 4 -> 7')
  assertEqual(next.players[1].hp, 7, 'and so does the Silent')

  const nearlyFull = { ...atCampfire(), players: atCampfire().players.map((p) => ({ ...p, hp: p.maxHp - 1 })) }
  const capped = resolveCampfire(nearlyFull, { p1: { choice: 'rest' }, p2: { choice: 'rest' } })
  for (const player of capped.players) {
    assertEqual(player.hp, player.maxHp, 'Rest must not heal past the maximum')
  }
})

check('Peace Pipe applies the printed Parasite maximum-HP loss', () => {
  const room = atCampfire()
  room.players[0].relics.push({ defId: 'peace_pipe', spent: false })
  room.players[0].deck[0] = { ...room.players[0].deck[0], defId: 'parasite' }
  room.players[0].hp = room.players[0].maxHp
  const beforeMaxHp = room.players[0].maxHp
  const next = resolveCampfire(room, {
    p1: { choice: 'rest', removeCardUid: room.players[0].deck[0].uid },
    p2: { choice: 'rest' },
  })
  assertEqual(next.players[0].maxHp, beforeMaxHp - 2)
  assertEqual(next.players[0].hp, beforeMaxHp - 2)
})

check('Smith upgrades exactly the chosen card', () => {
  const room = atCampfire()
  const target = room.players[0].deck[2]
  const next = resolveCampfire(room, {
    p1: { choice: 'smith', cardUid: target.uid },
    p2: { choice: 'rest' },
  })
  const upgraded = next.players[0].deck.filter((card) => card.upgraded)
  assertEqual(upgraded.length, 1, 'exactly one card is upgraded')
  assertEqual(upgraded[0].uid, target.uid, 'and it is the one that was chosen')
  assertEqual(next.players[0].hp, 4, 'Smith does not also heal')
})

check('Smith cannot upgrade a card twice', () => {
  const room = atCampfire()
  const already = room.players[0].deck[0]
  const primed = {
    ...room,
    players: room.players.map((player, index) =>
      index === 0
        ? {
            ...player,
            deck: player.deck.map((card) =>
              card.uid === already.uid ? { ...card, upgraded: true } : card,
            ),
          }
        : player,
    ),
  }
  const next = resolveCampfire(primed, {
    p1: { choice: 'smith', cardUid: already.uid },
    p2: { choice: 'rest' },
  })
  assertEqual(
    next.players[0].deck.filter((card) => card.upgraded).length,
    1,
    'naming an already-upgraded card is ignored rather than double-upgrading',
  )
})

check('Smith refuses cards without a physical upgrade face', () => {
  const room = atCampfire()
  const bane = { uid: 'campfire-bane', defId: 'ascenders_bane', upgraded: false }
  room.players[0].deck = [bane, ...room.players[0].deck]
  const next = resolveCampfire(room, {
    p1: { choice: 'smith', cardUid: bane.uid },
    p2: { choice: 'rest' },
  })
  assertEqual(next.players[0].deck[0].upgraded, false)
})

check('a campfire returns the party to the map', () => {
  const next = resolveCampfire(atCampfire(), { p1: { choice: 'rest' }, p2: { choice: 'rest' } })
  assertEqual(next.phase, 'map')
})

check('resolving a campfire anywhere else is refused', () => {
  const run = postNeowRun(11, [{ id: 'p1', name: 'Ironclad', character: 'ironclad' }])
  assert(resolveCampfire(run, { p1: { choice: 'rest' } }) === run, 'not in a room at all')

  const inCombat = enterRoom(run, roomChoices(run)[0].id)
  assert(
    resolveCampfire(inCombat, { p1: { choice: 'rest' } }) === inCombat,
    'a combat is not a campfire',
  )
})

check('a dead player is not healed or upgraded at a campfire', () => {
  const room = atCampfire()
  const withCorpse = {
    ...room,
    players: room.players.map((player, index) =>
      index === 0 ? { ...player, dead: true, hp: 0 } : player,
    ),
  }
  const target = withCorpse.players[0].deck[1]
  const next = resolveCampfire(withCorpse, {
    p1: { choice: 'smith', cardUid: target.uid },
    p2: { choice: 'rest' },
  })
  assertEqual(next.players[0].hp, 0, 'the dead do not heal')
  assertEqual(
    next.players[0].deck.filter((card) => card.upgraded).length,
    0,
    'and do not upgrade cards',
  )
  assertEqual(next.players[1].hp, 7, 'the living player is unaffected by the corpse')
})

// Party size changes the HP board column, the row an enemy stands in, and how
// many enemies an encounter draws. Four players is the box maximum and the case
// most likely to be wrong.
check('a four player encounter draws one enemy per row at four-player HP', () => {
  const run = postNeowRun(12, [
    { id: 'p1', name: 'Ironclad', character: 'ironclad' },
    { id: 'p2', name: 'Silent', character: 'silent' },
    { id: 'p3', name: 'Defect', character: 'defect' },
    { id: 'p4', name: 'Watcher', character: 'watcher' },
  ])
  const entered = enterRoom(run, roomChoices(run)[0].id)
  const mainEnemies = entered.combat.enemies.filter((enemy) => !enemy.uid.includes('-summon'))
  assertEqual(mainEnemies.length, 4, 'one encounter card per player (p.10)')
  assertEqual(new Set(mainEnemies.map((e) => e.row)).size, 4, 'each main enemy in its own row')
  for (const spawned of entered.combat.enemies) {
    assertEqual(
      spawned.maxHp,
      PRINTED_HP[spawned.defId][3],
      `${spawned.defId} should use the four-player column of its HP board`,
    )
  }
})

check('players can switch rows on the map before every combat', () => {
  const run = postNeowRun(120, [
    { id: 'p1', name: 'Ironclad', character: 'ironclad' },
    { id: 'p2', name: 'Silent', character: 'silent' },
  ])
  const switched = switchBetweenCombatRow(run, 'p1', 1)
  assertEqual(switched.players.find((player) => player.id === 'p1').row, 1)
  assertEqual(switched.players.find((player) => player.id === 'p2').row, 0,
    'moving into an occupied row swaps the two players')
  assert(switched.log.at(-1).includes('before the next combat'))
})

check('an elite stands in the bottom row, a boss in the top', () => {
  const party = [
    { id: 'p1', name: 'Ironclad', character: 'ironclad' },
    { id: 'p2', name: 'Silent', character: 'silent' },
    { id: 'p3', name: 'Defect', character: 'defect' },
  ]
  const initial = postNeowRun(21, party)
  const run = switchBetweenCombatRow(initial, 'p1', 2)
  const bottomRow = Math.min(...run.players.map((player) => player.row))
  const topRow = Math.max(...run.players.map((player) => player.row))
  assert(bottomRow !== topRow, 'the fixture needs distinct rows to be meaningful')
  assert(run.players[0].row !== bottomRow, 'the fixture must catch array-order placement')

  const bossId = run.map.rows[run.map.rows.length - 1][0]
  const parked = { ...run, map: { ...run.map, position: run.map.rows[run.map.rows.length - 2][0] } }
  const boss = enterRoom(parked, bossId).combat.enemies[0]
  assertEqual(boss.row, topRow, 'the boss is kept beside the board, at the top row')

  const eliteRoom = Object.values(run.map.rooms).find((room) => room.kind === 'elite')
  const approach = Object.values(run.map.rooms).find((room) => room.exits.includes(eliteRoom?.id))
  assert(eliteRoom && approach, 'the generated map needs a reachable elite')
  const eliteRun = { ...run, map: { ...run.map, position: approach.id } }
  const elite = enterRoom(eliteRun, eliteRoom.id).combat.enemies.find((enemy) => enemy.uid === 'elite')
  assertEqual(elite.row, bottomRow, 'an elite is placed in the physical bottom row (p.11)')
})

check('HP board columns are read by party size', () => {
  const nob = ENEMIES.gremlin_nob
  assertEqual(startingHp(nob, 1), PRINTED_HP.gremlin_nob[0])
  assertEqual(startingHp(nob, 2), PRINTED_HP.gremlin_nob[1])
  assertEqual(startingHp(nob, 3), PRINTED_HP.gremlin_nob[2])
  assertEqual(startingHp(nob, 4), PRINTED_HP.gremlin_nob[3], 'four players use the fourth column')
  assertEqual(startingHp(nob, 5), PRINTED_HP.gremlin_nob[3], 'beyond four clamps to the last column')
  assertEqual(startingHp(nob, 0), PRINTED_HP.gremlin_nob[0], 'below one clamps to the first')
})

check('a boss room uses a physical boss definition', () => {
  const run = postNeowRun(4, [{ id: 'p1', name: 'Ironclad', character: 'ironclad' }])
  const bossId = run.map.rows[run.map.rows.length - 1][0]
  const parked = { ...run, map: { ...run.map, position: run.map.rows[run.map.rows.length - 2][0] } }
  const boss = enterRoom(parked, bossId).combat.enemies[0]

  const def = enemyDef(boss.defId)
  assert(def.isBoss, `${boss.defId} must be a boss definition`)
  assertEqual(boss.maxHp, startingHp(def, 1), 'the boss uses its printed solo HP')
  assert(boss.isBoss, 'and its runtime card is marked as a boss')
})

check('a player who chooses nothing is left alone', () => {
  const next = resolveCampfire(atCampfire(), { p1: { choice: 'rest' } })
  assertEqual(next.players[0].hp, 7, 'the player who rested heals')
  assertEqual(next.players[1].hp, 4, 'the one who did not is untouched')
})

check('losing a combat ends the run', () => {
  const run = postNeowRun(3, [{ id: 'p1', name: 'Ironclad', character: 'ironclad' }])
  const entered = enterRoom(run, roomChoices(run)[0].id)
  const lost = resolveCombat({ ...entered, combat: { ...entered.combat, phase: 'lost' } })
  assertEqual(lost.phase, 'defeat')
})

check('campaign run ids advance independently of the deterministic gameplay seed', () => {
  const party = [{ id: 'p1', name: 'Ironclad', character: 'ironclad' }]
  const first = postNeowRun(3, party)
  const finished = finishRun({ ...first, phase: 'defeat' })
  const second = postNeowRun(3, party, 0, finished.campaignProgress)
  assert(first.campaign.runId !== second.campaign.runId)
})

check('a mandatory Relic choice blocks campaign finalization', () => {
  const run = postNeowRun(30, [{ id: 'p1', name: 'Ironclad', character: 'ironclad' }])
  const pending = {
    ...run,
    phase: 'victory',
    players: run.players.map((player) => ({
      ...player,
      relics: [...player.relics, { defId: 'war_paint', spent: false, pending: true }],
    })),
  }
  assertEqual(finishRun(pending), pending)
})

check('the party may stop after Act II or decline unlocked Act IV', () => {
  const party = [
    { id: 'p1', name: 'Ironclad', character: 'ironclad' },
    { id: 'p2', name: 'Silent', character: 'silent' },
  ]
  const actTwo = postNeowRun(31, party)
  const stopped = finishRun({ ...actTwo, act: 2, phase: 'victory', campaign: { ...actTwo.campaign, bossesDefeated: 2, highestBossActDefeated: 2 } })
  assert(stopped.campaign.finalized)
  assertEqual(stopped.campaignProgress.highestAscension, 1)

  const unlocked = { ...createCampaignProgress(), actIV: 5 }
  const actThree = postNeowRun(32, party, 0, unlocked)
  const declined = finishRun({ ...actThree, act: 3, phase: 'victory', campaign: { ...actThree.campaign, bossesDefeated: 3, highestBossActDefeated: 3, keys: { ruby: true, sapphire: true, emerald: true } } })
  assert(declined.campaign.finalized)
})

check('Burning Elite Status cards return to their supply after combat', () => {
  const progress = { ...createCampaignProgress(), actIV: 5 }
  const base = postNeowRun(81, [{ id: 'p1', name: 'Ironclad', character: 'ironclad' }], 0, progress)
  const roomId = base.map.rows[0][0]
  const prepared = { ...base, map: { ...base.map, rooms: { ...base.map.rooms, [roomId]: { ...base.map.rooms[roomId], kind: 'elite', burning: true } } } }
  const entered = enterRoom(prepared, roomId)
  assertEqual(entered.players[0].deck.filter((card) => CARDS[card.defId]?.owner === 'status').length, 2)
  const cleared = resolveCombat({ ...entered, combat: { ...entered.combat, phase: 'won' } })
  assertEqual(cleared.players[0].deck.filter((card) => CARDS[card.defId]?.owner === 'status').length, 0)
})

check('an already-held Sapphire Key cannot discard another relic reward', () => {
  const progress = { ...createCampaignProgress(), actIV: 5 }
  let run = postNeowRun(811, [{ id: 'p1', name: 'Ironclad', character: 'ironclad' }], 0, progress)
  const room = roomChoices(run)[0]
  run.map.rooms[room.id] = { ...room, kind: 'treasure' }
  run.campaign.keys.sapphire = true
  run = enterRoom(run, room.id)
  assertEqual(chooseRelicReward(run, 'p1', 'sapphire'), run)
})

check('malformed Treasure decisions cannot discard a physical reward', () => {
  let run = postNeowRun(812, [{ id: 'p1', name: 'Ironclad', character: 'ironclad' }])
  const room = roomChoices(run)[0]
  run.map.rooms[room.id] = { ...room, kind: 'treasure' }
  run = enterRoom(run, room.id)
  assertEqual(chooseRelicReward(run, 'p1', 'forged'), run)
})


report('map and run')
