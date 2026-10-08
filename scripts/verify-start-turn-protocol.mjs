// Co-op Start-of-Turn window: every seat must always be able to finish it, and a
// submit built from the latest snapshot must never be rejected as stale.
import { createStore, createRoom, joinRoom, startRun, apply, snapshotFor, markDisconnected } from './lib/rooms.mjs'
import { createCombat } from '../src/game/combat/create.ts'
import { enemyDef, startingHp } from '../src/game/enemies.ts'
import { suite, check, assert, assertEqual, report } from './lib/harness.mjs'

suite('start-of-turn protocol')

const enemy = (uid, defId, row, count, over = {}) => {
  const hp = startingHp(enemyDef(defId), count)
  return { uid, defId, row, isBoss: false, hp, maxHp: hp, block: 0, strength: 0, vulnerable: 0, weak: 0,
    poison: 0, goldReward: 0, cardReward: null, actionIndex: 0, abilityUsed: false, dead: false, phase: 0, ...over }
}
const card = (uid, defId) => ({ uid, defId, upgraded: false })
const blank = (id) => ({ id, shivEnemyUids: [], evokeSlots: [], evokeEnemyUids: [] })

function makeRoom(characters, setups, enemies, { die } = {}) {
  const store = createStore({ file: null })
  const room = createRoom(store, { code: 'PROTO1' })
  characters.forEach((character, index) => joinRoom(room, { name: `p${index}`, character }))
  startRun(room, room.seats[0].token, { seed: 7 })
  const players = room.run.players.map((player, index) => {
    const copy = structuredClone(player)
    copy.powers = []
    copy.relics = copy.relics.filter((relic) => relic.defId.endsWith('starting_relic'))
    copy.hand = []
    setups[index]?.(copy)
    return copy
  })
  const combat = createCombat(room.run.rng, players, enemies(characters.length), 'protocol')
  combat.turn = 1
  combat.phase = 'roundEnd'
  room.run = { ...room.run, phase: 'combat', combat }
  apply(room, room.seats[0].token, { kind: 'startTurn' })
  if (die !== undefined) {
    Object.assign(room.run.combat, { phase: 'start', die, startTurnProgress: undefined, startTurnStage: 'effects',
      pendingTriggers: [], pendingDieRelicChoices: [], powerTriggersUsedThisTurn: [] })
    for (const key of ['startTurnCombatId', 'startTurnOrder', 'startTurnEnemyTargets', 'startTurnChoices',
      'startTurnRequired', 'startTurnReady', 'startTurnStagedTriggers', 'startTurnPostRollLock']) room[key] = undefined
    snapshotFor(room, room.seats[0].token)
  }
  return room
}
const token = (room, index) => room.seats[index].token

/** What the UI sends: the seat's own picks over the latest snapshot's staged choices. */
function submit(room, index, picks = {}) {
  const snapshot = snapshotFor(room, token(room, index))
  const choices = snapshot.startTurnAbilities.map((ability) => {
    const staged = snapshot.startTurnChoices?.find((choice) => choice.id === ability.id)
    const choice = { ...blank(ability.id), ...staged }
    if (snapshot.startTurnEnemyTargets?.[ability.id]) choice.enemyUid = snapshot.startTurnEnemyTargets[ability.id]
    if (ability.guardianModeShift) choice.guardianModeShift = false
    return { ...choice, ...picks[ability.id] }
  })
  return apply(room, token(room, index), { kind: 'resolveStartTurn', choices })
}

check('a non-coordinator may stage overflow Shiv targets before the shared order is committed', () => {
  const room = makeRoom(['guardian', 'defect', 'silent'], [
    null,
    (player) => { player.powers = [card('ml', 'machine_learning'), card('fu', 'fusion')] },
    (player) => { player.shivs = 5; player.powers = [card('ib', 'infinite_blades'), card('ib2', 'infinite_blades')] },
  ], (count) => [enemy('e0', 'cultist', 0, count), enemy('e1', 'cultist', 1, count)])
  assert(snapshotFor(room, token(room, 2)).startTurnOrderPending, 'fixture must leave the order pending')
  const snapshot = snapshotFor(room, token(room, 2))
  const picks = Object.fromEntries(snapshot.startTurnAbilities
    .filter((ability) => ability.id.startsWith('p3/power:ib')).map((ability) => [ability.id, { shivEnemyUids: ['e0'] }]))
  submit(room, 2, picks)
  assert(room.startTurnChoices?.some((choice) => choice.id.startsWith('p3/power:ib') && choice.shivEnemyUids[0] === 'e0'),
    'the staged Shiv targets were not kept')
})

check('a seat that disconnects mid-window never strands the last submitter on a private prompt', () => {
  const room = makeRoom(['guardian', 'silent', 'ironclad'], [
    null,
    (player) => { player.powers = [card('tt', 'tools_of_the_trade'), card('nf', 'noxious_fumes')] },
    (player) => { player.relics.push({ defId: 'stone_calendar', spent: false }) },
  ], (count) => [enemy('e0', 'cultist', 0, count), enemy('e1', 'cultist', 1, count), enemy('e2', 'cultist', 2, count)], { die: 4 })
  submit(room, 0, { 'p2/power:nf': { enemyUid: 'e0' } })
  markDisconnected(room, token(room, 1))
  submit(room, 2, { 'p3/relic:0:0': { enemyUid: 'e1' } })
  assert(room.run.combat.startTurnProgress?.discard === undefined, 'the absent owner kept a private discard prompt')
  assertEqual(room.run.combat.phase, 'player', 'the turn never reached the player phase')
})

check('the quorum resolves when the coordinator is the last ready seat and every other owner is away', () => {
  const room = makeRoom(['guardian', 'silent'], [
    null, (player) => { player.powers = [card('nf', 'noxious_fumes'), card('tt', 'tools_of_the_trade')] },
  ], (count) => [enemy('e0', 'cultist', 0, count), enemy('e1', 'cultist', 1, count), enemy('e2', 'cultist', 1, count)])
  markDisconnected(room, token(room, 1))
  submit(room, 0)
  assertEqual(room.run.combat.phase, 'player', 'every required seat was ready but the combat stayed in start')
})

check('a staged target killed by an earlier ordered ability reopens its owner instead of failing the last submitter', () => {
  const room = makeRoom(['silent', 'ironclad'], [
    (player) => { player.relics.push({ defId: 'stone_calendar', spent: false }) },
    (player) => { player.relics.push({ defId: 'stone_calendar', spent: false }) },
  ], (count) => [enemy('e0', 'cultist', 0, count, { hp: 3 }), enemy('e1', 'cultist', 1, count), enemy('e2', 'cultist', 1, count)], { die: 4 })
  const own = (index) => {
    const abilities = snapshotFor(room, token(room, index)).startTurnAbilities
    return Object.fromEntries(abilities.filter((ability) => ability.playerId === `p${index + 1}` && ability.targets)
      .map((ability) => [ability.id, { enemyUid: ability.targets.some((target) => target.uid === 'e0') ? 'e0' : ability.targets[0].uid }]))
  }
  for (let attempt = 0; attempt < 6 && room.run.combat.phase === 'start'; attempt += 1) {
    submit(room, attempt % 2 === 0 ? 1 : 0, own(attempt % 2 === 0 ? 1 : 0))
  }
  assertEqual(room.run.combat.phase, 'player', 'a stale staged target stalled the window')
})

check('Shiv overflow prompts after a forced Mayhem card do not block the earlier seats', () => {
  const room = makeRoom(['ironclad', 'silent'], [
    (player) => { player.powers = [card('mh', 'mayhem')]; player.relics = [] },
    (player) => { player.shivs = 5; player.powers = [card('ib', 'infinite_blades')] },
  ], (count) => [enemy('e0', 'cultist', 0, count), enemy('e1', 'cultist', 1, count)])
  submit(room, 1)
  submit(room, 0)
  const forced = room.run.combat.startTurnProgress?.forcedCard
  assert(forced, 'Mayhem should have forced a card to be played')
})

check('a Noxious Fumes pick survives another owner disconnecting before the window settles', () => {
  const room = makeRoom(['silent', 'defect'], [
    (player) => { player.powers = [card('nf', 'noxious_fumes')] },
    (player) => { player.powers = [card('st', 'storm')]; player.orbs = ['lightning', 'frost', 'dark'] },
  ], (count) => [enemy('e0', 'cultist', 0, count), enemy('e1', 'cultist', 1, count), enemy('e2', 'cultist', 2, count)])
  markDisconnected(room, token(room, 1))
  submit(room, 0, { 'p1/power:nf': { enemyUid: 'e2' } })
  assertEqual(room.run.combat.phase, 'player')
  assertEqual(room.run.combat.enemies.find((target) => target.uid === 'e2').poison, 1, 'Fumes hit the default target')
  assertEqual(room.run.combat.enemies.find((target) => target.uid === 'e0').poison, 0, 'Fumes ignored the owner\'s pick')
})

check('a coordinator whose staged picks leave Noxious Fumes one target still resolves the window', () => {
  const room = makeRoom(['silent', 'ironclad'], [
    (player) => { player.shivs = 5; player.powers = [card('ib', 'infinite_blades'), card('nf', 'noxious_fumes')] },
    (player) => { player.relics.push({ defId: 'stone_calendar', spent: false }) },
  ], (count) => [enemy('e0', 'cultist', 0, count, { hp: 1 }), enemy('e1', 'cultist', 1, count)], { die: 4 })
  const snapshot = snapshotFor(room, token(room, 0))
  assert(snapshot.startTurnOrderPending, 'fixture must leave the order to the coordinator')
  submit(room, 0, { 'p1/power:ib': { shivEnemyUids: ['e0'] } })
  submit(room, 1, { 'p2/relic:0:0': { enemyUid: 'e1' } })
  for (let attempt = 0; attempt < 4 && room.run.combat.phase === 'start'; attempt += 1) submit(room, attempt % 2)
  assertEqual(room.run.combat.phase, 'player', 'the window never resolved')
})

check('a seat the server readied with fallback picks while it was away gets its decision back on return', () => {
  const room = makeRoom(['ironclad', 'silent'], [
    (player) => { player.relics.push({ defId: 'stone_calendar', spent: false }) },
    (player) => { player.relics.push({ defId: 'stone_calendar', spent: false }) },
  ], (count) => [enemy('e0', 'cultist', 0, count), enemy('e1', 'cultist', 1, count), enemy('e2', 'cultist', 2, count)], { die: 4 })
  markDisconnected(room, token(room, 1))
  assert(snapshotFor(room, token(room, 0)).startTurnDecided.includes('p2'), 'the absent seat should be readied with fallback picks')
  joinRoom(room, { token: token(room, 1) })
  assert(!snapshotFor(room, token(room, 1)).startTurnDecided.includes('p2'),
    'the returning seat stayed decided with no button or prompt')
  submit(room, 1, { 'p2/relic:0:0': { enemyUid: 'e1' } })
  submit(room, 0, { 'p1/relic:0:0': { enemyUid: 'e2' } })
  // Changing a pick reopens everyone, so the returning seat confirms once more.
  submit(room, 1)
  assertEqual(room.run.combat.phase, 'player')
})

report('start-of-turn protocol')
