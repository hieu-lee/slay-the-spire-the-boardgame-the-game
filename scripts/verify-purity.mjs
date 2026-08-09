// The engine never mutates what it is given.
//
// Every state transition takes a state and returns one. Two things depend on
// that being literally true, and both fail silently if it is not:
//
//   - Illegal actions are signalled by returning the SAME reference. If a
//     function mutated its input on the way to deciding "no", the caller would
//     hold a corrupted state and be told nothing happened.
//   - The room layer snapshots the run for each seat. A function that reached
//     back into the previous state would rewrite history other clients had
//     already been sent.
//
// Checked by deep-comparing the argument against a copy taken before the call,
// rather than by reading the code — a fresh mutation is exactly the thing a
// human reviewer stops noticing.
import {
  advanceAct,
  cardNeedsEnemy,
  createRun,
  endPlayerTurn,
  enemyTurn,
  enterRoom,
  leaveRoom,
  moveTo,
  playCard,
  revealCardReward,
  resolveCampfire,
  resolveCardRewards,
  resolveCombat,
  roomChoices,
  startPlayerTurn,
} from '../src/game/state.ts'
import { CARDS } from '../src/game/cards.ts'
import { suite, check, assert, report } from './lib/harness.mjs'

/** Runs `call` and fails if it changed anything reachable from `input`. */
function unchanged(label, input, call) {
  const before = JSON.stringify(input)
  call()
  const after = JSON.stringify(input)
  if (before === after) return
  // Report the first differing path rather than two enormous blobs.
  let at = 0
  while (at < before.length && before[at] === after[at]) at++
  throw new Error(
    `${label} mutated its input near …${before.slice(Math.max(0, at - 90), at + 90)}` +
      `\n  became …${after.slice(Math.max(0, at - 90), at + 90)}`,
  )
}

const party = [
  { id: 'p1', name: 'Ann', character: 'ironclad' },
  { id: 'p2', name: 'Bo', character: 'silent' },
]

/** A run parked in its opening combat, with a hand dealt. */
function inCombat(seed = 4242) {
  const run = createRun(seed, party)
  return enterRoom(run, roomChoices(run)[0].id)
}

suite('purity')

check('the mutation detector actually detects mutation', () => {
  // Every check below passes today, so without this one a broken `unchanged`
  // would make the whole suite a green light that inspects nothing.
  const victim = { players: [{ hp: 10 }] }
  let caught = false
  try {
    unchanged('deliberate', victim, () => {
      victim.players[0].hp = 9
    })
  } catch {
    caught = true
  }
  assert(caught, 'unchanged() failed to notice a mutation')
})

check('createRun does not touch the party it is given', () => {
  const input = party.map((member) => ({ ...member }))
  const built = createRun(7, input)
  assert(
    built.players.length === input.length &&
      built.players.every((player, i) => player.id === input[i].id && player.character === input[i].character),
    'precondition: the run must actually be built from this party',
  )
  unchanged('createRun', input, () => createRun(7, input))
})

check('enterRoom leaves the run it was called on alone', () => {
  const run = createRun(11, party)
  const roomId = roomChoices(run)[0].id
  assert(enterRoom(run, roomId) !== run, 'precondition: this call must actually do something')
  unchanged('enterRoom', run, () => enterRoom(run, roomId))
})

check('playCard leaves the combat it was called on alone', () => {
  const run = inCombat()
  const combat = run.combat
  const card = combat.players[0].hand.find((held) => held.defId.startsWith('strike'))
  assert(card, 'precondition: a Strike should be in hand')
  const enemy = combat.enemies[0]
  assert(
    playCard(combat, 'p1', card.uid, { enemyUid: enemy.uid, playerId: 'p1' }) !== combat,
    'precondition: this play must actually be accepted',
  )
  unchanged('playCard', combat, () =>
    playCard(combat, 'p1', card.uid, { enemyUid: enemy.uid, playerId: 'p1' }),
  )
})

check('a REFUSED playCard leaves the combat alone too', () => {
  // The dangerous case: the engine decides "no" partway through and returns the
  // original reference. Anything it changed before deciding is now invisible
  // damage, because the caller has been told nothing happened.
  const run = inCombat()
  const combat = run.combat
  const card = combat.players[0].hand.find((held) => cardNeedsEnemy(CARDS[held.defId], combat.players[0]))
  assert(card, 'precondition: the hand needs a targeted card')
  unchanged('playCard (refused)', combat, () => {
    const result = playCard(combat, 'p1', card.uid, { enemyUid: null, playerId: 'p1' })
    assert(result === combat, 'precondition: this play should have been refused')
  })
})

check('endPlayerTurn leaves the combat it was called on alone', () => {
  const combat = inCombat().combat
  assert(endPlayerTurn(combat) !== combat, 'precondition: this call must actually do something')
  unchanged('endPlayerTurn', combat, () => endPlayerTurn(combat))
})

check('enemyTurn leaves the combat it was called on alone', () => {
  const combat = endPlayerTurn(inCombat().combat)
  assert(enemyTurn(combat) !== combat, 'precondition: this call must actually do something')
  unchanged('enemyTurn', combat, () => enemyTurn(combat))
})

check('startPlayerTurn leaves the combat it was called on alone', () => {
  const combat = enemyTurn(endPlayerTurn(inCombat().combat))
  assert(startPlayerTurn(combat) !== combat, 'precondition: this call must actually do something')
  unchanged('startPlayerTurn', combat, () => startPlayerTurn(combat))
})

check('resolveCombat leaves the run it was called on alone', () => {
  const run = inCombat()
  // Win it outright so the fold-back path is the one exercised.
  const won = { ...run, combat: { ...run.combat, phase: 'won' } }
  assert(resolveCombat(won) !== won, 'precondition: this call must actually do something')
  unchanged('resolveCombat', won, () => resolveCombat(won))
})

check('resolveCardRewards leaves the offer and reward stacks alone', () => {
  const run = inCombat()
  const hidden = resolveCombat({ ...run, combat: { ...run.combat, phase: 'won' } })
  const offered = hidden.rewards.reduce(
    (current, offer) => revealCardReward(current, offer.playerId),
    hidden,
  )
  const decisions = Object.fromEntries(offered.rewards.map((offer) => [offer.playerId, 0]))
  assert(resolveCardRewards(offered, decisions) !== offered, 'precondition: the reward resolves')
  unchanged('revealCardReward', hidden, () => revealCardReward(hidden, hidden.rewards[0].playerId))
  unchanged('resolveCardRewards', offered, () => resolveCardRewards(offered, decisions))
})

check('moveTo leaves the map it was called on alone', () => {
  const run = createRun(21, party)
  const roomId = roomChoices(run)[0].id
  assert(moveTo(run.map, roomId) !== run.map, 'precondition: this call must actually do something')
  unchanged('moveTo', run.map, () => moveTo(run.map, roomId))
})

check('leaveRoom leaves the run it was called on alone', () => {
  // Parked in a room first. A fresh run is on the MAP, where leaveRoom hits
  // its guard and returns before executing a line — so the check passed
  // whatever the body did.
  const run = createRun(31, party)
  const parked = { ...run, phase: 'room' }
  assert(leaveRoom(parked) !== parked, 'precondition: this call must actually do something')
  unchanged('leaveRoom', parked, () => leaveRoom(parked))
})

check('advanceAct leaves the run it was called on alone', () => {
  // It needs BOTH a victory and a finished act; with only the phase set it
  // returns early and the check inspects nothing.
  const run = createRun(31, party)
  const boss = Object.values(run.map.rooms).find((room) => room.kind === 'boss')
  assert(boss, 'precondition: the act should end at a boss')
  const won = {
    ...run,
    phase: 'victory',
    map: {
      ...run.map,
      position: boss.id,
      rooms: { ...run.map.rooms, [boss.id]: { ...boss, visited: true } },
    },
  }
  assert(advanceAct(won) !== won, 'precondition: this call must actually do something')
  unchanged('advanceAct', won, () => advanceAct(won))
})

check('resolveCampfire leaves the run it was called on alone', () => {
  const run = createRun(41, party)
  const campfire = Object.values(run.map.rooms).find((room) => room.kind === 'campfire')
  assert(campfire, 'precondition: the act should contain a campfire')
  const parked = {
    ...run,
    phase: 'room',
    map: { ...run.map, position: campfire.id },
  }
  const target = parked.players[0].deck.find((card) => !card.upgraded)
  const choices = { p1: { choice: 'smith', cardUid: target.uid }, p2: { choice: 'rest' } }
  assert(resolveCampfire(parked, choices) !== parked, 'precondition: this call must do something')
  unchanged('resolveCampfire', parked, () => resolveCampfire(parked, choices))
})

// Refusals are the dangerous half: the function decides "no" and hands back the
// SAME reference, so anything it changed first is invisible damage the caller
// is told nothing about. Only one of these paths was covered.
check('every way playCard can refuse leaves the combat untouched', () => {
  const run = inCombat()
  const combat = run.combat
  const held = combat.players[0].hand[0]
  const strike = combat.players[0].hand.find((card) => card.defId.startsWith('strike'))
  const enemyUid = combat.enemies[0].uid

  // No SHIPPED card draws before it charges -- an architecture check forbids it,
  // because the UI cannot nominate a card that has not been dealt yet. A fixture
  // is the only way to reach the refuse-after-resolving path, which is exactly
  // the path nothing was covering.
  CARDS.fixture_draw_then_charge = {
    id: 'fixture_draw_then_charge',
    name: 'Fixture Draw Then Charge',
    owner: 'ironclad',
    type: 'skill',
    rarity: 'common',
    cost: 1,
    effects: [
      { kind: 'draw', amount: 2 },
      { kind: 'discard', amount: 1 },
    ],
  }
  const drawThenCharge = { uid: 'purity-draw-charge', defId: 'fixture_draw_then_charge', upgraded: false }

  const REFUSALS = [
    {
      why: 'the wrong phase',
      state: { ...combat, phase: 'enemy' },
      call: (state) => playCard(state, 'p1', held.uid, { enemyUid, playerId: 'p1' }),
    },
    {
      why: 'a card that is not in hand',
      state: combat,
      call: (state) => playCard(state, 'p1', 'not-a-card', { enemyUid, playerId: 'p1' }),
    },
    {
      why: 'a player who is not in the combat',
      state: combat,
      call: (state) => playCard(state, 'nobody', held.uid, { enemyUid, playerId: 'p1' }),
    },
    {
      why: 'no energy',
      state: { ...combat, players: combat.players.map((p, i) => (i === 0 ? { ...p, energy: 0 } : p)) },
      call: (state) => playCard(state, 'p1', held.uid, { enemyUid, playerId: 'p1' }),
    },
    {
      why: 'an attack with no target',
      state: combat,
      call: (state) => playCard(state, 'p1', strike.uid, { enemyUid: null, playerId: 'p1' }),
    },
    {
      // The one refusal that matters here. Every other entry returns BEFORE the
      // state is cloned, so none of them can detect a leak -- they were five
      // checks on a path that does nothing. This card is resolved in full, and
      // only then refused because its discard went unpaid, so anything the
      // resolution touched outside the clone escapes with it. An engine that
      // shares the caller's RNG object with the clone passes all fourteen
      // suites without this, and every shuffle for the rest of the run desyncs.
      why: 'an unpaid discard cost, after the card has already resolved',
      // The draw pile is deliberately EMPTY and the discard pile full, so the
      // draw must reshuffle -- which is the only thing in a card play that
      // turns the RNG. Without a reshuffle the leak is invisible: a shared RNG
      // object that is never advanced looks identical to a copied one.
      state: {
        ...combat,
        players: combat.players.map((player, index) =>
          index === 0
            ? {
                ...player,
                hand: [...player.hand, drawThenCharge],
                energy: 3,
                draw: [],
                discard: [...player.discard, ...player.draw],
              }
            : player,
        ),
      },
      call: (state) =>
        playCard(state, 'p1', drawThenCharge.uid, {
          enemyUid,
          playerId: 'p1',
          discardUids: [],
        }),
    },
  ]

  for (const { why, state, call } of REFUSALS) {
    assert(call(state) === state, `precondition: ${why} must actually be refused`)
    unchanged(`playCard refused for ${why}`, state, () => call(state))
  }
})

check('every way a turn step can refuse leaves the combat untouched', () => {
  const combat = inCombat().combat
  const STEPS = [
    { why: 'startPlayerTurn mid-turn', state: combat, call: startPlayerTurn },
    { why: 'endPlayerTurn outside the Player Turn', state: { ...combat, phase: 'enemy' }, call: endPlayerTurn },
    { why: 'enemyTurn outside the Enemy Turn', state: combat, call: enemyTurn },
  ]
  for (const { why, state, call } of STEPS) {
    assert(call(state) === state, `precondition: ${why} must actually be refused`)
    unchanged(why, state, () => call(state))
  }
})

report('purity')
