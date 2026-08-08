import {
  createCombat,
  endPlayerTurn,
  livingEnemies,
  playCard,
  resolveEnemyTargets,
  startPlayerTurn,
} from '../src/game/combat.ts'
import { CARDS, STARTER_DECKS } from '../src/game/cards.ts'
import { createRng } from '../src/game/rng.ts'
import { suite, check, assert, assertEqual, report } from './lib/harness.mjs'

let uid = 0
const instance = (defId, upgraded = false) => ({ uid: `c${uid++}`, defId, upgraded })

function makePlayer(over = {}) {
  return {
    id: 'p1',
    name: 'Ironclad',
    character: 'ironclad',
    row: 0,
    hp: 10,
    maxHp: 10,
    block: 0,
    energy: 3,
    deck: [],
    draw: [],
    hand: [],
    discard: [],
    exhaust: [],
    powers: [],
    gold: 0,
    relics: [],
    potions: [],
    cardRewards: [],
    rareRewards: [],
    strength: 0,
    vulnerable: 0,
    weak: 0,
    shivs: 0,
    miracles: 0,
    stance: 'neutral',
    orbs: [null, null, null],
    dead: false,
    ...over,
  }
}

function makeEnemy(over = {}) {
  return {
    uid: 'e1',
    defId: 'cultist',
    row: 0,
    isBoss: false,
    hp: 6,
    maxHp: 6,
    block: 0,
    strength: 0,
    vulnerable: 0,
    weak: 0,
    poison: 0,
    actionIndex: 0,
    dead: false,
    ...over,
  }
}

const combat = (players, enemies) => createCombat(createRng(42), players, enemies)

suite('combat')

check('playing Strike damages the chosen enemy', () => {
  const strike = instance('strike_ironclad')
  const state = combat([makePlayer({ hand: [strike] })], [makeEnemy()])
  const next = playCard(state, 'p1', strike.uid, { enemyUid: 'e1', playerId: null })
  assertEqual(next.enemies[0].hp, 5, 'Strike deals 1 damage')
  assertEqual(next.players[0].energy, 2, 'Strike costs 1 energy')
  assertEqual(next.players[0].hand.length, 0, 'the card leaves hand')
  assertEqual(next.players[0].discard.length, 1, 'and lands in the discard pile')
})

check('an illegal play returns the very same state reference', () => {
  const strike = instance('strike_ironclad')
  const state = combat([makePlayer({ hand: [strike], energy: 0 })], [makeEnemy()])
  assert(
    playCard(state, 'p1', strike.uid, { enemyUid: 'e1', playerId: null }) === state,
    'not enough energy must return the identical reference, which is how illegality is signalled',
  )
  assert(playCard(state, 'p1', 'nope', { enemyUid: 'e1', playerId: null }) === state, 'unknown card')
  assert(playCard(state, 'ghost', strike.uid, { enemyUid: 'e1', playerId: null }) === state, 'unknown player')
})

check('playing a card never mutates the state handed in', () => {
  const strike = instance('strike_ironclad')
  const state = combat([makePlayer({ hand: [strike] })], [makeEnemy()])
  const before = JSON.stringify(state)
  playCard(state, 'p1', strike.uid, { enemyUid: 'e1', playerId: null })
  assertEqual(JSON.stringify(state), before, 'playCard must return a new state, not edit the old one')
})

// Bash reads "2 damage, apply Vulnerable" — the Vulnerable lands after the hit,
// so it must NOT double Bash's own damage.
check('Bash applies Vulnerable after its own hit resolves', () => {
  const bash = instance('bash')
  const state = combat([makePlayer({ hand: [bash] })], [makeEnemy({ hp: 10 })])
  const next = playCard(state, 'p1', bash.uid, { enemyUid: 'e1', playerId: null })
  assertEqual(next.enemies[0].hp, 8, 'Bash deals its printed 2, undoubled by the Vulnerable it applies')
  assertEqual(next.enemies[0].vulnerable, 1, 'and leaves one Vulnerable token behind')
})

check('a hit into an already Vulnerable enemy doubles and spends one token', () => {
  const strike = instance('strike_ironclad')
  const state = combat([makePlayer({ hand: [strike] })], [makeEnemy({ hp: 10, vulnerable: 2 })])
  const next = playCard(state, 'p1', strike.uid, { enemyUid: 'e1', playerId: null })
  assertEqual(next.enemies[0].hp, 8, '1 damage doubles to 2')
  assertEqual(next.enemies[0].vulnerable, 1, 'exactly one Vulnerable token is removed')
})

check('enemy Block absorbs damage before HP', () => {
  const strike = instance('strike_ironclad', true)
  const state = combat([makePlayer({ hand: [strike] })], [makeEnemy({ hp: 6, block: 1 })])
  const next = playCard(state, 'p1', strike.uid, { enemyUid: 'e1', playerId: null })
  assertEqual(next.enemies[0].block, 0, 'Block is spent absorbing')
  assertEqual(next.enemies[0].hp, 5, 'Strike+ deals 2, one absorbed by Block')
})

check('an enemy reduced to zero HP dies and combat is won', () => {
  const strike = instance('strike_ironclad')
  const state = combat([makePlayer({ hand: [strike] })], [makeEnemy({ hp: 1 })])
  const next = playCard(state, 'p1', strike.uid, { enemyUid: 'e1', playerId: null })
  assert(next.enemies[0].dead, 'the enemy should be dead')
  assertEqual(next.phase, 'won', 'combat ends when every enemy is dead')
  assertEqual(livingEnemies(next).length, 0, 'no enemy should remain standing')
})

// Deck composition is data, and data drifts silently. These are the counts
// printed in the rulebook (p.5-6).
check('every starter deck has the composition the rulebook prints', () => {
  const count = (deck, id) => deck.filter((card) => card === id).length
  const expected = {
    ironclad: { size: 10, strike: 5, defend: 4, extras: ['bash'] },
    silent: { size: 12, strike: 5, defend: 5, extras: ['neutralize', 'survivor'] },
    defect: { size: 10, strike: 4, defend: 4, extras: ['zap', 'dual_cast'] },
    watcher: { size: 10, strike: 4, defend: 4, extras: ['eruption', 'vigilance'] },
  }
  for (const [character, want] of Object.entries(expected)) {
    const deck = STARTER_DECKS[character]
    assertEqual(deck.length, want.size, `${character} starter deck should hold ${want.size} cards`)
    assertEqual(count(deck, `strike_${character}`), want.strike, `${character} should have ${want.strike} Strikes`)
    assertEqual(count(deck, `defend_${character}`), want.defend, `${character} should have ${want.defend} Defends`)
    for (const extra of want.extras) {
      assertEqual(count(deck, extra), 1, `${character} should have exactly one ${extra}`)
    }
  }
})

check('every card a starter deck names actually exists', () => {
  for (const [character, deck] of Object.entries(STARTER_DECKS)) {
    for (const id of deck) {
      assert(CARDS[id] !== undefined, `${character} starter deck names unknown card "${id}"`)
    }
  }
})

// Defend+ reads "2 Block to any player" — co-op targeting printed on the card.
check('Defend+ can put Block on a teammate', () => {
  const defend = instance('defend_ironclad', true)
  const state = combat(
    [makePlayer({ hand: [defend] }), makePlayer({ id: 'p2', name: 'Silent', row: 1 })],
    [makeEnemy()],
  )
  const next = playCard(state, 'p1', defend.uid, { enemyUid: null, playerId: 'p2' })
  assertEqual(next.players[1].block, 2, 'the ally receives the Block')
  assertEqual(next.players[0].block, 0, 'and the caster keeps none')
})

check('plain Defend only ever blocks its own player', () => {
  const defend = instance('defend_ironclad')
  const state = combat(
    [makePlayer({ hand: [defend] }), makePlayer({ id: 'p2', name: 'Silent', row: 1 })],
    [makeEnemy()],
  )
  const next = playCard(state, 'p1', defend.uid, { enemyUid: null, playerId: 'p2' })
  assertEqual(next.players[0].block, 1, 'the unupgraded card blocks the caster')
  assertEqual(next.players[1].block, 0, 'and cannot reach an ally')
})

// p.15: an area-of-effect hits every enemy in one row AND always the boss.
check('a row target always includes the boss', () => {
  const state = combat(
    [makePlayer()],
    [
      makeEnemy({ uid: 'a', row: 0 }),
      makeEnemy({ uid: 'b', row: 0 }),
      makeEnemy({ uid: 'c', row: 1 }),
      makeEnemy({ uid: 'boss', row: 2, isBoss: true }),
    ],
  )
  const hit = resolveEnemyTargets(state, 'row', 'a').map((e) => e.uid)
  assert(hit.includes('a') && hit.includes('b'), 'both enemies in the row are hit')
  assert(hit.includes('boss'), 'the boss is always included in a row effect')
  assert(!hit.includes('c'), 'an enemy in another row is not hit')
})

check('row targeting skips the dead', () => {
  const state = combat(
    [makePlayer()],
    [makeEnemy({ uid: 'a', row: 0 }), makeEnemy({ uid: 'b', row: 0, dead: true })],
  )
  assertEqual(resolveEnemyTargets(state, 'row', 'a').length, 1, 'dead enemies are not targets')
})

check('start of turn resets energy and block and draws five', () => {
  const deck = STARTER_DECKS.ironclad.map((id) => instance(id))
  const state = combat([makePlayer({ draw: deck, energy: 0, block: 7 })], [makeEnemy()])
  const next = startPlayerTurn(state)
  assertEqual(next.players[0].energy, 3, 'energy resets to 3')
  assertEqual(next.players[0].block, 0, 'player Block clears at the start of the Player Turn')
  assertEqual(next.players[0].hand.length, 5, 'five cards are drawn')
  assert(next.die >= 1 && next.die <= 6, `the shared die should be 1-6, got ${next.die}`)
})

check('the die is rolled once per round and is deterministic for a seed', () => {
  const deck = STARTER_DECKS.ironclad.map((id) => instance(id))
  const a = startPlayerTurn(combat([makePlayer({ draw: deck })], [makeEnemy()]))
  const b = startPlayerTurn(combat([makePlayer({ draw: [...deck] })], [makeEnemy()]))
  assertEqual(a.die, b.die, 'the same seed must roll the same die')
})

check('end of turn discards every hand', () => {
  const hand = [instance('strike_ironclad'), instance('defend_ironclad')]
  const state = combat([makePlayer({ hand })], [makeEnemy()])
  const next = endPlayerTurn(state)
  assertEqual(next.players[0].hand.length, 0, 'the hand is discarded')
  assertEqual(next.players[0].discard.length, 2)
  assertEqual(next.phase, 'enemy', 'the Enemy Turn follows')
})

// p.17: Poison is HP loss at end of turn, so Block cannot stop it, and the
// tokens are never removed while the enemy lives.
check('poison costs HP at end of turn, ignores Block, and does not decay', () => {
  const state = combat([makePlayer()], [makeEnemy({ hp: 6, block: 5, poison: 2 })])
  const next = endPlayerTurn(state)
  assertEqual(next.enemies[0].hp, 4, 'poison bypasses the enemy Block entirely')
  assertEqual(next.enemies[0].block, 5, 'and does not consume Block')
  assertEqual(next.enemies[0].poison, 2, 'poison tokens stay until the enemy dies')
})

check('poison can finish an enemy off', () => {
  const state = combat([makePlayer()], [makeEnemy({ hp: 2, poison: 3 })])
  const next = endPlayerTurn(state)
  assert(next.enemies[0].dead, 'poison should kill')
  assertEqual(next.phase, 'won')
})

// p.17: ending your turn in Wrath costs 1 damage, and it can be blocked.
check('ending a turn in Wrath costs 1 damage unless blocked', () => {
  const exposed = endPlayerTurn(combat([makePlayer({ stance: 'wrath' })], [makeEnemy()]))
  assertEqual(exposed.players[0].hp, 9, 'Wrath bites for 1 at end of turn')

  const guarded = endPlayerTurn(combat([makePlayer({ stance: 'wrath', block: 3 })], [makeEnemy()]))
  assertEqual(guarded.players[0].hp, 10, 'Block prevents the Wrath damage')
  assertEqual(guarded.players[0].block, 2, 'and one Block is spent doing so')
})

// Twin Strike is two separate hits, not one hit of double size. The difference
// only shows against Block: 1+1 into 1 Block leaves 1 damage, while a single
// hit of 2 into 1 Block also leaves 1 — so this uses Strength, which applies to
// EACH hit and makes the two models diverge.
check('a multi-hit resolves as separate hits, each taking Strength', () => {
  const twin = instance('twin_strike')
  const state = combat([makePlayer({ hand: [twin], strength: 2 })], [makeEnemy({ hp: 20 })])
  const next = playCard(state, 'p1', twin.uid, { enemyUid: 'e1', playerId: null })
  assertEqual(next.enemies[0].hp, 14, 'two hits of (1+2) deal 6, not one hit of (2+2)')
})

check('a multi-hit spends exactly one Vulnerable token for the whole attack', () => {
  const twin = instance('twin_strike')
  const state = combat([makePlayer({ hand: [twin] })], [makeEnemy({ hp: 20, vulnerable: 2 })])
  const next = playCard(state, 'p1', twin.uid, { enemyUid: 'e1', playerId: null })
  assertEqual(next.enemies[0].hp, 16, 'both hits double, for 2 + 2')
  assertEqual(next.enemies[0].vulnerable, 1, 'and only one token comes off')
})

check('a multi-hit stops when the target dies partway through', () => {
  const twin = instance('twin_strike')
  const state = combat([makePlayer({ hand: [twin] })], [makeEnemy({ hp: 1 })])
  const next = playCard(state, 'p1', twin.uid, { enemyUid: 'e1', playerId: null })
  assert(next.enemies[0].dead, 'the first hit kills')
  assertEqual(next.enemies[0].hp, 0, 'HP does not go negative from the second hit')
})

// True Grit blocks any player and exhausts a chosen card from hand.
check('a card can exhaust another card out of hand', () => {
  const grit = instance('true_grit')
  const doomed = instance('strike_ironclad')
  const state = combat([makePlayer({ hand: [grit, doomed] })], [makeEnemy()])
  const next = playCard(state, 'p1', grit.uid, {
    enemyUid: null,
    playerId: 'p1',
    exhaustUids: [doomed.uid],
  })
  assertEqual(next.players[0].exhaust.length, 1, 'the chosen card is exhausted')
  assertEqual(next.players[0].exhaust[0].uid, doomed.uid)
  assertEqual(next.players[0].hand.length, 0, 'and leaves hand')
  assertEqual(next.players[0].block, 1, 'True Grit still grants its Block')
  assertEqual(next.players[0].discard.length, 1, 'True Grit itself goes to the discard pile')
})

check('Survivor discards a chosen card', () => {
  const survivor = instance('survivor')
  const spare = instance('strike_silent')
  const state = combat([makePlayer({ hand: [survivor, spare] })], [makeEnemy()])
  const next = playCard(state, 'p1', survivor.uid, {
    enemyUid: null,
    playerId: 'p1',
    discardUids: [spare.uid],
  })
  assertEqual(next.players[0].block, 2, 'Survivor grants 2 Block')
  assertEqual(next.players[0].hand.length, 0, 'the chosen card is discarded')
  assertEqual(next.players[0].discard.length, 2, 'the discarded card and Survivor itself')
})

// A malicious or buggy client could name more cards than the effect allows.
// The engine caps at the printed amount rather than trusting the request.
check('a discard effect never removes more than its printed amount', () => {
  const survivor = instance('survivor')
  const a = instance('strike_silent')
  const b = instance('strike_silent')
  const c = instance('strike_silent')
  const state = combat([makePlayer({ hand: [survivor, a, b, c] })], [makeEnemy()])
  const next = playCard(state, 'p1', survivor.uid, {
    enemyUid: null,
    playerId: 'p1',
    discardUids: [a.uid, b.uid, c.uid],
  })
  assertEqual(next.players[0].hand.length, 2, 'Survivor discards 1, so two cards stay in hand')
  assertEqual(next.players[0].discard.length, 2, 'one discarded card plus Survivor itself')
})

check('an exhaust effect never removes more than its printed amount', () => {
  const grit = instance('true_grit')
  const a = instance('strike_ironclad')
  const b = instance('strike_ironclad')
  const state = combat([makePlayer({ hand: [grit, a, b] })], [makeEnemy()])
  const next = playCard(state, 'p1', grit.uid, {
    enemyUid: null,
    playerId: 'p1',
    exhaustUids: [a.uid, b.uid],
  })
  assertEqual(next.players[0].exhaust.length, 1, 'True Grit exhausts exactly one card')
  assertEqual(next.players[0].hand.length, 1, 'the other card stays in hand')
})

check('a card that discards cannot discard itself', () => {
  const survivor = instance('survivor')
  const state = combat([makePlayer({ hand: [survivor] })], [makeEnemy()])
  const next = playCard(state, 'p1', survivor.uid, {
    enemyUid: null,
    playerId: 'p1',
    discardUids: [survivor.uid],
  })
  assertEqual(
    next.players[0].discard.length,
    1,
    'the resolving card is in no pile, so naming it as the discard is a no-op rather than a duplicate',
  )
})

// No transcribed card self-exhausts or is a Power yet, but playCard routes both,
// so the branches are covered with fixture definitions registered into the card
// table. These test the ENGINE's routing, not the card data.
CARDS.fixture_exhaust = {
  id: 'fixture_exhaust',
  name: 'Fixture Exhaust',
  owner: 'ironclad',
  type: 'skill',
  rarity: 'common',
  cost: 0,
  exhaust: true,
  effects: [{ kind: 'block', amount: 1 }],
}
CARDS.fixture_power = {
  id: 'fixture_power',
  name: 'Fixture Power',
  owner: 'ironclad',
  type: 'power',
  rarity: 'common',
  cost: 0,
  effects: [{ kind: 'gainStrength', amount: 1 }],
}
CARDS.fixture_unplayable = {
  id: 'fixture_unplayable',
  name: 'Fixture Unplayable',
  owner: 'curse',
  type: 'curse',
  rarity: 'special',
  cost: 0,
  unplayable: true,
  effects: [],
}

check('a card marked Exhaust goes to the exhaust pile, not the discard pile', () => {
  const fixture = instance('fixture_exhaust')
  const state = combat([makePlayer({ hand: [fixture] })], [makeEnemy()])
  const next = playCard(state, 'p1', fixture.uid, { enemyUid: null, playerId: 'p1' })
  assertEqual(next.players[0].exhaust.length, 1, 'the card exhausts itself')
  assertEqual(next.players[0].discard.length, 0, 'and never reaches the discard pile')
  assertEqual(next.players[0].block, 1, 'its effect still resolves')
})

check('a Power stays in front of the player instead of being discarded', () => {
  const fixture = instance('fixture_power')
  const state = combat([makePlayer({ hand: [fixture] })], [makeEnemy()])
  const next = playCard(state, 'p1', fixture.uid, { enemyUid: null, playerId: 'p1' })
  assertEqual(next.players[0].powers.length, 1, 'Powers stay in play for the combat')
  assertEqual(next.players[0].discard.length, 0, 'and do not go to the discard pile')
  assertEqual(next.players[0].strength, 1, 'its effect still resolves')
})

check('an Unplayable card cannot be played', () => {
  const fixture = instance('fixture_unplayable')
  const state = combat([makePlayer({ hand: [fixture] })], [makeEnemy()])
  assert(
    playCard(state, 'p1', fixture.uid, { enemyUid: null, playerId: 'p1' }) === state,
    'an Unplayable card must be refused, returning the identical state reference',
  )
})

// p.12 orders Start of Turn as Reset, Draw, Roll, then abilities. The order is
// observable because drawing consumes RNG: a draw that has to reshuffle pulls
// different values than one that does not, which shifts the roll that follows.
check('the die is rolled AFTER the draw, in rulebook order', () => {
  const deck = () => Array.from({ length: 10 }, () => instance('strike_ironclad'))

  // Same seed, same cards — but one player must reshuffle to draw, which
  // consumes extra RNG before the roll.
  const noReshuffle = startPlayerTurn(
    combat([makePlayer({ draw: deck(), discard: [] })], [makeEnemy()]),
  )
  const withReshuffle = startPlayerTurn(
    combat([makePlayer({ draw: [], discard: deck() })], [makeEnemy()]),
  )

  assertEqual(noReshuffle.players[0].hand.length, 5, 'both draw a full hand')
  assertEqual(withReshuffle.players[0].hand.length, 5)
  assert(
    noReshuffle.die !== withReshuffle.die,
    'the roll must come after the draw, so a reshuffle shifts it; ' +
      `both rolled ${noReshuffle.die}, which means the die was rolled first`,
  )
})

check('the die is a single roll in 1-6, not a sum of rolls', () => {
  const seen = new Set()
  for (let seed = 0; seed < 400; seed++) {
    const state = startPlayerTurn(createCombat(createRng(seed), [makePlayer()], [makeEnemy()]))
    assert(
      Number.isInteger(state.die) && state.die >= 1 && state.die <= 6,
      `die out of range for seed ${seed}: ${state.die}`,
    )
    seen.add(state.die)
  }
  assertEqual(seen.size, 6, 'every face should show up across 400 seeds, and none beyond 6')
})

// With several enemies, "won" must mean ALL of them are dead.
check('killing one of several enemies does not end the combat', () => {
  const strike = instance('strike_ironclad')
  const state = combat(
    [makePlayer({ hand: [strike] })],
    [makeEnemy({ uid: 'a', hp: 1 }), makeEnemy({ uid: 'b', hp: 6, row: 1 })],
  )
  const next = playCard(state, 'p1', strike.uid, { enemyUid: 'a', playerId: null })
  assert(next.enemies[0].dead, 'the first enemy dies')
  assert(!next.enemies[1].dead, 'the second is untouched')
  assertEqual(next.phase, 'player', 'combat continues while any enemy lives')
})

check('a full turn cycle is reproducible from the same seed', () => {
  const build = () =>
    combat([makePlayer({ draw: STARTER_DECKS.ironclad.map((id) => instance(id)) })], [makeEnemy()])
  const runOnce = (state) => {
    let s = startPlayerTurn(state)
    const first = s.players[0].hand[0]
    s = playCard(s, 'p1', first.uid, { enemyUid: 'e1', playerId: 'p1' })
    return endPlayerTurn(s)
  }
  uid = 0
  const a = runOnce(build())
  uid = 0
  const b = runOnce(build())
  assertEqual(
    JSON.stringify({ ...a, log: null }),
    JSON.stringify({ ...b, log: null }),
    'identical seeds and actions must produce identical states, or replays desync',
  )
})

report('combat')
