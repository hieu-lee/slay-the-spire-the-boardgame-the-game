import { generateMap, availableMoves, moveTo, currentRoom, isActComplete, ACT_SHAPE } from '../src/game/map.ts'
import { createRng } from '../src/game/rng.ts'
import { suite, check, assert, assertEqual, assertDeepEqual, report } from './lib/harness.mjs'

const build = (seed = 1, act = 1) => generateMap(createRng(seed), act)

suite('map')

check('the same seed always generates the same map', () => {
  assertDeepEqual(build(99), build(99), 'map generation must be reproducible from its seed')
})

check('different seeds generate different maps', () => {
  const a = JSON.stringify(build(1))
  const b = JSON.stringify(build(2))
  assert(a !== b, 'two seeds should not produce identical maps')
})

// p.9: the bottom row is a fixed encounter and the boss sits at the top.
check('the map opens on a single encounter and ends at the boss', () => {
  const map = build()
  const first = map.rows[0]
  assertEqual(first.length, 1, 'the party starts at one fixed room')
  assertEqual(map.rooms[first[0]].kind, 'encounter', 'and it is an encounter')

  const last = map.rows[map.rows.length - 1]
  assertEqual(last.length, 1, 'the boss stands alone')
  assertEqual(map.rooms[last[0]].kind, 'boss')
})

// p.9: the row below the boss on the Act I map is a row of campfires.
check('the row below the boss is all campfires', () => {
  const map = build()
  const campfireRow = map.rows[map.rows.length - 2]
  for (const id of campfireRow) {
    assertEqual(map.rooms[id].kind, 'campfire', 'every room before the boss should be a campfire')
  }
})

check('the map has the expected number of rows', () => {
  const map = build()
  // opening encounter + middle rows + campfire row + boss
  assertEqual(map.rows.length, ACT_SHAPE.middleRows + 3)
})

check('every room is reachable from the row below it', () => {
  for (let seed = 0; seed < 40; seed++) {
    const map = build(seed)
    for (let row = 1; row < map.rows.length; row++) {
      const reached = new Set(map.rows[row - 1].flatMap((id) => map.rooms[id].exits))
      for (const id of map.rows[row]) {
        assert(reached.has(id), `seed ${seed}: ${id} on row ${row} has nothing leading to it`)
      }
    }
  }
})

check('every room below the top has somewhere to go', () => {
  for (let seed = 0; seed < 40; seed++) {
    const map = build(seed)
    for (let row = 0; row < map.rows.length - 1; row++) {
      for (const id of map.rows[row]) {
        assert(map.rooms[id].exits.length > 0, `seed ${seed}: ${id} is a dead end`)
      }
    }
  }
})

check('exits only ever point at the row directly above', () => {
  for (let seed = 0; seed < 20; seed++) {
    const map = build(seed)
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
  for (let seed = 0; seed < 25; seed++) {
    let map = build(seed)
    let steps = 0
    while (!isActComplete(map) && steps < 50) {
      const moves = availableMoves(map)
      assert(moves.length > 0, `seed ${seed}: stranded at ${map.position} with no moves`)
      map = moveTo(map, moves[0].id)
      steps++
    }
    assert(isActComplete(map), `seed ${seed}: never reached the boss in ${steps} steps`)
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

// A run crashed at runtime because the encounter pool named an enemy that was
// never defined. Nothing caught it until the browser threw.
import { ENEMIES, enemyDef, startingHp } from '../src/game/enemies.ts'
import {
  advanceAct,
  createRun,
  enterRoom,
  resolveCampfire,
  roomChoices,
  resolveCombat,
  MAX_HP,
} from '../src/game/run.ts'
import { RELICS, POTIONS, STARTING_RELIC } from '../src/game/relics.ts'

suite('run')

check('every enemy the run can spawn actually exists', () => {
  // Reach into the module's pools by walking a lot of runs and spawning rooms.
  for (let seed = 0; seed < 30; seed++) {
    let run = createRun(seed, [
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

check('every enemy summon names an enemy that exists', () => {
  for (const def of Object.values(ENEMIES)) {
    for (const summoned of def.summons ?? []) {
      assert(ENEMIES[summoned] !== undefined, `${def.id} summons unknown enemy "${summoned}"`)
    }
  }
})

check('every enemy has a sane HP track', () => {
  for (const def of Object.values(ENEMIES)) {
    assertEqual(def.hpByPlayers.length, 4, `${def.id} needs an HP value per player count`)
    for (const hp of def.hpByPlayers) {
      assert(hp > 0, `${def.id} has a non-positive HP entry`)
    }
    // Elites use the HP board, which scales; ordinary enemies do not.
    if (def.elite) {
      assert(
        def.hpByPlayers[3] > def.hpByPlayers[0],
        `${def.id} is an elite so its HP should scale with the party`,
      )
    }
  }
})

check('a run starts every character at the HP their board prints', () => {
  const run = createRun(1, [
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
  const solo = createRun(1, [{ id: 'p1', name: 'Ironclad', character: 'ironclad' }])
  assertEqual(solo.players[0].gold, 2, 'p.4 step 12 grants gold, not potions')
  assert(
    solo.players[0].relics.some((relic) => relic.defId === 'loaded_die'),
    'solo also gets the Loaded Die relic (p.4 step 12)',
  )
  assertEqual(solo.players[0].relics.length, 2, 'the starting relic plus the Loaded Die')

  const duo = createRun(1, [
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
    assert(def.effects.length > 0, `${id} should actually do something`)
  }
})

check('entering a room is refused unless it is reachable', () => {
  const run = createRun(7, [{ id: 'p1', name: 'Ironclad', character: 'ironclad' }])
  assert(enterRoom(run, 'nowhere') === run, 'an unknown room must return the same reference')
  const far = run.map.rows[run.map.rows.length - 1][0]
  assert(enterRoom(run, far) === run, 'jumping to the boss must be refused')
})

check('the first room starts a combat with one enemy per player', () => {
  const run = createRun(3, [
    { id: 'p1', name: 'Ironclad', character: 'ironclad' },
    { id: 'p2', name: 'Silent', character: 'silent' },
  ])
  const entered = enterRoom(run, roomChoices(run)[0].id)
  assertEqual(entered.phase, 'combat')
  assertEqual(entered.combat.enemies.length, 2, 'one enemy per player row (p.10)')
  assertEqual(new Set(entered.combat.enemies.map((e) => e.row)).size, 2, 'one per row')
})

check('winning a combat carries HP forward into the run', () => {
  const run = createRun(3, [{ id: 'p1', name: 'Ironclad', character: 'ironclad' }])
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
  // An exact figure, not "more than before": a loose comparison lets the payout
  // drift to any positive number without a test noticing.
  assertEqual(after.players[0].gold, run.players[0].gold + 1, 'a won fight pays exactly 1 gold')
})

check('advancing an act heals the party and builds a new map', () => {
  const run = createRun(9, [
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
})

check('Ascension 6 heals 4 instead of to full', () => {
  const run = createRun(9, [{ id: 'p1', name: 'Ironclad', character: 'ironclad' }], 6)
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

check('a boss room stands up a single boss that acts last', () => {
  const run = createRun(4, [
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
  // Find a seed whose first reachable room from the start is an elite.
  let found = false
  for (let seed = 0; seed < 60 && !found; seed++) {
    const run = createRun(seed, [
      { id: 'p1', name: 'Ironclad', character: 'ironclad' },
      { id: 'p2', name: 'Silent', character: 'silent' },
    ])
    const start = enterRoom(run, roomChoices(run)[0].id)
    const afterFight = resolveCombat({
      ...start,
      combat: { ...start.combat, phase: 'won', enemies: start.combat.enemies.map((e) => ({ ...e, dead: true })) },
    })
    for (const choice of roomChoices(afterFight)) {
      if (choice.kind !== 'elite') continue
      const elite = enterRoom(afterFight, choice.id)
      assertEqual(elite.combat.enemies.length, 1, 'an elite is placed alone in the bottom row (p.11)')
      assert(!elite.combat.enemies[0].isBoss, 'an elite is not a boss')
      found = true
      break
    }
  }
  assert(found, 'expected at least one elite room within 60 seeds')
})

// Transcribed from the enemy card scans. Comparing a definition to itself is a
// tautology, so the numbers are pinned here against the printed cards instead.
const PRINTED_HP = {
  cultist: [9, 9, 9, 9],
  jaw_worm: [10, 10, 10, 10],
  green_louse: [3, 3, 3, 3],
  red_louse: [4, 4, 4, 4],
  spike_slime: [5, 5, 5, 5],
  fungi_beast: [6, 6, 6, 6],
  blue_slaver: [7, 7, 7, 7],
  gremlin_nob: [14, 28, 42, 56],
  lagavulin: [22, 44, 66, 88],
}

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
  const run = createRun(3, [{ id: 'p1', name: 'Ironclad', character: 'ironclad' }])
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
  const run = createRun(seed, [
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

check('a campfire returns the party to the map', () => {
  const next = resolveCampfire(atCampfire(), { p1: { choice: 'rest' }, p2: { choice: 'rest' } })
  assertEqual(next.phase, 'map')
})

check('resolving a campfire anywhere else is refused', () => {
  const run = createRun(11, [{ id: 'p1', name: 'Ironclad', character: 'ironclad' }])
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
  const run = createRun(12, [
    { id: 'p1', name: 'Ironclad', character: 'ironclad' },
    { id: 'p2', name: 'Silent', character: 'silent' },
    { id: 'p3', name: 'Defect', character: 'defect' },
    { id: 'p4', name: 'Watcher', character: 'watcher' },
  ])
  const entered = enterRoom(run, roomChoices(run)[0].id)
  assertEqual(entered.combat.enemies.length, 4, 'one enemy per player (p.10)')
  assertEqual(new Set(entered.combat.enemies.map((e) => e.row)).size, 4, 'each in its own row')
  for (const spawned of entered.combat.enemies) {
    assertEqual(
      spawned.maxHp,
      PRINTED_HP[spawned.defId][3],
      `${spawned.defId} should use the four-player column of its HP board`,
    )
  }
})

check('an elite stands in the bottom row, a boss in the top', () => {
  const party = [
    { id: 'p1', name: 'Ironclad', character: 'ironclad' },
    { id: 'p2', name: 'Silent', character: 'silent' },
    { id: 'p3', name: 'Defect', character: 'defect' },
  ]
  const run = createRun(21, party)
  const bottomRow = run.players[0].row
  const topRow = run.players[run.players.length - 1].row
  assert(bottomRow !== topRow, 'the fixture needs distinct rows to be meaningful')

  const bossId = run.map.rows[run.map.rows.length - 1][0]
  const parked = { ...run, map: { ...run.map, position: run.map.rows[run.map.rows.length - 2][0] } }
  const boss = enterRoom(parked, bossId).combat.enemies[0]
  assertEqual(boss.row, topRow, 'the boss is kept beside the board, at the top row')

  // Find an elite room and check it is placed in the bottom row (p.11).
  let checked = false
  for (let seed = 0; seed < 60 && !checked; seed++) {
    const attempt = createRun(seed, party)
    const first = enterRoom(attempt, roomChoices(attempt)[0].id)
    const cleared = resolveCombat({
      ...first,
      combat: { ...first.combat, phase: 'won', enemies: first.combat.enemies.map((e) => ({ ...e, dead: true })) },
    })
    for (const choice of roomChoices(cleared)) {
      if (choice.kind !== 'elite') continue
      const elite = enterRoom(cleared, choice.id).combat.enemies[0]
      assertEqual(elite.row, cleared.players[0].row, 'an elite is placed in the bottom row (p.11)')
      checked = true
      break
    }
  }
  assert(checked, 'expected an elite room within 60 seeds')
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

check('a boss is the toughest thing the run can put up', () => {
  const run = createRun(4, [{ id: 'p1', name: 'Ironclad', character: 'ironclad' }])
  const bossId = run.map.rows[run.map.rows.length - 1][0]
  const parked = { ...run, map: { ...run.map, position: run.map.rows[run.map.rows.length - 2][0] } }
  const boss = enterRoom(parked, bossId).combat.enemies[0]

  // Whatever stands in as the boss, it must be at least as tough as every
  // elite the run can spawn as an ordinary elite room.
  const eliteHp = Object.values(ENEMIES)
    .filter((def) => def.elite)
    .map((def) => def.hpByPlayers[0])
  assert(
    boss.maxHp >= Math.max(...eliteHp),
    `the boss (${boss.defId}, ${boss.maxHp} HP) should not be weaker than an elite`,
  )
  assert(boss.isBoss, 'and must be marked as a boss')
})

check('a player who chooses nothing is left alone', () => {
  const next = resolveCampfire(atCampfire(), { p1: { choice: 'rest' } })
  assertEqual(next.players[0].hp, 7, 'the player who rested heals')
  assertEqual(next.players[1].hp, 4, 'the one who did not is untouched')
})

check('losing a combat ends the run', () => {
  const run = createRun(3, [{ id: 'p1', name: 'Ironclad', character: 'ironclad' }])
  const entered = enterRoom(run, roomChoices(run)[0].id)
  const lost = resolveCombat({ ...entered, combat: { ...entered.combat, phase: 'lost' } })
  assertEqual(lost.phase, 'defeat')
})

report('map and run')
