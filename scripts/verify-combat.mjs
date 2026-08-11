import {
  activatePower,
  activatePotion,
  beginEndPlayerTurn,
  chooseEndTurnTarget,
  cardNeedsChoicePreview,
  cardNeedsEnemy,
  createCombat,
  defaultStartTurnChoices,
  endPlayerTurn,
  endTurnAbilities,
  enemyTurn,
  livingEnemies,
  nextEvokeChoice,
  playCard,
  playCardCopy,
  playCost,
  preparePlayerTurn,
  previewCardChoice,
  previewCardCopyChoice,
  resolveEnemyTargets,
  resolveStartPlayerTurn,
  spendMiracle,
  spendShiv,
  startPlayerTurn,
  startTurnAbilities,
} from '../src/game/combat.ts'
import { CARDS, STARTER_DECKS, cardDef, faceOf } from '../src/game/cards.ts'
import { ENEMIES } from '../src/game/enemies.ts'
import { createRng } from '../src/game/rng.ts'
import { CAPS } from '../src/game/types.ts'
import {
  advanceAct,
  createRun,
  enterRoom,
  resolveCampfire,
  resolveCardRewards,
  resolveCombat,
  roomChoices,
} from '../src/game/run.ts'
import { readFileSync } from 'node:fs'
import { suite, check, assert, assertDeepEqual, assertEqual, report } from './lib/harness.mjs'

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
    abilityUsed: false,
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

check('Curl Up fires once, only after HP damage, and can block later hits', () => {
  const first = instance('strike_ironclad')
  const second = instance('strike_ironclad')
  const state = combat(
    [makePlayer({ hand: [first, second] })],
    [makeEnemy({ defId: 'green_louse', hp: 6, maxHp: 6 })],
  )
  const curled = playCard(state, 'p1', first.uid, { enemyUid: 'e1', playerId: null })
  assertEqual(curled.enemies[0].hp, 5, 'the first hit deals damage before Curl Up')
  assertEqual(curled.enemies[0].block, 2, 'Curl Up grants its printed Block')
  assertEqual(curled.enemies[0].abilityUsed, true, 'the once-per-combat trigger is remembered')
  const again = playCard(curled, 'p1', second.uid, { enemyUid: 'e1', playerId: null })
  assertEqual(again.enemies[0].hp, 5, 'the later hit is absorbed by Curl Up Block')
  assertEqual(again.enemies[0].block, 1, 'Curl Up does not fire a second time')

  const blocked = instance('strike_ironclad')
  const noDamage = playCard(
    combat([makePlayer({ hand: [blocked] })], [makeEnemy({ defId: 'red_louse', block: 1 })]),
    'p1',
    blocked.uid,
    { enemyUid: 'e1', playerId: null },
  )
  assertEqual(noDamage.enemies[0].abilityUsed, false, 'a fully blocked hit dealt no damage')
  assertEqual(noDamage.enemies[0].block, 0, 'and therefore did not Curl Up')
})

check('Curl Up resolves between the hits of a multi-hit attack', () => {
  const spray = instance('dagger_spray')
  const next = playCard(
    combat(
      [makePlayer({ character: 'silent', hand: [spray] })],
      [makeEnemy({ defId: 'green_louse', hp: 6, maxHp: 6 })],
    ),
    'p1',
    spray.uid,
    { enemyUid: 'e1', playerId: null },
  )
  assertEqual(next.enemies[0].hp, 5, 'the first dagger deals damage')
  assertEqual(next.enemies[0].block, 1, 'Curl Up blocks the second dagger immediately')
})

check('Spore Cloud applies Vulnerable to its row however the Fungi Beast dies', () => {
  const strike = instance('strike_ironclad')
  const hit = playCard(
    combat(
      [
        makePlayer({ hand: [strike] }),
        makePlayer({ id: 'p2', name: 'Silent', character: 'silent', row: 1 }),
      ],
      [makeEnemy({ defId: 'fungi_beast', hp: 1, maxHp: 6 })],
    ),
    'p1',
    strike.uid,
    { enemyUid: 'e1', playerId: null },
  )
  assertEqual(hit.players[0].vulnerable, 1, 'the player in the defeated Beast\'s row is vulnerable')
  assertEqual(hit.players[1].vulnerable, 0, 'another row is untouched')

  const poisoned = beginEndPlayerTurn(combat(
    [makePlayer()],
    [makeEnemy({ defId: 'fungi_beast', hp: 1, maxHp: 6, poison: 1 })],
  ))
  assertEqual(poisoned.enemies[0].dead, true, 'Poison defeats the Beast')
  assertEqual(poisoned.players[0].vulnerable, 1, 'a Poison defeat still fires Spore Cloud')
})

check('Gremlin Nob becomes Enraged on turn 2 after a Skill finishes', () => {
  const early = instance('seeing_red')
  const turnOne = playCard(
    { ...combat([makePlayer({ hand: [early] })], [makeEnemy({ defId: 'gremlin_nob' })]), turn: 1 },
    'p1',
    early.uid,
    { enemyUid: null, playerId: null },
  )
  assertEqual(turnOne.players[0].hp, 10, 'Enraged is dormant on turn 1')

  const late = instance('seeing_red')
  const turnTwo = playCard(
    { ...combat([makePlayer({ hand: [late] })], [makeEnemy({ defId: 'gremlin_nob' })]), turn: 2 },
    'p1',
    late.uid,
    { enemyUid: null, playerId: null },
  )
  assertEqual(turnTwo.players[0].hp, 9, 'a turn-2 Skill triggers 1 Enraged damage')

  const defend = instance('defend_ironclad')
  const blocked = playCard(
    { ...combat([makePlayer({ hand: [defend] })], [makeEnemy({ defId: 'gremlin_nob' })]), turn: 2 },
    'p1',
    defend.uid,
    { enemyUid: null, playerId: null },
  )
  assertEqual(blocked.players[0].hp, 10, 'the Skill resolves before Enraged')
  assertEqual(blocked.players[0].block, 0, 'its Block can absorb the Enraged damage')
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

check('players choose which card is on top when discarding their hand', () => {
  const bash = instance('bash')
  const deflect = instance('deflect')
  const state = combat([makePlayer({ hand: [deflect, bash] })], [makeEnemy()])
  const next = endPlayerTurn(state, { p1: [bash.uid, deflect.uid] })
  assertEqual(next.players[0].discard.at(-1)?.uid, deflect.uid, 'the chosen 0-cost card lands on top')

  const refused = endPlayerTurn(state, { p1: [deflect.uid, deflect.uid] })
  assertEqual(refused.phase, 'discard', 'a stale order leaves the post-trigger choice open')
  assertEqual(refused.players[0].hand.length, 2, 'and discards nothing')
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

check('exhausting Daze returns it to the shared supply and still fires exhaust triggers', () => {
  const grit = instance('true_grit')
  const daze = instance('daze')
  const state = combat([
    makePlayer({ hand: [grit, daze], powers: [instance('feel_no_pain')] }),
  ], [makeEnemy()])
  const next = playCard(state, 'p1', grit.uid, {
    enemyUid: null,
    playerId: 'p1',
    exhaustUids: [daze.uid],
  })
  assertEqual(next.players[0].exhaust.length, 0, 'Daze returns instead of entering the exhaust pile')
  assertEqual(next.players[0].block, 2, 'Feel No Pain still sees the Daze exhaust')
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

check('Purity exhausts any chosen number up to its face limit atomically', () => {
  for (const upgraded of [false, true]) {
    const purity = instance('purity', upgraded)
    const fodder = Array.from({ length: 5 }, () => instance('strike_ironclad'))
    const state = combat([
      makePlayer({ hand: [purity, ...fodder], powers: [instance('feel_no_pain')] }),
    ], [makeEnemy()])
    const limit = upgraded ? 5 : 3
    const picked = fodder.slice(0, limit)
    const played = playCard(state, 'p1', purity.uid, {
      enemyUid: null,
      playerId: null,
      exhaustUids: picked.map((card) => card.uid),
    })
    assertDeepEqual(played.players[0].exhaust.map((card) => card.uid), [
      ...picked.map((card) => card.uid), purity.uid,
    ])
    assertEqual(played.players[0].block, limit + 1, 'Feel No Pain sees every chosen card and Purity itself')
  }

  const purity = instance('purity')
  const [first, ...rest] = Array.from({ length: 4 }, () => instance('strike_ironclad'))
  const state = combat([makePlayer({ hand: [purity, first, ...rest] })], [makeEnemy()])
  assertEqual(playCard(state, 'p1', purity.uid, {
    enemyUid: null,
    playerId: null,
    exhaustUids: [first.uid, ...rest.map((card) => card.uid)],
  }), state, 'the base face accepted more than three choices')
  assertEqual(playCard(state, 'p1', purity.uid, {
    enemyUid: null,
    playerId: null,
    exhaustUids: [first.uid, first.uid],
  }), state, 'duplicate choices were accepted')
  const skipped = playCard(state, 'p1', purity.uid, {
    enemyUid: null,
    playerId: null,
    exhaustUids: [],
  })
  assertDeepEqual(skipped.players[0].exhaust.map((card) => card.uid), [purity.uid],
    'exhausting no hand cards must remain legal')
})

check('Burning Pact Exhausts before drawing and follows both printed faces', () => {
  for (const upgraded of [false, true]) {
    const pact = instance('burning_pact', upgraded)
    const fuel = instance('strike_ironclad')
    const draw = Array.from({ length: 3 }, () => instance('defend_ironclad'))
    const state = combat([
      makePlayer({ hand: [pact, fuel], draw, powers: [instance('feel_no_pain')] }),
    ], [makeEnemy()])
    const played = playCard(state, 'p1', pact.uid, {
      enemyUid: null,
      playerId: null,
      exhaustUids: [fuel.uid],
    })
    assertDeepEqual(played.players[0].exhaust.map((card) => card.uid), [fuel.uid])
    assertEqual(played.players[0].hand.length, upgraded ? 3 : 2)
    assertEqual(played.players[0].block, 1, 'Feel No Pain sees the exhausted card')
  }

  const pact = instance('burning_pact')
  const state = combat([
    makePlayer({ hand: [pact], draw: [instance('strike_ironclad'), instance('defend_ironclad')] }),
  ], [makeEnemy()])
  const played = playCard(state, 'p1', pact.uid, { enemyUid: null, playerId: null })
  assertEqual(played.players[0].hand.length, 2, 'an empty hand Exhausts nothing, then draws normally')

  const orderedPact = instance('burning_pact')
  const orderedFuel = instance('strike_ironclad')
  const hidden = instance('defend_ironclad')
  const orderedState = combat([
    makePlayer({ hand: [orderedPact, orderedFuel], draw: [hidden, instance('strike_ironclad')] }),
  ], [makeEnemy()])
  assertEqual(playCard(orderedState, 'p1', orderedPact.uid, {
    enemyUid: null, playerId: null, exhaustUids: [hidden.uid],
  }), orderedState, 'Burning Pact drew before validating its Exhaust choice')
  assertEqual(orderedState.players[0].draw.length, 2, 'a refused Exhaust partially drew cards')

  const embracePact = instance('burning_pact')
  const embraceFuel = instance('strike_ironclad')
  const embraced = playCard(combat([makePlayer({
    hand: [embracePact, embraceFuel],
    draw: Array.from({ length: 3 }, () => instance('defend_ironclad')),
    powers: [instance('dark_embrace')],
  })], [makeEnemy()]), 'p1', embracePact.uid, {
    enemyUid: null, playerId: null, exhaustUids: [embraceFuel.uid],
  })
  const pactDrawAt = embraced.log.indexOf('Ironclad draws 2')
  const embraceDrawAt = embraced.log.indexOf("Ironclad's Dark Embrace: Ironclad draws 1")
  assert(pactDrawAt >= 0 && embraceDrawAt > pactDrawAt,
    `Dark Embrace resolved before Burning Pact finished: ${embraced.log.join(' | ')}`)
})

check('Sever Soul+ requires one choice when possible and accepts either one or two', () => {
  const makeState = () => {
    const sever = instance('sever_soul', true)
    const choices = Array.from({ length: 3 }, () => instance('defend_ironclad'))
    return { sever, choices, state: combat([makePlayer({ hand: [sever, ...choices] })], [makeEnemy()]) }
  }

  const base = instance('sever_soul')
  const baseChoices = [instance('defend_ironclad'), instance('strike_ironclad')]
  const basePlayed = playCard(
    combat([makePlayer({ hand: [base, ...baseChoices] })], [makeEnemy()]),
    'p1', base.uid,
    { enemyUid: 'e1', playerId: null, exhaustUids: baseChoices.map((card) => card.uid) },
  )
  assertEqual(basePlayed.enemies[0].hp, 3, 'Sever Soul did not deal 3')
  assertDeepEqual(basePlayed.players[0].exhaust.map((card) => card.uid), [baseChoices[0].uid],
    'Sever Soul must Exhaust exactly one available card')
  assertDeepEqual(basePlayed.players[0].hand.map((card) => card.uid), [baseChoices[1].uid])

  const skipped = makeState()
  assertEqual(playCard(skipped.state, 'p1', skipped.sever.uid, {
    enemyUid: 'e1', playerId: null, exhaustUids: [],
  }), skipped.state, 'Sever Soul+ accepted zero choices while cards were available')
  assertEqual(skipped.state.enemies[0].hp, 6, 'a refused play partially dealt damage')

  for (const count of [1, 2]) {
    const fixture = makeState()
    const played = playCard(fixture.state, 'p1', fixture.sever.uid, {
      enemyUid: 'e1',
      playerId: null,
      exhaustUids: fixture.choices.slice(0, count).map((card) => card.uid),
    })
    assertEqual(played.enemies[0].hp, 2, `Sever Soul+ with ${count} choice(s) did not deal 4`)
    assertEqual(played.players[0].exhaust.length, count)
  }

  const oversized = makeState()
  assertEqual(playCard(oversized.state, 'p1', oversized.sever.uid, {
    enemyUid: 'e1', playerId: null, exhaustUids: oversized.choices.map((card) => card.uid),
  }), oversized.state, 'Sever Soul+ accepted more than two choices')

  const lone = instance('sever_soul', true)
  const emptyHand = combat([makePlayer({ hand: [lone] })], [makeEnemy()])
  assert(playCard(emptyHand, 'p1', lone.uid, { enemyUid: 'e1', playerId: null }) !== emptyHand,
    'a card may resolve as much as possible when no Exhaust choice exists')
})

check('Second Wind exhausts every non-Attack, counts Status cards, and resolves Sentinel afterward', () => {
  for (const upgraded of [false, true]) {
    const wind = instance('second_wind', upgraded)
    const attack = instance('strike_ironclad')
    const sentinel = instance('sentinel')
    const defend = instance('defend_ironclad')
    const daze = instance('daze')
    const state = combat([makePlayer({ hand: [wind, attack, sentinel, defend, daze] })], [makeEnemy()])
    const played = playCard(state, 'p1', wind.uid, { enemyUid: null, playerId: null })
    assertDeepEqual(played.players[0].hand.map((card) => card.uid), [attack.uid])
    assertDeepEqual(played.players[0].exhaust.map((card) => card.uid), [sentinel.uid, defend.uid],
      'Status cards count as Exhausted but return to their shared supply')
    assertEqual(played.players[0].block, upgraded ? 6 : 3)
    assertEqual(played.players[0].energy, 4, 'Sentinel gains 2 Energy only after Second Wind finishes')
    const blockAt = played.log.indexOf(`Ironclad gains ${upgraded ? 6 : 3} Block`)
    const energyAt = played.log.indexOf("Ironclad's Sentinel: Ironclad gains 2 Energy")
    assert(blockAt >= 0 && energyAt > blockAt,
      `Sentinel resolved before Second Wind finished: ${played.log.join(' | ')}`)
  }
})

check('Sentinel only gains Energy when another effect Exhausts it', () => {
  const sentinel = instance('sentinel', true)
  const ally = makePlayer({ id: 'p2', name: 'Silent', character: 'silent', row: 1, block: 0 })
  const state = combat([makePlayer({ hand: [sentinel], energy: 1 }), ally], [makeEnemy()])
  const played = playCard(state, 'p1', sentinel.uid, { enemyUid: null, playerId: 'p2' })
  assertEqual(played.players[0].energy, 0, 'playing Sentinel incorrectly fired its Exhaust reaction')
  assertEqual(played.players[1].block, 3, 'Sentinel+ did not give 3 Block to its chosen ally')

  const pact = instance('burning_pact')
  const fuel = instance('sentinel')
  const exhausted = playCard(combat([
    makePlayer({ hand: [pact, fuel], energy: 1, draw: [instance('strike_ironclad'), instance('defend_ironclad')] }),
  ], [makeEnemy()]), 'p1', pact.uid, {
    enemyUid: null, playerId: null, exhaustUids: [fuel.uid],
  })
  assertEqual(exhausted.players[0].energy, 2, 'Exhausted Sentinel did not gain its printed 2 Energy')
})

check('Fiend Fire Exhausts the rest of the hand and deals one Strength-modified hit per card', () => {
  for (const upgraded of [false, true]) {
    const fiend = instance('fiend_fire', upgraded)
    const strike = instance('strike_ironclad')
    const sentinel = instance('sentinel')
    const daze = instance('daze')
    const state = combat([makePlayer({
      hand: [fiend, strike, sentinel, daze],
      energy: 2,
      strength: 1,
      powers: [instance('feel_no_pain')],
    })], [makeEnemy({ hp: 20, maxHp: 20 })])
    const played = playCard(state, 'p1', fiend.uid, { enemyUid: 'e1', playerId: null })

    assertEqual(played.enemies[0].hp, upgraded ? 11 : 14,
      'Fiend Fire must deal a separate Strength-modified hit for each other card')
    assertDeepEqual(played.players[0].hand, [])
    assertDeepEqual(played.players[0].exhaust.map((card) => card.uid), [strike.uid, sentinel.uid, fiend.uid],
      'Daze returns to the shared supply while every non-Status card Exhausts')
    assertEqual(played.players[0].block, 4, 'Feel No Pain must see all three hand cards and Fiend Fire itself')
    assertEqual(played.players[0].energy, 2, 'Sentinel must resolve after the attack and refund 2 Energy')
    const hitAt = played.log.findIndex((line) => line.includes(' hit '))
    const sentinelAt = played.log.indexOf("Ironclad's Sentinel: Ironclad gains 2 Energy")
    assert(hitAt >= 0 && sentinelAt > hitAt,
      `Exhaust reactions resolved before Fiend Fire finished: ${played.log.join(' | ')}`)
  }

  const fiend = instance('fiend_fire')
  const empty = combat([makePlayer({ hand: [fiend], energy: 2 })], [makeEnemy()])
  assertEqual(cardNeedsEnemy(faceOf(cardDef('fiend_fire'), false), empty.players[0]), false,
    'a Fiend Fire with no other cards should not ask for a meaningless target')
  const played = playCard(empty, 'p1', fiend.uid, { enemyUid: null, playerId: null })
  assert(played !== empty, 'Fiend Fire should still be playable with no other cards')
  assertDeepEqual(played.players[0].exhaust.map((card) => card.uid), [fiend.uid])
})

check('Corruption makes only its owner\'s Skills free and Exhausts them after they resolve', () => {
  for (const upgraded of [false, true]) {
    const corruption = instance('corruption', upgraded)
    const defend = instance('defend_ironclad')
    const drawn = instance('strike_ironclad')
    const state = combat([makePlayer({
      hand: [corruption, defend],
      draw: [drawn],
      energy: upgraded ? 2 : 3,
      powers: [instance('feel_no_pain'), instance('dark_embrace')],
    })], [makeEnemy()])
    const powered = playCard(state, 'p1', corruption.uid, { enemyUid: null, playerId: null })
    assertEqual(powered.players[0].energy, 0, `Corruption${upgraded ? '+' : ''} charged the wrong cost`)
    assert(powered.players[0].powers.some((card) => card.uid === corruption.uid), 'Corruption did not enter play')

    const played = playCard(powered, 'p1', defend.uid, { enemyUid: null, playerId: null })
    assert(played !== powered, 'Corruption did not make the Skill affordable at zero Energy')
    assertEqual(played.players[0].energy, 0)
    assertEqual(played.players[0].block, 2, 'Defend resolves before Feel No Pain adds its Block')
    assertDeepEqual(played.players[0].exhaust.map((card) => card.uid), [defend.uid])
    assertDeepEqual(played.players[0].hand.map((card) => card.uid), [drawn.uid],
      'Dark Embrace must draw only after the Skill finishes and Exhausts')
  }

  const corrupted = instance('corruption')
  const ironStrike = instance('strike_ironclad')
  const allyDefend = instance('defend_silent')
  const state = combat([
    makePlayer({ hand: [ironStrike], energy: 0, powers: [corrupted] }),
    makePlayer({ id: 'p2', name: 'Silent', character: 'silent', row: 1, hand: [allyDefend], energy: 1 }),
  ], [makeEnemy()])
  assertEqual(playCard(state, 'p1', ironStrike.uid, { enemyUid: 'e1', playerId: null }), state,
    'Corruption incorrectly made an Attack free')
  const allyPlayed = playCard(state, 'p2', allyDefend.uid, { enemyUid: null, playerId: null })
  assertEqual(allyPlayed.players[1].energy, 0, 'another player incorrectly received Corruption\'s discount')
  assertDeepEqual(allyPlayed.players[1].discard.map((card) => card.uid), [allyDefend.uid],
    'another player\'s Skill incorrectly Exhausted')

  const barrier = instance('steam_barrier')
  const discountedTop = instance('defend_ironclad')
  const conditional = playCard(combat([makePlayer({
    hand: [barrier], discard: [discountedTop], energy: 0, powers: [instance('corruption')],
  })], [makeEnemy()]), 'p1', barrier.uid, { enemyUid: null, playerId: null })
  assertEqual(conditional.players[0].block, 2,
    'cost conditions must see Corruption\'s zero-cost Skill override outside the hand too')
})

check('Barricade preserves only its owner\'s leftover Block at Start of Turn', () => {
  for (const upgraded of [false, true]) {
    const barricade = instance('barricade', upgraded)
    const powered = playCard(combat([makePlayer({
      hand: [barricade], energy: upgraded ? 1 : 2, block: 7,
    })], [makeEnemy()]), 'p1', barricade.uid, { enemyUid: null, playerId: null })
    assertEqual(powered.players[0].energy, 0, `Barricade${upgraded ? '+' : ''} charged the wrong cost`)
    assertDeepEqual(powered.players[0].powers.map((card) => card.uid), [barricade.uid])
    const nextTurn = startPlayerTurn({ ...powered, phase: 'roundEnd', turn: 1 })
    assertEqual(nextTurn.players[0].block, 7, 'Barricade cleared its owner\'s leftover Block')
  }

  const reset = startPlayerTurn({
    ...combat([
      makePlayer({ block: 7, powers: [instance('barricade')] }),
      makePlayer({ id: 'p2', name: 'Silent', character: 'silent', row: 1, block: 6 }),
    ], [makeEnemy()]),
    phase: 'roundEnd',
    turn: 1,
  })
  assertDeepEqual(reset.players.map((player) => player.block), [7, 0],
    'Barricade must not preserve a teammate\'s Block')
})

check('Entrench doubles current Block to the cap and upgrades by removing Exhaust', () => {
  for (const upgraded of [false, true]) {
    const entrench = instance('entrench', upgraded)
    const played = playCard(combat([makePlayer({
      hand: [entrench], energy: 1, block: 6,
    })], [makeEnemy()]), 'p1', entrench.uid, { enemyUid: null, playerId: null })
    assertEqual(played.players[0].block, 12)
    assertEqual(played.players[0].energy, 0)
    assertDeepEqual(played.players[0][upgraded ? 'discard' : 'exhaust'].map((card) => card.uid),
      [entrench.uid])
  }

  const capped = instance('entrench', true)
  const played = playCard(combat([makePlayer({ hand: [capped], block: 14 })], [makeEnemy()]),
    'p1', capped.uid, { enemyUid: null, playerId: null })
  assertEqual(played.players[0].block, 20, 'Entrench must discard Block above the global cap')
})

check('Clash requires an all-Attack hand and upgrades from 3 to 4 damage', () => {
  const blocked = instance('clash')
  const blockedState = combat([makePlayer({
    hand: [blocked, instance('defend_ironclad')], energy: 0,
  })], [makeEnemy()])
  assertEqual(playCard(blockedState, 'p1', blocked.uid, { enemyUid: 'e1', playerId: null }), blockedState)

  for (const upgraded of [false, true]) {
    const clash = instance('clash', upgraded)
    const state = combat([makePlayer({
      hand: [clash, instance('strike_ironclad')], energy: 0,
    })], [makeEnemy()])
    const played = playCard(state, 'p1', clash.uid, { enemyUid: 'e1', playerId: null })
    assertEqual(played.enemies[0].hp, upgraded ? 2 : 3)
    assertEqual(played.players[0].energy, 0)
    assertDeepEqual(played.players[0].discard.map((card) => card.uid), [clash.uid])
  }
})

check('Spot Weakness gives any player Strength on its printed die faces', () => {
  for (const upgraded of [false, true]) {
    const spot = instance('spot_weakness', upgraded)
    const state = {
      ...combat([
        makePlayer({ hand: [spot], energy: 1 }),
        makePlayer({ id: 'p2', name: 'Silent', character: 'silent', row: 1 }),
      ], [makeEnemy()]),
      die: 4,
    }
    const played = playCard(state, 'p1', spot.uid, { enemyUid: null, playerId: 'p2' })
    assertEqual(played.players[1].strength, upgraded ? 1 : 0)
    assertEqual(played.players[0].energy, 0)
    assertDeepEqual(played.players[0].discard.map((card) => card.uid), [spot.uid])
  }
})

check('Rage gains one Block per other Attack in hand and upgrades to cost 0', () => {
  for (const upgraded of [false, true]) {
    const rage = instance('rage', upgraded)
    const state = combat([makePlayer({
      hand: [rage, instance('strike_ironclad'), instance('clash'), instance('body_slam'), instance('defend_ironclad')],
      energy: upgraded ? 0 : 1,
    })], [makeEnemy()])
    const played = playCard(state, 'p1', rage.uid, { enemyUid: null, playerId: null })
    assertEqual(played.players[0].block, 3)
    assertEqual(played.players[0].energy, 0)
  }
})

check('Limit Break doubles Strength to its cap and only the base face Exhausts', () => {
  for (const upgraded of [false, true]) {
    const limit = instance('limit_break', upgraded)
    const state = combat([makePlayer({ hand: [limit], energy: 1, strength: upgraded ? 5 : 3 })], [makeEnemy()])
    const played = playCard(state, 'p1', limit.uid, { enemyUid: null, playerId: null })
    assertEqual(played.players[0].strength, upgraded ? 8 : 6)
    assertDeepEqual(played.players[0].exhaust.map((card) => card.uid), upgraded ? [] : [limit.uid])
    assertDeepEqual(played.players[0].discard.map((card) => card.uid), upgraded ? [limit.uid] : [])
  }
})

check('Feed gains capped Strength only when its hit kills the chosen enemy', () => {
  for (const upgraded of [false, true]) {
    const feed = instance('feed', upgraded)
    const state = combat(
      [makePlayer({ hand: [feed], energy: 1, strength: upgraded ? 7 : 0 })],
      [makeEnemy({ hp: 3, maxHp: 3 }), makeEnemy({ uid: 'e2', row: 1 })],
    )
    const played = playCard(state, 'p1', feed.uid, { enemyUid: 'e1', playerId: null })
    assertEqual(played.players[0].strength, upgraded ? 8 : 1)
    assertDeepEqual(played.players[0].exhaust.map((card) => card.uid), [feed.uid])
  }
})

check('Blood for Blood discounts after HP loss and upgrades that discount to 0', () => {
  const fullPrice = instance('blood_for_blood')
  const unaffordable = combat([makePlayer({ hand: [fullPrice], energy: 2 })], [makeEnemy()])
  assertEqual(playCard(unaffordable, 'p1', fullPrice.uid, { enemyUid: 'e1', playerId: null }), unaffordable)

  for (const upgraded of [false, true]) {
    const blood = instance('blood_for_blood', upgraded)
    const state = combat([makePlayer({ hand: [blood], energy: upgraded ? 0 : 1 })], [makeEnemy()])
    state.players[0].lostHpThisCombat = true
    const played = playCard(state, 'p1', blood.uid, { enemyUid: 'e1', playerId: null })
    assertEqual(played.enemies[0].hp, 2)
    assertEqual(played.players[0].energy, 0)
  }
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
  resolvesOnPlay: true,
  effects: [{ kind: 'gainStrength', amount: 1 }],
}
CARDS.fixture_terminal_power = {
  id: 'fixture_terminal_power',
  name: 'Fixture Terminal Power',
  owner: 'defect',
  type: 'power',
  rarity: 'special',
  cost: 0,
  target: 'allEnemies',
  trigger: { kind: 'startOfTurn' },
  effects: [{ kind: 'damage', amount: 1 }],
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

check('a terminal trigger stops later Powers immediately', () => {
  const terminal = instance('fixture_terminal_power')
  const fusion = instance('fusion')
  const state = combat([
    makePlayer({ character: 'defect', powers: [terminal, fusion], energy: 0 }),
  ], [makeEnemy({ hp: 1, maxHp: 1 })])
  const won = startPlayerTurn(state)
  assertEqual(won.phase, 'won')
  assertEqual(won.players[0].energy, 3, 'Fusion fired after an earlier trigger ended combat')
  assert(!won.log.some((line) => line.includes('Fusion')), 'a post-combat Fusion trigger was logged')
})

check('an Unplayable card cannot be played', () => {
  const fixture = instance('fixture_unplayable')
  const state = combat([makePlayer({ hand: [fixture] })], [makeEnemy()])
  assert(
    playCard(state, 'p1', fixture.uid, { enemyUid: null, playerId: 'p1' }) === state,
    'an Unplayable card must be refused, returning the identical state reference',
  )
})

check('Curses resolve their printed end-of-turn rules before discard', () => {
  const decay = instance('decay')
  const doubt = instance('doubt')
  const shame = instance('shame')
  const pain = instance('pain')
  const state = combat([
    makePlayer({ hand: [decay, doubt, shame, pain], hp: 8, block: 2 }),
  ], [makeEnemy()])
  const next = beginEndPlayerTurn(state)
  assertEqual(next.players[0].hp, 8, 'Decay damage is absorbed by Block')
  assertEqual(next.players[0].block, 0, 'Decay spends one Block and Shame removes one')
  assertEqual(next.players[0].weak, 1, 'Doubt gives Weak')
  assertEqual(next.players[0].hand.length, 4, 'the curses stay available for discard ordering')
  assert(!next.log.some((line) => line.startsWith('Pain:')), 'Pain is inactive above two cards')

  const painful = beginEndPlayerTurn(combat([
    makePlayer({ hand: [instance('pain'), instance('injury')], hp: 8, block: 20 }),
  ], [makeEnemy()]))
  assertEqual(painful.players[0].hp, 7, 'Pain loses HP through Block at two cards')
  assertEqual(painful.players[0].block, 20, 'Pain does not spend Block')
})

check('players choose the order of Power and Curse end-of-turn abilities', () => {
  const shame = instance('shame')
  const metallicize = instance('metallicize')
  const powered = combat([
    makePlayer({ hand: [shame], powers: [metallicize], block: 0 }),
  ], [makeEnemy()])
  assertEqual(beginEndPlayerTurn(powered).players[0].block, 0,
    'the default Power-then-Shame order spends Metallicize Block')
  const powerChosen = beginEndPlayerTurn(powered, [
    `p1/card:${shame.uid}`, `p1/power:${metallicize.uid}`,
  ])
  assertEqual(powerChosen.players[0].block, 1, 'Shame then Metallicize preserves the gained Block')

  const decay = instance('decay')
  const curseState = combat([
    makePlayer({ hand: [shame, decay], hp: 5, block: 1 }),
  ], [makeEnemy()])
  assertEqual(beginEndPlayerTurn(curseState).players[0].hp, 4,
    'the default Shame-then-Decay order loses HP')
  const curseChosen = beginEndPlayerTurn(curseState, [
    `p1/card:${decay.uid}`, `p1/card:${shame.uid}`,
  ])
  assertEqual(curseChosen.players[0].hp, 5, 'Decay then Shame spends Block instead')
  assert(beginEndPlayerTurn(curseState, [`p1/card:${shame.uid}`]) === curseState,
    'an incomplete order is rejected without mutating the turn')
})

check('the party can interleave end-of-turn abilities across co-op seats', () => {
  const state = combat([
    makePlayer({ hp: 1, stance: 'wrath' }),
    makePlayer({ id: 'p2', name: 'Defect', character: 'defect', row: 1, orbs: ['lightning', null, null] }),
  ], [makeEnemy({ hp: 1, maxHp: 1 })])
  assertEqual(beginEndPlayerTurn(state).phase, 'lost', 'seat order would resolve lethal Wrath first')
  const chosen = beginEndPlayerTurn(state, [`p2/orb:0@${state.enemies[0].uid}`, 'p1/wrath'])
  assertEqual(chosen.phase, 'won', 'the legal cross-seat Orb-first order wins immediately')
  assertEqual(chosen.players[0].hp, 1, 'Wrath never resolves after immediate victory')
})

check('a lethal Curse immediately defeats the co-op party', () => {
  const next = beginEndPlayerTurn(combat([
    makePlayer({ hand: [instance('pain'), instance('injury')], hp: 1 }),
    makePlayer({ id: 'p2', name: 'Silent', character: 'silent', row: 1, hand: [instance('doubt')] }),
  ], [makeEnemy()]))
  assert(next.players[0].dead, 'Pain defeats the first player')
  assertEqual(next.players[1].weak, 0, 'later end-turn effects stop after the immediate defeat')
  assertEqual(next.phase, 'lost', 'one fallen player ends the co-op combat (p.13)')
})

check('Ethereal uses the hand at end-turn start and returns Daze to its supply', () => {
  const clumsy = instance('clumsy')
  const daze = instance('daze')
  const drawnClumsy = instance('clumsy')
  const state = combat([
    makePlayer({
      hand: [clumsy, daze],
      draw: [drawnClumsy],
      powers: [instance('dark_embrace')],
    }),
  ], [makeEnemy()])
  const next = beginEndPlayerTurn(state)
  assertDeepEqual(next.players[0].exhaust.map((held) => held.uid), [clumsy.uid],
    'the Curse remains exhausted but the shared Daze returns to its supply')
  assertEqual(next.players[0].hand.length, 1, 'Dark Embrace draws once per exhausted card')
  assertEqual(next.players[0].hand[0].uid, drawnClumsy.uid,
    'an Ethereal card drawn during this step waits until the next end turn')
  const discarded = endPlayerTurn(next, { p1: [drawnClumsy.uid] })
  assertEqual(discarded.players[0].hand[0].uid, drawnClumsy.uid,
    'Dark Embrace draws are not discarded during this discard step')
  assertEqual(discarded.players[0].hand[0].endTurnProtected, undefined,
    'the one-turn protection is cleared after it is used')
})

check('Regret retains while Writhe can be paid to exhaust itself', () => {
  const regret = instance('regret')
  const strike = instance('strike_ironclad')
  const discarded = endPlayerTurn(
    combat([makePlayer({ hand: [regret, strike] })], [makeEnemy()]),
    { p1: [strike.uid, regret.uid] },
  )
  assertDeepEqual(discarded.players[0].hand.map((held) => held.uid), [regret.uid])
  assertDeepEqual(discarded.players[0].discard.map((held) => held.uid), [strike.uid])

  const writhe = instance('writhe')
  const played = playCard(
    combat([makePlayer({ hand: [writhe], energy: 1 })], [makeEnemy()]),
    'p1', writhe.uid, { enemyUid: null, playerId: null },
  )
  assertEqual(played.players[0].energy, 0)
  assertDeepEqual(played.players[0].exhaust.map((held) => held.uid), [writhe.uid])
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

suite('defeat')

// p.13: "When a player dies, the game immediately ends in defeat." One death,
// not a wipe. Reading it as last-man-standing makes a co-op game much easier
// than the box intends, and nothing else in the engine would notice.
check('one player dying ends the whole combat in defeat', () => {
  const state = {
    ...combat(
      [makePlayer({ id: 'p1', hp: 1, row: 0 }), makePlayer({ id: 'p2', hp: 10, row: 1 })],
      [makeEnemy({ uid: 'e1', row: 0 })],
    ),
    phase: 'enemy',
  }
  const next = enemyTurn(state)
  assert(next.players[0].dead, 'the player in the enemy\'s row was killed')
  assert(!next.players[1].dead, 'the other player is still standing')
  assertEqual(next.phase, 'lost', 'and the combat is lost anyway')
})

check('a combat with everyone alive is not lost', () => {
  const state = combat([makePlayer({ hp: 10 })], [makeEnemy({ hp: 5 })])
  assert(state.phase !== 'lost', 'a healthy party has not lost')
})

check('killing the last enemy wins, even if the party then takes lethal damage', () => {
  // Both endings are immediate (p.13). Once the last monster is dead the
  // combat is over, so the end-of-turn effects that follow never run at all —
  // which is what `combatIsOver` enforces, and what this exercises.
  const state = {
    ...combat(
      [makePlayer({ id: 'p1', hp: 1, stance: 'wrath' })],
      [makeEnemy({ uid: 'e1', hp: 1, poison: 3 })],
    ),
    phase: 'player',
  }
  const next = endPlayerTurn(state)
  assert(next.enemies[0].dead, 'the poison finished the last enemy')
  assertEqual(next.phase, 'won', 'so the combat is won, not lost to the Wrath bite')
})

check('poison resolves before the party takes its own end-of-turn damage', () => {
  const state = {
    ...combat([makePlayer({ id: 'p1', hp: 5 })], [makeEnemy({ uid: 'e1', hp: 10, poison: 2 })]),
    phase: 'player',
  }
  const next = endPlayerTurn(state)
  const poisonLine = next.log.findIndex((line) => line.includes('Poison'))
  assert(poisonLine >= 0, `expected a poison line, got: ${next.log.join(' | ')}`)
  assertEqual(next.enemies[0].hp, 8, 'the enemy lost hit points to poison')
})

check('a lost combat carries the party out of it as it stood', () => {
  // The fold-back for a defeat was untested: survivors' hit points and the
  // dead flag have to come from the COMBAT, not from the run as it was before.
  const run = createRun(77, [
    { id: 'p1', name: 'Ann', character: 'ironclad' },
    { id: 'p2', name: 'Bo', character: 'silent' },
  ])
  const entered = enterRoom(run, roomChoices(run)[0].id)
  const combat = entered.combat
  const hurt = {
    ...entered,
    combat: {
      ...combat,
      phase: 'lost',
      players: combat.players.map((player, i) =>
        i === 0 ? { ...player, hp: 0, dead: true } : { ...player, hp: 3, gold: 12 },
      ),
    },
  }
  const after = resolveCombat(hurt)
  assertEqual(after.phase, 'defeat', 'a lost combat ends the run')
  assert(after.players[0].dead, 'the fallen player is carried out as dead')
  assertEqual(after.players[1].hp, 3, "and the survivor's hit points come from the combat")
  assertEqual(after.players[1].gold, 12, 'as does their gold')
})

check('nothing else resolves once the last enemy is dead', () => {
  // The combat ends immediately (p.13). Letting the rest of the end-of-turn
  // work run anyway killed a player AFTER victory, and the corpse was then
  // folded into the run — where advanceAct healed it back to full.
  const state = {
    ...combat(
      [makePlayer({ id: 'p1', hp: 1, stance: 'wrath' })],
      [makeEnemy({ uid: 'e1', hp: 1, poison: 5 })],
    ),
    phase: 'player',
  }
  const next = endPlayerTurn(state)
  assertEqual(next.phase, 'won', 'the poison finished the last enemy')
  assert(!next.players[0].dead, 'and the Wrath bite never landed')
  assertEqual(next.players[0].hp, 1, 'the player is untouched')
})

check('a discard cost cannot be skipped', () => {
  // Reachable straight off the network: an empty list used to satisfy it, and
  // the card paid nothing.
  const survivor = instance('survivor')
  const spare = instance('strike_silent')
  const state = combat(
    [makePlayer({ id: 'p1', character: 'silent', hand: [survivor, spare], energy: 3 })],
    [makeEnemy()],
  )
  const skipped = playCard(state, 'p1', survivor.uid, { enemyUid: null, playerId: 'p1' })
  assert(skipped === state, 'a Survivor played with nothing discarded must be refused')

  const paid = playCard(state, 'p1', survivor.uid, {
    enemyUid: null,
    playerId: 'p1',
    discardUids: [spare.uid],
  })
  assert(paid !== state, 'and accepted when the cost is paid')
  assertEqual(paid.players[0].discard.length, 2, 'the discarded card and the card itself')
})

check('an exhaust cost cannot be skipped either', () => {
  // The mirror of the discard check. True Grit reads "1 Block to any player.
  // Exhaust a card in your hand." — without this it was 1 Block for free.
  const grit = instance('true_grit')
  const spare = instance('strike_ironclad')
  const state = combat(
    [makePlayer({ id: 'p1', hand: [grit, spare], energy: 3 })],
    [makeEnemy()],
  )
  const skipped = playCard(state, 'p1', grit.uid, { enemyUid: null, playerId: 'p1' })
  assert(skipped === state, 'True Grit with nothing exhausted must be refused')

  const forged = playCard(state, 'p1', grit.uid, {
    enemyUid: null,
    playerId: 'p1',
    exhaustUids: ['not-a-card'],
  })
  assert(forged === state, 'and a uid naming no card in hand pays nothing')

  const paid = playCard(state, 'p1', grit.uid, {
    enemyUid: null,
    playerId: 'p1',
    exhaustUids: [spare.uid],
  })
  assert(paid !== state, 'but it works when the cost is paid')
  assertEqual(paid.players[0].exhaust.length, 1, 'and the card is exhausted')
})

check('the same card cannot pay two separate costs', () => {
  // Two consuming clauses were each validated against the pre-play hand, so
  // one card satisfied both while only one of them actually took it.
  CARDS.fixture_two_costs = {
    id: 'fixture_two_costs',
    name: 'Fixture Two Costs',
    owner: 'ironclad',
    type: 'skill',
    rarity: 'common',
    cost: 0,
    effects: [
      { kind: 'discard', amount: 1 },
      { kind: 'exhaustFromHand', amount: 1 },
    ],
  }
  const greedy = instance('fixture_two_costs')
  const spare = instance('strike_ironclad')
  const second = instance('defend_ironclad')
  const state = combat([makePlayer({ id: 'p1', hand: [greedy, spare, second] })], [makeEnemy()])

  const doubled = playCard(state, 'p1', greedy.uid, {
    enemyUid: null,
    playerId: 'p1',
    discardUids: [spare.uid],
    exhaustUids: [spare.uid],
  })
  assert(doubled === state, 'naming one card for both costs must be refused')

  const paid = playCard(state, 'p1', greedy.uid, {
    enemyUid: null,
    playerId: 'p1',
    discardUids: [spare.uid],
    exhaustUids: [second.uid],
  })
  assert(paid !== state, 'two different cards pay both costs')
})

check('a cost the hand cannot fully pay takes what it can', () => {
  // One spare card against two consuming clauses: you discard it and then have
  // nothing left to exhaust, which is exactly what happens at the table. The
  // play is legal, not refused.
  const greedy = instance('fixture_two_costs')
  const spare = instance('strike_ironclad')
  const state = combat([makePlayer({ id: 'p1', hand: [greedy, spare] })], [makeEnemy()])
  const played = playCard(state, 'p1', greedy.uid, {
    enemyUid: null,
    playerId: 'p1',
    discardUids: [spare.uid],
  })
  assert(played !== state, 'paying as much as the hand allows is legal')
})

check('a discard cost takes what the hand can pay, and no more', () => {
  // Holding nothing else, the cost is paid by discarding nothing — the card is
  // not made unplayable by an empty hand.
  const survivor = instance('survivor')
  const state = combat(
    [makePlayer({ id: 'p1', character: 'silent', hand: [survivor], energy: 3 })],
    [makeEnemy()],
  )
  const played = playCard(state, 'p1', survivor.uid, { enemyUid: null, playerId: 'p1' })
  assert(played !== state, 'the last card in hand can still be played')
})

check('a forged discard uid does not pay the cost', () => {
  const survivor = instance('survivor')
  const spare = instance('strike_silent')
  const state = combat(
    [makePlayer({ id: 'p1', character: 'silent', hand: [survivor, spare], energy: 3 })],
    [makeEnemy()],
  )
  const forged = playCard(state, 'p1', survivor.uid, {
    enemyUid: null,
    playerId: 'p1',
    discardUids: ['not-a-card'],
  })
  assert(forged === state, 'a uid naming no card in hand pays nothing')
})

check('an orb that kills the last enemy stops the Wrath bite', () => {
  // The poison guard and the orb guard each hide the other: delete either one
  // alone and the sibling still ends the combat, so neither was pinned.
  const state = {
    ...combat(
      [makePlayer({ id: 'p1', hp: 1, stance: 'wrath', orbs: ['lightning', null, null] })],
      [makeEnemy({ uid: 'e1', hp: 1 })],
    ),
    phase: 'player',
  }
  const next = endPlayerTurn(state)
  assert(next.enemies[0].dead, 'the Lightning orb finished the last enemy')
  assertEqual(next.phase, 'won', 'so the combat is won')
  assert(!next.players[0].dead, 'and the Wrath bite never landed')
})

check('a death stops a LATER player from winning the combat', () => {
  // The mirror of the check above, and the reason single-player coverage was
  // not enough: the first player dies to the Wrath bite, then the second
  // player's orb kills the last enemy. p.13 — the death happened first, so
  // this is a defeat, not a victory with a corpse in the party.
  const state = {
    ...combat(
      [
        makePlayer({ id: 'p1', row: 0, hp: 1, stance: 'wrath' }),
        makePlayer({ id: 'p2', row: 1, hp: 10, orbs: ['lightning', null, null] }),
      ],
      [makeEnemy({ uid: 'e1', hp: 1 })],
    ),
    phase: 'player',
  }
  const next = endPlayerTurn(state)
  assert(next.players[0].dead, 'the Wrath bite killed the first player')
  assertEqual(next.phase, 'lost', 'so the combat is lost, whatever happened after')
  assert(!next.enemies[0].dead, 'and the second player never got their orb tick')
})

check('a defeated party is never folded back into a live run', () => {
  // What the bug above actually produced downstream: a corpse carried onto the
  // map, healed to full by advanceAct, losing the next combat before anyone
  // acted.
  const run = createRun(88, [
    { id: 'p1', name: 'Ann', character: 'ironclad' },
    { id: 'p2', name: 'Bo', character: 'silent' },
  ])
  const entered = enterRoom(run, roomChoices(run)[0].id)
  const lost = {
    ...entered,
    combat: {
      ...entered.combat,
      phase: 'lost',
      players: entered.combat.players.map((player, i) =>
        i === 0 ? { ...player, hp: 0, dead: true } : player,
      ),
    },
  }
  const after = resolveCombat(lost)
  assertEqual(after.phase, 'defeat', 'a lost combat ends the run rather than continuing it')
})

check('the same card named twice does not pay a cost of two', () => {
  // Without deduplication, `discardUids: ['a','a']` paid a printed "Discard 2"
  // with a single card. The sibling check covers one uid across TWO arrays,
  // which the spent-set catches; this is one uid twice in ONE array.
  CARDS.fixture_discard_two = {
    id: 'fixture_discard_two',
    name: 'Fixture Discard Two',
    owner: 'ironclad',
    type: 'skill',
    rarity: 'common',
    cost: 0,
    effects: [{ kind: 'discard', amount: 2 }],
  }
  const card = instance('fixture_discard_two')
  const spare = instance('strike_ironclad')
  const other = instance('defend_ironclad')
  const state = combat([makePlayer({ id: 'p1', hand: [card, spare, other] })], [makeEnemy()])

  const doubled = playCard(state, 'p1', card.uid, {
    enemyUid: null,
    playerId: 'p1',
    discardUids: [spare.uid, spare.uid],
  })
  assert(doubled === state, 'one card cannot be discarded twice')

  const paid = playCard(state, 'p1', card.uid, {
    enemyUid: null,
    playerId: 'p1',
    discardUids: [spare.uid, other.uid],
  })
  assert(paid !== state, 'two different cards pay it')
  assertEqual(paid.players[0].discard.length, 3, 'both discards plus the card itself')
})

suite('who may play, and when')

// Both of these guards are reachable straight off the network and neither was
// pinned by anything.

check('a card cannot be played outside the Player Turn', () => {
  const strike = instance('strike_ironclad')
  const base = combat([makePlayer({ id: 'p1', hand: [strike] })], [makeEnemy()])
  for (const phase of ['enemy', 'roundEnd', 'won', 'lost']) {
    const parked = { ...base, phase }
    assert(
      playCard(parked, 'p1', strike.uid, { enemyUid: 'e1', playerId: 'p1' }) === parked,
      `a card was played during ${phase}`,
    )
  }
})

check('a fallen player cannot play cards', () => {
  const strike = instance('strike_ironclad')
  const state = combat(
    [makePlayer({ id: 'p1', hand: [strike], hp: 0, dead: true })],
    [makeEnemy()],
  )
  assert(
    playCard(state, 'p1', strike.uid, { enemyUid: 'e1', playerId: 'p1' }) === state,
    'the dead do not act',
  )
})

check('a stale or forged co-op target refuses the whole card play', () => {
  const predator = instance('predator')
  const state = combat(
    [
      makePlayer({ id: 'p1', character: 'silent', hand: [predator], energy: 3 }),
      makePlayer({ id: 'p2', character: 'ironclad', hp: 0, dead: true }),
    ],
    [makeEnemy()],
  )
  for (const playerId of ['not-a-player', '', false, 0, 'p2']) {
    const refused = playCard(state, 'p1', predator.uid, { enemyUid: 'e1', playerId })
    assert(refused === state, `${playerId} redirected Predator to the caster`)
  }
})

check('a bogus uid does not stand in for a real one when paying a cost', () => {
  // `allocate` is the sole validator: it re-checks that each uid is really in
  // hand as the clause resolves. Without that check it would take the bogus
  // uid into its slice and discard nothing, leaving the cost unpaid.
  const survivor = instance('survivor')
  const spare = instance('strike_silent')
  const state = combat(
    [makePlayer({ id: 'p1', character: 'silent', hand: [survivor, spare] })],
    [makeEnemy()],
  )
  const played = playCard(state, 'p1', survivor.uid, {
    enemyUid: null,
    playerId: 'p1',
    discardUids: ['zzz-not-a-card', spare.uid],
  })
  assert(played !== state, 'the real uid in the list pays the cost')
  assert(
    !played.players[0].hand.some((card) => card.uid === spare.uid),
    'and the real card actually left the hand',
  )
})

check('an evoke with no orbs is refused rather than wasted', () => {
  const card = instance('dual_cast')
  const state = combat(
    [makePlayer({ id: 'p1', character: 'defect', hand: [card], orbs: [null, null, null] })],
    [makeEnemy()],
  )
  assert(
    playCard(state, 'p1', card.uid, { enemyUid: 'e1', playerId: 'p1' }) === state,
    'it would otherwise spend the Energy, discard the card and do nothing',
  )
})

// An attack that cannot land should not send the player hunting for a target.
// The UI and the engine ask the same function, so this is one rule rather than
// two that can drift -- which they already did once, in the other direction.
check('an attack that will swing zero times asks for no target', () => {
  const barrage = cardDef('barrage')
  const empty = makePlayer({ character: 'defect', orbs: [null, null, null] })
  const armed = makePlayer({ character: 'defect', orbs: ['frost', null, null] })
  assertEqual(cardNeedsEnemy(barrage, empty), false, 'no orbs, no target to choose')
  assertEqual(cardNeedsEnemy(barrage, armed), true, 'one orb makes it a real attack')
  // The upgraded face prints "+1", so it always swings and always needs one.
  assertEqual(cardNeedsEnemy(faceOf(barrage, true), empty), true, 'Barrage+ always swings')
  // Without a player to ask, the answer has to be the cautious one: a card that
  // might swing still needs its target collected.
  assertEqual(cardNeedsEnemy(barrage), true, 'unknown board means assume it swings')
  // And the engine must then ACCEPT the play with no target, or the UI would
  // stop asking for something the engine still demands.
  const card = instance('barrage')
  const state = combat(
    [makePlayer({ character: 'defect', hand: [card], energy: 3, orbs: [null, null, null] })],
    [makeEnemy({ hp: 20 })],
  )
  const next = playCard(state, 'p1', card.uid, { enemyUid: null, playerId: null })
  assert(next !== state, 'a zero-swing attack with no target was refused')
  assertEqual(next.players[0].energy, 2, 'and still cost its Energy')
})

check('an evoke card hits the exact target carried with its Orb choice', () => {
  // The broad predicate still reports that an evoke can damage an enemy; the
  // UI splits this into its Orb picker and per-evoke target picker.
  assertEqual(cardNeedsEnemy(cardDef('dual_cast')), true, 'Dual Cast needs a target')

  const card = instance('dual_cast')
  const state = combat(
    [makePlayer({ id: 'p1', character: 'defect', hand: [card], orbs: ['lightning', null, null] })],
    [makeEnemy({ uid: 'e1', row: 0, hp: 20 }), makeEnemy({ uid: 'e2', row: 1, hp: 20 })],
  )
  const next = playCard(state, 'p1', card.uid, {
    enemyUid: null,
    playerId: 'p1',
    evokeSlots: [0],
    evokeEnemyUids: ['e2'],
  })
  assertEqual(next.enemies[1].hp, 18, 'the chosen enemy took the orb')
  assertEqual(next.enemies[0].hp, 20, 'and the other did not')
})

check('poison winning the fight suppresses the FIRST player\'s own bite', () => {
  // The guard at the top of the end-of-turn loop. The one after the orbs is
  // separately tested; this one covers the player whose turn it is when the
  // poison tick has already ended the combat.
  const state = {
    ...combat(
      [makePlayer({ id: 'p1', hp: 1, stance: 'wrath' })],
      [makeEnemy({ uid: 'e1', hp: 1, poison: 5 })],
    ),
    phase: 'player',
  }
  const next = endPlayerTurn(state)
  assertEqual(next.phase, 'won', 'the poison finished it')
  assert(!next.players[0].dead, 'so the bite never landed')
  assertEqual(next.players[0].hp, 1, 'and the player is untouched')
})

check('an orb behind a lethal one does not resolve', () => {
  // The guard INSIDE the orb loop, as opposed to the one around it.
  const state = {
    ...combat(
      [makePlayer({ id: 'p1', orbs: ['lightning', 'frost', null] })],
      [makeEnemy({ uid: 'e1', hp: 1 })],
    ),
    phase: 'player',
  }
  const next = endPlayerTurn(state)
  assert(next.enemies[0].dead, 'the Lightning orb killed it')
  assertEqual(next.players[0].block, 0, 'and the Frost orb behind it gave nothing')
  assert(
    !next.log.some((line) => /Frost orb/.test(line)),
    `nor wrote a line: ${next.log.join(' | ')}`,
  )
})

check('plain damage is not modified the way a hit is', () => {
  // The defining difference between the two effects, and it was untested: a
  // hit takes Strength, Weak and Vulnerable; plain damage takes none of them.
  CARDS.fixture_plain_damage = {
    id: 'fixture_plain_damage',
    name: 'Fixture Plain Damage',
    owner: 'ironclad',
    type: 'attack',
    rarity: 'common',
    cost: 0,
    effects: [{ kind: 'damage', amount: 2 }],
  }
  const card = instance('fixture_plain_damage')
  const next = playCard(
    combat(
      [makePlayer({ id: 'p1', hand: [card], strength: 3 })],
      [makeEnemy({ uid: 'e1', hp: 20, vulnerable: 2 })],
    ),
    'p1',
    card.uid,
    { enemyUid: 'e1', playerId: 'p1' },
  )
  assertEqual(next.enemies[0].hp, 18, '2 damage, not 2+3 doubled')
})

check('losing hit points ignores Block entirely', () => {
  CARDS.fixture_lose_hp = {
    id: 'fixture_lose_hp',
    name: 'Fixture Lose HP',
    owner: 'ironclad',
    type: 'skill',
    rarity: 'common',
    cost: 0,
    effects: [{ kind: 'loseHp', amount: 3 }],
  }
  const card = instance('fixture_lose_hp')
  const next = playCard(
    combat([makePlayer({ id: 'p1', hand: [card] })], [makeEnemy({ uid: 'e1', hp: 20, block: 10 })]),
    'p1',
    card.uid,
    { enemyUid: 'e1', playerId: 'p1' },
  )
  assertEqual(next.enemies[0].hp, 17, 'the Block did not absorb any of it')
  assertEqual(next.enemies[0].block, 10, 'and none of it was spent')
})

check('Poison is capped across the whole table, not per enemy', () => {
  CARDS.fixture_poison = {
    id: 'fixture_poison',
    name: 'Fixture Poison',
    owner: 'silent',
    type: 'skill',
    rarity: 'common',
    cost: 0,
    effects: [{ kind: 'poison', amount: 10 }],
  }
  const card = instance('fixture_poison')
  const next = playCard(
    combat(
      [makePlayer({ id: 'p1', character: 'silent', hand: [card] })],
      [makeEnemy({ uid: 'e1', hp: 40, poison: 25 }), makeEnemy({ uid: 'e2', row: 1, hp: 40 })],
    ),
    'p1',
    card.uid,
    { enemyUid: 'e1', playerId: 'p1' },
  )
  // 25 already on the table, so only 5 of the 10 can go on.
  assertEqual(next.enemies[0].poison, 30, 'the shared cap of 30 bounds the table')
})

check('a row card with no anchor is refused, not turned into a board wipe', () => {
  CARDS.fixture_row_hit = {
    id: 'fixture_row_hit',
    name: 'Fixture Row Hit',
    owner: 'ironclad',
    type: 'attack',
    rarity: 'common',
    cost: 0,
    target: 'row',
    effects: [{ kind: 'hit', amount: 1 }],
  }
  const card = instance('fixture_row_hit')
  const state = combat(
    [makePlayer({ id: 'p1', hand: [card] })],
    [makeEnemy({ uid: 'e1', row: 0, hp: 10 }), makeEnemy({ uid: 'e2', row: 1, hp: 10 })],
  )
  assert(
    playCard(state, 'p1', card.uid, { enemyUid: null, playerId: 'p1' }) === state,
    'a row card with no anchor must be refused',
  )
  assert(
    playCard(state, 'p1', card.uid, { enemyUid: 'gone', playerId: 'p1' }) === state,
    'and a stale anchor too',
  )
})

check('the campfire only works at a campfire', () => {
  // The engine function is exported and the local UI calls it directly, so it
  // cannot rely on the room layer's guard.
  const run = createRun(31, [{ id: 'p1', name: 'Ann', character: 'ironclad' }])
  const otherRoom = Object.values(run.map.rooms).find((room) => room.kind !== 'campfire')
  assert(otherRoom, 'precondition: the act should contain a non-campfire room')
  const parked = { ...run, phase: 'room', map: { ...run.map, position: otherRoom.id } }
  assert(
    resolveCampfire(parked, { p1: { choice: 'rest' } }) === parked,
    'resting in a non-campfire room must be refused',
  )
})

suite('guards that stop an exploit')

// Every check here was proven deletable by mutation testing. None of them was
// a live bug — the shipped code is right — but each is the only thing between
// a client and something farmable.

check('a crafted orb slot is refused by the ENGINE, not just the transport', () => {
  // The room layer sanitises these, so a test that goes through `apply` can
  // never see the engine's own guard. Both layers were mutually masking.
  const card = instance('dual_cast')
  for (const crafted of [['length'], ['__proto__'], ['constructor'], ['0'], [1.5], [null]]) {
    const state = combat(
      [makePlayer({ id: 'p1', character: 'defect', hand: [card], orbs: ['lightning', null, null] })],
      [makeEnemy({ uid: 'e1', hp: 20 })],
    )
    let threw = null
    let next = state
    try {
      next = playCard(state, 'p1', card.uid, { enemyUid: 'e1', playerId: 'p1', evokeSlots: crafted })
    } catch (error) {
      threw = error
    }
    assertEqual(threw, null, `${String(crafted[0])} threw ${threw?.message}`)
    assert(next === state, `${String(crafted[0])} was not refused atomically`)
    assertEqual(next.players[0].orbs.length, 3, `${String(crafted[0])} changed the slot count`)
    assertEqual(next.enemies[0].hp, 20, `${String(crafted[0])} damaged an enemy on a refused play`)
  }
})

check('an empty but valid slot is refused instead of changing the choice', () => {
  const card = instance('dual_cast')
  const state = combat(
    [makePlayer({ id: 'p1', character: 'defect', hand: [card], orbs: ['lightning', null, null] })],
    [makeEnemy({ uid: 'e1', hp: 20 })],
  )
  const next = playCard(state, 'p1', card.uid, {
    enemyUid: 'e1',
    playerId: 'p1',
    evokeSlots: [2],
  })
  assert(next === state, 'naming an empty slot must leave the card available for a corrected choice')
})

check('a room already occupied cannot be re-entered to farm it', () => {
  // After a win the party stands on the map WITH a position, which is the
  // state the reachability guard actually has to refuse.
  const run = createRun(31, [{ id: 'p1', name: 'Ann', character: 'ironclad' }])
  const entered = enterRoom(run, roomChoices(run)[0].id)
  const rewarded = resolveCombat({
    ...entered,
    combat: {
      ...entered.combat,
      phase: 'won',
      enemies: entered.combat.enemies.map((foe) => ({ ...foe, hp: 0, dead: true })),
    },
  })
  const won = resolveCardRewards(
    rewarded,
    Object.fromEntries(rewarded.rewards.map((offer) => [offer.playerId, null])),
  )
  assertEqual(won.phase, 'map', 'precondition: back on the map with a position')
  assert(won.map.position !== null, 'precondition: the boot has moved')
  assert(enterRoom(won, won.map.position) === won, 'the room just cleared cannot be re-entered')
  // The boss sits at the far end of the act, so it is never an exit from the
  // opening room — picking "any other room" would have caught a legal
  // neighbour instead.
  const boss = Object.values(won.map.rooms).find((room) => room.kind === 'boss')
  assert(boss, 'precondition: the act ends at a boss')
  assert(enterRoom(won, boss.id) === won, 'nor can the boss be jumped to')
})

check('a campfire cannot be rested at twice', () => {
  // resolveCampfire leaves the map position on the campfire, so without the
  // phase guard the same message heals another 3 every time it is re-sent.
  const run = createRun(41, [{ id: 'p1', name: 'Ann', character: 'ironclad' }])
  const campfire = Object.values(run.map.rooms).find((room) => room.kind === 'campfire')
  const parked = {
    ...run,
    phase: 'room',
    map: { ...run.map, position: campfire.id },
    players: run.players.map((player) => ({ ...player, hp: 1 })),
  }
  const rested = resolveCampfire(parked, { p1: { choice: 'rest' } })
  assertEqual(rested.players[0].hp, 4, 'precondition: the first rest heals 3')
  assert(
    resolveCampfire(rested, { p1: { choice: 'rest' } }) === rested,
    'a second rest at the same campfire must be refused',
  )
})

check('the boss cannot be skipped to reach the next Act', () => {
  // isActComplete is already true DURING the boss fight, because the boss room
  // counts as visited — so the phase guard is the only thing stopping a client
  // from healing to full and opening Act 2.
  const run = createRun(51, [{ id: 'p1', name: 'Ann', character: 'ironclad' }])
  const boss = Object.values(run.map.rooms).find((room) => room.kind === 'boss')
  const fighting = {
    ...run,
    phase: 'combat',
    map: { ...run.map, position: boss.id, rooms: { ...run.map.rooms, [boss.id]: { ...boss, visited: true } } },
    players: run.players.map((player) => ({ ...player, hp: 2 })),
  }
  assert(advanceAct(fighting) === fighting, 'the Act cannot be advanced mid-boss')
  assertEqual(fighting.players[0].hp, 2, 'and nobody was healed')
})

check('the map offers no rooms while a fight is on', () => {
  const run = createRun(61, [{ id: 'p1', name: 'Ann', character: 'ironclad' }])
  const fighting = enterRoom(run, roomChoices(run)[0].id)
  assertEqual(fighting.phase, 'combat', 'precondition: in a fight')
  assertEqual(roomChoices(fighting).length, 0, 'the map must offer nothing mid-combat')
})


suite('what the printed cards actually do')

// Every card below was read off a scan. These checks exist because a
// transcription error is invisible: the card plays, the numbers look
// plausible, and only the printed face says otherwise. Each one asserts the
// OUTCOME on the board, not that some effect list has a given shape.

check('a numeral repeats the symbol rather than scaling it', () => {
  // Dagger Spray prints "AoE 1x 1x" and its upgrade prints three. That is two
  // separate hits for 1, not one hit for 2.
  //
  // Block does NOT tell the two apart -- it is a depleting pool, so against 1
  // Block both shapes leak exactly 1. Strength does, because it is added to
  // every hit: two hits at 1+1 deal 4, where one hit at 2+1 would deal 3.
  const spray = instance('dagger_spray')
  const buffed = playCard(
    combat(
      [makePlayer({ character: 'silent', hand: [spray], strength: 1 })],
      [makeEnemy({ hp: 20 })],
    ),
    'p1',
    spray.uid,
    { enemyUid: 'e1', playerId: null },
  )
  assertEqual(buffed.enemies[0].hp, 16, 'Strength is added to each of the two hits, not once')

  const open = instance('dagger_spray')
  const through = playCard(
    combat([makePlayer({ character: 'silent', hand: [open] })], [makeEnemy({ hp: 9 })]),
    'p1',
    open.uid,
    { enemyUid: 'e1', playerId: null },
  )
  assertEqual(through.enemies[0].hp, 7, 'unblocked, both hits land')

  const upgraded = instance('dagger_spray', true)
  const thrice = playCard(
    combat([makePlayer({ character: 'silent', hand: [upgraded] })], [makeEnemy({ hp: 9 })]),
    'p1',
    upgraded.uid,
    { enemyUid: 'e1', playerId: null },
  )
  assertEqual(thrice.enemies[0].hp, 6, 'the upgraded face prints a third dagger')
})

check('a bare symbol means one', () => {
  // Deadly Poison prints a single poison skull with no numeral. Its upgraded
  // face prints the same single skull for no energy, and Poisoned Stab+ prints
  // two skulls where the base card prints one -- so a lone symbol is 1, not
  // some unprinted default.
  const dose = instance('deadly_poison')
  const one = playCard(
    combat([makePlayer({ character: 'silent', hand: [dose] })], [makeEnemy()]),
    'p1',
    dose.uid,
    { enemyUid: 'e1', playerId: null },
  )
  assertEqual(one.enemies[0].poison, 1, 'one skull is one Poison')
  assertEqual(one.players[0].energy, 2, 'and the base face costs 1')

  const free = instance('deadly_poison', true)
  const upgraded = playCard(
    combat([makePlayer({ character: 'silent', hand: [free] })], [makeEnemy()]),
    'p1',
    free.uid,
    { enemyUid: 'e1', playerId: null },
  )
  assertEqual(upgraded.enemies[0].poison, 1, 'the upgrade changes the cost, not the dose')
  assertEqual(upgraded.players[0].energy, 3, 'and it is free')

  const stab = instance('poisoned_stab', true)
  const two = playCard(
    combat([makePlayer({ character: 'silent', hand: [stab] })], [makeEnemy()]),
    'p1',
    stab.uid,
    { enemyUid: 'e1', playerId: null },
  )
  assertEqual(two.enemies[0].poison, 2, 'two skulls are two Poison')
})

check('the burst symbol hits a whole row', () => {
  // Cleave, Consecrate and Dagger Spray all print the red burst. It takes the
  // row, so a second enemy standing in it is hit by the same card -- and one
  // in another row is not.
  const cleave = instance('cleave')
  const swept = playCard(
    combat(
      [makePlayer({ hand: [cleave] })],
      [
        makeEnemy({ uid: 'a', row: 0, hp: 9 }),
        makeEnemy({ uid: 'b', row: 0, hp: 9 }),
        makeEnemy({ uid: 'c', row: 1, hp: 9 }),
      ],
    ),
    'p1',
    cleave.uid,
    { enemyUid: 'a', playerId: null },
  )
  assertEqual(swept.enemies[0].hp, 7, 'the chosen enemy is hit')
  assertEqual(swept.enemies[1].hp, 7, 'so is the one beside it')
  assertEqual(swept.enemies[2].hp, 9, 'the next row is untouched')
})

check('Poisoned Stab exhausts itself, and Cleave does not', () => {
  const stab = instance('poisoned_stab')
  const spent = playCard(
    combat([makePlayer({ character: 'silent', hand: [stab] })], [makeEnemy()]),
    'p1',
    stab.uid,
    { enemyUid: 'e1', playerId: null },
  )
  assertEqual(spent.players[0].exhaust.length, 1, 'the card is exhausted')
  assertEqual(spent.players[0].discard.length, 0, 'and never reaches the discard pile')

  const cleave = instance('cleave')
  const kept = playCard(
    combat([makePlayer({ hand: [cleave] })], [makeEnemy()]),
    'p1',
    cleave.uid,
    { enemyUid: 'e1', playerId: null },
  )
  assertEqual(kept.players[0].exhaust.length, 0, 'Cleave prints no Exhaust')
  assertEqual(kept.players[0].discard.length, 1, 'so it goes to the discard pile')
})

check('a consuming clause that goes unpaid refuses the whole play', () => {
  // The discard is the COST. Off the network an empty or invented uid list
  // would otherwise buy the card's effects for nothing, so the refusal has to
  // survive resolution: the card is resolved into a clone and the clone thrown
  // away, signalled by handing back the very same reference.
  const survivor = instance('survivor')
  const spare = instance('strike_silent')
  const state = combat(
    [makePlayer({ character: 'silent', hand: [survivor, spare] })],
    [makeEnemy()],
  )
  const base = { enemyUid: null, playerId: null }
  assert(
    playCard(state, 'p1', survivor.uid, { ...base, discardUids: [] }) === state,
    'naming no card at all must be refused',
  )
  assert(
    playCard(state, 'p1', survivor.uid, { ...base, discardUids: ['not-a-card'] }) === state,
    'naming a card that does not exist must be refused',
  )
  assert(
    playCard(state, 'p1', survivor.uid, { ...base, discardUids: [survivor.uid] }) === state,
    'the card being played has left hand and cannot pay for itself',
  )
  assert(
    playCard(state, 'p1', survivor.uid, { ...base, discardUids: [spare.uid, spare.uid] }) !==
      state,
    'naming the same card twice still pays the one card it owes',
  )
  // A refused play must leave nothing behind at all.
  const refused = playCard(state, 'p1', survivor.uid, { ...base, discardUids: [] })
  assertEqual(refused, state, 'the refusal is the same reference')
  assertEqual(state.players[0].energy, 3, 'and no energy was taken on the way')

  // True Grit exhausts rather than discards; the same rule holds.
  const grit = instance('true_grit')
  const fodder = instance('strike_ironclad')
  const ironclad = combat([makePlayer({ hand: [grit, fodder] })], [makeEnemy()])
  assert(
    playCard(ironclad, 'p1', grit.uid, { ...base, exhaustUids: [] }) === ironclad,
    'an unpaid exhaust cost is refused the same way',
  )
})

check('a cost larger than the hand is paid by whatever the hand holds', () => {
  // "Discard 1" with nothing else in hand is settled by discarding nothing, as
  // it would be at the table -- the card is not stuck in limbo. Survivor is the
  // live card that reaches this: its Block resolves BEFORE its discard, so the
  // hand it is paid from is the hand the player could actually see.
  const survivor = instance('survivor')
  const state = combat(
    [makePlayer({ character: 'silent', hand: [survivor], draw: [] })],
    [makeEnemy()],
  )
  const next = playCard(state, 'p1', survivor.uid, {
    enemyUid: null,
    playerId: null,
    discardUids: [],
  })
  assert(next !== state, 'an otherwise empty hand still lets the card resolve')
  assert(next.players[0].block > 0, 'and the Block half is paid out')
  assertEqual(next.players[0].hand.length, 0, 'there was nothing to discard')
})

check('every newly transcribed card does what its face prints', () => {
  // One expected BOARD OUTCOME per card, per face.
  //
  // This replaces a sweep that asserted `playCard(...) !== state`. That can
  // never fail for an accepted play: the card leaves hand and the energy is
  // spent before any effect resolves, so the clone always differs. Eleven of
  // these cards could lose a whole printed clause -- Ball Lightning its orb,
  // Clothesline its Weak, Pommel Strike its draw -- with the entire suite
  // green. State inequality proves "not refused", never "the text happened".
  const E = 6
  const CASES = [
    { id: 'cleave', enemyHp: [18, 17] },
    { id: 'clothesline', enemyHp: [17, 16], weak: [1, 1] },
    { id: 'pommel_strike', enemyHp: [18, 18], hand: [1, 2] },
    { id: 'shrug_it_off', block: [2, 3], hand: [1, 1] },
    { id: 'deadly_poison', poison: [1, 1], energy: [E - 1, E] },
    { id: 'poisoned_stab', enemyHp: [19, 19], poison: [1, 2], exhaust: [1, 1] },
    { id: 'dagger_spray', enemyHp: [18, 17] },
    { id: 'backflip', block: [1, 2], hand: [2, 2] },
    { id: 'ball_lightning', enemyHp: [19, 18], orb: ['lightning', 'lightning'] },
    { id: 'cold_snap', enemyHp: [18, 17], orb: ['frost', 'frost'] },
    { id: 'coolheaded', orb: ['frost', 'frost'], hand: [0, 1] },
    { id: 'consecrate', enemyHp: [19, 18] },
    { id: 'empty_body', block: [2, 3], stance: ['neutral', 'neutral'] },
    // Started in Wrath (below), which is worth +1 damage (p.17), so the
    // printed 2 and 3 land as 3 and 4.
    { id: 'empty_fist', enemyHp: [17, 16], stance: ['neutral', 'neutral'] },
    { id: 'collect', miracles: [2, 3], exhaust: [1, 1] },
    { id: 'halt', block: [1, 1] },
    { id: 'body_slam', enemyHp: [18, 18], player: { block: 2 }, energy: [E - 1, E] },
    { id: 'heavy_blade', enemyHp: [17, 17] },
    { id: 'seeing_red', energy: [4, 5], exhaust: [1, 1], player: { energy: 3 } },
    { id: 'wild_strike', enemyHp: [17, 16], daze: [1, 1] },
    { id: 'power_through', block: [3, 4], daze: [1, 1] },
    { id: 'flame_barrier', block: [3, 4] },
    { id: 'rampage', enemyHp: [20, 20] },
    { id: 'exhume', exhaust: [1, 1], energy: [E - 1, E] },
    { id: 'blade_dance', shivs: [2, 3] },
    { id: 'cloak_and_dagger', block: [1, 1], shivs: [1, 2] },
    { id: 'sneaky_strike', enemyHp: [17, 16] },
    { id: 'terror', vulnerable: [1, 1], exhaust: [1, 0] },
    { id: 'backstab', enemyHp: [16, 14], exhaust: [1, 1] },
    { id: 'predator', enemyHp: [17, 16], hand: [2, 2] },
    { id: 'leg_sweep', block: [3, 4], weak: [1, 1] },
    { id: 'sweeping_beam', enemyHp: [19, 18], hand: [1, 1] },
    { id: 'compile_driver', enemyHp: [19, 18] },
    { id: 'scrape', enemyHp: [18, 17] },
    { id: 'turbo', energy: [5, 6], exhaust: [1, 1], dazeDiscard: [1, 1], player: { energy: 3 } },
    { id: 'skim', hand: [3, 4] },
    { id: 'claw', enemyHp: [19, 19] },
    { id: 'crescendo', hand: [0, 1], stance: ['wrath', 'wrath'], initialStance: 'neutral' },
    { id: 'flurry_of_blows', enemyHp: [19, 19] },
    { id: 'flying_sleeves', enemyHp: [18, 17] },
    { id: 'protect', block: [3, 4] },
    { id: 'tranquility', stance: ['calm', 'calm'], initialStance: 'neutral', energy: [2, 3], player: { energy: 3 } },
    { id: 'empty_mind', hand: [2, 3], stance: ['neutral', 'neutral'] },
    { id: 'crush_joints', enemyHp: [19, 18], vulnerable: [0, 0] },
    { id: 'fear_no_evil', enemyHp: [18, 17] },

    // The conditional cards, with their condition switched OFF: no shivs, no
    // orbs, an empty discard pile, and `createCombat`'s die showing 1. This is
    // the printed number alone, which is the half a bonus must not leak into.
    // The block below turns each condition on.
    { id: 'slice', enemyHp: [19, 18] },
    { id: 'deflect', block: [1, 2] },
    { id: 'bane', enemyHp: [18, 17] },
    { id: 'steam_barrier', block: [1, 2] },
    // No orbs charged, so the base face swings zero times and the upgraded face
    // -- which prints "+1" -- swings once.
    { id: 'barrage', enemyHp: [20, 19] },
    { id: 'go_for_the_eyes', enemyHp: [19, 19], weak: [0, 1] },
    { id: 'charge_battery', block: [2, 3] },
    { id: 'inflame', strength: [1, 1] },
    { id: 'disarm', weak: [2, 3], exhaust: [1, 1] },
    { id: 'shockwave', vulnerable: [1, 1], weak: [1, 2], exhaust: [1, 1] },
    { id: 'dagger_throw', enemyHp: [18, 17], hand: [0, 0], discardAfterDraw: true },
    { id: 'carnage', enemyHp: [16, 14] },
    { id: 'ghostly_armor', block: [2, 3] },
    { id: 'prepared', hand: [0, 0], discardAfterDraw: [1, 2] },
    { id: 'beam_cell', enemyHp: [19, 19], vulnerable: [1, 1] },
    { id: 'ftl', enemyHp: [19, 18], hand: [1, 1] },
    { id: 'force_field', block: [3, 4] },
    { id: 'tempest', energySpent: [1, 1], energy: [E - 1, E - 1], orb: ['lightning', 'lightning'], exhaust: [1, 1] },
    { id: 'blizzard', enemyHp: [20, 20] },
    { id: 'hologram', block: [1, 1], exhaust: [1, 0] },
    { id: 'storm', powers: [1, 1] },
    { id: 'doom_and_gloom', enemyHp: [18, 17], orb: ['dark', 'dark'] },
    { id: 'overclock', hand: [2, 3], dazeDiscard: [1, 1] },
    { id: 'prostrate', block: [1, 2], miracles: [1, 1] },
    { id: 'riddle_with_holes', shivs: [4, 5] },
    { id: 'battle_trance', hand: [3, 4] },
    { id: 'rupture', strength: [1, 1] },
    { id: 'whirlwind', enemyHp: [20, 19], energySpent: [0, 0] },
    { id: 'skewer', enemyHp: [19, 20], energySpent: [0, 0] },
    { id: 'burning_pact', hand: [2, 3] },
    { id: 'sever_soul', enemyHp: [17, 16] },
    { id: 'second_wind', block: [0, 0] },
    { id: 'sentinel', block: [2, 3], energy: [E - 1, E - 1] },
    { id: 'fiend_fire', enemyHp: [20, 20], exhaust: [1, 1] },
    { id: 'limit_break', strength: [0, 0], exhaust: [1, 0], energy: [E - 1, E - 1] },
    { id: 'feed', enemyHp: [17, 17], strength: [0, 0], exhaust: [1, 1] },
    { id: 'corruption', powers: [1, 1], energy: [E - 3, E - 2] },
    { id: 'barricade', powers: [1, 1], energy: [E - 2, E - 1] },
    { id: 'entrench', block: [0, 0], exhaust: [1, 0] },
    { id: 'clash', enemyHp: [17, 16] },
    { id: 'spot_weakness', strength: [1, 1] },
    { id: 'rage', block: [0, 0], energy: [E - 1, E] },
    { id: 'blood_for_blood', enemyHp: [16, 16], energy: [E - 3, E - 3] },
    { id: 'pray', hand: [2, 2], miracles: [1, 2] },
    { id: 'darkness', orb: ['dark', 'dark'] },
    { id: 'machine_learning', powers: [1, 1] },
    { id: 'dash', enemyHp: [18, 17], block: [2, 3] },
    { id: 'leap', block: [2, 3] },
    { id: 'bludgeon', enemyHp: [13, 10] },
    { id: 'impervious', block: [6, 8], exhaust: [1, 1] },
    { id: 'cut_through_fate', enemyHp: [19, 18], hand: [1, 1] },
    { id: 'just_lucky', enemyHp: [19, 18] },
    { id: 'uppercut', enemyHp: [17, 17], vulnerable: [1, 2], weak: [1, 1] },
    { id: 'offering', player: { energy: 3 }, energy: [5, 5], hand: [3, 5], exhaust: [1, 1] },
    { id: 'die_die_die', enemyHp: [17, 16], exhaust: [1, 1] },
    { id: 'rainbow', orb: ['lightning', 'lightning'], exhaust: [1, 0] },
    { id: 'immolate', enemyHp: [15, 13], daze: [2, 2] },
    { id: 'piercing_wail', block: [1, 3], weak: [1, 1], exhaust: [1, 1] },
    { id: 'crippling_cloud', poison: [1, 2], weak: [1, 1], exhaust: [1, 1] },
    { id: 'glacier', block: [2, 3], orb: ['frost', 'frost'] },
    { id: 'finesse', block: [1, 1], hand: [1, 1], exhaust: [1, 0] },
    { id: 'flash_of_steel', enemyHp: [19, 19], hand: [1, 1], exhaust: [1, 0] },
    { id: 'good_instincts', block: [1, 2] },
    { id: 'swift_strike', enemyHp: [19, 18] },
    { id: 'blind', weak: [1, 2], exhaust: [1, 1] },
    { id: 'dramatic_entrance', enemyHp: [17, 15], exhaust: [1, 1] },
    { id: 'master_of_strategy', hand: [3, 4], exhaust: [1, 1] },
    { id: 'trip', vulnerable: [2, 3], exhaust: [1, 1] },
    { id: 'impatience', hand: [2, 3] },
    { id: 'mind_blast', enemyHp: [20, 19] },
    { id: 'hand_of_greed', enemyHp: [16, 16] },
    { id: 'panacea', exhaust: [1, 1] },
    { id: 'purity', exhaust: [1, 1] },
    { id: 'apparition', exhaust: [1, 1] },
    { id: 'dark_shackles', block: [2, 3], exhaust: [1, 1] },
    { id: 'madness', exhaust: [1, 1] },
    { id: 'panache', powers: [1, 1] },
    { id: 'apotheosis', powers: [1, 1], energy: [E - 2, E - 1] },
    { id: 'the_bomb', powers: [1, 1], energy: [E - 2, E - 2] },
    { id: 'sadistic_nature', powers: [1, 1] },
    { id: 'thinking_ahead', hand: [1, 2], exhaust: [1, 1], topdeckAfterDraw: true },
    { id: 'warcry', hand: [1, 2], exhaust: [1, 1], topdeckAfterDraw: true },
    { id: 'havoc', hand: [1, 1] },
    { id: 'combust', powers: [1, 1], energy: [E - 1, E - 1] },
    { id: 'evolve', powers: [1, 1], energy: [E - 1, E] },
    { id: 'double_tap', energy: [E - 1, E] },
    { id: 'perfected_strike', enemyHp: [17, 17] },
    { id: 'headbutt', enemyHp: [18, 17] },
    { id: 'mayhem', powers: [1, 1], energy: [E - 2, E - 1] },
    { id: 'reprogram', strength: [1, 1], energy: [E - 1, E] },
    { id: 'melter', enemyHp: [18, 17] },
    { id: 'hyperbeam', enemyHp: [15, 13] },
    { id: 'sunder', enemyHp: [15, 13] },
    { id: 'fusion', powers: [1, 1], energy: [E - 2, E - 1] },
    { id: 'heatsinks', powers: [1, 1] },
    { id: 'stack', block: [0, 1] },
    { id: 'capacitor', powers: [1, 1] },
    { id: 'consume', powers: [1, 1] },
    { id: 'defragment', powers: [1, 1], energy: [E - 3, E - 3] },
    { id: 'static_discharge', powers: [1, 1], energy: [E - 2, E - 2] },
    { id: 'amplify', powers: [1, 1], energy: [E - 1, E - 1] },
    { id: 'core_surge', enemyHp: [17, 16] },
    { id: 'all_for_one', enemyHp: [18, 17] },
    { id: 'thunder_strike', enemyHp: [20, 20] },
    { id: 'reinforced_body', block: [2, 0], energySpent: [1, 0], energy: [E - 1, E] },
    { id: 'double_energy', energy: [6, 6], exhaust: [1, 1] },
    { id: 'streamline', enemyHp: [17, 16] },
    { id: 'meteor_strike', enemyHp: [10, 8] },
    { id: 'catalyst', exhaust: [1, 1] },
    { id: 'flechettes', enemyHp: [20, 19] },
    { id: 'adrenaline', energy: [6, 6], hand: [2, 2], exhaust: [1, 1] },
    { id: 'grand_finale', player: { draw: [] }, enemyHp: [10, 8] },
    { id: 'blur', block: [2, 3] },
    { id: 'setup', player: { energy: 3 }, energy: [4, 5], exhaust: [1, 1] },
    { id: 'all_out_attack', enemyHp: [18, 17] },
    { id: 'expertise', hand: [6, 6] },
    { id: 'calculated_gamble', exhaust: [1, 0] },
    { id: 'reflex', unplayable: true },
    { id: 'tactician', unplayable: true },
    { id: 'after_image', powers: [1, 1] },
    { id: 'escape_plan', block: [1, 1], hand: [1, 1], player: { draw: [instance('defend_silent')] } },
    { id: 'finisher', enemyHp: [20, 20] },
    { id: 'masterful_stab', enemyHp: [18, 17], energy: [E, E] },
    { id: 'outmaneuver', energy: [5, 6], player: { energy: 3 }, retained: true },
    { id: 'accuracy', powers: [1, 1], energy: [E - 1, E] },
    { id: 'choke', enemyHp: [17, 16] },
    { id: 'footwork', powers: [1, 1], energy: [E - 2, E - 2] },
    { id: 'infinite_blades', powers: [1, 1], energy: [E - 1, E - 1] },
    { id: 'noxious_fumes', powers: [1, 1], energy: [E - 1, E - 1] },
    { id: 'envenom', powers: [1, 1], energy: [E - 3, E - 2] },
    { id: 'dodge_and_roll', block: [2, 3] },
    { id: 'bouncing_flask', poison: [2, 3] },
    { id: 'concentrate', energy: [1, 2], player: { energy: 1 } },
    { id: 'distraction', powers: [1, 1], energy: [E - 2, E - 1] },
    { id: 'storm_of_steel', shivs: [0, 1] },
    { id: 'unload', enemyHp: [18, 18] },
  ]

  // A hardcoded list silently stops covering card sixteen. Everything outside
  // the original hand-built set must appear here, so adding a card without an
  // expected outcome fails rather than passing unnoticed.
  const LEGACY = new Set([
    'strike_ironclad', 'defend_ironclad', 'bash', 'twin_strike', 'true_grit', 'anger', 'flex', 'iron_wave',
    'metallicize', 'demon_form', 'feel_no_pain', 'dark_embrace',
    'strike_silent', 'defend_silent', 'neutralize', 'survivor', 'acrobatics',
    'strike_defect', 'defend_defect', 'zap', 'dual_cast', 'chaos', 'recursion',
    'strike_watcher', 'defend_watcher', 'eruption', 'vigilance', 'third_eye',
    'daze', 'clumsy', 'decay', 'doubt', 'injury', 'pain', 'parasite', 'regret',
    'shame', 'writhe', 'ascenders_bane',
  ])
  const covered = new Set(CASES.map((spec) => spec.id))
  // Checks earlier in THIS process register `fixture_*` cards into the table;
  // they are scaffolding, not printed cards.
  const uncovered = Object.keys(CARDS).filter(
    (id) => !id.startsWith('fixture_') && !LEGACY.has(id) && !covered.has(id),
  )
  assertEqual(
    uncovered.length,
    0,
    `these cards have no expected outcome and could lose a clause unnoticed: ${uncovered.join(', ')}`,
  )

  for (const spec of CASES) {
    const def = CARDS[spec.id]
    assert(def, `${spec.id} should be defined`)
    for (const upgraded of [false, true]) {
      const at = upgraded ? 1 : 0
      const label = `${spec.id}${upgraded ? '+' : ''}`
      const card = { ...instance(spec.id, upgraded), retainedLastTurn: spec.retained || undefined }
      const state = {
        ...combat(
          [
            makePlayer({
              character: def.owner,
              hand: [card],
              draw: Array.from({ length: 6 }, () => instance('strike_ironclad')),
              energy: E,
              // Entering Neutral is invisible from Neutral, so the stance cards
              // start in Wrath -- otherwise the clause could be deleted outright
              // and the check would still see the stance it expected.
              stance: spec.initialStance ?? (spec.stance ? 'wrath' : 'neutral'),
              ...spec.player,
            }),
          ],
          [makeEnemy({ hp: 20, maxHp: 20 })],
        ),
        // Real play calls startPlayerTurn before cards can be used.
        turn: 1,
      }
      const face = faceOf(def, upgraded)
      const context = {
        enemyUid: cardNeedsEnemy(face) ? 'e1' : null,
        playerId: null,
      }
      if (face.cost === 'X') context.energySpent = spec.energySpent?.[at] ?? 0
      const enemyChoices = face.effects.reduce(
        (sum, effect) => sum + (effect.kind === 'poisonChoices' ? effect.targets : 0), 0)
      const playerChoices = face.effects.reduce(
        (sum, effect) => sum + (effect.kind === 'blockChoices' ? effect.targets : 0), 0)
      if (enemyChoices > 0) context.enemyUids = Array(enemyChoices).fill('e1')
      if (playerChoices > 0) context.playerIds = Array(playerChoices).fill('p1')
      if (face.effects.some((effect) => effect.kind === 'discardAny')) context.discardUids = []
      if (face.effects.some((effect) => effect.kind === 'exhaustAny')) context.exhaustUids = []
      if (spec.unplayable) {
        assertEqual(playCard(state, 'p1', card.uid, context), state, `${label} should be unplayable`)
        continue
      }
      if (spec.discardAfterDraw) {
        const amount = Array.isArray(spec.discardAfterDraw) ? spec.discardAfterDraw[at] : 1
        context.discardUids = previewCardChoice(state, 'p1', card.uid).cards.slice(0, amount).map((held) => held.uid)
      }
      if (spec.topdeckAfterDraw) {
        context.topdeckUids = previewCardChoice(state, 'p1', card.uid).cards.slice(0, 1).map((held) => held.uid)
      }
      const next = playCard(state, 'p1', card.uid, context)
      assert(next !== state, `${label} was refused outright`)
      const me = next.players[0]
      const foe = next.enemies[0]

      if (spec.enemyHp) assertEqual(foe.hp, spec.enemyHp[at], `${label}: enemy hit points`)
      if (spec.weak) assertEqual(foe.weak, spec.weak[at], `${label}: Weak on the enemy`)
      if (spec.poison) assertEqual(foe.poison, spec.poison[at], `${label}: Poison on the enemy`)
      if (spec.block) assertEqual(me.block, spec.block[at], `${label}: Block gained`)
      if (spec.hand) assertEqual(me.hand.length, spec.hand[at], `${label}: cards drawn`)
      if (spec.exhaust) assertEqual(me.exhaust.length, spec.exhaust[at], `${label}: cards exhausted`)
      if (spec.stance) assertEqual(me.stance, spec.stance[at], `${label}: stance entered`)
      if (spec.orb) assertEqual(me.orbs[0], spec.orb[at], `${label}: orb channelled`)
      if (spec.miracles) assertEqual(me.miracles, spec.miracles[at], `${label}: Miracles gained`)
      if (spec.shivs) assertEqual(me.shivs, spec.shivs[at], `${label}: Shivs gained`)
      if (spec.strength) assertEqual(me.strength, spec.strength[at], `${label}: Strength gained`)
      if (spec.powers) assertEqual(me.powers.length, spec.powers[at], `${label}: Powers in play`)
      if (spec.vulnerable) assertEqual(foe.vulnerable, spec.vulnerable[at], `${label}: Vulnerable applied`)
      if (spec.daze) assertEqual(me.draw.filter((held) => held.defId === 'daze').length, spec.daze[at], `${label}: Daze gained`)
      if (spec.dazeDiscard) assertEqual(me.discard.filter((held) => held.defId === 'daze').length, spec.dazeDiscard[at], `${label}: Daze discarded`)
      // Every card charges its printed cost, and the cost is a balance number
      // nothing else pins.
      const cost = face.cost === 'X' ? 0 : face.cost
      assertEqual(me.energy, spec.energy ? spec.energy[at] : E - cost, `${label}: energy left`)
    }
  }
})

check('Flex gains temporary Strength and only its base face Exhausts', () => {
  for (const upgraded of [false, true]) {
    const flex = instance('flex', upgraded)
    const state = combat([makePlayer({ hand: [flex] })], [makeEnemy()])
    const played = playCard(state, 'p1', flex.uid, { enemyUid: null, playerId: 'p1' })
    assertEqual(played.players[0].strength, 1)
    assertEqual(played.players[0].strengthLossAtEndOfTurn, 1)
    assertEqual(played.players[0].exhaust.some((card) => card.uid === flex.uid), !upgraded)
    assertEqual(played.players[0].discard.some((card) => card.uid === flex.uid), upgraded)
    const ended = beginEndPlayerTurn(played)
    assertEqual(ended.players[0].strength, 0, 'the gained Strength expires this turn')
  }

  for (const upgraded of [false, true]) {
    const flex = instance('flex', upgraded)
    const state = combat([makePlayer({ hand: [flex], strength: 8 })], [makeEnemy()])
    const played = playCard(state, 'p1', flex.uid, { enemyUid: null, playerId: 'p1' })
    assertEqual(played.players[0].strengthLossAtEndOfTurn, upgraded ? 0 : 1)
    const ended = beginEndPlayerTurn(played)
    assertEqual(ended.players[0].strength, upgraded ? 8 : 7,
      `Flex${upgraded ? '+' : ''} should follow its printed loss wording at the cap`)
  }
})

check('Iron Wave base gains both effects and its upgrade requires one printed mode', () => {
  const base = instance('iron_wave')
  const baseState = combat(
    [makePlayer({ hand: [base] })],
    [makeEnemy({ hp: 20, maxHp: 20 })],
  )
  const basePlayed = playCard(baseState, 'p1', base.uid, { enemyUid: 'e1', playerId: null })
  assertEqual(basePlayed.enemies[0].hp, 19)
  assertEqual(basePlayed.players[0].block, 1)
  assertEqual(basePlayed.players[0].energy, 2)

  for (const invalid of [undefined, -1, 2, '0']) {
    const card = instance('iron_wave', true)
    const state = combat([makePlayer({ hand: [card] })], [makeEnemy({ hp: 20, maxHp: 20 })])
    const context = { enemyUid: 'e1', playerId: null }
    if (invalid !== undefined) context.mode = invalid
    assertEqual(playCard(state, 'p1', card.uid, context), state, `mode ${String(invalid)} should be refused`)
  }

  for (const [mode, damage, block] of [[0, 2, 1], [1, 1, 2]]) {
    const card = instance('iron_wave', true)
    const state = combat([makePlayer({ hand: [card] })], [makeEnemy({ hp: 20, maxHp: 20 })])
    const played = playCard(state, 'p1', card.uid, { enemyUid: 'e1', playerId: null, mode })
    assertEqual(played.enemies[0].hp, 20 - damage, `mode ${mode} damage`)
    assertEqual(played.players[0].block, block, `mode ${mode} Block`)
    assertEqual(played.players[0].energy, 2, `mode ${mode} energy`)
  }
})

check('Inflame, Disarm, and Shockwave resolve both scan-read faces', () => {
  for (const upgraded of [false, true]) {
    const inflame = instance('inflame', upgraded)
    const inflamed = playCard(
      combat([makePlayer({ hand: [inflame] })], [makeEnemy()]),
      'p1', inflame.uid, { enemyUid: null, playerId: null },
    )
    assertEqual(inflamed.players[0].strength, 1)
    assertEqual(inflamed.players[0].energy, upgraded ? 2 : 1)
    assert(inflamed.players[0].powers.some((card) => card.uid === inflame.uid))

    const disarm = instance('disarm', upgraded)
    const disarmed = playCard(
      combat([makePlayer({ hand: [disarm] })], [makeEnemy()]),
      'p1', disarm.uid, { enemyUid: 'e1', playerId: null },
    )
    assertEqual(disarmed.enemies[0].weak, upgraded ? 3 : 2)
    assert(disarmed.players[0].exhaust.some((card) => card.uid === disarm.uid))

    const shockwave = instance('shockwave', upgraded)
    const shocked = playCard(
      combat(
        [makePlayer({ hand: [shockwave] })],
        [
          makeEnemy({ uid: 'other-row', row: 0 }),
          makeEnemy({ uid: 'chosen-row', row: 1 }),
          makeEnemy({ uid: 'boss', row: 0, isBoss: true }),
        ],
      ),
      'p1', shockwave.uid, { enemyUid: 'chosen-row', playerId: null },
    )
    assertDeepEqual(shocked.enemies.map((enemy) => enemy.vulnerable), [0, 1, 1])
    assertDeepEqual(shocked.enemies.map((enemy) => enemy.weak), [0, upgraded ? 2 : 1, upgraded ? 2 : 1])
    assert(shocked.players[0].exhaust.some((card) => card.uid === shockwave.uid))
  }
})

check('Dagger Throw binds its target to the post-draw discard choice', () => {
  for (const upgraded of [false, true]) {
    const dagger = instance('dagger_throw', upgraded)
    const existing = instance('defend_silent')
    const drawn = instance('neutralize')
    const state = combat(
      [makePlayer({ character: 'silent', hand: [dagger, existing], draw: [drawn] })],
      [makeEnemy({ hp: 10, maxHp: 10 })],
    )
    const preview = previewCardChoice(state, 'p1', dagger.uid)
    assertEqual(preview?.kind, 'discard')
    assertDeepEqual(preview?.cards.map((card) => card.uid), [existing.uid, drawn.uid])
    assertEqual(playCard(state, 'p1', dagger.uid, {
      enemyUid: 'e1', playerId: null, discardUids: [],
    }), state, 'Dagger Throw cannot skip its discard')
    const played = playCard(state, 'p1', dagger.uid, {
      enemyUid: 'e1', playerId: null, discardUids: [drawn.uid],
    })
    assertEqual(played.enemies[0].hp, upgraded ? 7 : 8)
    assertDeepEqual(played.players[0].hand.map((card) => card.uid), [existing.uid])
    assertDeepEqual(played.players[0].discard.map((card) => card.uid), [drawn.uid, dagger.uid])
    assertEqual(played.players[0].energy, 2)
  }
})

check('Carnage and Ghostly Armor exhaust only when Ethereal resolves at end of turn', () => {
  const carnage = instance('carnage')
  const ghostly = instance('ghostly_armor', true)
  const state = combat([makePlayer({ hand: [carnage, ghostly] })], [makeEnemy()])
  const ending = beginEndPlayerTurn(state)
  assertDeepEqual(ending.players[0].exhaust.map((card) => card.uid), [carnage.uid, ghostly.uid])
  assertEqual(ending.players[0].hand.length, 0)

  const ally = makePlayer({ id: 'p2', name: 'Silent', character: 'silent', row: 1 })
  const played = playCard(
    combat([makePlayer({ hand: [ghostly] }), ally], [makeEnemy()]),
    'p1', ghostly.uid, { enemyUid: null, playerId: 'p2' },
  )
  assertEqual(played.players[1].block, 3)
  assert(played.players[0].discard.some((card) => card.uid === ghostly.uid),
    'a played Ethereal card should discard normally')
})

check('Prepared reveals its complete post-draw hand and pays the upgraded discard count', () => {
  for (const upgraded of [false, true]) {
    const prepared = instance('prepared', upgraded)
    const existing = instance('defend_silent')
    const drawn = [instance('neutralize'), instance('strike_silent')]
    const state = combat(
      [makePlayer({ character: 'silent', hand: [prepared, existing], draw: drawn })],
      [makeEnemy()],
    )
    const preview = previewCardChoice(state, 'p1', prepared.uid)
    const amount = upgraded ? 2 : 1
    assertEqual(preview?.kind, 'discard')
    assertDeepEqual(preview?.cards.map((card) => card.uid),
      [existing, ...drawn.slice(0, amount)].map((card) => card.uid))
    const discarded = upgraded ? [drawn[0].uid, existing.uid] : [drawn[0].uid]
    const played = playCard(state, 'p1', prepared.uid, {
      enemyUid: null, playerId: null, discardUids: discarded,
    })
    assertDeepEqual(played.players[0].hand.map((card) => card.uid),
      upgraded ? [drawn[1].uid] : [existing.uid])
    assertDeepEqual(played.players[0].discard.map((card) => card.uid), [...discarded, prepared.uid])
  }
})

check('Beam Cell follows its printed die faces until upgraded', () => {
  for (const die of [1, 4]) {
    const base = instance('beam_cell')
    const state = { ...combat([makePlayer({ hand: [base] })], [makeEnemy()]), die }
    const played = playCard(state, 'p1', base.uid, { enemyUid: 'e1', playerId: null })
    assertEqual(played.enemies[0].hp, 5)
    assertEqual(played.enemies[0].vulnerable, die === 1 ? 1 : 0)

    const upgraded = instance('beam_cell', true)
    const upgradedState = { ...combat([makePlayer({ hand: [upgraded] })], [makeEnemy()]), die }
    const upgradedPlay = playCard(upgradedState, 'p1', upgraded.uid, { enemyUid: 'e1', playerId: null })
    assertEqual(upgradedPlay.enemies[0].vulnerable, 1)
  }
})

check('Doom and Gloom hits one row plus the boss before channeling Dark', () => {
  for (const upgraded of [false, true]) {
    const card = instance('doom_and_gloom', upgraded)
    const state = combat(
      [makePlayer({ character: 'defect', hand: [card] })],
      [
        makeEnemy({ uid: 'other-row', row: 0, hp: 10, maxHp: 10 }),
        makeEnemy({ uid: 'chosen-row', row: 1, hp: 10, maxHp: 10 }),
        makeEnemy({ uid: 'boss', row: 0, hp: 10, maxHp: 10, isBoss: true }),
      ],
    )
    const played = playCard(state, 'p1', card.uid, { enemyUid: 'chosen-row', playerId: null })
    assertDeepEqual(played.enemies.map((enemy) => enemy.hp), [10, upgraded ? 7 : 8, upgraded ? 7 : 8])
    assertDeepEqual(played.players[0].orbs, ['dark', null, null])
  }
})

check('Overclock draws before putting its Daze into the discard pile', () => {
  for (const upgraded of [false, true]) {
    const card = instance('overclock', upgraded)
    const deck = Array.from({ length: 3 }, () => instance('strike_defect'))
    const state = combat([makePlayer({ character: 'defect', hand: [card], draw: deck })], [makeEnemy()])
    const played = playCard(state, 'p1', card.uid, { enemyUid: null, playerId: null })
    const amount = upgraded ? 3 : 2
    assertDeepEqual(played.players[0].hand.map((held) => held.uid), deck.slice(0, amount).map((held) => held.uid))
    assertDeepEqual(played.players[0].discard.map((held) => held.defId), ['daze', 'overclock'])
  }
})

check('Battle Trance and Pray draw first, then block later draws until next turn', () => {
  for (const id of ['battle_trance', 'pray']) {
    const lock = instance(id)
    const followup = instance('pommel_strike')
    const deck = Array.from({ length: 8 }, () => instance('strike_ironclad'))
    const state = combat([makePlayer({ hand: [lock, followup], draw: deck })], [makeEnemy()])
    const locked = playCard(state, 'p1', lock.uid, { enemyUid: null, playerId: null })
    const firstDraw = id === 'battle_trance' ? 3 : 2
    assertEqual(locked.players[0].hand.length, firstDraw + 1)
    assert(locked.players[0].drawLocked, `${id} did not lock later draws`)
    const drawCount = locked.players[0].draw.length
    const followed = playCard(locked, 'p1', followup.uid, { enemyUid: 'e1', playerId: null })
    assertEqual(followed.players[0].draw.length, drawCount, `${id} allowed Pommel Strike to draw`)
    assertEqual(followed.players[0].hand.length, firstDraw)

    const nextDeck = Array.from({ length: 6 }, () => instance('defend_ironclad'))
    const nextTurn = startPlayerTurn({
      ...followed,
      phase: 'roundEnd',
      players: [{ ...followed.players[0], hand: [], draw: nextDeck, discard: [] }],
    })
    assert(!nextTurn.players[0].drawLocked, `${id} draw lock survived the next Player Turn`)
    assertEqual(nextTurn.players[0].hand.length, 5)
  }
})

check('Machine Learning draws after the normal five-card start-of-turn draw', () => {
  const machine = instance('machine_learning')
  const state = combat([makePlayer({ character: 'defect', hand: [machine] })], [makeEnemy()])
  const powered = playCard(state, 'p1', machine.uid, { enemyUid: null, playerId: null })
  const deck = Array.from({ length: 6 }, () => instance('strike_defect'))
  const next = startPlayerTurn({
    ...powered,
    phase: 'roundEnd',
    players: [{ ...powered.players[0], hand: [], draw: deck, discard: [], drawLocked: true }],
  })
  assertEqual(next.players[0].hand.length, 6)
  assert(!next.players[0].drawLocked)
  assert(next.log.some((line) => line.includes('Machine Learning:') && line.includes('draws 1')))
})

check('Dash and Leap optionally switch rows independently of their other targets', () => {
  for (const upgraded of [false, true]) {
    const dash = instance('dash', upgraded)
    const players = [
      makePlayer({ hand: [dash], row: 0 }),
      makePlayer({ id: 'p2', name: 'Silent', character: 'silent', row: 1 }),
      makePlayer({ id: 'p3', name: 'Defect', character: 'defect', row: 2 }),
    ]
    const dashed = playCard(combat(players, [makeEnemy({ hp: 10, maxHp: 10 })]), 'p1', dash.uid, {
      enemyUid: 'e1', playerId: 'p1', switchWithPlayerId: 'p3',
    })
    assertEqual(dashed.enemies[0].hp, upgraded ? 7 : 8)
    assertEqual(dashed.players[0].block, upgraded ? 3 : 2)
    assertDeepEqual(dashed.players.map((player) => player.row), [2, 1, 0])

    const leap = instance('leap', upgraded)
    const leaped = playCard(combat([
      makePlayer({ hand: [leap], row: 0 }),
      makePlayer({ id: 'p2', name: 'Silent', character: 'silent', row: 1 }),
      makePlayer({ id: 'p3', name: 'Defect', character: 'defect', row: 2 }),
    ], [makeEnemy()]), 'p1', leap.uid, {
      enemyUid: null, playerId: 'p2', switchWithPlayerId: 'p3',
    })
    assertEqual(leaped.players[1].block, upgraded ? 3 : 2)
    assertDeepEqual(leaped.players.map((player) => player.row), [2, 1, 0])
  }
})

check('row switching can be skipped but refuses self, dead, missing, and malformed targets', () => {
  for (const switchWithPlayerId of ['p1', 'p2', 'missing', 7]) {
    const dash = instance('dash')
    const state = combat([
      makePlayer({ hand: [dash], row: 0 }),
      makePlayer({ id: 'p2', name: 'Silent', character: 'silent', row: 1, dead: true }),
    ], [makeEnemy()])
    assertEqual(playCard(state, 'p1', dash.uid, {
      enemyUid: 'e1', playerId: 'p1', switchWithPlayerId,
    }), state, `invalid row switch ${switchWithPlayerId} was accepted`)
  }

  const dash = instance('dash')
  const state = combat([
    makePlayer({ hand: [dash], row: 0 }),
    makePlayer({ id: 'p2', name: 'Silent', character: 'silent', row: 1 }),
  ], [makeEnemy()])
  const skipped = playCard(state, 'p1', dash.uid, {
    enemyUid: 'e1', playerId: 'p1', switchWithPlayerId: null,
  })
  assertDeepEqual(skipped.players.map((player) => player.row), [0, 1])
})

check('Acrobatics privately previews its draw, then atomically discards from the drawn hand', () => {
  for (const upgraded of [false, true]) {
    const acrobatics = instance('acrobatics', upgraded)
    const deck = Array.from({ length: 4 }, () => instance('defend_silent'))
    const state = combat(
      [makePlayer({ character: 'silent', hand: [acrobatics], draw: deck })],
      [makeEnemy()],
    )
    const before = JSON.stringify(state)
    const preview = previewCardChoice(state, 'p1', acrobatics.uid)
    const drawn = upgraded ? 4 : 3
    assertEqual(JSON.stringify(state), before, 'previewing must not change piles or RNG')
    assertEqual(preview?.kind, 'discard')
    assertDeepEqual(preview?.cards.map((card) => card.uid), deck.slice(0, drawn).map((card) => card.uid))

    assertEqual(
      playCard(state, 'p1', acrobatics.uid, { enemyUid: null, playerId: null, discardUids: [] }),
      state,
      'the play cannot skip its post-draw discard',
    )
    const discarded = deck[drawn - 1]
    const played = playCard(state, 'p1', acrobatics.uid, {
      enemyUid: null, playerId: null, discardUids: [discarded.uid],
    })
    assertDeepEqual(played.players[0].hand.map((card) => card.uid),
      deck.slice(0, drawn - 1).map((card) => card.uid))
    assertEqual(played.players[0].discard[0].uid, discarded.uid)
    assertEqual(played.players[0].discard[1].uid, acrobatics.uid)
    assertEqual(played.players[0].energy, 2)
  }

  const acrobatics = instance('acrobatics')
  const top = instance('strike_silent')
  const shuffled = [instance('defend_silent'), instance('neutralize')]
  const state = combat([makePlayer({ hand: [acrobatics], draw: [top], discard: shuffled })], [makeEnemy()])
  const preview = previewCardChoice(state, 'p1', acrobatics.uid)
  const chosen = preview.cards.at(-1)
  const played = playCard(state, 'p1', acrobatics.uid, {
    enemyUid: null, playerId: null, discardUids: [chosen.uid],
  })
  assertDeepEqual(played.players[0].hand.map((card) => card.uid),
    preview.cards.filter((card) => card.uid !== chosen.uid).map((card) => card.uid),
    'preview and play must perform the same reshuffle')
})

check('Third Eye previews only its Scry window and validates every chosen card', () => {
  for (const upgraded of [false, true]) {
    const thirdEye = instance('third_eye', upgraded)
    const deck = Array.from({ length: 6 }, () => instance('defend_watcher'))
    const state = combat(
      [makePlayer({ character: 'watcher', hand: [thirdEye], draw: deck })],
      [makeEnemy()],
    )
    const before = JSON.stringify(state)
    const preview = previewCardChoice(state, 'p1', thirdEye.uid)
    const looked = upgraded ? 5 : 3
    assertEqual(JSON.stringify(state), before, 'Scry preview must not expose itself by mutating state')
    assertEqual(preview?.kind, 'scry')
    assertDeepEqual(preview?.cards.map((card) => card.uid), deck.slice(0, looked).map((card) => card.uid))

    for (const bad of [['not-revealed'], [deck[0].uid, deck[0].uid]]) {
      assertEqual(playCard(state, 'p1', thirdEye.uid, {
        enemyUid: null, playerId: null, scryDiscardUids: bad,
      }), state, 'Scry must refuse a forged or duplicate reveal choice')
    }
    const tossed = [deck[1].uid, deck[looked - 1].uid]
    const played = playCard(state, 'p1', thirdEye.uid, {
      enemyUid: null, playerId: null, scryDiscardUids: tossed,
    })
    assertEqual(played.players[0].block, upgraded ? 3 : 2)
    assertDeepEqual(played.players[0].draw.map((card) => card.uid),
      deck.filter((card) => !tossed.includes(card.uid)).map((card) => card.uid))
    assertDeepEqual(played.players[0].discard.slice(0, 2).map((card) => card.uid), tossed)
    assertEqual(played.players[0].discard.at(-1).uid, thirdEye.uid)
  }
})

check('Cut Through Fate resolves its hit, Scry, then draw in printed order', () => {
  for (const upgraded of [false, true]) {
    const cut = instance('cut_through_fate', upgraded)
    const deck = Array.from({ length: 4 }, () => instance('defend_watcher'))
    const state = combat(
      [makePlayer({ character: 'watcher', hand: [cut], draw: deck })],
      [makeEnemy({ hp: 10, maxHp: 10 })],
    )
    const preview = previewCardChoice(state, 'p1', cut.uid)
    assertEqual(preview?.kind, 'scry')
    assertDeepEqual(preview?.cards.map((card) => card.uid),
      deck.slice(0, upgraded ? 3 : 2).map((card) => card.uid))
    const played = playCard(state, 'p1', cut.uid, {
      enemyUid: 'e1', playerId: null, scryDiscardUids: [deck[0].uid],
    })
    assertEqual(played.enemies[0].hp, upgraded ? 8 : 9)
    assertDeepEqual(played.players[0].hand.map((card) => card.uid), [deck[1].uid])
    assertDeepEqual(played.players[0].draw.map((card) => card.uid), deck.slice(2).map((card) => card.uid))
    assertDeepEqual(played.players[0].discard.map((card) => card.uid), [deck[0].uid, cut.uid])
  }
})

check('Just Lucky reveals Scry only on die 1-3 and grants Block only on 4-6', () => {
  for (const upgraded of [false, true]) {
    for (const die of [1, 4]) {
      const lucky = instance('just_lucky', upgraded)
      const deck = Array.from({ length: 3 }, () => instance('defend_watcher'))
      const state = {
        ...combat(
          [makePlayer({ character: 'watcher', hand: [lucky], draw: deck })],
          [makeEnemy({ hp: 10, maxHp: 10 })],
        ),
        die,
      }
      const face = faceOf(cardDef('just_lucky'), upgraded)
      const needsPreview = die <= 3
      assertEqual(cardNeedsChoicePreview(face, state, state.players[0]), needsPreview)
      const preview = previewCardChoice(state, 'p1', lucky.uid)
      assertEqual(preview?.kind ?? null, needsPreview ? 'scry' : null)
      if (preview) assertEqual(preview.cards.length, upgraded ? 2 : 1)
      const played = playCard(state, 'p1', lucky.uid, {
        enemyUid: 'e1', playerId: null,
        scryDiscardUids: needsPreview ? [deck[0].uid] : undefined,
      })
      assertEqual(played.enemies[0].hp, upgraded ? 8 : 9)
      assertEqual(played.players[0].block, die >= 4 ? 1 : 0)
      assertEqual(played.players[0].draw.length, needsPreview ? 2 : 3)
    }
  }
})

check('Offering pays HP before its Energy and draw, and Exhausts both faces', () => {
  for (const upgraded of [false, true]) {
    const offering = instance('offering', upgraded)
    const deck = Array.from({ length: 6 }, () => instance('defend_ironclad'))
    const state = combat([makePlayer({ hand: [offering], draw: deck, hp: 7, energy: 1 })], [makeEnemy()])
    const played = playCard(state, 'p1', offering.uid, { enemyUid: null, playerId: null })
    assertEqual(played.players[0].hp, 6)
    assertEqual(played.players[0].energy, 3)
    assertEqual(played.players[0].hand.length, upgraded ? 5 : 3)
    assertEqual(played.players[0].exhaust[0].uid, offering.uid)
  }

  const fatal = instance('offering')
  const deck = Array.from({ length: 3 }, () => instance('defend_ironclad'))
  const state = combat([makePlayer({ hand: [fatal], draw: deck, hp: 1, energy: 1 })], [makeEnemy()])
  const lost = playCard(state, 'p1', fatal.uid, { enemyUid: null, playerId: null })
  assertEqual(lost.phase, 'lost')
  assertEqual(lost.players[0].energy, 1, 'Energy after the fatal clause still resolved')
  assertEqual(lost.players[0].hand.length, 0, 'cards were drawn after the fatal clause')
  assertDeepEqual(lost.players[0].draw.map((card) => card.uid), deck.map((card) => card.uid))
  assertEqual(lost.players[0].exhaust.length, 0, 'Offering Exhausted after combat had already ended')
})

check('Rupture gains Strength, loses HP through Block, and upgrades only its cost', () => {
  for (const upgraded of [false, true]) {
    const rupture = instance('rupture', upgraded)
    const state = combat([makePlayer({ hand: [rupture], hp: 7, block: 5, energy: 1 })], [makeEnemy()])
    const played = playCard(state, 'p1', rupture.uid, { enemyUid: null, playerId: null })
    assertEqual(played.players[0].strength, 1)
    assertEqual(played.players[0].hp, 6)
    assertEqual(played.players[0].block, 5, 'printed HP loss ignores Block')
    assertEqual(played.players[0].energy, upgraded ? 1 : 0)
    assertEqual(played.players[0].discard[0].uid, rupture.uid)
  }

  const fatal = instance('rupture')
  const state = combat([makePlayer({ hand: [fatal], hp: 1, energy: 1 })], [makeEnemy()])
  const lost = playCard(state, 'p1', fatal.uid, { enemyUid: null, playerId: null })
  assertEqual(lost.phase, 'lost')
  assertEqual(lost.players[0].strength, 1, 'Strength resolves before the printed HP loss')
  assertEqual(lost.players[0].discard.length, 0, 'cleanup cannot continue after a lethal clause')
})

check('Whirlwind spends chosen X Energy on one row and gains one upgraded hit', () => {
  for (const upgraded of [false, true]) {
    const whirlwind = instance('whirlwind', upgraded)
    const state = combat([makePlayer({ hand: [whirlwind], energy: 3 })], [
      makeEnemy({ uid: 'chosen', row: 0, hp: 10, maxHp: 10 }),
      makeEnemy({ uid: 'same-row', row: 0, hp: 10, maxHp: 10 }),
      makeEnemy({ uid: 'other-row', row: 1, hp: 10, maxHp: 10 }),
      makeEnemy({ uid: 'boss', row: 1, hp: 10, maxHp: 10, isBoss: true }),
    ])
    const played = playCard(state, 'p1', whirlwind.uid, {
      enemyUid: 'chosen', playerId: null, energySpent: 2,
    })
    const damage = upgraded ? 3 : 2
    assertDeepEqual(played.enemies.map((enemy) => enemy.hp), [10 - damage, 10 - damage, 10, 10 - damage])
    assertEqual(played.players[0].energy, 1)
    assertEqual(played.players[0].discard[0].uid, whirlwind.uid)
  }
})

check('Whirlwind validates X atomically and zero Energy follows each face', () => {
  for (const energySpent of [undefined, -1, 1.5, 4]) {
    const whirlwind = instance('whirlwind')
    const state = combat([makePlayer({ hand: [whirlwind], energy: 3 })], [makeEnemy()])
    const context = { enemyUid: 'e1', playerId: null }
    if (energySpent !== undefined) context.energySpent = energySpent
    assert(playCard(state, 'p1', whirlwind.uid, context) === state,
      `forged X value ${String(energySpent)} changed combat`)
  }

  const base = instance('whirlwind')
  const baseState = combat([makePlayer({ hand: [base], energy: 3 })], [makeEnemy({ hp: 10, maxHp: 10 })])
  const spentZero = playCard(baseState, 'p1', base.uid, {
    enemyUid: null, playerId: null, energySpent: 0,
  })
  assertEqual(spentZero.enemies[0].hp, 10)
  assertEqual(spentZero.players[0].energy, 3)
  assertEqual(spentZero.players[0].discard[0].uid, base.uid)

  const upgraded = instance('whirlwind', true)
  const upgradedState = combat(
    [makePlayer({ hand: [upgraded], energy: 3 })], [makeEnemy({ hp: 10, maxHp: 10 })],
  )
  assert(playCard(upgradedState, 'p1', upgraded.uid, {
    enemyUid: null, playerId: null, energySpent: 0,
  }) === upgradedState, 'Whirlwind+ still needs a row for its X+1 hit')
  const upgradedZero = playCard(upgradedState, 'p1', upgraded.uid, {
    enemyUid: 'e1', playerId: null, energySpent: 0,
  })
  assertEqual(upgradedZero.enemies[0].hp, 9)
  assertEqual(upgradedZero.players[0].energy, 3)

  const forced = instance('whirlwind', true)
  const forcedState = {
    ...combat([makePlayer({ hand: [forced], energy: 3 })], [makeEnemy({ hp: 10, maxHp: 10 })]),
    phase: 'start',
    startTurnProgress: {
      choices: [],
      forcedCard: { playerId: 'p1', cardUid: forced.uid, sourceCardId: 'mayhem', exhaustNonPower: false },
    },
  }
  assert(playCard(forcedState, 'p1', forced.uid, {
    enemyUid: 'e1', playerId: null, energySpent: 2,
  }) === forcedState, 'a free forced X card cannot forge a paid X value')
  const forcedPlay = playCard(forcedState, 'p1', forced.uid, {
    enemyUid: 'e1', playerId: null, energySpent: 0,
  })
  assertEqual(forcedPlay.enemies[0].hp, 9, 'a free Whirlwind+ resolves as X = 0, then adds one hit')
  assertEqual(forcedPlay.players[0].energy, 3)
})

check('Skewer resolves its two printed X hit formulas against one enemy', () => {
  for (const upgraded of [false, true]) {
    const skewer = instance('skewer', upgraded)
    const state = combat(
      [makePlayer({ hand: [skewer], energy: 3, strength: 1 })],
      [makeEnemy({ hp: 10, maxHp: 10, block: 1 })],
    )
    const played = playCard(state, 'p1', skewer.uid, {
      enemyUid: 'e1', playerId: null, energySpent: 2,
    })
    assertEqual(played.enemies[0].hp, 5,
      upgraded ? 'Skewer+ applies Strength to each of two hits' : 'Skewer applies Strength to each of three hits')
    assertEqual(played.players[0].energy, 1)
    assertEqual(played.players[0].discard[0].uid, skewer.uid)
  }

  const base = instance('skewer')
  const baseState = combat([makePlayer({ hand: [base], energy: 3 })], [makeEnemy()])
  assert(playCard(baseState, 'p1', base.uid, {
    enemyUid: null, playerId: null, energySpent: 0,
  }) === baseState, 'Skewer at X = 0 still needs a target for its extra hit')

  const upgraded = instance('skewer', true)
  const upgradedState = combat([makePlayer({ hand: [upgraded], energy: 3 })], [makeEnemy()])
  const upgradedZero = playCard(upgradedState, 'p1', upgraded.uid, {
    enemyUid: null, playerId: null, energySpent: 0,
  })
  assertEqual(upgradedZero.players[0].energy, 3)
  assertEqual(upgradedZero.players[0].discard[0].uid, upgraded.uid)
})

check('FTL draws only when it is the first card played this turn', () => {
  for (const upgraded of [false, true]) {
    const ftl = instance('ftl', upgraded)
    const drawn = instance('defend_defect')
    const state = combat([makePlayer({ hand: [ftl], draw: [drawn] })], [makeEnemy()])
    const played = playCard(state, 'p1', ftl.uid, { enemyUid: 'e1', playerId: null })
    assertEqual(played.enemies[0].hp, 6 - (upgraded ? 2 : 1))
    assertDeepEqual(played.players[0].hand.map((card) => card.uid), [drawn.uid])
    assertEqual(played.players[0].cardsPlayedThisTurn, 1)
  }

  const defend = instance('defend_defect')
  const late = instance('ftl')
  const drawn = instance('strike_defect')
  const state = combat([makePlayer({ hand: [defend, late], draw: [drawn] })], [makeEnemy()])
  const guarded = playCard(state, 'p1', defend.uid, { enemyUid: null, playerId: 'p1' })
  const playedLate = playCard(guarded, 'p1', late.uid, { enemyUid: 'e1', playerId: null })
  assertEqual(playedLate.players[0].hand.length, 0, 'a later FTL did not draw')
  assertEqual(playedLate.players[0].draw[0].uid, drawn.uid)
  assertEqual(playedLate.players[0].cardsPlayedThisTurn, 2)
})

check('Force Field discounts for Powers and Tempest channels once per X Energy', () => {
  for (const [powerCount, expectedEnergy] of [[0, 2], [2, 4], [4, 5]]) {
    const forceField = instance('force_field')
    const powers = Array.from({ length: powerCount }, (_, at) => ({
      ...instance('machine_learning'), uid: `force-power-${at}`,
    }))
    const state = combat([makePlayer({ hand: [forceField], powers, energy: 5 })], [makeEnemy()])
    const played = playCard(state, 'p1', forceField.uid, { enemyUid: null, playerId: 'p1' })
    assertEqual(played.players[0].energy, expectedEnergy)
    assertEqual(played.players[0].block, 3)
  }

  for (const upgraded of [false, true]) {
    for (const energySpent of [0, 2]) {
      const tempest = instance('tempest', upgraded)
      const state = combat([makePlayer({ hand: [tempest], energy: 3 })], [makeEnemy()])
      const played = playCard(state, 'p1', tempest.uid, {
        enemyUid: null, playerId: null, energySpent,
      })
      assertEqual(played.players[0].energy, 3 - energySpent)
      assertEqual(played.players[0].orbs.filter(Boolean).length, energySpent + (upgraded ? 1 : 0))
      assertEqual(played.players[0].exhaust[0].uid, tempest.uid)
    }
  }

  const overflowTempest = instance('tempest')
  const overflowState = combat([
    makePlayer({ hand: [overflowTempest], energy: 3, orbs: ['frost', 'lightning', 'dark'] }),
  ], [makeEnemy({ hp: 10, maxHp: 10 })])
  assertEqual(nextEvokeChoice(CARDS.tempest, overflowState.players[0], [], undefined, 2)?.options.length, 3)
  assertEqual(playCard(overflowState, 'p1', overflowTempest.uid, {
    enemyUid: null, playerId: null, energySpent: 2,
  }), overflowState, 'Tempest cannot choose full-slot evocations for the player')
  const overflowed = playCard(overflowState, 'p1', overflowTempest.uid, {
    enemyUid: null, playerId: null, energySpent: 2,
    evokeSlots: [2, 0], evokeEnemyUids: ['e1', null],
  })
  assertDeepEqual(overflowed.players[0].orbs, ['lightning', 'lightning', 'lightning'])
  assertEqual(overflowed.players[0].block, 1, 'the chosen Frost evoke still resolves')
})

check('Storm pauses start of turn for every full-slot Orb and target choice', () => {
  for (const upgraded of [false, true]) {
    const storm = instance('storm', upgraded)
    const state = combat([
      makePlayer({ character: 'defect', powers: [storm], orbs: ['frost', 'dark', 'lightning'] }),
    ], [makeEnemy({ hp: 10, maxHp: 10 }), makeEnemy({ uid: 'e2', hp: 10, maxHp: 10, row: 1 })])
    Object.assign(state, { phase: 'roundEnd', turn: 1 })
    const prepared = preparePlayerTurn(state)
    const [ability] = startTurnAbilities(prepared)
    assertEqual(ability.evokeChoice.options.length, 3)
    assertEqual(resolveStartPlayerTurn(prepared, [{ id: ability.id, shivEnemyUids: [] }]), prepared,
      'Storm resolved without the required Orb choice')

    const choice = upgraded
      ? { id: ability.id, shivEnemyUids: [], evokeSlots: [1, 0], evokeEnemyUids: ['e2', null] }
      : { id: ability.id, shivEnemyUids: [], evokeSlots: [1], evokeEnemyUids: ['e2'] }
    const resolved = resolveStartPlayerTurn(prepared, [choice])
    assertEqual(resolved.phase, 'player')
    assertDeepEqual(resolved.players[0].orbs,
      upgraded ? ['lightning', 'lightning', 'lightning'] : ['frost', 'lightning', 'lightning'])
    assertEqual(resolved.players[0].block, upgraded ? 1 : 0)
    assertEqual(resolved.enemies[1].hp, 6, 'the Dark Orb did not use its chosen target')
  }

  const state = combat([makePlayer({
    character: 'defect',
    powers: [instance('storm', true), instance('storm', true)],
    orbs: ['frost', 'dark', 'lightning'],
  })], [makeEnemy({ hp: 30, maxHp: 30 })])
  Object.assign(state, { phase: 'roundEnd', turn: 1 })
  const prepared = preparePlayerTurn(state)
  const choices = defaultStartTurnChoices(prepared)
  assertEqual(choices.reduce((sum, choice) => sum + (choice.evokeSlots?.length ?? 0), 0), 4)
  const resolved = resolveStartPlayerTurn(prepared, choices)
  assertEqual(resolved.phase, 'player')
  assertDeepEqual(resolved.players[0].orbs, ['lightning', 'dark', 'lightning'])

  const lethal = combat([makePlayer({
    character: 'defect', powers: [instance('storm', true)], orbs: ['lightning', 'lightning', 'lightning'],
  })], [makeEnemy({ hp: 2, maxHp: 2 }), makeEnemy({ uid: 'e2', hp: 10, maxHp: 10, row: 1 })])
  Object.assign(lethal, { phase: 'roundEnd', turn: 1 })
  const lethalPrepared = preparePlayerTurn(lethal)
  const lethalAbility = startTurnAbilities(lethalPrepared)[0]
  const afterFirstLethal = startTurnAbilities(lethalPrepared, undefined, [{
    id: lethalAbility.id, shivEnemyUids: [], evokeSlots: [0], evokeEnemyUids: ['e1'],
  }])[0]
  assertDeepEqual(afterFirstLethal.evokeTargets.map((target) => target.uid), ['e2'])
  const waitingForSafeTarget = startTurnAbilities(lethalPrepared, undefined, [{
    id: lethalAbility.id, shivEnemyUids: [], evokeSlots: [0, 0], evokeEnemyUids: ['e1'],
  }])[0]
  assertEqual(waitingForSafeTarget.evokeChoice, undefined)
  assertDeepEqual(waitingForSafeTarget.evokeTargets.map((target) => target.uid), ['e2'])
  const lethalChoices = defaultStartTurnChoices(lethalPrepared)
  assertDeepEqual(lethalChoices[0].evokeEnemyUids, ['e1', 'e2'])
  const lethalResolved = resolveStartPlayerTurn(lethalPrepared, lethalChoices)
  assertEqual(lethalResolved.phase, 'player')
  assert(lethalResolved.enemies[0].dead)
  assertEqual(lethalResolved.enemies[1].hp, 8)

  const finalEnemy = combat([makePlayer({
    character: 'defect', powers: [instance('storm', true)], orbs: ['lightning', 'lightning', 'lightning'],
  })], [makeEnemy({ hp: 2, maxHp: 2 })])
  Object.assign(finalEnemy, { phase: 'roundEnd', turn: 1 })
  const finalPrepared = preparePlayerTurn(finalEnemy)
  const finalChoices = defaultStartTurnChoices(finalPrepared)
  assertDeepEqual(finalChoices[0].evokeSlots, [0],
    'Storm+ still asked for a second Orb after the first Evoke won combat')
  assertDeepEqual(finalChoices[0].evokeEnemyUids, ['e1'])
  const finalResolved = resolveStartPlayerTurn(finalPrepared, finalChoices)
  assertEqual(finalResolved.phase, 'won')
  assert(finalResolved.enemies[0].dead)

  const amplifiedDark = combat([makePlayer({
    character: 'defect',
    powers: [instance('amplify', true), instance('storm', true)],
    orbs: ['dark', 'lightning', 'frost'],
  })], [makeEnemy({ hp: 10, maxHp: 10 }), makeEnemy({ uid: 'e2', hp: 10, maxHp: 10, row: 1 })])
  amplifiedDark.players[0].darkOrbEvokeBonus = 5
  Object.assign(amplifiedDark, { phase: 'roundEnd', turn: 1 })
  const amplifiedPrepared = preparePlayerTurn(amplifiedDark)
  const amplifiedChoices = defaultStartTurnChoices(amplifiedPrepared)
  assertDeepEqual(amplifiedChoices[0].evokeEnemyUids, ['e1', 'e2'],
    'Amplify damage must remove the first target from Storm+ planning')
  const amplifiedResolved = resolveStartPlayerTurn(amplifiedPrepared, amplifiedChoices)
  assertEqual(amplifiedResolved.phase, 'player')
  assert(amplifiedResolved.enemies[0].dead)
  assertEqual(amplifiedResolved.enemies[1].hp, 8)

  const hiddenDraw = combat([makePlayer({
    character: 'defect',
    powers: [instance('machine_learning'), instance('storm')],
    orbs: ['lightning', 'lightning', 'lightning'],
  })], [makeEnemy()])
  Object.assign(hiddenDraw, { phase: 'roundEnd', turn: 1 })
  const hiddenPrepared = preparePlayerTurn(hiddenDraw)
  delete hiddenPrepared.players[0].draw
  delete hiddenPrepared.rng
  const hiddenAbilities = startTurnAbilities(hiddenPrepared)
  assertEqual(hiddenAbilities.length, 2)
  assertEqual(hiddenAbilities[1].evokeChoice.options.length, 3,
    'a redacted Machine Learning preview hid Storm\'s Orb choices')

  for (const laterPower of ['noxious_fumes', 'infinite_blades']) {
    const postLethal = combat([makePlayer({
      character: 'defect', shivs: laterPower === 'infinite_blades' ? 5 : 0,
      powers: [instance('storm'), instance(laterPower)],
      orbs: ['lightning', 'lightning', 'lightning'],
    })], [makeEnemy({ hp: 2, maxHp: 2 })])
    Object.assign(postLethal, { phase: 'roundEnd', turn: 1 })
    const postLethalPrepared = preparePlayerTurn(postLethal)
    const postLethalAbilities = startTurnAbilities(postLethalPrepared)
    const postLethalPlan = startTurnAbilities(
      postLethalPrepared,
      postLethalAbilities.map((ability) => ability.id),
      [
        { id: postLethalAbilities[0].id, shivEnemyUids: [], evokeSlots: [0], evokeEnemyUids: ['e1'] },
        { id: postLethalAbilities[1].id, shivEnemyUids: [] },
      ],
    )
    assertEqual(postLethalPlan[1].targets, undefined,
      `${laterPower} kept a target after Storm won combat`)
    assertEqual(postLethalPlan[1].overflowShivs, 0,
      `${laterPower} kept an overflow Shiv after Storm won combat`)
    assertEqual(resolveStartPlayerTurn(postLethalPrepared, [
      { id: postLethalAbilities[0].id, shivEnemyUids: [], evokeSlots: [0], evokeEnemyUids: ['e1'] },
      { id: postLethalAbilities[1].id, shivEnemyUids: [] },
    ]).phase, 'won')
  }

  const lethalShivs = combat([makePlayer({
    character: 'silent', shivs: 5, powers: [instance('infinite_blades', true)],
  })], [makeEnemy({ hp: 1, maxHp: 1 })])
  Object.assign(lethalShivs, { phase: 'roundEnd', turn: 1 })
  const lethalShivsPrepared = preparePlayerTurn(lethalShivs)
  const [lethalShivAbility] = startTurnAbilities(lethalShivsPrepared)
  const lethalShivChoice = { id: lethalShivAbility.id, shivEnemyUids: ['e1'] }
  assertEqual(startTurnAbilities(lethalShivsPrepared, undefined, [lethalShivChoice])[0].overflowShivs, 1,
    'Infinite Blades+ still asked for its second Shiv after the first won combat')
  assertEqual(resolveStartPlayerTurn(lethalShivsPrepared, [lethalShivChoice]).phase, 'won')

  const orderedTargets = combat([makePlayer({
    character: 'defect',
    powers: [instance('storm', true), instance('noxious_fumes')],
    orbs: ['lightning', 'lightning', 'lightning'],
  })], [makeEnemy({ hp: 2, maxHp: 2 }), makeEnemy({ uid: 'e2', hp: 10, maxHp: 10, row: 1 })])
  Object.assign(orderedTargets, { phase: 'roundEnd', turn: 1 })
  const orderedPrepared = preparePlayerTurn(orderedTargets)
  const orderedAbilities = startTurnAbilities(orderedPrepared)
  const orderedStorm = orderedAbilities.find((ability) => ability.label.includes('Storm'))
  const orderedFumes = orderedAbilities.find((ability) => ability.label.includes('Noxious Fumes'))
  const stagedTargets = startTurnAbilities(orderedPrepared, [orderedStorm.id, orderedFumes.id], [
    { id: orderedStorm.id, shivEnemyUids: [], evokeSlots: [0, 0], evokeEnemyUids: ['e1', 'e2'] },
    { id: orderedFumes.id, enemyUid: 'e1', shivEnemyUids: [] },
  ])
  const stagedFumes = stagedTargets.find((ability) => ability.id === orderedFumes.id)
  assert(stagedFumes.enemyTargetStale)
  assertDeepEqual(stagedFumes.targets.map((target) => target.uid), ['e2'])
  const orderedDefaults = defaultStartTurnChoices(orderedPrepared)
  assertEqual(orderedDefaults.find((choice) => choice.id === orderedFumes.id).enemyUid, 'e2')
  const orderedResolved = resolveStartPlayerTurn(orderedPrepared, orderedDefaults)
  assertEqual(orderedResolved.phase, 'player')
  assertEqual(orderedResolved.enemies[1].hp, 8)
  assertEqual(orderedResolved.enemies[1].poison, 1)

  const orderedShivs = combat([makePlayer({
    character: 'defect', shivs: 5,
    powers: [instance('storm', true), instance('infinite_blades')],
    orbs: ['lightning', 'lightning', 'lightning'],
  })], [makeEnemy({ hp: 2, maxHp: 2 }), makeEnemy({ uid: 'e2', hp: 10, maxHp: 10, row: 1 })])
  Object.assign(orderedShivs, { phase: 'roundEnd', turn: 1 })
  const shivPrepared = preparePlayerTurn(orderedShivs)
  const shivAbilities = startTurnAbilities(shivPrepared)
  const shivStorm = shivAbilities.find((ability) => ability.label.includes('Storm'))
  const blades = shivAbilities.find((ability) => ability.label.includes('Infinite Blades'))
  const stagedShivs = startTurnAbilities(shivPrepared, [shivStorm.id, blades.id], [
    { id: shivStorm.id, shivEnemyUids: [], evokeSlots: [0, 0], evokeEnemyUids: ['e1', 'e2'] },
    { id: blades.id, shivEnemyUids: ['e1'] },
  ]).find((ability) => ability.id === blades.id)
  assertEqual(stagedShivs.staleShivIndex, 0)
  assertDeepEqual(stagedShivs.shivTargets.map((target) => target.uid), ['e2'])

  const modifiedShiv = combat([makePlayer({
    character: 'defect', shivs: 5,
    relics: [{ defId: 'akabeko', spent: false }],
    powers: [instance('infinite_blades'), instance('storm')],
    orbs: ['lightning', 'lightning', 'lightning'],
  })], [makeEnemy({ hp: 2, maxHp: 2 }), makeEnemy({ uid: 'e2', hp: 10, maxHp: 10, row: 1 })])
  Object.assign(modifiedShiv, { phase: 'roundEnd', turn: 0 })
  const modifiedPrepared = preparePlayerTurn(modifiedShiv)
  const modifiedAbilities = startTurnAbilities(modifiedPrepared)
  const akabeko = modifiedAbilities.find((ability) => ability.label.includes('Akabeko'))
  const modifiedBlades = modifiedAbilities.find((ability) => ability.label.includes('Infinite Blades'))
  const modifiedStorm = modifiedAbilities.find((ability) => ability.label.includes('Storm'))
  const modifiedPlan = startTurnAbilities(modifiedPrepared,
    [akabeko.id, modifiedBlades.id, modifiedStorm.id], [
      { id: akabeko.id, shivEnemyUids: [] },
      { id: modifiedBlades.id, shivEnemyUids: ['e1'] },
      { id: modifiedStorm.id, shivEnemyUids: [], evokeSlots: [0], evokeEnemyUids: ['e1'] },
    ]).find((ability) => ability.id === modifiedStorm.id)
  assertEqual(modifiedPlan.evokeChoice, undefined)
  assertDeepEqual(modifiedPlan.evokeTargets.map((target) => target.uid), ['e2'])

  const triggeredDamage = combat([makePlayer({
    character: 'defect',
    powers: [instance('noxious_fumes'), instance('sadistic_nature'), instance('storm')],
    orbs: ['lightning', 'lightning', 'lightning'],
  })], [makeEnemy({ hp: 1, maxHp: 1 }), makeEnemy({ uid: 'e2', hp: 10, maxHp: 10, row: 1 })])
  Object.assign(triggeredDamage, { phase: 'roundEnd', turn: 1 })
  const triggeredPrepared = preparePlayerTurn(triggeredDamage)
  const triggeredDefaults = defaultStartTurnChoices(triggeredPrepared)
  const triggeredStorm = startTurnAbilities(triggeredPrepared)
    .find((ability) => ability.label.includes('Storm'))
  assertEqual(triggeredDefaults.find((choice) => choice.id === triggeredStorm.id).evokeEnemyUids[0], 'e2')
  const triggeredResolved = resolveStartPlayerTurn(triggeredPrepared, triggeredDefaults)
  assertEqual(triggeredResolved.phase, 'player')
  assert(triggeredResolved.enemies[0].dead)
  assertEqual(triggeredResolved.enemies[1].hp, 8)

  const triggeredShivs = combat([makePlayer({
    character: 'silent', shivs: 5,
    powers: [instance('sadistic_nature'), instance('infinite_blades', true), instance('storm')],
    orbs: ['lightning', 'lightning', 'lightning'],
  })], [makeEnemy({ hp: 2, maxHp: 2 }), makeEnemy({ uid: 'e2', hp: 10, maxHp: 10, row: 1 })])
  triggeredShivs.players[0].hitPoison = 1
  Object.assign(triggeredShivs, { phase: 'roundEnd', turn: 1 })
  const triggeredShivPrepared = preparePlayerTurn(triggeredShivs)
  const triggeredShivAbilities = startTurnAbilities(triggeredShivPrepared)
  const triggeredBlades = triggeredShivAbilities.find((ability) => ability.label.includes('Infinite Blades'))
  const stormAfterShivs = triggeredShivAbilities.find((ability) => ability.label.includes('Storm'))
  const triggeredShivPlan = startTurnAbilities(triggeredShivPrepared,
    [triggeredBlades.id, stormAfterShivs.id], [
      { id: triggeredBlades.id, shivEnemyUids: ['e1', 'e1'] },
      { id: stormAfterShivs.id, shivEnemyUids: [], evokeSlots: [], evokeEnemyUids: [] },
    ]).find((ability) => ability.id === triggeredBlades.id)
  assertEqual(triggeredShivPlan.staleShivIndex, 1)
  assertDeepEqual(triggeredShivPlan.shivTargets.map((target) => target.uid), ['e2'])
})

check('Blizzard counts only Frost Orbs and Hologram recovers a chosen discard', () => {
  for (const upgraded of [false, true]) {
    const blizzard = instance('blizzard', upgraded)
    const frozen = combat([makePlayer({
      character: 'defect', hand: [blizzard], orbs: ['frost', 'lightning', 'frost'], energy: 3,
    })], [makeEnemy({ hp: 10, maxHp: 10, block: 1 })])
    const resolved = playCard(frozen, 'p1', blizzard.uid, { enemyUid: 'e1', playerId: null })
    assertEqual(resolved.enemies[0].hp, upgraded ? 5 : 7,
      'Blizzard did not resolve one separate hit per Frost Orb')
  }

  const emptyBlizzard = instance('blizzard')
  const empty = combat([makePlayer({
    character: 'defect', hand: [emptyBlizzard], orbs: ['lightning', 'dark', null], energy: 3,
  })], [makeEnemy({ hp: 10, maxHp: 10 })])
  assertEqual(cardNeedsEnemy(CARDS.blizzard, empty.players[0]), false)
  const noFrost = playCard(empty, 'p1', emptyBlizzard.uid, { enemyUid: null, playerId: null })
  assertEqual(noFrost.enemies[0].hp, 10)
  assertEqual(noFrost.players[0].energy, 2)

  for (const upgraded of [false, true]) {
    const hologram = instance('hologram', upgraded)
    const recovered = instance('strike_defect')
    const other = instance('defend_defect')
    const state = combat([makePlayer({
      character: 'defect', hand: [hologram], discard: [recovered, other], energy: 3,
    })], [makeEnemy()])
    assertEqual(playCard(state, 'p1', hologram.uid, { enemyUid: null, playerId: null }), state,
      'Hologram resolved without its mandatory discard choice')
    const resolved = playCard(state, 'p1', hologram.uid, {
      enemyUid: null, playerId: null, recoverDiscardUid: recovered.uid,
    })
    assertEqual(resolved.players[0].block, 1)
    assertDeepEqual(resolved.players[0].hand.map((card) => card.uid), [recovered.uid])
    assertDeepEqual(resolved.players[0].discard.map((card) => card.uid),
      upgraded ? [other.uid, hologram.uid] : [other.uid])
    assertDeepEqual(resolved.players[0].exhaust.map((card) => card.uid),
      upgraded ? [] : [hologram.uid])
  }
})

check('FTL copies are separate cards, while Shivs do not consume its first-card bonus', () => {
  const ftl = instance('ftl')
  const firstDraw = instance('defend_defect')
  const secondDraw = instance('strike_defect')
  const doubled = combat(
    [makePlayer({ hand: [ftl], draw: [firstDraw, secondDraw] })],
    [makeEnemy({ hp: 10, maxHp: 10 })],
  )
  doubled.players[0].doubledAttacksThisTurn = 1
  const first = playCard(doubled, 'p1', ftl.uid, { enemyUid: 'e1', playerId: null })
  assertEqual(first.phase, 'copy')
  assertEqual(first.players[0].cardsPlayedThisTurn, 1)
  assertDeepEqual(first.players[0].hand.map((card) => card.uid), [firstDraw.uid])
  const copied = playCardCopy(first, 'p1', { enemyUid: 'e1', playerId: null })
  assertEqual(copied.players[0].cardsPlayedThisTurn, 2)
  assertDeepEqual(copied.players[0].hand.map((card) => card.uid), [firstDraw.uid],
    'the second FTL copy is no longer the first card and does not draw')
  assertDeepEqual(copied.players[0].draw.map((card) => card.uid), [secondDraw.uid])

  const afterShivFtl = instance('ftl')
  const afterShivDraw = instance('defend_defect')
  const shivState = combat(
    [makePlayer({ hand: [afterShivFtl], draw: [afterShivDraw], shivs: 1 })],
    [makeEnemy({ hp: 10, maxHp: 10 })],
  )
  const shivved = spendShiv(shivState, 'p1', 'e1')
  assertEqual(shivved.players[0].cardsPlayedThisTurn, 0, 'a Shiv is an Attack, not a card')
  const afterShiv = playCard(shivved, 'p1', afterShivFtl.uid, { enemyUid: 'e1', playerId: null })
  assertDeepEqual(afterShiv.players[0].hand.map((card) => card.uid), [afterShivDraw.uid])
})

check('the card-play ledger resets each turn and ignores refused plays', () => {
  const ftl = instance('ftl')
  const state = combat(
    [makePlayer({ hand: [ftl] })],
    [makeEnemy()],
  )
  state.players[0].cardsPlayedThisTurn = 4
  assertEqual(playCard(state, 'p1', ftl.uid, { enemyUid: null, playerId: null }), state)
  assertEqual(state.players[0].cardsPlayedThisTurn, 4)
  const reset = startPlayerTurn(state)
  assertEqual(reset.players[0].cardsPlayedThisTurn, 0)
})

check('Die Die Die hits every enemy and Rainbow channels its three Orbs in order', () => {
  for (const upgraded of [false, true]) {
    const die = instance('die_die_die', upgraded)
    const died = playCard(combat([makePlayer({ hand: [die] })], [
      makeEnemy({ uid: 'left', hp: 10, maxHp: 10, row: 0 }),
      makeEnemy({ uid: 'right', hp: 10, maxHp: 10, row: 1 }),
      makeEnemy({ uid: 'boss', hp: 10, maxHp: 10, row: 2, isBoss: true }),
    ]), 'p1', die.uid, { enemyUid: null, playerId: null })
    assertDeepEqual(died.enemies.map((enemy) => enemy.hp), Array(3).fill(upgraded ? 6 : 7))
    assertEqual(died.players[0].exhaust[0].uid, die.uid)

    const rainbow = instance('rainbow', upgraded)
    const charged = playCard(combat([
      makePlayer({ character: 'defect', hand: [rainbow], orbs: [null, null, null] }),
    ], [makeEnemy()]), 'p1', rainbow.uid, { enemyUid: null, playerId: null })
    assertDeepEqual(charged.players[0].orbs, ['lightning', 'frost', 'dark'])
    assertEqual(charged.players[0].exhaust.some((card) => card.uid === rainbow.uid), !upgraded)
    assertEqual(charged.players[0].discard.some((card) => card.uid === rainbow.uid), upgraded)
  }
})

check('a lethal first evoke ends combat before Dual Cast removes the next Orb', () => {
  const dualCast = instance('dual_cast')
  const state = combat([
    makePlayer({ character: 'defect', hand: [dualCast], orbs: ['lightning', 'frost', null], block: 0 }),
  ], [makeEnemy({ hp: 2, maxHp: 2 })])
  const won = playCard(state, 'p1', dualCast.uid, {
    enemyUid: 'e1', playerId: null,
    evokeSlots: [0, 1], evokeEnemyUids: ['e1', null],
  })
  assertEqual(won.phase, 'won')
  assertDeepEqual(won.players[0].orbs, [null, 'frost', null])
  assertEqual(won.players[0].block, 0, 'the second Frost evoke resolved after combat ended')

  const rainbow = instance('rainbow')
  const forced = playCard(combat([
    makePlayer({ name: 'Defect', character: 'defect', hand: [rainbow], orbs: ['lightning', 'frost', 'dark'] }),
  ], [makeEnemy({ hp: 2, maxHp: 2 })]), 'p1', rainbow.uid, {
    enemyUid: null, playerId: null,
    evokeSlots: [0, 1, 2], evokeEnemyUids: ['e1', null, 'e1'],
  })
  assertEqual(forced.phase, 'won')
  assertDeepEqual(forced.players[0].orbs, [null, 'frost', 'dark'])
  assert(!forced.log.includes('Defect channels 1 lightning'), 'an Orb that was never placed was logged as channeled')
})

check('Immolate and the Silent clouds reach every enemy before their later clauses', () => {
  for (const upgraded of [false, true]) {
    const enemies = [
      makeEnemy({ uid: 'left', hp: 20, maxHp: 20, row: 0 }),
      makeEnemy({ uid: 'right', hp: 20, maxHp: 20, row: 1 }),
      makeEnemy({ uid: 'boss', hp: 20, maxHp: 20, row: 2, isBoss: true }),
    ]
    const immolate = instance('immolate', upgraded)
    const burned = playCard(combat([makePlayer({ hand: [immolate] })], enemies), 'p1', immolate.uid, {
      enemyUid: null, playerId: null,
    })
    assertDeepEqual(burned.enemies.map((enemy) => enemy.hp), Array(3).fill(upgraded ? 13 : 15))
    assertEqual(burned.players[0].draw.filter((card) => card.defId === 'daze').length, 2)

    const wail = instance('piercing_wail', upgraded)
    const wailed = playCard(combat([makePlayer({ hand: [wail] })], enemies), 'p1', wail.uid, {
      enemyUid: null, playerId: null,
    })
    assertDeepEqual(wailed.enemies.map((enemy) => enemy.weak), [1, 1, 1])
    assertEqual(wailed.players[0].block, upgraded ? 3 : 1)

    const cloud = instance('crippling_cloud', upgraded)
    const clouded = playCard(combat([makePlayer({ hand: [cloud] })], enemies), 'p1', cloud.uid, {
      enemyUid: null, playerId: null,
    })
    assertDeepEqual(clouded.enemies.map((enemy) => enemy.poison), Array(3).fill(upgraded ? 2 : 1))
    assertDeepEqual(clouded.enemies.map((enemy) => enemy.weak), [1, 1, 1])
  }

  const lethal = instance('immolate')
  const won = playCard(combat([makePlayer({ hand: [lethal] })], [makeEnemy({ hp: 5, maxHp: 5 })]),
    'p1', lethal.uid, { enemyUid: null, playerId: null })
  assertEqual(won.phase, 'won')
  assertEqual(won.players[0].draw.filter((card) => card.defId === 'daze').length, 0,
    'Immolate added Daze after its attack had already won combat')
})

check('Glacier+ redirects only its Block while its caster channels Frost', () => {
  for (const upgraded of [false, true]) {
    const glacier = instance('glacier', upgraded)
    const state = combat([
      makePlayer({ character: 'defect', hand: [glacier], orbs: [null, null, null] }),
      makePlayer({ id: 'p2', name: 'Silent', character: 'silent' }),
    ], [makeEnemy()])
    const played = playCard(state, 'p1', glacier.uid, { enemyUid: null, playerId: 'p2' })
    assertEqual(played.players[0].block, upgraded ? 0 : 2)
    assertEqual(played.players[1].block, upgraded ? 3 : 0)
    assertDeepEqual(played.players[0].orbs, ['frost', null, null])
  }
})

check('colorless support and movement cards preserve their chosen-player clauses', () => {
  for (const upgraded of [false, true]) {
    const instincts = instance('good_instincts', upgraded)
    const supported = playCard(combat([
      makePlayer({ hand: [instincts], energy: 0 }),
      makePlayer({ id: 'p2', name: 'Silent', character: 'silent', row: 1 }),
    ], [makeEnemy()]), 'p1', instincts.uid, { enemyUid: null, playerId: 'p2' })
    assertEqual(supported.players[0].block, 0)
    assertEqual(supported.players[1].block, upgraded ? 2 : 1)

    const swift = instance('swift_strike', upgraded)
    const moved = playCard(combat([
      makePlayer({ hand: [swift], energy: 0, row: 0 }),
      makePlayer({ id: 'p2', name: 'Silent', character: 'silent', row: 1 }),
    ], [makeEnemy({ hp: 5, maxHp: 5 })]), 'p1', swift.uid, {
      enemyUid: 'e1', playerId: null, switchWithPlayerId: 'p2',
    })
    assertEqual(moved.enemies[0].hp, upgraded ? 3 : 4)
    assertEqual(moved.players[0].row, 1)
    assertEqual(moved.players[1].row, 0)
  }
})

check('a lethal Flash of Steel stops before drawing its later clause', () => {
  const flash = instance('flash_of_steel')
  const draw = instance('defend_ironclad')
  const won = playCard(combat([
    makePlayer({ hand: [flash], draw: [draw], energy: 0 }),
  ], [makeEnemy({ hp: 1, maxHp: 1 })]), 'p1', flash.uid, { enemyUid: 'e1', playerId: null })
  assertEqual(won.phase, 'won')
  assertEqual(won.players[0].hand.length, 0)
  assertEqual(won.players[0].draw[0].uid, draw.uid)
  assertEqual(won.players[0].exhaust.length, 0, 'terminal card cleanup ran after combat ended')
})

check('Dramatic Entrance gets its first-turn bonus and hits one row plus the boss', () => {
  for (const upgraded of [false, true]) {
    const firstCard = instance('dramatic_entrance', upgraded)
    const enemies = [
      makeEnemy({ uid: 'left', row: 0, hp: 20, maxHp: 20 }),
      makeEnemy({ uid: 'right', row: 1, hp: 20, maxHp: 20 }),
      makeEnemy({ uid: 'boss', row: 2, hp: 20, maxHp: 20, isBoss: true }),
    ]
    const first = playCard({
      ...combat([makePlayer({ hand: [firstCard], energy: 0 })], enemies),
      turn: 1,
    }, 'p1', firstCard.uid, { enemyUid: 'left', playerId: null })
    const firstDamage = upgraded ? 5 : 3
    assertDeepEqual(first.enemies.map((enemy) => enemy.hp), [20 - firstDamage, 20, 20 - firstDamage])

    const laterCard = instance('dramatic_entrance', upgraded)
    const later = playCard({
      ...combat([makePlayer({ hand: [laterCard], energy: 0 })], enemies),
      turn: 2,
    }, 'p1', laterCard.uid, { enemyUid: 'left', playerId: null })
    assertDeepEqual(later.enemies.map((enemy) => enemy.hp), [18, 20, 18])
  }
})

check('Impatience, Mind Blast, and Hand of Greed read the current hand and gold', () => {
  const impatient = instance('impatience', true)
  const attack = instance('strike_ironclad')
  const blocked = playCard(combat([
    makePlayer({ hand: [impatient, attack], draw: [instance('defend_ironclad')], energy: 0 }),
  ], [makeEnemy()]), 'p1', impatient.uid, { enemyUid: null, playerId: null })
  assertDeepEqual(blocked.players[0].hand.map((card) => card.uid), [attack.uid])

  for (const upgraded of [false, true]) {
    const blast = instance('mind_blast', upgraded)
    const otherCards = Array.from({ length: 3 }, () => instance('defend_ironclad'))
    const blasted = playCard(combat([
      makePlayer({ hand: [blast, ...otherCards] }),
    ], [makeEnemy({ hp: 20, maxHp: 20 })]), 'p1', blast.uid, { enemyUid: 'e1', playerId: null })
    assertEqual(blasted.enemies[0].hp, upgraded ? 16 : 17)

    const greedy = instance('hand_of_greed', upgraded)
    const enriched = playCard(combat([
      makePlayer({ hand: [greedy], gold: 10 }),
    ], [makeEnemy({ hp: 20, maxHp: 20 })]), 'p1', greedy.uid, { enemyUid: 'e1', playerId: null })
    assertEqual(enriched.enemies[0].hp, upgraded ? 11 : 13)
  }
})

check('Panacea redirects its base face and clears every player when upgraded', () => {
  for (const upgraded of [false, true]) {
    const panacea = instance('panacea', upgraded)
    const cured = playCard(combat([
      makePlayer({ hand: [panacea], energy: 0, weak: 1, vulnerable: 1 }),
      makePlayer({ id: 'p2', name: 'Silent', character: 'silent', weak: 2, vulnerable: 2 }),
    ], [makeEnemy()]), 'p1', panacea.uid, { enemyUid: null, playerId: upgraded ? null : 'p2' })
    assertEqual(cured.players[0].weak, upgraded ? 0 : 1)
    assertEqual(cured.players[0].vulnerable, upgraded ? 0 : 1)
    assertEqual(cured.players[1].weak, 0)
    assertEqual(cured.players[1].vulnerable, 0)
  }
})

check('Apparition caps every kind of HP loss for the round and then expires', () => {
  for (const upgraded of [false, true]) {
    const apparition = instance('apparition', upgraded)
    const offering = instance('offering')
    const protectedState = playCard(combat([
      makePlayer({ hand: [apparition, offering], draw: Array.from({ length: 3 }, () => instance('defend_ironclad')) }),
    ], [makeEnemy({ defId: 'lagavulin', actionIndex: 1 })]), 'p1', apparition.uid, {
      enemyUid: null, playerId: null,
    })
    const selfHit = playCard(protectedState, 'p1', offering.uid, { enemyUid: null, playerId: null })
    assertEqual(selfHit.players[0].hp, 9, 'Offering should spend the one allowed HP loss')
    const attacked = enemyTurn(endPlayerTurn(selfHit))
    assertEqual(attacked.players[0].hp, 9, 'later enemy damage should lose no more HP this round')
    assertEqual(attacked.players[0].block, 0, 'Apparition should not preserve Block from the attack')
    const nextRound = startPlayerTurn(attacked)
    assertEqual(nextRound.players[0].hpLossLimitThisRound, undefined)
    assertEqual(nextRound.players[0].hpLostThisRound, 0)
  }
})

check('Apparition loses Ethereal when upgraded', () => {
  const base = instance('apparition')
  const upgraded = instance('apparition', true)
  const baseEnd = endPlayerTurn(combat([makePlayer({ hand: [base] })], [makeEnemy()]))
  const upgradedEnd = endPlayerTurn(combat([makePlayer({ hand: [upgraded] })], [makeEnemy()]))
  assertDeepEqual(baseEnd.players[0].exhaust.map((card) => card.uid), [base.uid])
  assertDeepEqual(upgradedEnd.players[0].discard.map((card) => card.uid), [upgraded.uid])
})

check('Dark Shackles counts enemies whose current intent attacks its player', () => {
  for (const upgraded of [false, true]) {
    const shackles = instance('dark_shackles', upgraded)
    const state = {
      ...combat([makePlayer({ hand: [shackles], row: 0, energy: 0 })], [
        makeEnemy({ uid: 'same-row', row: 0, defId: 'cultist' }),
        makeEnemy({ uid: 'other-row', row: 1, defId: 'cultist' }),
        makeEnemy({ uid: 'boss', row: 2, defId: 'cultist', isBoss: true }),
        makeEnemy({ uid: 'no-attack', row: 0, defId: 'red_louse' }),
      ]),
      die: 1,
    }
    const played = playCard(state, 'p1', shackles.uid, { enemyUid: null, playerId: null })
    assertEqual(played.players[0].block, upgraded ? 6 : 4)
    assertDeepEqual(played.players[0].exhaust.map((card) => card.uid), [shackles.uid])
  }
})

check('Madness discounts exactly the next card this turn and gains Retain when upgraded', () => {
  const madness = instance('madness')
  const first = instance('hand_of_greed')
  const second = instance('hand_of_greed')
  const state = combat([makePlayer({ hand: [madness, first, second], energy: 0 })], [
    makeEnemy({ hp: 30, maxHp: 30 }),
  ])
  const primed = playCard(state, 'p1', madness.uid, { enemyUid: null, playerId: null })
  assertEqual(playCost(faceOf(cardDef(first.defId), false), primed.players[0]), 0)
  const free = playCard(primed, 'p1', first.uid, { enemyUid: 'e1', playerId: null })
  assertEqual(free.players[0].energy, 0)
  assertEqual(free.players[0].freeCardsThisTurn, 0)
  assertEqual(playCard(free, 'p1', second.uid, { enemyUid: 'e1', playerId: null }), free,
    'a second paid card should not inherit the discount')

  const retained = instance('madness', true)
  const kept = endPlayerTurn(combat([makePlayer({ hand: [retained] })], [makeEnemy()]))
  assertDeepEqual(kept.players[0].hand.map((card) => card.uid), [retained.uid])
})

check('Panache targets a row and reads the hand when its ordered end-turn ability resolves', () => {
  for (const upgraded of [false, true]) {
    const panache = instance('panache', upgraded)
    const played = playCard(combat([makePlayer({ hand: [panache], energy: 0 })], [
      makeEnemy({ uid: 'left', row: 0, hp: 20, maxHp: 20 }),
      makeEnemy({ uid: 'right', row: 1, hp: 20, maxHp: 20 }),
      makeEnemy({ uid: 'boss', row: 2, hp: 20, maxHp: 20, isBoss: true }),
    ]), 'p1', panache.uid, { enemyUid: null, playerId: null })
    const ability = endTurnAbilities(played).find((entry) => entry.label.includes('Panache'))
    assertEqual(ability.targets.length, 3)
    const ended = beginEndPlayerTurn(played, [chooseEndTurnTarget(ability.id, 'left')])
    const damage = upgraded ? 5 : 3
    assertDeepEqual(ended.enemies.map((enemy) => enemy.hp), [20 - damage, 20, 20 - damage])
  }

  const panache = instance('panache')
  const apparition = instance('apparition')
  const state = combat([makePlayer({ hand: [apparition], powers: [panache] })], [
    makeEnemy({ hp: 20, maxHp: 20 }),
  ])
  const abilities = endTurnAbilities(state)
  const power = abilities.find((entry) => entry.label.includes('Panache'))
  const ethereal = abilities.find((entry) => entry.label.includes('Apparition'))
  const panacheFirst = beginEndPlayerTurn(state, [
    chooseEndTurnTarget(power.id, 'e1'), ethereal.id,
  ])
  assertEqual(panacheFirst.enemies[0].hp, 20, 'Panache should see the still-held Ethereal card')
  const etherealFirst = beginEndPlayerTurn(state, [
    ethereal.id, chooseEndTurnTarget(power.id, 'e1'),
  ])
  assertEqual(etherealFirst.enemies[0].hp, 17, 'Ethereal may empty the hand before Panache resolves')

  const poisonAnchor = combat([makePlayer({ hand: [], powers: [instance('panache')] })], [
    makeEnemy({ uid: 'anchor', row: 0, hp: 1, maxHp: 1, poison: 1 }),
    makeEnemy({ uid: 'same-row', row: 0, hp: 20, maxHp: 20 }),
  ])
  const poisonAbilities = endTurnAbilities(poisonAnchor)
  const poison = poisonAbilities.find((entry) => entry.label.includes('Poison'))
  const anchoredPanache = poisonAbilities.find((entry) => entry.label.includes('Panache'))
  const resolved = beginEndPlayerTurn(poisonAnchor, [
    poison.id, chooseEndTurnTarget(anchoredPanache.id, 'anchor'),
  ])
  assert(resolved !== poisonAnchor, 'a dead row anchor should not roll back the end-turn plan')
  assertEqual(resolved.enemies[0].dead, true)
  assertEqual(resolved.enemies[1].hp, 17)

  const emptyRow = combat([makePlayer({ hand: [], powers: [instance('panache')] })], [
    makeEnemy({ uid: 'sole-anchor', row: 0, hp: 1, maxHp: 1, poison: 1 }),
    makeEnemy({ uid: 'other-row', row: 1, hp: 20, maxHp: 20 }),
  ])
  const emptyRowAbilities = endTurnAbilities(emptyRow)
  const solePoison = emptyRowAbilities.find((entry) => entry.label.includes('Poison'))
  const solePanache = emptyRowAbilities.find((entry) => entry.label.includes('Panache'))
  const fizzled = beginEndPlayerTurn(emptyRow, [
    solePoison.id, chooseEndTurnTarget(solePanache.id, 'sole-anchor'),
  ])
  assert(fizzled !== emptyRow, 'an emptied chosen row should fizzle rather than roll back')
  assertEqual(fizzled.enemies[0].dead, true)
  assertEqual(fizzled.enemies[1].hp, 20)

  const entrance = instance('dramatic_entrance')
  const staleCardTarget = combat([makePlayer({ hand: [entrance], energy: 0 })], [
    makeEnemy({ uid: 'dead-card-anchor', row: 0, hp: 0, maxHp: 5, dead: true }),
    makeEnemy({ uid: 'live-card-target', row: 0, hp: 20, maxHp: 20 }),
  ])
  assertEqual(playCard(staleCardTarget, 'p1', entrance.uid, {
    enemyUid: 'dead-card-anchor', playerId: null,
  }), staleCardTarget, 'ordinary row cards must still reject a dead target')
})

check('Apotheosis improves only starter Strikes and Defends for the combat', () => {
  for (const upgraded of [false, true]) {
    const apotheosis = instance('apotheosis', upgraded)
    const strike = instance('strike_ironclad')
    const defend = instance('defend_ironclad', true)
    const bash = instance('bash')
    const state = combat([makePlayer({ hand: [apotheosis, strike, defend, bash], energy: 6 })], [
      makeEnemy({ hp: 20, maxHp: 20 }),
    ])
    const empowered = playCard(state, 'p1', apotheosis.uid, { enemyUid: null, playerId: null })
    assertEqual(empowered.players[0].energy, upgraded ? 5 : 4)
    assertEqual(empowered.players[0].starterStrikeDamageBonus, 1)
    assertEqual(empowered.players[0].starterDefendBlockBonus, 1)
    const struck = playCard(empowered, 'p1', strike.uid, { enemyUid: 'e1', playerId: null })
    assertEqual(struck.enemies[0].hp, 18)
    const defended = playCard(struck, 'p1', defend.uid, { enemyUid: null, playerId: 'p1' })
    assertEqual(defended.players[0].block, 3, 'Defend+ should keep its printed 2 and add 1')
    const bashed = playCard(defended, 'p1', bash.uid, { enemyUid: 'e1', playerId: null })
    assertEqual(bashed.enemies[0].hp, 16, 'another starter-rarity card is not a Strike')
  }
  const reset = createCombat(createRng(99), [makePlayer({
    starterStrikeDamageBonus: 3, starterDefendBlockBonus: 3,
  })], [makeEnemy()])
  assertEqual(reset.players[0].starterStrikeDamageBonus, 0)
  assertEqual(reset.players[0].starterDefendBlockBonus, 0)
})

check('The Bomb counts three end turns, damages every enemy, then Exhausts itself', () => {
  for (const upgraded of [false, true]) {
    const bomb = instance('the_bomb', upgraded)
    let state = playCard(combat([makePlayer({ hand: [bomb], energy: 2 })], [
      makeEnemy({ uid: 'left', hp: 30, maxHp: 30 }),
      makeEnemy({ uid: 'right', row: 1, hp: 30, maxHp: 30 }),
    ]), 'p1', bomb.uid, { enemyUid: null, playerId: null })
    for (let cube = 1; cube <= 3; cube++) {
      const ability = endTurnAbilities(state).find((entry) => entry.label.includes('The Bomb'))
      state = beginEndPlayerTurn(state, [ability.id])
      if (cube < 3) {
        assertEqual(state.players[0].powers[0].counter, cube)
        state = { ...state, phase: 'player' }
      }
    }
    const damage = upgraded ? 12 : 10
    assertDeepEqual(state.enemies.map((enemy) => enemy.hp), [30 - damage, 30 - damage])
    assertEqual(state.players[0].powers.some((card) => card.uid === bomb.uid), false)
    assertEqual(state.players[0].exhaust.some((card) => card.uid === bomb.uid), true)
    assertEqual(state.players[0].exhaust.find((card) => card.uid === bomb.uid).counter, undefined)
  }
})

check('Sadistic Nature fires once per enemy token actually added, on that enemy', () => {
  for (const upgraded of [false, true]) {
    const sadistic = instance('sadistic_nature', upgraded)
    const shockwave = instance('shockwave')
    const state = combat([makePlayer({ hand: [sadistic, shockwave], energy: 3 })], [
      makeEnemy({ uid: 'left', hp: 20, maxHp: 20 }),
      makeEnemy({ uid: 'right', row: 0, hp: 20, maxHp: 20 }),
    ])
    const powered = playCard(state, 'p1', sadistic.uid, { enemyUid: null, playerId: null })
    const tokened = playCard(powered, 'p1', shockwave.uid, { enemyUid: 'left', playerId: null })
    const damage = upgraded ? 4 : 2
    assertDeepEqual(tokened.enemies.map((enemy) => enemy.hp), [20 - damage, 20 - damage])
    assertDeepEqual(tokened.enemies.map((enemy) => [enemy.vulnerable, enemy.weak]), [[1, 1], [1, 1]])
  }

  const cappedPower = instance('sadistic_nature', true)
  const blind = instance('blind')
  const capped = playCard(playCard(combat([
    makePlayer({ hand: [cappedPower, blind], energy: 0 }),
  ], [makeEnemy({ hp: 20, maxHp: 20, weak: CAPS.weak })]), 'p1', cappedPower.uid, {
    enemyUid: null, playerId: null,
  }), 'p1', blind.uid, { enemyUid: 'e1', playerId: null })
  assertEqual(capped.enemies[0].hp, 20, 'a token blocked by the cap must not trigger Sadistic Nature')

  const catalystPower = instance('sadistic_nature', true)
  const catalyst = instance('catalyst', true)
  const multiplied = playCard(playCard(combat([
    makePlayer({ hand: [catalystPower, catalyst], energy: 1 }),
  ], [makeEnemy({ hp: 30, maxHp: 30, poison: 5 })]), 'p1', catalystPower.uid, {
    enemyUid: null, playerId: null,
  }), 'p1', catalyst.uid, { enemyUid: 'e1', playerId: null })
  assertEqual(multiplied.enemies[0].poison, 15)
  assertEqual(multiplied.enemies[0].hp, 10, 'Catalyst added 10 cubes, so Sadistic Nature+ fires 10 times')

  const ownerPower = instance('sadistic_nature', true)
  const allyBlind = instance('blind')
  const otherOwner = playCard(combat([
    makePlayer({ powers: [ownerPower] }),
    makePlayer({ id: 'p2', name: 'Silent', character: 'silent', hand: [allyBlind], energy: 0 }),
  ], [makeEnemy({ hp: 20, maxHp: 20 })]), 'p2', allyBlind.uid, { enemyUid: 'e1', playerId: null })
  assertEqual(otherOwner.enemies[0].weak, 1)
  assertEqual(otherOwner.enemies[0].hp, 20, 'another player\'s token does not trigger your Power')
})

check('Thinking Ahead draws first, then returns exactly one chosen card to the draw top', () => {
  for (const upgraded of [false, true]) {
    const thinking = instance('thinking_ahead', upgraded)
    const held = instance('strike_ironclad')
    const drawn = Array.from({ length: upgraded ? 3 : 2 }, () => instance('defend_ironclad'))
    const state = combat([makePlayer({ hand: [thinking, held], draw: drawn })], [makeEnemy()])
    const preview = previewCardChoice(state, 'p1', thinking.uid)
    assertEqual(preview?.kind, 'topdeck')
    assertDeepEqual(preview.cards.map((card) => card.uid), [held.uid, ...drawn.map((card) => card.uid)])
    const chosen = drawn.at(-1)
    const next = playCard(state, 'p1', thinking.uid, {
      enemyUid: null, playerId: null, topdeckUids: [chosen.uid],
    })
    assert(next !== state)
    assertEqual(next.players[0].draw[0]?.uid, chosen.uid)
    assertEqual(next.players[0].hand.length, drawn.length)
    assertEqual(next.players[0].exhaust.at(-1)?.uid, thinking.uid)

    assertEqual(playCard(state, 'p1', thinking.uid, {
      enemyUid: null, playerId: null, topdeckUids: ['not-in-hand'],
    }), state, 'a stale private choice must reject the whole play')
    assertEqual(playCard(state, 'p1', thinking.uid, {
      enemyUid: null, playerId: null, topdeckUids: [held.uid, drawn[0].uid],
    }), state, 'extra topdeck choices must not be silently ignored')
  }

  const thinking = instance('thinking_ahead')
  const onlyDraw = instance('strike_ironclad')
  const reshuffled = [instance('defend_ironclad'), instance('bash')]
  const state = combat([makePlayer({ hand: [thinking], draw: [onlyDraw], discard: reshuffled })], [makeEnemy()])
  const preview = previewCardChoice(state, 'p1', thinking.uid)
  assertEqual(preview.cards.length, 2, 'the preview follows a mid-draw reshuffle')
  const next = playCard(state, 'p1', thinking.uid, {
    enemyUid: null, playerId: null, topdeckUids: [preview.cards[1].uid],
  })
  assertEqual(next.players[0].draw[0].uid, preview.cards[1].uid)
})

check('Warcry draws 2/3, topdecks one chosen hand card, and Exhausts', () => {
  for (const upgraded of [false, true]) {
    const warcry = instance('warcry', upgraded)
    const held = instance('strike_ironclad')
    const drawn = Array.from({ length: upgraded ? 3 : 2 }, () => instance('defend_ironclad'))
    const state = combat([makePlayer({ hand: [warcry, held], draw: drawn, energy: 0 })], [makeEnemy()])
    const preview = previewCardChoice(state, 'p1', warcry.uid)
    assertEqual(preview?.kind, 'topdeck')
    assertDeepEqual(preview.cards.map((card) => card.uid), [held.uid, ...drawn.map((card) => card.uid)])
    const chosen = drawn.at(-1)
    const next = playCard(state, 'p1', warcry.uid, {
      enemyUid: null, playerId: null, topdeckUids: [chosen.uid],
    })
    assertEqual(next.players[0].energy, 0)
    assertEqual(next.players[0].draw[0].uid, chosen.uid)
    assertEqual(next.players[0].hand.length, drawn.length)
    assertEqual(next.players[0].exhaust.at(-1).uid, warcry.uid)
  }
})

check('Havoc forces its draw for 0 Energy and Exhausts every non-Power', () => {
  for (const upgraded of [false, true]) {
    const havoc = instance('havoc', upgraded)
    const held = instance('defend_ironclad')
    const strike = instance('strike_ironclad')
    const state = combat([makePlayer({ hand: [havoc, held], draw: [strike], energy: upgraded ? 0 : 1 })], [
      makeEnemy({ hp: 10, maxHp: 10 }),
    ])
    const forced = playCard(state, 'p1', havoc.uid, { enemyUid: null, playerId: null })
    assertEqual(forced.players[0].energy, 0)
    assertEqual(forced.startTurnProgress?.forcedCard?.cardUid, strike.uid)
    assertEqual(forced.startTurnProgress?.forcedCard?.sourceCardId, 'havoc')
    assertEqual(forced.startTurnProgress?.forcedCard?.exhaustNonPower, true)
    assertEqual(playCard(forced, 'p1', held.uid, { enemyUid: null, playerId: null }), forced,
      'another hand card cannot bypass the immediate play')
    const played = playCard(forced, 'p1', strike.uid, { enemyUid: 'e1', playerId: null })
    assertEqual(played.enemies[0].hp, 9)
    assertDeepEqual(played.players[0].exhaust.map((card) => card.uid), [strike.uid])
    assertDeepEqual(played.players[0].discard.map((card) => card.uid), [havoc.uid])
    assertEqual(played.startTurnProgress, undefined)
  }

  const havoc = instance('havoc')
  const inflame = instance('inflame')
  const powerForced = playCard(combat([
    makePlayer({ hand: [havoc], draw: [inflame], energy: 1 }),
  ], [makeEnemy()]), 'p1', havoc.uid, { enemyUid: null, playerId: null })
  const powered = playCard(powerForced, 'p1', inflame.uid, { enemyUid: null, playerId: null })
  assertDeepEqual(powered.players[0].powers.map((card) => card.uid), [inflame.uid])
  assertEqual(powered.players[0].exhaust.length, 0, 'Havoc never Exhausts a Power')

  const dazeHavoc = instance('havoc')
  const daze = instance('daze')
  const unplayable = playCard(combat([makePlayer({
    hand: [dazeHavoc], draw: [daze], energy: 1, powers: [instance('feel_no_pain')],
  })], [makeEnemy()]), 'p1', dazeHavoc.uid, { enemyUid: null, playerId: null })
  assertEqual(unplayable.startTurnProgress, undefined)
  assertEqual(unplayable.players[0].block, 1, 'an unplayable draw is still Exhausted')
  assert(!unplayable.players[0].hand.some((card) => card.uid === daze.uid))
  assert(!unplayable.players[0].discard.some((card) => card.uid === daze.uid))
})

check('Havoc finishes its immediate child before cleanup and post-card reactions', () => {
  const havoc = instance('havoc', true)
  const lethal = instance('strike_ironclad')
  const state = {
    ...combat([makePlayer({ hand: [havoc], draw: [lethal], hp: 1, energy: 0 })], [
      makeEnemy({ defId: 'gremlin_nob', hp: 1, maxHp: 1 }),
    ]),
    turn: 2,
  }
  const forced = playCard(state, 'p1', havoc.uid, { enemyUid: null, playerId: null })
  assertEqual(forced.players[0].hp, 1, 'Enraged fired before Havoc\'s immediate card')
  assertEqual(forced.players[0].discard.length, 0, 'Havoc cleaned up before its child finished')
  const won = playCard(forced, 'p1', lethal.uid, { enemyUid: 'e1', playerId: null })
  assertEqual(won.phase, 'won')
  assertEqual(won.players[0].hp, 1, 'a defeated Nob still reacted to Havoc')

  const guardedHavoc = instance('havoc', true)
  const guardedStrike = instance('strike_ironclad')
  const guardedState = {
    ...combat([makePlayer({
      hand: [guardedHavoc], draw: [guardedStrike], hp: 3, energy: 0,
      shivs: 1, miracles: 1, potions: ['block_potion'],
    })], [makeEnemy({ defId: 'gremlin_nob', hp: 5, maxHp: 5 })]),
    turn: 2,
  }
  const pending = playCard(guardedState, 'p1', guardedHavoc.uid, { enemyUid: null, playerId: null })
  assertEqual(beginEndPlayerTurn(pending), pending, 'End turn bypassed Havoc')
  assertEqual(spendMiracle(pending, 'p1'), pending, 'a Miracle bypassed Havoc')
  assertEqual(spendShiv(pending, 'p1', 'e1'), pending, 'a Shiv bypassed Havoc')
  assertEqual(activatePotion(pending, 'p1', 'block_potion', { targetPlayerId: 'p1' }), pending,
    'a potion bypassed Havoc')
  const played = playCard(pending, 'p1', guardedStrike.uid, { enemyUid: 'e1', playerId: null })
  assertEqual(played.players[0].hp, 2)
  assertDeepEqual(played.players[0].discard.map((card) => card.uid), [guardedHavoc.uid])
  assert(played.log.findIndex((line) => line.includes('played Strike')) <
    played.log.findIndex((line) => line.includes('Enraged')),
  'Enraged was logged before Havoc\'s immediate child')
})

check('Perfected Strike counts every other hand card whose name contains Strike', () => {
  for (const upgraded of [false, true]) {
    const perfected = instance('perfected_strike', upgraded)
    const otherPerfected = instance('perfected_strike')
    const strike = instance('strike_ironclad')
    const swift = instance('swift_strike')
    const defend = instance('defend_ironclad')
    const state = combat([makePlayer({
      hand: [perfected, otherPerfected, strike, swift, defend], energy: 2,
    })], [makeEnemy({ hp: 20, maxHp: 20 })])
    const played = playCard(state, 'p1', perfected.uid, { enemyUid: 'e1', playerId: null })
    assertEqual(played.enemies[0].hp, upgraded ? 11 : 14)
    assertEqual(played.players[0].energy, 0)
  }
})

check('Headbutt moves exactly one chosen discard card to draw-top after damage', () => {
  for (const upgraded of [false, true]) {
    const headbutt = instance('headbutt', upgraded)
    const lower = instance('defend_ironclad')
    const chosen = instance('bash')
    const state = combat([makePlayer({
      hand: [headbutt], discard: [lower, chosen], draw: [instance('strike_ironclad')], energy: 1,
    })], [makeEnemy({ hp: 10, maxHp: 10 })])
    const played = playCard(state, 'p1', headbutt.uid, {
      enemyUid: 'e1', playerId: null, recoverDiscardUid: lower.uid,
    })
    assertEqual(played.enemies[0].hp, upgraded ? 7 : 8)
    assertEqual(played.players[0].draw[0].uid, lower.uid)
    assertDeepEqual(played.players[0].discard.map((card) => card.uid), [chosen.uid, headbutt.uid])
    assertEqual(played.players[0].energy, 0)

    assertEqual(playCard(state, 'p1', headbutt.uid, { enemyUid: 'e1', playerId: null }), state,
      'a missing discard choice paid Headbutt')
    assertEqual(playCard(state, 'p1', headbutt.uid, {
      enemyUid: 'e1', playerId: null, recoverDiscardUid: headbutt.uid,
    }), state, 'a hand card was accepted as a discard choice')
  }

  const headbutt = instance('headbutt')
  const empty = combat([makePlayer({ hand: [headbutt], discard: [], energy: 1 })], [makeEnemy()])
  const played = playCard(empty, 'p1', headbutt.uid, { enemyUid: 'e1', playerId: null })
  assert(played !== empty, 'an empty discard pile made Headbutt unplayable')
  assertEqual(played.players[0].discard.at(-1).uid, headbutt.uid)

  const lethalHeadbutt = instance('headbutt')
  const recoverable = instance('bash')
  const lethal = combat([makePlayer({
    hand: [lethalHeadbutt], discard: [recoverable], energy: 1,
  })], [makeEnemy({ hp: 2, maxHp: 2 })])
  assertEqual(playCard(lethal, 'p1', lethalHeadbutt.uid, { enemyUid: 'e1', playerId: null }), lethal,
    'lethal damage bypassed the mandatory recovery choice')
  assertEqual(playCard(lethal, 'p1', lethalHeadbutt.uid, {
    enemyUid: 'e1', playerId: null, recoverDiscardUid: 'not-in-discard',
  }), lethal, 'lethal damage bypassed a stale recovery choice')
  assertEqual(playCard(lethal, 'p1', lethalHeadbutt.uid, {
    enemyUid: 'e1', playerId: null, recoverDiscardUid: recoverable.uid,
  }).phase, 'won')
})

check('Power Through blocks any player but puts its Daze on the caster draw-top', () => {
  for (const upgraded of [false, true]) {
    const powerThrough = instance('power_through', upgraded)
    const state = combat([
      makePlayer({ hand: [powerThrough], draw: [instance('strike_ironclad')], energy: 1 }),
      makePlayer({ id: 'p2', name: 'Silent', row: 1 }),
    ], [makeEnemy()])
    const played = playCard(state, 'p1', powerThrough.uid, { enemyUid: null, playerId: 'p2' })
    assertEqual(played.players[0].block, 0)
    assertEqual(played.players[1].block, upgraded ? 4 : 3)
    assertEqual(played.players[0].draw[0].defId, 'daze')
    assertEqual(played.players[1].draw.some((card) => card.defId === 'daze'), false)
    assertEqual(played.players[0].energy, 0)
  }
})

check('Flame Barrier damages only enemies whose current intent attacks its player', () => {
  ENEMIES.flame_barrier_multi_hit_fixture = {
    id: 'flame_barrier_multi_hit_fixture', name: 'Multi-hit fixture', hpByPlayers: [5, 5, 5, 5],
    pattern: { kind: 'single', actions: [{ kind: 'attack', amount: 1, times: 2 }] },
  }
  try {
    for (const upgraded of [false, true]) {
      const barrier = instance('flame_barrier', upgraded)
      const state = {
        ...combat([makePlayer({ hand: [barrier], row: 0, energy: 2 })], [
          makeEnemy({ uid: 'same-row', row: 0, defId: 'cultist', hp: 5, maxHp: 5 }),
          makeEnemy({ uid: 'other-row', row: 1, defId: 'cultist', hp: 5, maxHp: 5 }),
          makeEnemy({ uid: 'boss', row: 2, defId: 'cultist', isBoss: true, hp: 5, maxHp: 5 }),
          makeEnemy({ uid: 'idle', row: 0, defId: 'gremlin_nob', hp: 5, maxHp: 5, actionIndex: 0 }),
          makeEnemy({ uid: 'off-row-aoe', row: 1, defId: 'gremlin_nob', hp: 5, maxHp: 5, actionIndex: 1 }),
          makeEnemy({ uid: 'multi-hit', row: 0, defId: 'flame_barrier_multi_hit_fixture', hp: 5, maxHp: 5 }),
        ]),
        die: 1,
      }
      const played = playCard(state, 'p1', barrier.uid, { enemyUid: null, playerId: null })
      assertEqual(played.players[0].block, upgraded ? 4 : 3)
      assertEqual(played.enemies.find((enemy) => enemy.uid === 'same-row').hp, 4)
      assertEqual(played.enemies.find((enemy) => enemy.uid === 'other-row').hp, 5)
      assertEqual(played.enemies.find((enemy) => enemy.uid === 'boss').hp, 4)
      assertEqual(played.enemies.find((enemy) => enemy.uid === 'idle').hp, 5)
      assertEqual(played.enemies.find((enemy) => enemy.uid === 'off-row-aoe').hp, 4)
      assertEqual(played.enemies.find((enemy) => enemy.uid === 'multi-hit').hp, 3)
    }
  } finally {
    delete ENEMIES.flame_barrier_multi_hit_fixture
  }
})

check('Rampage counts the whole Exhaust pile after its upgraded Exhaust resolves', () => {
  const exhausted = [instance('defend_ironclad'), instance('bash')]
  for (const upgraded of [false, true]) {
    const rampage = instance('rampage', upgraded)
    const fuel = instance('strike_ironclad')
    const state = combat([makePlayer({ hand: [rampage, fuel], exhaust: exhausted, energy: 1 })], [
      makeEnemy({ hp: 10, maxHp: 10 }),
    ])
    const played = playCard(state, 'p1', rampage.uid, {
      enemyUid: 'e1', playerId: null, exhaustUids: upgraded ? [fuel.uid] : undefined,
    })
    assertEqual(played.enemies[0].hp, upgraded ? 7 : 8)
    assertDeepEqual(played.players[0].exhaust.map((card) => card.uid),
      upgraded ? [...exhausted.map((card) => card.uid), fuel.uid] : exhausted.map((card) => card.uid))
  }

  const emptyRampage = instance('rampage')
  const empty = combat([makePlayer({ hand: [emptyRampage], exhaust: [], energy: 1 })], [makeEnemy()])
  const played = playCard(empty, 'p1', emptyRampage.uid, { enemyUid: 'e1', playerId: null })
  assert(played !== empty, 'Rampage with an empty Exhaust pile was refused')
  assertEqual(played.enemies[0].hp, empty.enemies[0].hp)

  const lethalRampage = instance('rampage', true)
  const lethalFuel = instance('strike_ironclad')
  const lethal = combat([makePlayer({
    hand: [lethalRampage, lethalFuel], exhaust: [instance('bash')], energy: 1,
  })], [makeEnemy({ hp: 2, maxHp: 2 })])
  assertEqual(playCard(lethal, 'p1', lethalRampage.uid, { enemyUid: 'e1', playerId: null }), lethal,
    'lethal Rampage+ bypassed its missing Exhaust')
  assertEqual(playCard(lethal, 'p1', lethalRampage.uid, {
    enemyUid: 'e1', playerId: null, exhaustUids: ['not-in-hand'],
  }), lethal, 'lethal Rampage+ bypassed a stale Exhaust choice')
  const killed = playCard(lethal, 'p1', lethalRampage.uid, {
    enemyUid: 'e1', playerId: null, exhaustUids: [lethalFuel.uid],
  })
  assertEqual(killed.enemies[0].hp, 0)
})

check('Exhume returns any chosen Exhaust card to hand before Exhausting itself', () => {
  for (const upgraded of [false, true]) {
    const exhume = instance('exhume', upgraded)
    const lower = instance('defend_ironclad')
    const chosen = instance('bash')
    const state = combat([makePlayer({ hand: [exhume], exhaust: [lower, chosen], energy: 1 })], [makeEnemy()])
    assertEqual(playCard(state, 'p1', exhume.uid, { enemyUid: null, playerId: null }), state,
      'Exhume accepted a missing Exhaust choice')
    assertEqual(playCard(state, 'p1', exhume.uid, {
      enemyUid: null, playerId: null, recoverExhaustUid: 'not-in-pile',
    }), state, 'Exhume accepted a stale Exhaust choice')

    const played = playCard(state, 'p1', exhume.uid, {
      enemyUid: null, playerId: null, recoverExhaustUid: lower.uid,
    })
    assertDeepEqual(played.players[0].hand.map((card) => card.uid), [lower.uid])
    assertDeepEqual(played.players[0].exhaust.map((card) => card.uid), [chosen.uid, exhume.uid])
    assertEqual(played.players[0].energy, upgraded ? 1 : 0)
  }

  const spentBomb = { ...instance('the_bomb'), counter: 3 }
  const exhume = instance('exhume', true)
  const state = combat([makePlayer({ hand: [exhume], exhaust: [spentBomb], energy: 2 })], [
    makeEnemy({ hp: 20, maxHp: 20 }),
  ])
  const returned = playCard(state, 'p1', exhume.uid, {
    enemyUid: null, playerId: null, recoverExhaustUid: spentBomb.uid,
  })
  assertEqual(returned.players[0].hand[0].counter, undefined, 'Exhume preserved The Bomb\'s spent cubes')
  const replayed = playCard(returned, 'p1', spentBomb.uid, { enemyUid: null, playerId: null })
  const ability = endTurnAbilities(replayed).find((entry) => entry.label.includes('The Bomb'))
  const ticked = beginEndPlayerTurn(replayed, [ability.id])
  assertEqual(ticked.players[0].powers[0].counter, 1, 'replayed The Bomb resumed at its old counter')
  assertEqual(ticked.enemies[0].hp, 20, 'replayed The Bomb detonated after one turn')

  const emptyExhume = instance('exhume')
  const empty = combat([makePlayer({ hand: [emptyExhume], exhaust: [], energy: 1 })], [makeEnemy()])
  const played = playCard(empty, 'p1', emptyExhume.uid, { enemyUid: null, playerId: null })
  assert(played !== empty, 'Exhume with an empty Exhaust pile was refused')
  assertDeepEqual(played.players[0].exhaust.map((card) => card.uid), [emptyExhume.uid])
})

check('nested forced cards preserve the outer Start-of-Turn queue', () => {
  const opening = Array.from({ length: 5 }, () => instance('defend_ironclad'))
  const havoc = instance('havoc', true)
  const strike = instance('strike_ironclad')
  const defend = instance('defend_ironclad')
  const state = combat([makePlayer({
    powers: [instance('mayhem'), instance('mayhem')],
    draw: [...opening, havoc, strike, defend],
  })], [makeEnemy({ hp: 10, maxHp: 10 })])
  Object.assign(state, { phase: 'roundEnd', turn: 1 })
  const prepared = preparePlayerTurn(state)
  const abilities = startTurnAbilities(prepared)
  const first = resolveStartPlayerTurn(prepared, abilities.map((ability) => ({
    id: ability.id, shivEnemyUids: [],
  })))
  const nested = playCard(first, 'p1', havoc.uid, { enemyUid: null, playerId: null })
  assertEqual(nested.startTurnProgress?.forcedCard?.cardUid, strike.uid)
  assertEqual(nested.startTurnProgress?.choices.length, 1, 'Havoc dropped the second Mayhem')
  const afterStrike = playCard(nested, 'p1', strike.uid, { enemyUid: 'e1', playerId: null })
  assertEqual(afterStrike.startTurnProgress?.forcedCard?.cardUid, defend.uid,
    'the queued Mayhem did not resume after Havoc')
  const finished = playCard(afterStrike, 'p1', defend.uid, { enemyUid: null, playerId: null })
  assertEqual(finished.phase, 'player')
  assertEqual(finished.startTurnProgress, undefined)
})

check('Mayhem privately pauses Start of Turn and plays its drawn card for 0 Energy', () => {
  for (const upgraded of [false, true]) {
    assertEqual(faceOf(CARDS.mayhem, upgraded).cost, upgraded ? 1 : 2)
    const mayhem = instance('mayhem', upgraded)
    const opening = Array.from({ length: 5 }, () => instance('defend_ironclad'))
    const meteor = instance('meteor_strike')
    const state = combat([makePlayer({ powers: [mayhem], draw: [...opening, meteor], energy: 0 })], [
      makeEnemy({ hp: 20, maxHp: 20 }),
    ])
    Object.assign(state, { phase: 'roundEnd', turn: 1 })
    const prepared = preparePlayerTurn(state)
    const [ability] = startTurnAbilities(prepared)
    const forced = resolveStartPlayerTurn(prepared, [{ id: ability.id, shivEnemyUids: [] }])
    assertEqual(forced.phase, 'start')
    assertEqual(forced.startTurnProgress?.forcedCard?.cardUid, meteor.uid)
    assertEqual(forced.players[0].energy, 3)
    const played = playCard(forced, 'p1', meteor.uid, { enemyUid: 'e1', playerId: null })
    assertEqual(played.phase, 'player')
    assertEqual(played.players[0].energy, 3, 'Mayhem pays the entire printed cost')
    assertEqual(played.enemies[0].hp, 10)
    assertEqual(played.players[0].attacksPlayedThisTurn, 1, 'the forced card counts as played')
  }

  const mayhem = instance('mayhem')
  const opening = Array.from({ length: 5 }, () => instance('defend_ironclad'))
  const daze = instance('daze')
  const state = combat([makePlayer({ powers: [mayhem], draw: [...opening, daze] })], [makeEnemy()])
  Object.assign(state, { phase: 'roundEnd', turn: 1 })
  const prepared = preparePlayerTurn(state)
  const [ability] = startTurnAbilities(prepared)
  const resolved = resolveStartPlayerTurn(prepared, [{ id: ability.id, shivEnemyUids: [] }])
  assertEqual(resolved.phase, 'player', 'an unplayable Mayhem draw is discarded without a prompt')
  assertEqual(resolved.players[0].discard.at(-1)?.uid, daze.uid)

  const emptyDualCast = instance('dual_cast')
  const noOrbState = combat([makePlayer({
    character: 'defect', powers: [instance('mayhem')], draw: [...opening, emptyDualCast], orbs: [null, null, null],
  })], [makeEnemy()])
  Object.assign(noOrbState, { phase: 'roundEnd', turn: 1 })
  const noOrbPrepared = preparePlayerTurn(noOrbState)
  const [noOrbAbility] = startTurnAbilities(noOrbPrepared)
  const noOrbResolved = resolveStartPlayerTurn(noOrbPrepared, [{ id: noOrbAbility.id, shivEnemyUids: [] }])
  assertEqual(noOrbResolved.phase, 'player', 'an impossible Evoke cannot strand Mayhem')
  assertEqual(noOrbResolved.players[0].discard.at(-1)?.uid, emptyDualCast.uid)

  const madness = instance('madness')
  const forcedStrike = instance('strike_ironclad')
  const chainedState = combat([makePlayer({
    powers: [instance('mayhem'), instance('mayhem')],
    draw: [...opening, madness, forcedStrike],
  })], [makeEnemy({ hp: 10, maxHp: 10 })])
  Object.assign(chainedState, { phase: 'roundEnd', turn: 1 })
  const chainedPrepared = preparePlayerTurn(chainedState)
  const chainedAbilities = startTurnAbilities(chainedPrepared)
  const firstForced = resolveStartPlayerTurn(chainedPrepared, chainedAbilities.map((ability) => ({
    id: ability.id, shivEnemyUids: [],
  })))
  const secondForced = playCard(firstForced, 'p1', madness.uid, { enemyUid: null, playerId: null })
  assertEqual(secondForced.startTurnProgress?.forcedCard?.cardUid, forcedStrike.uid)
  assertEqual(secondForced.players[0].freeCardsThisTurn, 1)
  const chained = playCard(secondForced, 'p1', forcedStrike.uid, { enemyUid: 'e1', playerId: null })
  assertEqual(chained.phase, 'player')
  assertEqual(chained.players[0].freeCardsThisTurn, 0,
    'Mayhem\'s forced card still consumes Madness\'s next-card discount')
})

check('a queued post-Mayhem ability rolls back a partial stale-target resolution', () => {
  const opening = Array.from({ length: 5 }, () => instance('defend_ironclad'))
  const forcedDefend = instance('defend_ironclad')
  const state = combat([makePlayer({
    powers: [instance('mayhem'), instance('infinite_blades', true)],
    draw: [...opening, forcedDefend],
    shivs: 5,
  })], [makeEnemy({ hp: 1, maxHp: 1 }), makeEnemy({ uid: 'e2', row: 1, hp: 20, maxHp: 20 })])
  Object.assign(state, { phase: 'roundEnd', turn: 1 })
  const prepared = preparePlayerTurn(state)
  const [mayhem, blades] = startTurnAbilities(prepared)
  const forced = resolveStartPlayerTurn(prepared, [
    { id: mayhem.id, shivEnemyUids: [] },
    { id: blades.id, shivEnemyUids: ['e1', 'e1'] },
  ])
  const stale = playCard(forced, 'p1', forcedDefend.uid, { enemyUid: null, playerId: null })
  assertEqual(stale.enemies[0].hp, 1, 'the first overflow hit must roll back with the stale second target')
  assertEqual(stale.players[0].attacksPlayedThisTurn, 0)
  assertEqual(stale.startTurnProgress?.choices.length, 1)

  const retried = resolveStartPlayerTurn(stale, [{ id: blades.id, shivEnemyUids: ['e2', 'e2'] }])
  assertEqual(retried.enemies[1].hp, 18)
  assertEqual(retried.players[0].attacksPlayedThisTurn, 2,
    'retrying a two-Shiv gain must not retain a hit from the failed attempt')
})

check('Reprogram, Melter, Hyperbeam, and Sunder resolve their ordered cleanup clauses', () => {
  for (const upgraded of [false, true]) {
    const reprogram = instance('reprogram', upgraded)
    const reset = playCard(combat([
      makePlayer({ character: 'defect', hand: [reprogram], orbs: ['lightning', 'frost', 'dark'] }),
    ], [makeEnemy()]), 'p1', reprogram.uid, { enemyUid: null, playerId: null })
    assertEqual(reset.players[0].strength, 1)
    assertDeepEqual(reset.players[0].orbs, [null, null, null])

    const melter = instance('melter', upgraded)
    const melted = playCard(combat([
      makePlayer({ character: 'defect', hand: [melter] }),
    ], [makeEnemy({ hp: 10, maxHp: 10, block: 4 })]), 'p1', melter.uid, { enemyUid: 'e1', playerId: null })
    assertEqual(melted.enemies[0].block, 0)
    assertEqual(melted.enemies[0].hp, upgraded ? 7 : 8)

    const beam = instance('hyperbeam', upgraded)
    const beamed = playCard(combat([
      makePlayer({ character: 'defect', hand: [beam], orbs: ['lightning', 'frost', 'dark'] }),
    ], [
      makeEnemy({ uid: 'left', row: 0, hp: 20, maxHp: 20 }),
      makeEnemy({ uid: 'right', row: 1, hp: 20, maxHp: 20 }),
      makeEnemy({ uid: 'boss', row: 2, hp: 20, maxHp: 20, isBoss: true }),
    ]), 'p1', beam.uid, { enemyUid: 'left', playerId: null })
    const damage = upgraded ? 7 : 5
    assertDeepEqual(beamed.enemies.map((enemy) => enemy.hp), [20 - damage, 20, 20 - damage])
    assertDeepEqual(beamed.players[0].orbs, [null, null, null])

    const sunder = instance('sunder', upgraded)
    const sundered = playCard(combat([
      makePlayer({ character: 'defect', hand: [sunder], energy: 3 }),
    ], [makeEnemy({ uid: 'victim', hp: damage, maxHp: damage }), makeEnemy({ uid: 'spare', row: 1 })]),
    'p1', sunder.uid, { enemyUid: 'victim', playerId: null })
    assertEqual(sundered.enemies[0].dead, true)
    assertEqual(sundered.players[0].energy, 3)
  }
})

check('Fusion, Heatsinks, Stack, and Capacitor fire only on their printed triggers', () => {
  for (const upgraded of [false, true]) {
    const fusion = instance('fusion', upgraded)
    const heat = instance('heatsinks', upgraded)
    const draw = Array.from({ length: 3 }, () => instance('defend_defect'))
    let state = combat([
      makePlayer({ character: 'defect', hand: [heat, fusion], draw, energy: 3, orbs: [null, null, null] }),
    ], [makeEnemy()])
    state = playCard(state, 'p1', heat.uid, { enemyUid: null, playerId: null })
    assertEqual(state.players[0].hand.length, 1, 'Heatsinks triggered from its own play')
    state = playCard(state, 'p1', fusion.uid, { enemyUid: null, playerId: null })
    assertEqual(state.players[0].hand.length, upgraded ? 3 : 2)

    const started = startPlayerTurn(state)
    assertEqual(started.players[0].energy, 4, 'Fusion did not grant start-of-turn Energy')

    const capacitor = instance('capacitor', upgraded)
    const expanded = playCard(combat([
      makePlayer({ character: 'defect', hand: [capacitor], orbs: [null, null, null] }),
    ], [makeEnemy()]), 'p1', capacitor.uid, { enemyUid: null, playerId: null })
    assertEqual(expanded.players[0].orbs.length, upgraded ? 6 : 5)

    const stack = instance('stack', upgraded)
    const blocked = playCard(combat([
      makePlayer({ character: 'defect', hand: [stack], orbs: ['lightning', 'frost', null] }),
      makePlayer({ id: 'p2', name: 'Silent', character: 'silent' }),
    ], [makeEnemy()]), 'p1', stack.uid, { enemyUid: null, playerId: 'p2' })
    assertEqual(blocked.players[0].block, 0)
    assertEqual(blocked.players[1].block, upgraded ? 3 : 2)
  }
})

check('Consume, Double Energy, Streamline, and Meteor Strike use their printed board modifiers', () => {
  for (const upgraded of [false, true]) {
    const consume = instance('consume', upgraded)
    const consumed = playCard(combat([
      makePlayer({ character: 'defect', hand: [consume], energy: 3 }),
    ], [makeEnemy()]), 'p1', consume.uid, { enemyUid: null, playerId: null })
    assertEqual(consumed.players[0].orbEvokeBonus, 1)
    assertEqual(consumed.players[0].powers.length, 1)

    const double = instance('double_energy', upgraded)
    const doubled = playCard(combat([
      makePlayer({ character: 'defect', hand: [double], energy: 3 }),
    ], [makeEnemy()]), 'p1', double.uid, { enemyUid: null, playerId: null })
    assertEqual(doubled.players[0].energy, upgraded ? 6 : 4)
    assertEqual(doubled.players[0].exhaust.length, 1)

    const powers = Array.from({ length: 4 }, () => instance('capacitor'))
    const meteor = instance('meteor_strike', upgraded)
    const struck = playCard(combat([
      makePlayer({ character: 'defect', hand: [meteor], powers, energy: 1 }),
    ], [makeEnemy({ hp: 20, maxHp: 20 })]), 'p1', meteor.uid, { enemyUid: 'e1', playerId: null })
    assertEqual(struck.players[0].energy, 0)
    assertEqual(struck.enemies[0].hp, upgraded ? 8 : 10)

    const streamline = instance('streamline', upgraded)
    const streamlined = playCard(combat([
      makePlayer({ character: 'defect', hand: [streamline], powers: powers.slice(0, 1), energy: 1 }),
    ], [makeEnemy({ hp: 20, maxHp: 20 })]), 'p1', streamline.uid, { enemyUid: 'e1', playerId: null })
    assertEqual(streamlined.players[0].energy, 0)
    assertEqual(streamlined.enemies[0].hp, upgraded ? 16 : 17)
  }

  for (const [orb, expected] of [['lightning', 14], ['frost', 4], ['dark', 10]]) {
    const dual = instance('dual_cast')
    const powers = [instance('consume')]
    const state = combat([
      makePlayer({
        character: 'defect', hand: [dual], energy: 1, powers,
        orbs: [orb, orb, null], orbEvokeBonus: 1,
      }),
    ], [makeEnemy({ hp: 20, maxHp: 20 })])
    const context = orb === 'frost'
      ? { enemyUid: null, playerId: null, evokeSlots: [0, 1], evokeEnemyUids: [null, null] }
      : { enemyUid: 'e1', playerId: null, evokeSlots: [0, 1], evokeEnemyUids: ['e1', 'e1'] }
    const evoked = playCard(state, 'p1', dual.uid, context)
    if (orb === 'frost') assertEqual(evoked.players[0].block, expected)
    else assertEqual(evoked.enemies[0].hp, expected)
  }
})

check('Defragment stacks only on Orb end-of-turn effects and loses Ethereal when upgraded', () => {
  assertEqual(faceOf(CARDS.defragment, false).ethereal, true)
  assertEqual(faceOf(CARDS.defragment, true).ethereal, false)

  const first = instance('defragment')
  const second = instance('defragment', true)
  let state = combat([makePlayer({
    character: 'defect', hand: [first, second], energy: 6, orbs: ['lightning', 'frost', 'dark'],
  })], [makeEnemy({ hp: 20, maxHp: 20 })])
  state = playCard(state, 'p1', first.uid, { enemyUid: null, playerId: null })
  state = playCard(state, 'p1', second.uid, { enemyUid: null, playerId: null })
  assertEqual(state.players[0].orbEndTurnBonus, 2)
  assertEqual(state.players[0].powers.length, 2)

  const ended = beginEndPlayerTurn(state, ['p1/orb:0@e1', 'p1/orb:1'])
  assertEqual(ended.enemies[0].hp, 17, 'Lightning gets the stacked +2 end-turn bonus')
  assertEqual(ended.players[0].block, 3, 'Frost gets the stacked +2 end-turn bonus')

  const dual = instance('dual_cast')
  const evoked = playCard(combat([makePlayer({
    character: 'defect', hand: [dual], energy: 1,
    orbs: ['lightning', 'lightning', null], orbEndTurnBonus: 2,
  })], [makeEnemy({ hp: 20, maxHp: 20 })]), 'p1', dual.uid, {
    enemyUid: 'e1', playerId: null, evokeSlots: [0, 1], evokeEnemyUids: ['e1', 'e1'],
  })
  assertEqual(evoked.enemies[0].hp, 16, 'Defragment must not increase Evoke damage')

  const base = instance('defragment')
  const upgraded = instance('defragment', true)
  const ethereal = beginEndPlayerTurn(combat([makePlayer({ hand: [base, upgraded] })], [makeEnemy()]))
  assertDeepEqual(ethereal.players[0].exhaust.map((card) => card.uid), [base.uid])
  assertDeepEqual(ethereal.players[0].hand.map((card) => card.uid), [upgraded.uid])
})

check('Static Discharge boosts only Lightning Orb end-of-turn effects', () => {
  assertEqual(faceOf(CARDS.static_discharge, false).effects[0].amount, 1)
  assertEqual(faceOf(CARDS.static_discharge, true).effects[0].amount, 2)

  const discharge = instance('static_discharge', true)
  const defragment = instance('defragment', true)
  let state = combat([makePlayer({
    character: 'defect', hand: [discharge, defragment], energy: 6,
    orbs: ['lightning', 'frost', 'dark'],
  })], [makeEnemy({ hp: 20, maxHp: 20 })])
  state = playCard(state, 'p1', discharge.uid, { enemyUid: null, playerId: null })
  state = playCard(state, 'p1', defragment.uid, { enemyUid: null, playerId: null })
  assertEqual(state.players[0].lightningEndTurnBonus, 2)
  assertEqual(state.players[0].orbEndTurnBonus, 1)
  assertEqual(state.players[0].powers.length, 2)

  const ended = beginEndPlayerTurn(state, ['p1/orb:0@e1', 'p1/orb:1'])
  assertEqual(ended.enemies[0].hp, 16, 'Lightning gets both Static Discharge and Defragment')
  assertEqual(ended.players[0].block, 2, 'Frost gets Defragment but not Static Discharge')

  const dual = instance('dual_cast')
  const evokeState = combat([makePlayer({
    character: 'defect', hand: [dual], energy: 1,
    orbs: ['lightning', 'lightning', null],
  })], [makeEnemy({ hp: 20, maxHp: 20 })])
  evokeState.players[0].lightningEndTurnBonus = 2
  const evoked = playCard(evokeState, 'p1', dual.uid, {
    enemyUid: 'e1', playerId: null, evokeSlots: [0, 1], evokeEnemyUids: ['e1', 'e1'],
  })
  assertEqual(evoked.enemies[0].hp, 16, 'Static Discharge must not increase Evoke damage')
})

check('Amplify boosts only Dark Orb Evoke damage', () => {
  assertEqual(faceOf(CARDS.amplify, false).effects[0].amount, 3)
  assertEqual(faceOf(CARDS.amplify, true).effects[0].amount, 5)

  const amplify = instance('amplify', true)
  const consume = instance('consume')
  const dual = instance('dual_cast')
  let state = combat([makePlayer({
    character: 'defect', hand: [amplify, consume, dual], energy: 4,
    orbs: ['dark', null, null],
  })], [makeEnemy({ hp: 20, maxHp: 20 })])
  state = playCard(state, 'p1', amplify.uid, { enemyUid: null, playerId: null })
  state = playCard(state, 'p1', consume.uid, { enemyUid: null, playerId: null })
  assertEqual(state.players[0].darkOrbEvokeBonus, 5)
  assertEqual(state.players[0].orbEvokeBonus, 1)
  const dark = playCard(state, 'p1', dual.uid, {
    enemyUid: 'e1', playerId: null, evokeSlots: [0], evokeEnemyUids: ['e1'],
  })
  assertEqual(dark.enemies[0].hp, 9,
    'Dark combines its printed damage, both Powers, Consume, and Amplify+')

  for (const orb of ['lightning', 'frost']) {
    const card = instance('dual_cast')
    const unaffectedState = combat([makePlayer({
      character: 'defect', hand: [card], energy: 1, orbs: [orb, orb, null],
    })], [makeEnemy({ hp: 20, maxHp: 20 })])
    unaffectedState.players[0].darkOrbEvokeBonus = 5
    const context = orb === 'frost'
      ? { enemyUid: null, playerId: null, evokeSlots: [0, 1], evokeEnemyUids: [null, null] }
      : { enemyUid: 'e1', playerId: null, evokeSlots: [0, 1], evokeEnemyUids: ['e1', 'e1'] }
    const evoked = playCard(unaffectedState, 'p1', card.uid, context)
    if (orb === 'frost') assertEqual(evoked.players[0].block, 2)
    else assertEqual(evoked.enemies[0].hp, 16)
  }
})

check('Core Surge redirects its base cleanse, upgrades to the whole party, and Retains', () => {
  for (const upgraded of [false, true]) {
    const surge = instance('core_surge', upgraded)
    const cured = playCard(combat([
      makePlayer({ character: 'defect', hand: [surge], weak: upgraded ? 1 : 0, vulnerable: 1 }),
      makePlayer({ id: 'p2', name: 'Silent', character: 'silent', weak: 2, vulnerable: 2 }),
    ], [makeEnemy({ hp: 10, maxHp: 10 })]), 'p1', surge.uid, {
      enemyUid: 'e1', playerId: upgraded ? null : 'p2',
    })
    assertEqual(cured.players[0].weak, 0, 'the upgraded cleanse resolves before its Attack')
    assertEqual(cured.players[0].vulnerable, upgraded ? 0 : 1)
    assertEqual(cured.players[1].weak, 0)
    assertEqual(cured.players[1].vulnerable, 0)
    assertEqual(cured.enemies[0].hp, upgraded ? 6 : 7)
  }

  const held = instance('core_surge')
  const retained = endPlayerTurn(combat([makePlayer({ hand: [held] })], [makeEnemy()]), { p1: [] })
  assertDeepEqual(retained.players[0].hand.map((card) => card.uid), [held.uid])
})

check('All for One returns every playable 0-cost discard card in pile order', () => {
  for (const upgraded of [false, true]) {
    const all = instance('all_for_one', upgraded)
    const deflect = instance('deflect')
    const zapPlus = instance('zap', true)
    const daze = instance('daze')
    const zap = instance('zap')
    const state = combat([makePlayer({
      character: 'defect', hand: [all], discard: [deflect, daze, zapPlus, zap], energy: 2,
    })], [makeEnemy({ hp: 10, maxHp: 10 })])
    const recovered = playCard(state, 'p1', all.uid, { enemyUid: 'e1', playerId: null })
    assertEqual(recovered.enemies[0].hp, upgraded ? 7 : 8)
    assertDeepEqual(recovered.players[0].hand.map((card) => card.uid), [deflect.uid, zapPlus.uid])
    assertDeepEqual(recovered.players[0].discard.map((card) => card.uid), [daze.uid, zap.uid, all.uid])
  }
})

check('Thunder Strike deals one separate hit per Lightning Orb and needs no target at zero', () => {
  for (const upgraded of [false, true]) {
    const thunder = instance('thunder_strike', upgraded)
    const struck = playCard(combat([makePlayer({
      character: 'defect', hand: [thunder], orbs: ['lightning', 'frost', 'lightning'], energy: 3,
    })], [makeEnemy({ hp: 20, maxHp: 20, block: 1 })]), 'p1', thunder.uid, {
      enemyUid: 'e1', playerId: null,
    })
    assertEqual(struck.enemies[0].hp, upgraded ? 9 : 13)
  }

  const thunder = instance('thunder_strike')
  const empty = combat([makePlayer({
    character: 'defect', hand: [thunder], orbs: ['frost', 'dark', null], energy: 3,
  })], [makeEnemy({ hp: 10, maxHp: 10 })])
  assertEqual(cardNeedsEnemy(CARDS.thunder_strike, empty.players[0]), false)
  const harmless = playCard(empty, 'p1', thunder.uid, { enemyUid: null, playerId: null })
  assertEqual(harmless.enemies[0].hp, 10)
  assertEqual(harmless.players[0].energy, 0)
})

check('Reinforced Body enforces its base X minimum and assigns upgraded Block icons separately', () => {
  const base = instance('reinforced_body')
  const baseState = combat([
    makePlayer({ character: 'defect', hand: [base], energy: 3 }),
    makePlayer({ id: 'p2', name: 'Silent', character: 'silent' }),
  ], [makeEnemy()])
  assertEqual(playCard(baseState, 'p1', base.uid, {
    enemyUid: null, playerId: null, playerIds: ['p2'], energySpent: 0,
  }), baseState, 'Reinforced Body cannot use X = 0')
  const blocked = playCard(baseState, 'p1', base.uid, {
    enemyUid: null, playerId: null, playerIds: ['p2'], energySpent: 2,
  })
  assertEqual(blocked.players[0].block, 0)
  assertEqual(blocked.players[1].block, 3)
  assertEqual(blocked.players[0].energy, 1)

  const discounted = combat([makePlayer({
    character: 'defect', hand: [instance('reinforced_body')], energy: 3, freeCardsThisTurn: 1,
  })], [makeEnemy()])
  assertEqual(playCard(discounted, 'p1', discounted.players[0].hand[0].uid, {
    enemyUid: null, playerId: null, playerIds: ['p1'], energySpent: 0,
  }), discounted, 'a free-card discount cannot bypass the printed X minimum')

  const upgraded = instance('reinforced_body', true)
  const upgradedState = combat([
    makePlayer({ character: 'defect', hand: [upgraded], energy: 3 }),
    makePlayer({ id: 'p2', name: 'Silent', character: 'silent' }),
  ], [makeEnemy()])
  upgradedState.players[0].cardBlockBonus = 1
  const zero = playCard(upgradedState, 'p1', upgraded.uid, {
    enemyUid: null, playerId: null, playerIds: ['p1', 'p2'], energySpent: 0,
  })
  assertEqual(zero.players[0].block, 1, 'Footwork modifies the first printed X Block icon at X = 0')
  assertEqual(zero.players[1].block, 1, 'the second printed icon has its own target and Footwork bonus')
  assertEqual(zero.players[0].energy, 3)

  const havoc = instance('havoc', true)
  const havocBody = instance('reinforced_body')
  const havocState = playCard(combat([makePlayer({
    character: 'defect', hand: [havoc], draw: [havocBody], energy: 3,
  })], [makeEnemy()]), 'p1', havoc.uid, { enemyUid: null, playerId: null })
  assertEqual(havocState.startTurnProgress, undefined,
    'Havoc must not pause on a base Reinforced Body that cannot spend X = 0')
  assert(havocState.players[0].exhaust.some((card) => card.uid === havocBody.uid))

  const mayhemBody = instance('reinforced_body')
  const mayhemState = combat([makePlayer({
    character: 'defect', powers: [instance('mayhem')],
    draw: [...Array.from({ length: 5 }, () => instance('defend_defect')), mayhemBody],
  })], [makeEnemy()])
  Object.assign(mayhemState, { phase: 'roundEnd', turn: 1 })
  const prepared = preparePlayerTurn(mayhemState)
  const [ability] = startTurnAbilities(prepared)
  const resolved = resolveStartPlayerTurn(prepared, [{ id: ability.id, shivEnemyUids: [] }])
  assertEqual(resolved.phase, 'player',
    'Mayhem must not pause on a base Reinforced Body that cannot spend X = 0')
  assert(resolved.players[0].discard.some((card) => card.uid === mayhemBody.uid))
})

check('Catalyst, Flechettes, Adrenaline, and Grand Finale resolve their full printed rules', () => {
  for (const upgraded of [false, true]) {
    const catalyst = instance('catalyst', upgraded)
    const poisoned = playCard(combat([
      makePlayer({ character: 'silent', hand: [catalyst] }),
    ], [makeEnemy({ poison: 3 })]), 'p1', catalyst.uid, { enemyUid: 'e1', playerId: null })
    assertEqual(poisoned.enemies[0].poison, upgraded ? 9 : 6)
    assertEqual(poisoned.players[0].exhaust.length, 1)

    const flechettes = instance('flechettes', upgraded)
    const skills = [instance('deflect'), instance('acrobatics')]
    const counted = playCard(combat([
      makePlayer({ character: 'silent', hand: [flechettes, ...skills, instance('slice')] }),
    ], [makeEnemy({ hp: 20, maxHp: 20 })]), 'p1', flechettes.uid, { enemyUid: 'e1', playerId: null })
    assertEqual(counted.enemies[0].hp, upgraded ? 17 : 18)

    const adrenaline = instance('adrenaline', upgraded)
    const drawn = [instance('strike_silent'), instance('defend_silent')]
    const surged = playCard(combat([
      makePlayer({ character: 'silent', hand: [adrenaline], draw: drawn, energy: 2 }),
    ], [makeEnemy()]), 'p1', adrenaline.uid, { enemyUid: null, playerId: null })
    assertEqual(surged.players[0].energy, upgraded ? 4 : 3)
    assertDeepEqual(surged.players[0].hand.map((card) => card.uid), drawn.map((card) => card.uid))
    assertEqual(surged.players[0].exhaust.length, 1)

    const finale = instance('grand_finale', upgraded)
    const blocked = combat([
      makePlayer({ character: 'silent', hand: [finale], draw: [instance('defend_silent')] }),
    ], [makeEnemy()])
    assertEqual(
      playCard(blocked, 'p1', finale.uid, { enemyUid: 'e1', playerId: null }),
      blocked,
      'Grand Finale is refused while the draw pile has a card',
    )
    const played = playCard(combat([
      makePlayer({ character: 'silent', hand: [finale], draw: [] }),
    ], [
      makeEnemy({ uid: 'left', row: 0, hp: 20, maxHp: 20 }),
      makeEnemy({ uid: 'right', row: 1, hp: 20, maxHp: 20 }),
      makeEnemy({ uid: 'boss', row: 2, hp: 20, maxHp: 20, isBoss: true }),
    ]), 'p1', finale.uid, { enemyUid: 'left', playerId: null })
    const damage = upgraded ? 12 : 10
    assertDeepEqual(played.enemies.map((enemy) => enemy.hp), [20 - damage, 20, 20 - damage])
  }
})

check('Blur gains its printed discard-this-turn bonus on both faces', () => {
  for (const upgraded of [false, true]) {
    const blur = instance('blur', upgraded)
    const plain = playCard(combat([
      makePlayer({ character: 'silent', hand: [blur] }),
    ], [makeEnemy()]), 'p1', blur.uid, { enemyUid: null, playerId: null })
    assertEqual(plain.players[0].block, upgraded ? 3 : 2)

    const discarded = combat([
      makePlayer({ character: 'silent', hand: [blur] }),
    ], [makeEnemy()])
    discarded.discardedThisTurn = ['p1']
    const boosted = playCard(discarded, 'p1', blur.uid, { enemyUid: null, playerId: null })
    assertEqual(boosted.players[0].block, upgraded ? 4 : 3)
  }
})

check('All-Out Attack discards the chosen card after hitting every enemy', () => {
  for (const upgraded of [false, true]) {
    const attack = instance('all_out_attack', upgraded)
    const chosen = instance('deflect')
    const kept = instance('slice')
    const state = playCard(combat([
      makePlayer({ character: 'silent', hand: [attack, chosen, kept] }),
    ], [
      makeEnemy({ uid: 'left', hp: 10, maxHp: 10 }),
      makeEnemy({ uid: 'right', row: 1, hp: 10, maxHp: 10 }),
    ]), 'p1', attack.uid, { enemyUid: null, playerId: null, discardUids: [chosen.uid] })
    const damage = upgraded ? 3 : 2
    assertDeepEqual(state.enemies.map((enemy) => enemy.hp), [10 - damage, 10 - damage])
    assertDeepEqual(state.players[0].hand.map((card) => card.uid), [kept.uid])
    assertDeepEqual(state.players[0].discard.map((card) => card.uid), [chosen.uid, attack.uid])
  }
})

check('Expertise draws only the cards needed to reach its printed hand size', () => {
  for (const upgraded of [false, true]) {
    const expertise = instance('expertise', upgraded)
    const held = [instance('slice'), instance('deflect')]
    const state = playCard(combat([
      makePlayer({ character: 'silent', hand: [expertise, ...held], draw: Array.from({ length: 8 }, () => instance('strike_silent')) }),
    ], [makeEnemy()]), 'p1', expertise.uid, { enemyUid: null, playerId: null })
    assertEqual(state.players[0].hand.length, upgraded ? 7 : 6)
    assertEqual(state.players[0].draw.length, upgraded ? 3 : 4)
  }
})

check('Reflex and Tactician react only when a card effect discards them', () => {
  for (const upgraded of [false, true]) {
    const attack = instance('all_out_attack')
    const reflex = instance('reflex', upgraded)
    const kept = instance('slice')
    const reflexState = playCard(combat([
      makePlayer({ character: 'silent', hand: [attack, reflex, kept], draw: Array.from({ length: 5 }, () => instance('deflect')) }),
    ], [makeEnemy()]), 'p1', attack.uid, {
      enemyUid: null, playerId: null, discardUids: [reflex.uid],
    })
    assertEqual(reflexState.players[0].hand.length, upgraded ? 4 : 3)
    assert(reflexState.players[0].discard.some((card) => card.uid === reflex.uid))

    const tactician = instance('tactician', upgraded)
    const tacticianState = playCard(combat([
      makePlayer({ character: 'silent', hand: [attack, tactician, kept], energy: 1 }),
    ], [makeEnemy()]), 'p1', attack.uid, {
      enemyUid: null, playerId: null, discardUids: [tactician.uid],
    })
    assertEqual(tacticianState.players[0].energy, upgraded ? 3 : 2)
    assert(tacticianState.players[0].exhaust.some((card) => card.uid === tactician.uid))
    assert(!tacticianState.players[0].discard.some((card) => card.uid === tactician.uid))
  }
})

check('Calculated Gamble finishes drawing before resolving discard reactions', () => {
  for (const upgraded of [false, true]) {
    const gamble = instance('calculated_gamble', upgraded)
    const reflex = instance('reflex', upgraded)
    const tactician = instance('tactician', upgraded)
    const kept = instance('slice')
    const state = playCard(combat([
      makePlayer({
        character: 'silent', hand: [gamble, reflex, tactician, kept],
        draw: Array.from({ length: 10 }, () => instance('deflect')), energy: 0,
        powers: [instance('after_image')],
      }),
    ], [makeEnemy()]), 'p1', gamble.uid, { enemyUid: null, playerId: null })
    assertEqual(state.players[0].hand.length, upgraded ? 6 : 5)
    assertEqual(state.players[0].energy, upgraded ? 3 : 2)
    assertEqual(state.players[0].block, 1, 'After Image fires once for the whole discard effect')
    assertEqual(state.players[0].exhaust.length, upgraded ? 1 : 2)
    assert(state.discardedThisTurn.includes('p1'))
    const ownDraw = state.log.findIndex((line) => line === `${state.players[0].name} draws 3`)
    const reflexDraw = state.log.findIndex((line) => line.startsWith(`${upgraded ? 'Reflex+' : 'Reflex'}:`))
    assert(ownDraw >= 0 && reflexDraw > ownDraw, 'Reflex waits for Calculated Gamble to finish drawing')
  }
})

check('Calculated Gamble never duplicates a shuffled Tactician when reactions resolve', () => {
  const gamble = instance('calculated_gamble')
  const reflex = instance('reflex', true)
  const tactician = instance('tactician', true)
  const spare = instance('slice')
  const state = playCard(combat([
    makePlayer({
      character: 'silent', hand: [gamble, reflex, tactician, spare],
      draw: [], discard: [], energy: 0,
    }),
  ], [makeEnemy()]), 'p1', gamble.uid, { enemyUid: null, playerId: null })
  const player = state.players[0]
  const all = [...player.hand, ...player.draw, ...player.discard, ...player.exhaust]
  assertEqual(all.filter((card) => card.uid === tactician.uid).length, 1)
  assertEqual(player.exhaust.filter((card) => card.uid === tactician.uid).length, 1)
})

check('Scry routes discarded cards through Silent reactions and After Image', () => {
  const thirdEye = instance('third_eye')
  const reflex = instance('reflex')
  const tactician = instance('tactician')
  const spare = instance('slice')
  const state = playCard(combat([
    makePlayer({
      character: 'silent', hand: [thirdEye], draw: [reflex, tactician, spare], energy: 1,
      powers: [instance('after_image')],
    }),
  ], [makeEnemy()]), 'p1', thirdEye.uid, {
    enemyUid: null, playerId: null, scryDiscardUids: [reflex.uid, tactician.uid],
  })
  const player = state.players[0]
  const all = [...player.hand, ...player.draw, ...player.discard, ...player.exhaust]
  assertEqual(player.energy, 2)
  assertEqual(player.block, 3, 'Third Eye grants 2 Block and After Image grants 1')
  assert(state.discardedThisTurn.includes('p1'))
  assertEqual(all.filter((card) => card.uid === tactician.uid).length, 1)
  assertEqual(player.exhaust.filter((card) => card.uid === tactician.uid).length, 1)
  assert(player.hand.some((card) => card.uid === reflex.uid), 'Reflex draws after the Scry text finishes')
})

check('Anger returns the played card itself to the top of draw', () => {
  for (const upgraded of [false, true]) {
    const anger = instance('anger', upgraded)
    const spare = instance('defend_ironclad')
    const state = combat([makePlayer({ hand: [anger], draw: [spare] })], [makeEnemy({ hp: 20 })])
    const played = playCard(state, 'p1', anger.uid, { enemyUid: 'e1', playerId: 'p1' })
    assertEqual(played.enemies[0].hp, upgraded ? 18 : 19)
    assertEqual(played.players[0].draw[0].uid, anger.uid)
    assertEqual(played.players[0].draw[1].uid, spare.uid)
    assert(!played.players[0].discard.some((card) => card.uid === anger.uid))
  }
})

check('repeated status-producing cards mint distinct Daze instances', () => {
  const first = instance('turbo')
  const second = instance('turbo')
  const state = combat(
    [makePlayer({ character: 'defect', hand: [first, second], energy: 0 })],
    [makeEnemy()],
  )
  const afterFirst = playCard(state, 'p1', first.uid, { enemyUid: null, playerId: null })
  const afterSecond = playCard(afterFirst, 'p1', second.uid, { enemyUid: null, playerId: null })
  const dazes = afterSecond.players[0].discard.filter((card) => card.defId === 'daze')
  assertEqual(dazes.length, 2, 'both TURBO plays add a Daze')
  assertEqual(new Set(dazes.map((card) => card.uid)).size, 2, 'each Daze needs a unique card uid')
})

// The other half of the conditional cards. The CASES table above plays each of
// these with its condition FALSE, which a card that had silently lost its bonus
// would also pass. These plays make each condition true and assert the bonus
// actually arrives.
check('a conditional bonus lands when the board satisfies it', () => {
  // `upgraded` is not optional decoration. The CASES table plays both faces but
  // only ever with the condition OFF, so it pins the printed base and nothing
  // else; dropping the bonus from an upgraded face left the whole suite green.
  // Every assertion below is therefore made against both faces.
  const play = (cardId, {
    player = {}, enemy = {}, die, upgraded = false, discardedThisTurn = [], stanceChangedThisTurn = [],
  } = {}) => {
    const card = instance(cardId, upgraded)
    const base = combat([makePlayer({ hand: [card], energy: 3, ...player })], [makeEnemy({ hp: 20, maxHp: 20, ...enemy })])
    const state = { ...base, die: die ?? base.die, discardedThisTurn, stanceChangedThisTurn }
    const next = playCard(state, 'p1', card.uid, {
      enemyUid: cardNeedsEnemy(faceOf(CARDS[cardId], upgraded)) ? 'e1' : null,
      playerId: null,
    })
    assert(next !== state, `${cardId}${upgraded ? '+' : ''} was refused`)
    return next
  }

  // Slice and Deflect both read "if you have a shiv" — the token, not a card.
  const shivved = { player: { shivs: 1 } }
  assertEqual(play('slice', shivved).enemies[0].hp, 18, 'Slice with a shiv hits for 2')
  assertEqual(
    play('slice', { ...shivved, upgraded: true }).enemies[0].hp,
    17,
    'Slice+ with a shiv hits for 3',
  )
  assertEqual(play('deflect', shivved).players[0].block, 2, 'Deflect with a shiv blocks 2')
  assertEqual(
    play('deflect', { ...shivved, upgraded: true }).players[0].block,
    3,
    'Deflect+ with a shiv blocks 3',
  )

  // Bane reads the ENEMY, so the bonus is the only thing separating a poisoned
  // target from a clean one.
  const poisoned = { enemy: { poison: 1 } }
  assertEqual(play('bane', poisoned).enemies[0].hp, 16, 'Bane into Poison hits for 4')
  assertEqual(
    play('bane', { ...poisoned, upgraded: true }).enemies[0].hp,
    15,
    'Bane+ into Poison hits for 5',
  )

  // Steam Barrier reads the TOPMOST card of the discard pile, which is the most
  // recently discarded and so the END of the array. Both piles below hold the
  // same two cards in opposite orders, which is what makes this a test of the
  // end rather than of the contents: a resolver reading `at(0)` passes a
  // one-card pile and swaps these two answers.
  const zeroOnTop = [instance('bash'), instance('deflect')]
  const twoOnTop = [instance('deflect'), instance('bash')]
  assertEqual(
    play('steam_barrier', { player: { discard: zeroOnTop } }).players[0].block,
    2,
    'Steam Barrier over a 0-cost top card blocks 2',
  )
  assertEqual(
    play('steam_barrier', { player: { discard: zeroOnTop }, upgraded: true }).players[0].block,
    3,
    'Steam Barrier+ over a 0-cost top card blocks 3',
  )
  assertEqual(
    play('steam_barrier', { player: { discard: twoOnTop } }).players[0].block,
    1,
    'Steam Barrier over a 2-cost top card blocks 1',
  )
  // An unplayable card has NO cost (p.24) -- it prints no energy gem at all --
  // so it satisfies "costs 0" at no number. `CARDS.daze` stores 0 because the
  // field is required, and that placeholder paid the bonus out. This is not a
  // contrived board: an enemy deals a Daze, it cannot be played, and the
  // end-of-turn sweep leaves it on top precisely because everything else was.
  assertEqual(
    play('steam_barrier', { player: { discard: [instance('daze')] } }).players[0].block,
    1,
    'a Daze on top of the discard pile is not a 0-cost card',
  )
  // The cost read has to be the face actually in the pile. Zap costs 1 and
  // Zap+ costs 0, so upgrading a card is an ordinary way to turn Steam Barrier
  // on -- and reading the base face of an upgraded card silently switches it
  // back off.
  assertEqual(
    play('steam_barrier', { player: { discard: [instance('zap', true)] } }).players[0].block,
    2,
    'an upgraded 0-cost card on top satisfies the condition',
  )
  assertEqual(
    play('steam_barrier', { player: { discard: [instance('zap')] } }).players[0].block,
    1,
    'and its un-upgraded face, costing 1, does not',
  )
  const discountedStreamline = instance('streamline')
  const discountingPowers = [instance('capacitor'), instance('fusion')]
  assertEqual(
    play('steam_barrier', {
      player: { discard: [discountedStreamline], powers: discountingPowers },
    }).players[0].block,
    2,
    'Streamline costs 0 in discard while two Powers are in play (FAQ)',
  )

  // Barrage counts orbs as SWINGS. Two orbs is two separate one-damage hits,
  // which is why this is `times` and not `amount`.
  const twoOrbs = { player: { orbs: ['lightning', 'frost', null] } }
  assertEqual(play('barrage', twoOrbs).enemies[0].hp, 18, 'Barrage with two orbs swings twice')
  // The upgraded face prints "+1", so the same board is one more swing.
  assertEqual(
    play('barrage', { ...twoOrbs, upgraded: true }).enemies[0].hp,
    17,
    'Barrage+ with two orbs swings three times',
  )

  // One shared die per round drives the base face of Go for the Eyes: the Weak
  // is printed against 4-5-6 only.
  assertEqual(play('go_for_the_eyes', { die: 4 }).enemies[0].weak, 1, 'die 4 applies the Weak')
  assertEqual(play('go_for_the_eyes', { die: 3 }).enemies[0].weak, 0, 'die 3 does not')
  // The upgraded face prints no dice at all, so the roll stops mattering.
  assertEqual(
    play('go_for_the_eyes', { die: 3, upgraded: true }).enemies[0].weak,
    1,
    'Go for the Eyes+ applies the Weak whatever the die shows',
  )

  assertEqual(
    play('halt', { player: { stance: 'wrath' } }).players[0].block,
    2,
    'Halt in Wrath blocks 2',
  )
  assertEqual(
    play('halt', { player: { stance: 'wrath' }, upgraded: true }).players[0].block,
    3,
    'Halt+ in Wrath blocks 3',
  )

  assertEqual(
    play('heavy_blade', { player: { strength: 2 } }).enemies[0].hp,
    11,
    'Heavy Blade makes each Strength worth 3 damage',
  )
  assertEqual(
    play('heavy_blade', { player: { strength: 2 }, upgraded: true }).enemies[0].hp,
    7,
    'Heavy Blade+ makes each Strength worth 5 damage',
  )
  assertEqual(
    play('sneaky_strike', { discardedThisTurn: ['p1'] }).players[0].energy,
    3,
    'Sneaky Strike refunds 2 Energy after a discard this turn',
  )
  assertEqual(
    play('backstab', { enemy: { hp: 19, maxHp: 20 } }).enemies[0].hp,
    17,
    'Backstab gets no bonus below full HP',
  )
  assertEqual(
    play('compile_driver', {
      player: {
        orbs: ['lightning', 'frost', 'lightning'],
        draw: [instance('strike_defect'), instance('strike_defect')],
      },
    }).players[0].hand.length,
    2,
    'Compile Driver draws once per distinct Orb type',
  )
  assertEqual(
    play('claw', { player: { discard: [instance('deflect')] } }).enemies[0].hp,
    18,
    'Claw gets its bonus over a 0-cost discard top',
  )
  assertEqual(
    play('claw', {
      player: { discard: [instance('streamline')], powers: discountingPowers },
    }).enemies[0].hp,
    18,
    'Claw gets its bonus over a power-discounted Streamline',
  )
  const recovered = instance('deflect')
  assertEqual(
    play('scrape', { player: { discard: [recovered] } }).players[0].hand.at(-1).uid,
    recovered.uid,
    'Scrape returns a 0-cost discard top to hand',
  )
  const recoveredStreamline = instance('streamline')
  assertEqual(
    play('scrape', {
      player: { discard: [recoveredStreamline], powers: discountingPowers },
    }).players[0].hand.at(-1).uid,
    recoveredStreamline.uid,
    'Scrape returns a power-discounted Streamline from discard (FAQ)',
  )
  assertEqual(
    play('flurry_of_blows', { stanceChangedThisTurn: ['p1'] }).enemies[0].hp,
    18,
    'Flurry of Blows adds one hit after switching stance',
  )
  assertEqual(
    play('flurry_of_blows', { stanceChangedThisTurn: ['p1'], upgraded: true }).enemies[0].hp,
    17,
    'Flurry of Blows+ adds two hits after switching stance',
  )
  const weakFlurry = play('flurry_of_blows', {
    player: { weak: 1 },
    enemy: { hp: 20, maxHp: 20 },
    stanceChangedThisTurn: ['p1'],
  })
  assertEqual(weakFlurry.enemies[0].hp, 20, 'Weak modifies every hit of one Flurry attack')
  assertEqual(weakFlurry.players[0].weak, 0, 'one Flurry attack spends one Weak token')
  const vulnerableFlurry = play('flurry_of_blows', {
    enemy: { hp: 20, maxHp: 20, vulnerable: 1 },
    stanceChangedThisTurn: ['p1'],
  })
  assertEqual(vulnerableFlurry.enemies[0].hp, 16, 'Vulnerable modifies every hit of one Flurry attack')
  assertEqual(vulnerableFlurry.enemies[0].vulnerable, 0, 'one Flurry attack spends one Vulnerable token')
  const crushed = play('crush_joints', { player: { stance: 'wrath' } })
  assertEqual(crushed.enemies[0].vulnerable, 1, 'Crush Joints in Wrath applies Vulnerable')
  const calmed = play('fear_no_evil', { player: { stance: 'wrath' } })
  assertEqual(calmed.players[0].stance, 'calm', 'Fear No Evil leaves Wrath for Calm')
})

check('Retain cards survive the ordered end-of-turn discard', () => {
  const retained = instance('protect')
  const spent = instance('strike_watcher')
  const state = combat([makePlayer({ character: 'watcher', hand: [retained, spent] })], [makeEnemy()])
  const next = endPlayerTurn(state, { p1: [spent.uid, retained.uid] })
  assertDeepEqual(next.players[0].hand.map((held) => held.uid), [retained.uid], 'Protect stays in hand')
  assertDeepEqual(next.players[0].discard.map((held) => held.uid), [spent.uid], 'only non-Retain cards discard')
})

check('Escape Plan checks only the card its own draw effect drew', () => {
  for (const [drawnId, expectedBlock] of [['defend_silent', 1], ['strike_silent', 0]]) {
    const escape = instance('escape_plan')
    const drawn = instance(drawnId)
    const state = combat(
      [makePlayer({ character: 'silent', hand: [escape], draw: [drawn] })],
      [makeEnemy()],
    )
    const played = playCard(state, 'p1', escape.uid, { enemyUid: null, playerId: null })
    assertEqual(played.players[0].block, expectedBlock)
    assertEqual(played.players[0].hand[0]?.uid, drawn.uid)
  }

  const upgraded = instance('escape_plan', true)
  const attack = instance('strike_silent')
  const played = playCard(
    combat([makePlayer({ character: 'silent', hand: [upgraded], draw: [attack] })], [makeEnemy()]),
    'p1', upgraded.uid, { enemyUid: null, playerId: null },
  )
  assertEqual(played.players[0].block, 1, 'Escape Plan+ grants Block before any draw result')
})

check('Finisher counts earlier Attack cards and Shiv attacks once each', () => {
  const strike = instance('strike_silent')
  const finisher = instance('finisher')
  let state = combat(
    [makePlayer({ character: 'silent', hand: [strike, finisher], shivs: 1 })],
    [makeEnemy({ hp: 20, maxHp: 20 })],
  )
  state = playCard(state, 'p1', strike.uid, { enemyUid: 'e1', playerId: null })
  assertEqual(state.players[0].attacksPlayedThisTurn, 1)
  state = spendShiv(state, 'p1', 'e1')
  assertEqual(state.players[0].attacksPlayedThisTurn, 2)
  state = playCard(state, 'p1', finisher.uid, { enemyUid: 'e1', playerId: null })
  assertEqual(state.enemies[0].hp, 16, 'Strike, Shiv, then two Finisher hits')
  assertEqual(state.players[0].attacksPlayedThisTurn, 3, 'Finisher counts only after resolving itself')

  const reset = startPlayerTurn({ ...state, phase: 'roundEnd' })
  assertEqual(reset.players[0].attacksPlayedThisTurn, 0)
})

check('Masterful Stab changes cost only after HP is actually lost this combat', () => {
  for (const upgraded of [false, true]) {
    const offering = instance('offering')
    const stab = instance('masterful_stab', upgraded)
    let state = combat(
      [makePlayer({ character: 'silent', hand: [offering, stab], energy: 3 })],
      [makeEnemy({ hp: 20, maxHp: 20 })],
    )
    state = playCard(state, 'p1', offering.uid, { enemyUid: null, playerId: null })
    assert(state.players[0].lostHpThisCombat, 'Offering records its real HP loss')
    const energy = state.players[0].energy
    state = playCard(state, 'p1', stab.uid, { enemyUid: 'e1', playerId: null })
    assertEqual(state.players[0].energy, energy - (upgraded ? 1 : 2))
    assertEqual(state.enemies[0].hp, upgraded ? 17 : 18)
  }

  const carried = makePlayer({ lostHpThisCombat: true, attacksPlayedThisTurn: 4 })
  const fresh = createCombat(createRng(7), [carried], [makeEnemy()])
  assertEqual(fresh.players[0].lostHpThisCombat, false, 'a new combat clears the HP-loss ledger')
  assertEqual(fresh.players[0].attacksPlayedThisTurn, 0, 'a new combat clears the attack ledger')
})

check('Outmaneuver pays only after that card was Retained last turn', () => {
  const freshCard = instance('outmaneuver')
  const fresh = playCard(
    combat([makePlayer({ character: 'silent', hand: [freshCard], energy: 1 })], [makeEnemy()]),
    'p1', freshCard.uid, { enemyUid: null, playerId: null },
  )
  assertEqual(fresh.players[0].energy, 1, 'a newly drawn Outmaneuver gains nothing')

  const retained = instance('outmaneuver')
  let state = combat([makePlayer({ character: 'silent', hand: [retained] })], [makeEnemy()])
  state = endPlayerTurn(state, { p1: [retained.uid] })
  assertEqual(state.players[0].hand[0]?.retainedLastTurn, true)
  state = enemyTurn(state)
  state = startPlayerTurn(state)
  state.players[0].energy = 1
  state = playCard(state, 'p1', retained.uid, { enemyUid: null, playerId: null })
  assertEqual(state.players[0].energy, 3)
  assertEqual(state.players[0].discard.at(-1)?.retainedLastTurn, undefined,
    'leaving hand forgets the prior Retain')
})

check('Accuracy changes Shiv hits without changing ordinary Attacks', () => {
  const accuracy = instance('accuracy')
  const strike = instance('strike_silent')
  let state = combat(
    [makePlayer({ character: 'silent', hand: [accuracy, strike], energy: 3, shivs: 1 })],
    [makeEnemy({ hp: 20, maxHp: 20 })],
  )
  state = playCard(state, 'p1', accuracy.uid, { enemyUid: null, playerId: null })
  assertEqual(state.players[0].shivDamageBonus, 1)
  state = spendShiv(state, 'p1', 'e1')
  assertEqual(state.enemies[0].hp, 18, 'Accuracy makes the Shiv deal 2')
  state = playCard(state, 'p1', strike.uid, { enemyUid: 'e1', playerId: null })
  assertEqual(state.enemies[0].hp, 17, 'Accuracy does not modify a card hit')
})

check('Choke adds every Weak and Poison token on its target to one hit', () => {
  for (const upgraded of [false, true]) {
    const choke = instance('choke', upgraded)
    const state = combat(
      [makePlayer({ character: 'silent', hand: [choke] })],
      [makeEnemy({ hp: 20, maxHp: 20, weak: 2, poison: 3 })],
    )
    const played = playCard(state, 'p1', choke.uid, { enemyUid: 'e1', playerId: null })
    assertEqual(played.enemies[0].hp, upgraded ? 11 : 12)
    assertEqual(played.enemies[0].weak, 2, 'Choke reads but does not spend enemy Weak')
    assertEqual(played.enemies[0].poison, 3, 'Choke reads but does not spend Poison')
  }
})

check('Footwork adds Block only to printed Attack and Skill Block icons', () => {
  const footwork = instance('footwork')
  const defend = instance('defend_silent', true)
  const ironWave = instance('iron_wave')
  let state = combat(
    [makePlayer({ character: 'silent', hand: [footwork, defend, ironWave], energy: 6,
      potions: ['block_potion'] })],
    [makeEnemy({ hp: 20, maxHp: 20 })],
  )
  state = playCard(state, 'p1', footwork.uid, { enemyUid: null, playerId: null })
  assertEqual(state.players[0].cardBlockBonus, 1)
  state = playCard(state, 'p1', defend.uid, { enemyUid: null, playerId: null })
  assertEqual(state.players[0].block, 3, 'Defend+ has one printed Block icon')
  state = playCard(state, 'p1', ironWave.uid, { enemyUid: 'e1', playerId: null })
  assertEqual(state.players[0].block, 5, 'an Attack Block icon gains one extra Block too')
  state = activatePotion(state, 'p1', 'block_potion', { targetPlayerId: 'p1' })
  assertEqual(state.players[0].block, 7, 'Footwork does not modify a potion')

  const firstFootwork = instance('footwork')
  const secondFootwork = instance('footwork')
  const stackedDefend = instance('defend_silent', true)
  let stacked = combat(
    [makePlayer({ character: 'silent', hand: [firstFootwork, secondFootwork, stackedDefend], energy: 6 })],
    [makeEnemy()],
  )
  stacked = playCard(stacked, 'p1', firstFootwork.uid, { enemyUid: null, playerId: null })
  stacked = playCard(stacked, 'p1', secondFootwork.uid, { enemyUid: null, playerId: null })
  stacked = playCard(stacked, 'p1', stackedDefend.uid, { enemyUid: null, playerId: null })
  assertEqual(stacked.players[0].block, 4, 'stacked Footwork modifies the one printed Block icon twice')

  const conditionalFootwork = instance('footwork')
  const deflect = instance('deflect', true)
  let conditional = combat(
    [makePlayer({ character: 'silent', hand: [conditionalFootwork, deflect], energy: 3, shivs: 1 })],
    [makeEnemy()],
  )
  conditional = playCard(conditional, 'p1', conditionalFootwork.uid, { enemyUid: null, playerId: null })
  conditional = playCard(conditional, 'p1', deflect.uid, { enemyUid: null, playerId: null })
  assertEqual(conditional.players[0].block, 5, 'both active Block icons on Deflect+ get the bonus')
})

check('Envenom applies Poison once per hit even when Block absorbs all damage', () => {
  const envenom = instance('envenom')
  const spray = instance('dagger_spray')
  let state = combat(
    [makePlayer({ character: 'silent', hand: [envenom, spray], energy: 4 })],
    [makeEnemy({ hp: 20, maxHp: 20, block: 2 })],
  )
  state = playCard(state, 'p1', envenom.uid, { enemyUid: null, playerId: null })
  assertEqual(state.players[0].hitPoison, 1)
  state = playCard(state, 'p1', spray.uid, { enemyUid: 'e1', playerId: null })
  assertEqual(state.enemies[0].hp, 20, 'Block absorbs both one-damage hits')
  assertEqual(state.enemies[0].poison, 2, 'each blocked hit still applies Poison')

  const shivState = combat(
    [makePlayer({ character: 'silent', shivs: 1 })],
    [makeEnemy({ hp: 20, maxHp: 20 })],
  )
  shivState.players[0].hitPoison = 1
  const shivved = spendShiv(shivState, 'p1', 'e1')
  assertEqual(shivved.enemies[0].poison, 1, 'Envenom includes Shiv hits')
})

check('Dodge and Roll assigns every Block icon independently and Footwork modifies each one', () => {
  const dodge = instance('dodge_and_roll')
  const state = combat([
    makePlayer({ id: 'p1', character: 'silent', hand: [dodge] }),
    makePlayer({ id: 'p2', name: 'Ally', row: 1 }),
  ], [makeEnemy()])
  state.players[0].cardBlockBonus = 1
  const played = playCard(state, 'p1', dodge.uid, {
    enemyUid: null,
    playerId: null,
    playerIds: ['p2', 'p1'],
  })
  assertEqual(played.players[0].block, 2, 'one icon may stay with the caster')
  assertEqual(played.players[1].block, 2, 'the other may go to an ally')

  assertEqual(playCard(state, 'p1', dodge.uid, {
    enemyUid: null,
    playerId: null,
    playerIds: ['p2'],
  }), state, 'every printed icon needs a target')
  assertEqual(playCard(state, 'p1', dodge.uid, {
    enemyUid: null,
    playerId: null,
    playerIds: ['p2', 'gone'],
  }), state, 'a stale ally target refuses the atomic play')
})

check('Bouncing Flask assigns Poison cubes independently, including repeated targets', () => {
  const flask = instance('bouncing_flask', true)
  const state = combat(
    [makePlayer({ id: 'p1', character: 'silent', hand: [flask] })],
    [makeEnemy({ uid: 'e1' }), makeEnemy({ uid: 'e2', row: 1 })],
  )
  const played = playCard(state, 'p1', flask.uid, {
    enemyUid: null,
    playerId: null,
    enemyUids: ['e1', 'e2', 'e1'],
  })
  assertEqual(played.enemies[0].poison, 2)
  assertEqual(played.enemies[1].poison, 1)
  assertEqual(playCard(state, 'p1', flask.uid, {
    enemyUid: null,
    playerId: null,
    enemyUids: ['e1', 'gone', 'e2'],
  }), state, 'a dead or stale enemy target refuses every cube')
})

check('Concentrate gains Energy from exactly the optional cards it discards', () => {
  for (const upgraded of [false, true]) {
    const concentrate = instance('concentrate', upgraded)
    const first = instance('strike_silent')
    const second = instance('defend_silent')
    const spare = instance('neutralize')
    const state = combat([
      makePlayer({ character: 'silent', hand: [concentrate, first, second, spare], energy: 1 }),
    ], [makeEnemy()])
    const played = playCard(state, 'p1', concentrate.uid, {
      enemyUid: null,
      playerId: null,
      discardUids: [first.uid, second.uid],
    })
    assertEqual(played.players[0].energy, upgraded ? 4 : 3)
    assertDeepEqual(played.players[0].discard.map((card) => card.uid), [first.uid, second.uid])
    assertEqual(played.players[0].exhaust.at(-1)?.uid, concentrate.uid)

    assertEqual(playCard(state, 'p1', concentrate.uid, {
      enemyUid: null,
      playerId: null,
      discardUids: [first.uid, first.uid],
    }), state, 'duplicate ids cannot mint Energy')
  }

  const upgraded = instance('concentrate', true)
  const empty = playCard(combat([
    makePlayer({ character: 'silent', hand: [upgraded], energy: 1 }),
  ], [makeEnemy()]), 'p1', upgraded.uid, { enemyUid: null, playerId: null, discardUids: [] })
  assertEqual(empty.players[0].energy, 2, 'the upgraded face adds one even when none are discarded')
})

check('Distraction grants Block only on the first real Poison gain each turn', () => {
  const flask = instance('bouncing_flask')
  const poison = instance('deadly_poison')
  let state = {
    ...combat([
      makePlayer({
        character: 'silent',
        powers: [instance('distraction')],
        hand: [flask, poison],
        energy: 6,
      }),
    ], [makeEnemy({ hp: 20, maxHp: 20 })]),
    turn: 1,
  }
  state = playCard(state, 'p1', flask.uid, {
    enemyUid: null,
    playerId: null,
    enemyUids: ['e1', 'e1'],
  })
  assertEqual(state.players[0].block, 2, 'two Flask cubes still trigger once')
  const poisonLines = state.log.flatMap((line, index) => line.includes('takes 1 Poison') ? [index] : [])
  const distractionLine = state.log.findIndex((line) => line.includes('Distraction'))
  assert(poisonLines.length === 2 && poisonLines.every((index) => index < distractionLine),
    'all printed Poison resolves before Distraction')
  state = playCard(state, 'p1', poison.uid, { enemyUid: 'e1', playerId: null })
  assertEqual(state.players[0].block, 2, 'another Poison effect in the same turn does not trigger again')

  const nextTurn = startPlayerTurn({
    ...state,
    phase: 'roundEnd',
    players: state.players.map((player) => ({
      ...player,
      draw: Array.from({ length: 5 }, () => instance('strike_silent')),
    })),
  })
  const nextPoison = instance('deadly_poison')
  nextTurn.players[0].hand.push(nextPoison)
  nextTurn.players[0].energy = 3
  const replayed = playCard(nextTurn, 'p1', nextPoison.uid, { enemyUid: 'e1', playerId: null })
  assertEqual(replayed.players[0].block, 2, 'the Start of Turn reset makes Distraction available again')

  const cappedPoison = instance('deadly_poison')
  const capped = combat([
    makePlayer({ character: 'silent', powers: [instance('distraction')], hand: [cappedPoison] }),
  ], [makeEnemy({ poison: 30 })])
  const ignored = playCard(capped, 'p1', cappedPoison.uid, { enemyUid: 'e1', playerId: null })
  assertEqual(ignored.players[0].block, 0, 'an ignored Poison cube does not spend the once-per-turn trigger')
})

check('Storm of Steel turns every chosen discard into a Shiv, plus one when upgraded', () => {
  for (const upgraded of [false, true]) {
    const storm = instance('storm_of_steel', upgraded)
    const first = instance('strike_silent')
    const second = instance('defend_silent')
    const state = combat([
      makePlayer({ character: 'silent', hand: [storm, first, second], energy: 3 }),
    ], [makeEnemy()])
    const played = playCard(state, 'p1', storm.uid, {
      enemyUid: null,
      playerId: null,
      discardUids: [first.uid, second.uid],
    })
    assertEqual(played.players[0].shivs, upgraded ? 3 : 2)
    assertDeepEqual(played.players[0].discard.map((card) => card.uid), [first.uid, second.uid, storm.uid])
  }

  const upgraded = instance('storm_of_steel', true)
  const empty = playCard(combat([
    makePlayer({ character: 'silent', hand: [upgraded], energy: 3 }),
  ], [makeEnemy()]), 'p1', upgraded.uid, { enemyUid: null, playerId: null, discardUids: [] })
  assertEqual(empty.players[0].shivs, 1, 'Storm of Steel+ grants its extra Shiv after discarding none')

  const overflow = instance('storm_of_steel', false)
  const fodder = [instance('strike_silent'), instance('defend_silent')]
  const thrown = playCard(combat([
    makePlayer({ character: 'silent', hand: [overflow, ...fodder], energy: 3, shivs: 4 }),
    makePlayer({ id: 'p2', shivs: 1 }),
  ], [makeEnemy({ uid: 'e1', hp: 5, maxHp: 5 }), makeEnemy({ uid: 'e2', hp: 5, maxHp: 5 })]),
  'p1', overflow.uid, {
    enemyUid: null,
    playerId: null,
    discardUids: fodder.map((card) => card.uid),
    shivEnemyUids: ['e1', 'e2'],
  })
  assertDeepEqual(thrown.enemies.map((enemy) => enemy.hp), [4, 4])
  assertEqual(thrown.players[0].shivs, 4, 'overflow Shivs are thrown without taking unavailable cubes')
  assertEqual(thrown.players[0].attacksPlayedThisTurn, 2, 'each overflow Shiv is a separate attack')
})

check('Unload uses every held Shiv as a separately targeted attack', () => {
  for (const upgraded of [false, true]) {
    const unload = instance('unload', upgraded)
    const state = combat([
      makePlayer({
        character: 'silent', hand: [unload], energy: 3, shivs: 2,
      }),
    ], [
      makeEnemy({ uid: 'e1', hp: 20, maxHp: 20 }),
      makeEnemy({ uid: 'e2', hp: 20, maxHp: 20 }),
    ])
    Object.assign(state.players[0], { shivDamageBonus: 1, hitPoison: 1, attacksPlayedThisTurn: 4 })
    const played = playCard(state, 'p1', unload.uid, {
      enemyUid: 'e1', playerId: null, shivEnemyUids: ['e1', 'e2'],
    })
    const shivDamage = upgraded ? 4 : 3
    assertDeepEqual(played.enemies.map((enemy) => enemy.hp), [18 - shivDamage, 20 - shivDamage])
    assertDeepEqual(played.enemies.map((enemy) => enemy.poison), [2, 1], 'Envenom applies on every separate hit')
    assertEqual(played.players[0].shivs, 0)
    assertEqual(played.players[0].attacksPlayedThisTurn, 7, 'the card and both Shivs count as attacks')
  }

  const unload = instance('unload')
  const stale = combat([
    makePlayer({ character: 'silent', hand: [unload], shivs: 2 }),
  ], [makeEnemy({ uid: 'e1' }), makeEnemy({ uid: 'e2', dead: true, hp: 0 })])
  assertEqual(playCard(stale, 'p1', unload.uid, {
    enemyUid: 'e1', playerId: null, shivEnemyUids: ['e1'],
  }), stale, 'every held Shiv needs a target')
  assertEqual(playCard(stale, 'p1', unload.uid, {
    enemyUid: 'e1', playerId: null, shivEnemyUids: ['e1', 'e2'],
  }), stale, 'a stale Shiv target refuses the whole play atomically')

  const separate = instance('unload')
  const tokenState = combat([
    makePlayer({ character: 'silent', hand: [separate], shivs: 2, weak: 3 }),
  ], [
    makeEnemy({ uid: 'e1', hp: 20, maxHp: 20, vulnerable: 3 }),
    makeEnemy({ uid: 'e2', hp: 20, maxHp: 20, vulnerable: 3 }),
  ])
  const spentTokens = playCard(tokenState, 'p1', separate.uid, {
    enemyUid: 'e1', playerId: null, shivEnemyUids: ['e1', 'e2'],
  })
  assertEqual(spentTokens.players[0].weak, 0, 'the card and each Shiv spend their own Weak')
  assertDeepEqual(spentTokens.enemies.map((enemy) => enemy.vulnerable), [1, 2],
    'each separately targeted attack spends its own Vulnerable')
})

check('a Miracle can be spent for Energy only during the Player Turn', () => {
  const state = combat([makePlayer({ miracles: 2, energy: 2 })], [makeEnemy()])
  const spent = spendMiracle(state, 'p1')
  assertEqual(spent.players[0].miracles, 1)
  assertEqual(spent.players[0].energy, 3)
  const enemyPhase = { ...spent, phase: 'enemy' }
  assert(spendMiracle(enemyPhase, 'p1') === enemyPhase, 'a Miracle was spent outside the Player Turn')

  const card = instance('bash')
  const capped = combat([makePlayer({ hand: [card], miracles: 1, energy: 6 })], [makeEnemy()])
  assert(spendMiracle(capped, 'p1') === capped, 'over-cap Energy must be spent atomically on a card')
  const paid = playCard(capped, 'p1', card.uid, {
    enemyUid: 'e1',
    playerId: null,
    spendMiracle: true,
  })
  assertEqual(paid.players[0].miracles, 0, 'the atomic payment spends the Miracle')
  assertEqual(paid.players[0].energy, 5, 'the Miracle subsidises the card without storing 7 Energy')
})

check('Shivs are separate attacks and overflow may attack immediately', () => {
  const armed = combat(
    [makePlayer({ character: 'silent', shivs: 2, strength: 1 })],
    [makeEnemy({ hp: 20, maxHp: 20, vulnerable: 2 })],
  )
  const thrown = spendShiv(armed, 'p1', 'e1')
  assertEqual(thrown.players[0].shivs, 1, 'one Shiv token is spent')
  assertEqual(thrown.enemies[0].hp, 16, 'Strength and Vulnerable modify the separate Shiv attack')
  assertEqual(thrown.enemies[0].vulnerable, 1, 'a Shiv spends one Vulnerable')

  const dance = instance('blade_dance')
  const fullSupply = combat(
    [
      makePlayer({ id: 'p1', character: 'silent', hand: [dance], shivs: 4 }),
      makePlayer({ id: 'p2', character: 'silent', shivs: 1 }),
    ],
    [
      makeEnemy({ uid: 'e1', hp: 1, maxHp: 1 }),
      makeEnemy({ uid: 'e2', row: 1, hp: 20, maxHp: 20 }),
    ],
  )
  const overflow = playCard(fullSupply, 'p1', dance.uid, {
    enemyUid: null,
    playerId: null,
    shivEnemyUids: ['e1', 'e2'],
  })
  assertEqual(overflow.players.reduce((sum, player) => sum + player.shivs, 0), 5, 'the Shiv supply stays capped globally')
  assert(overflow.enemies[0].dead, 'the first overflow Shiv can kill its target')
  assertEqual(overflow.enemies[1].hp, 19, 'the second overflow Shiv independently attacks another enemy')
})

// Weak and Vulnerable are spent by a hit LANDING (p.24). A counted attack that
// comes to nothing lands none, and Barrage at zero orbs is that attack — a
// legal play the Defect can make on turn 1 of every combat, since they start
// with no orbs charged. Paying the tokens out anyway cleansed the attacker's
// own Weak for 1 Energy and binned a Vulnerable the party had just set up.
check('an attack that swings zero times spends no Weak and strips no Vulnerable', () => {
  const card = instance('barrage')
  const state = combat(
    [makePlayer({ character: 'defect', hand: [card], energy: 3, weak: 2, orbs: [null, null, null] })],
    [makeEnemy({ hp: 20, vulnerable: 2 })],
  )
  const next = playCard(state, 'p1', card.uid, { enemyUid: 'e1', playerId: null })
  assert(next !== state, 'the play was refused')
  assertEqual(next.enemies[0].hp, 20, 'no orbs means no damage')
  assertEqual(next.enemies[0].vulnerable, 2, 'the Vulnerable token stays on the enemy')
  assertEqual(next.players[0].weak, 2, 'the attacker keeps their Weak')
  // A zero-swing attack takes no target, so the per-target loop prints nothing.
  // Without a line of its own the player clicks a card, loses the Energy, and
  // the log says only that the card was played.
  assert(
    next.log.some((line) => line.includes('had nothing to attack with')),
    `the wasted attack should say so, log was: ${next.log.join(' | ')}`,
  )
  // The card is still played and still paid for: this is a wasted turn, not an
  // illegal move, and refusing it would be a different rule.
  assertEqual(next.players[0].energy, 2, 'the Energy is still spent')

  // One orb is enough to make it a real attack again, and then both tokens move.
  const armed = combat(
    [makePlayer({ character: 'defect', hand: [card], energy: 3, weak: 2, orbs: ['frost', null, null] })],
    [makeEnemy({ hp: 20, vulnerable: 2 })],
  )
  const swung = playCard(armed, 'p1', card.uid, { enemyUid: 'e1', playerId: null })
  assertEqual(swung.players[0].weak, 1, 'a landed hit does spend a Weak')
  assertEqual(swung.enemies[0].vulnerable, 1, 'and does strip a Vulnerable')
})

// `Amount` can carry a bonus and a count at once, and the two are additive.
// No printed card does both, so nothing pins the combination and an `else if`
// between them passes the whole suite. The fixture is what says which of the
// two readings the vocabulary means, before a card arrives that depends on it.
check('an amount carrying both a bonus and a count adds both', () => {
  CARDS.fixture_bonus_and_count = {
    id: 'fixture_bonus_and_count',
    name: 'Fixture Bonus And Count',
    owner: 'defect',
    type: 'skill',
    rarity: 'common',
    cost: 1,
    effects: [
      { kind: 'block', amount: { base: 1, per: 'orbs', bonus: { plus: 4, when: { kind: 'hasShiv' } } } },
    ],
  }
  try {
    const play = (player) => {
      const card = instance('fixture_bonus_and_count')
      const state = combat([makePlayer({ hand: [card], energy: 3, ...player })], [makeEnemy({})])
      const next = playCard(state, 'p1', card.uid, { enemyUid: null, playerId: null })
      assert(next !== state, 'the fixture was refused')
      return next.players[0].block
    }
    assertEqual(play({ orbs: ['frost', 'frost', null], shivs: 0 }), 3, 'base 1 plus two orbs')
    assertEqual(play({ orbs: ['frost', 'frost', null], shivs: 1 }), 7, 'and the bonus on top of that')
    assertEqual(play({ orbs: [null, null, null], shivs: 1 }), 5, 'the bonus alone, with nothing to count')
  } finally {
    delete CARDS.fixture_bonus_and_count
  }
})

// A bonus that reads the target has to be re-read for each enemy an
// area-of-effect card reaches. Reading it once — off the first enemy, or off
// nothing at all — is the natural way to write this and is wrong the moment a
// row holds one poisoned enemy and one clean one. No printed card does both
// yet, so the fixture is what keeps the resolver honest until one does.
check('a per-target bonus is re-read for every enemy in the row', () => {
  CARDS.fixture_row_bane = {
    id: 'fixture_row_bane',
    name: 'Fixture Row Bane',
    owner: 'silent',
    type: 'attack',
    rarity: 'common',
    cost: 1,
    target: 'row',
    effects: [{ kind: 'hit', amount: { base: 1, bonus: { plus: 2, when: { kind: 'targetPoisoned' } } } }],
  }
  const card = instance('fixture_row_bane')
  const state = combat(
    [makePlayer({ hand: [card], energy: 3 })],
    [
      makeEnemy({ uid: 'e1', row: 0, hp: 20, poison: 1 }),
      makeEnemy({ uid: 'e2', row: 0, hp: 20, poison: 0 }),
    ],
  )
  try {
    const next = playCard(state, 'p1', card.uid, { enemyUid: 'e1', playerId: null })
    assert(next !== state, 'the row attack was refused')
    const [struck, clean] = next.enemies
    assertEqual(struck.hp, 17, 'the poisoned enemy takes the bonus')
    assertEqual(clean.hp, 19, 'the clean enemy in the same row does not')
  } finally {
    // `CARDS` is module-level and every later check in this process sees it.
    // The fixture is not a printed card, so it has no scan, no CSV row and no
    // entry in the card index -- it is safe here only because the checks that
    // would trip over it happen to skip names they do not recognise.
    delete CARDS.fixture_row_bane
  }
})

// The scans and the component CSV are two independent transcriptions of the
// same physical cards. Cost and type are printed on both, so disagreement means
// one of them was read wrong -- and neither is checkable from the other side of
// the code.
check('every card agrees with the printed component list', () => {
  const rows = readFileSync(new URL('../data/raw/player-cards.csv', import.meta.url), 'utf8')
  const byName = new Map()
  // Values are quoted and none of the fields used here contain a comma.
  const lines = rows.split('\n').slice(1)
  for (const line of lines) {
    const cells = line.split('","').map((cell) => cell.replace(/^"|"\r?$/g, ''))
    if (cells.length < 6) continue
    const [, name, cost, rarity, , type] = cells
    byName.set(name, { cost, rarity, type })
  }
  assert(byName.size > 250, `the component list should have parsed, got ${byName.size} rows`)

  const disagreements = []
  for (const def of Object.values(CARDS)) {
    const printed = byName.get(def.name)
    // Not every live card has a row: Dual Cast and the Status cards are listed
    // differently or not at all.
    if (!printed || printed.cost === '') continue
    if (String(def.cost) !== printed.cost) {
      disagreements.push(`${def.id}: code costs ${def.cost}, the list prints ${printed.cost}`)
    }
    if (def.type !== printed.type.toLowerCase()) {
      disagreements.push(`${def.id}: code says ${def.type}, the list prints ${printed.type}`)
    }
    // Rarity is the card's BANNER COLOUR, and it decides which reward deck the
    // card sits in and how many copies the box holds. It went unchecked, and
    // Bane -- blue-bannered, one copy -- was transcribed as a common. Starters
    // are not listed with a rarity of their own.
    if (def.rarity !== 'starter' && printed.rarity && def.rarity !== printed.rarity.toLowerCase()) {
      disagreements.push(`${def.id}: code says ${def.rarity}, the list prints ${printed.rarity}`)
    }
  }
  assertEqual(disagreements.length, 0, disagreements.join(' | '))
})

check('a multi-hit into a row lands every blow on every enemy', () => {
  // The two dimensions were never crossed: the row check used Cleave, which
  // hits once, and both Dagger Spray checks used a single enemy. An engine that
  // gave all the hits to the anchor and one to each of its neighbours passed
  // everything -- Dagger Spray+ into a row of three would read 3/1/1.
  const spray = instance('dagger_spray', true)
  const swept = playCard(
    combat(
      [makePlayer({ character: 'silent', hand: [spray] })],
      [
        makeEnemy({ uid: 'a', row: 0, hp: 20 }),
        makeEnemy({ uid: 'b', row: 0, hp: 20 }),
        makeEnemy({ uid: 'c', row: 1, hp: 20 }),
      ],
    ),
    'p1',
    spray.uid,
    { enemyUid: 'a', playerId: null },
  )
  assertEqual(swept.enemies[0].hp, 17, 'the anchor takes all three hits')
  assertEqual(swept.enemies[1].hp, 17, 'and so does the enemy beside it')
  assertEqual(swept.enemies[2].hp, 20, 'the next row is untouched')
})

check('a multi-hit that kills partway still reports one clean attack', () => {
  // Dagger Spray is the first shipped card that can kill on its first swing and
  // still have a swing left.
  //
  // Note what this does NOT claim. `combat.ts` breaks out of the swing loop on
  // a kill, and that break is deliberately unobservable: damage clamps at zero
  // hit points and the log writes one aggregated line per attack, so deleting
  // it changes no state and no text. I tried -- the mutation survives, and it
  // survives because there is nothing there to catch, not because the check is
  // weak. It is a guard against a future change (a per-swing trigger, an
  // overkill counter), not current behaviour. What IS observable is asserted:
  // the kill is clean, and the swings the corpse did not absorb are not
  // silently transferred to anyone else.
  const spray = instance('dagger_spray')
  const killed = playCard(
    combat(
      [makePlayer({ character: 'silent', hand: [spray] })],
      [makeEnemy({ uid: 'a', row: 0, hp: 1 }), makeEnemy({ uid: 'b', row: 0, hp: 20 })],
    ),
    'p1',
    spray.uid,
    { enemyUid: 'a', playerId: null },
  )
  assert(killed.enemies[0].dead, 'the first hit is lethal')
  assertEqual(killed.enemies[0].hp, 0, 'and hit points never go below zero')
  assertEqual(
    killed.log.filter((line) => /is dead/.test(line)).length,
    1,
    `the kill is announced exactly once: ${killed.log.join(' | ')}`,
  )
  assertEqual(killed.enemies[1].hp, 18, 'the living neighbour takes both of its own hits')
})

check('two of the same enemy in ONE row can still be told apart', () => {
  // The row is the natural discriminator, but a row-targeting card puts both
  // copies in the same row -- and then "Cultist (row 0)" names them both. The
  // log then reads as striking a corpse: kill one and the next line reports a
  // hit on what looks like the same creature.
  const spray = instance('dagger_spray')
  const state = combat(
    [makePlayer({ character: 'silent', hand: [spray] })],
    [
      makeEnemy({ uid: 'a', row: 0, defId: 'green_louse', hp: 1 }),
      makeEnemy({ uid: 'b', row: 0, defId: 'green_louse', hp: 20 }),
    ],
  )
  const next = playCard(state, 'p1', spray.uid, { enemyUid: 'a', playerId: null })
  const hits = next.log.filter((line) => /hit|damages/.test(line))
  const named = new Set(hits.map((line) => line.replace(/.*?(Green Louse[^ ]*[^,]*?)( for| is).*/, '$1')))
  assert(
    named.size >= 2,
    `two enemies sharing a row must not print the same name: ${next.log.join(' | ')}`,
  )
  assert(
    next.log.some((line) => /#1|#2/.test(line)),
    `a position within the row is what separates them: ${next.log.join(' | ')}`,
  )

  // And two in DIFFERENT rows still use the row alone -- no needless "#1".
  const split = combat(
    [makePlayer({ character: 'silent', hand: [instance('dagger_spray')] })],
    [
      makeEnemy({ uid: 'a', row: 0, defId: 'green_louse', hp: 20 }),
      makeEnemy({ uid: 'b', row: 1, defId: 'green_louse', hp: 20 }),
    ],
  )
  const apart = playCard(split, 'p1', split.players[0].hand[0].uid, {
    enemyUid: 'a',
    playerId: null,
  })
  assert(
    !apart.log.some((line) => /#\d/.test(line)),
    `the row alone already separates these: ${apart.log.join(' | ')}`,
  )
})

check('targeted potions require a living target and discard one copy', () => {
  const state = combat(
    [makePlayer({ strength: 3, weak: 1, potions: ['fire_potion', 'fire_potion'] })],
    [makeEnemy({ hp: 8, maxHp: 8, vulnerable: 1 })],
  )
  assert(activatePotion(state, 'p1', 'fire_potion') === state, 'a missing target must not waste the potion')
  const used = activatePotion(state, 'p1', 'fire_potion', { enemyUid: 'e1' })
  assertEqual(used.enemies[0].hp, 4, 'Fire Potion deals 4 plain damage')
  assertEqual(used.players[0].weak, 1, 'plain damage does not spend the drinker\'s Weak')
  assertEqual(used.enemies[0].vulnerable, 1, 'plain damage does not spend Vulnerable')
  assertDeepEqual(used.players[0].potions, ['fire_potion'], 'only one physical copy is discarded')
  assert(used.log.some((line) => line === 'Ironclad uses Fire Potion'), 'using the item is named in the log')
})

check('support potions share the card effect resolver and obey caps', () => {
  const draw = [instance('strike_ironclad'), instance('defend_ironclad'), instance('bash')]
  let state = combat([
    makePlayer({
      hp: 5,
      energy: 5,
      strength: 7,
      draw,
      potions: ['block_potion', 'energy_potion', 'blood_potion', 'flex_potion', 'swift_potion'],
    }),
    makePlayer({ id: 'p2', name: 'Silent', character: 'silent', block: 1 }),
  ], [makeEnemy()])
  const refused = activatePotion(state, 'p1', 'block_potion', { targetPlayerId: 'missing' })
  assert(refused === state, 'an invalid ally must not consume Block Potion')
  state = activatePotion(state, 'p1', 'block_potion', { targetPlayerId: 'p2' })
  state = activatePotion(state, 'p1', 'energy_potion')
  state = activatePotion(state, 'p1', 'blood_potion')
  state = activatePotion(state, 'p1', 'flex_potion')
  state = activatePotion(state, 'p1', 'swift_potion')
  assertEqual(state.players[0].block, 0)
  assertEqual(state.players[1].block, 3, 'Block Potion grants its printed 2 Block to any player')
  assertEqual(state.players[0].energy, 6, 'Energy remains capped')
  assertEqual(state.players[0].hp, 7)
  assertEqual(state.players[0].strength, 8, 'Strength remains capped')
  assertEqual(state.players[0].strengthLossAtEndOfTurn, 1)
  assertEqual(state.players[0].hand.length, 3)
  assertEqual(state.players[0].potions.length, 0, 'every used potion is discarded')
  const ended = beginEndPlayerTurn(state)
  assertEqual(ended.players[0].strength, 7, 'Flex Potion Strength expires at end of turn')
  assertEqual(ended.players[0].strengthLossAtEndOfTurn, 0)
})

check('Weak Potion applies the three printed Weak tokens', () => {
  const state = combat(
    [makePlayer({ potions: ['weak_potion'] })],
    [makeEnemy()],
  )
  const used = activatePotion(state, 'p1', 'weak_potion', { enemyUid: 'e1' })
  assertEqual(used.enemies[0].weak, 3)
})

check('simple printed potions resolve through the shared effect vocabulary', () => {
  const draw = Array.from({ length: 5 }, () => instance('strike_ironclad'))
  let state = combat(
    [makePlayer({
      weak: 3,
      vulnerable: 2,
      draw,
      potions: ['ancient_potion', 'cunning_potion', 'snecko_oil'],
    })],
    [makeEnemy()],
  )
  state = activatePotion(state, 'p1', 'ancient_potion')
  state = activatePotion(state, 'p1', 'cunning_potion')
  state = activatePotion(state, 'p1', 'snecko_oil')
  assertEqual(state.players[0].weak, 0)
  assertEqual(state.players[0].vulnerable, 0)
  assertEqual(state.players[0].shivs, 3)
  assertEqual(state.players[0].hand.length, 5)
  assertEqual(state.players[0].draw.filter((card) => card.defId === 'daze').length, 2)
  assertEqual(state.players[0].potions.length, 0)
})

check('Snecko Oil puts Daze on top without exceeding the shared ten-card deck', () => {
  const existing = Array.from({ length: 9 }, () => instance('daze'))
  const state = combat(
    [
      makePlayer({ potions: ['snecko_oil'], draw: Array.from({ length: 5 }, () => instance('strike_ironclad')) }),
      makePlayer({ id: 'p2', name: 'Silent', character: 'silent', row: 1, draw: existing }),
    ],
    [makeEnemy({ defId: 'spike_slime' })],
  )
  const used = activatePotion(state, 'p1', 'snecko_oil')
  assertEqual(used.players[0].hand.length, 5)
  assertEqual(used.players[0].draw.length, 1, 'only one Daze remains in the shared supply')
  assertEqual(used.players[0].draw[0].defId, 'daze', 'Daze is the next card drawn')
  const afterEnemy = enemyTurn({ ...used, phase: 'enemy', die: 3 })
  const dazes = afterEnemy.players.reduce((total, player) => total + [
    ...player.draw,
    ...player.hand,
    ...player.discard,
  ].filter((card) => card.defId === 'daze').length, 0)
  assertEqual(dazes, 10, 'an enemy cannot draw an eleventh card from the shared Daze deck')
})

check('Cunning Potion offers one immediate attack per unavailable Shiv cube', () => {
  const state = combat(
    [
      makePlayer({ shivs: 4, potions: ['cunning_potion'] }),
      makePlayer({ id: 'p2', name: 'Silent', character: 'silent', row: 1, shivs: 1 }),
    ],
    [makeEnemy({ hp: 10, maxHp: 10 })],
  )
  const used = activatePotion(state, 'p1', 'cunning_potion', {
    shivEnemyUids: ['e1', 'e1', 'e1'],
  })
  assertEqual(used.players[0].shivs, 4, 'the full shared supply cannot grant another cube')
  assertEqual(used.enemies[0].hp, 7, 'all three unavailable cubes became immediate attacks')
  assertEqual(used.players[0].potions.length, 0)
})

check('overflow Shiv choices are atomic when an earlier attack kills a later target', () => {
  const state = combat(
    [
      makePlayer({ shivs: 4, potions: ['cunning_potion'] }),
      makePlayer({ id: 'p2', name: 'Silent', character: 'silent', row: 1, shivs: 1 }),
    ],
    [
      makeEnemy({ uid: 'fragile', hp: 1, maxHp: 1 }),
      makeEnemy({ uid: 'durable', hp: 5, maxHp: 5 }),
    ],
  )
  const refused = activatePotion(state, 'p1', 'cunning_potion', {
    shivEnemyUids: ['fragile', 'fragile', 'durable'],
  })
  assert(refused === state, 'a later attack cannot silently disappear into a dead target')
  const used = activatePotion(state, 'p1', 'cunning_potion', {
    shivEnemyUids: ['fragile', 'durable', 'durable'],
  })
  assertDeepEqual(used.enemies.map((enemy) => enemy.hp), [0, 3])
})

check('Explosive Potion damages only the chosen row and its boss', () => {
  const state = combat(
    [
      makePlayer({ potions: ['explosive_potion'] }),
      makePlayer({ id: 'p2', name: 'Silent', character: 'silent', row: 1 }),
    ],
    [
      makeEnemy({ uid: 'row-0', row: 0, hp: 6, maxHp: 6 }),
      makeEnemy({ uid: 'row-1', row: 1, hp: 6, maxHp: 6 }),
      makeEnemy({ uid: 'boss', row: 0, hp: 6, maxHp: 6, isBoss: true }),
    ],
  )
  assert(activatePotion(state, 'p1', 'explosive_potion') === state, 'a row still needs a target')
  const used = activatePotion(state, 'p1', 'explosive_potion', { enemyRow: 1 })
  assertDeepEqual(used.enemies.map((enemy) => enemy.hp), [6, 4, 4])
  assertEqual(used.players[0].potions.length, 0)
})

check('Flex Potion still loses its printed Strength when the gain hits the cap', () => {
  const state = combat(
    [makePlayer({ strength: 8, potions: ['flex_potion'] })],
    [makeEnemy()],
  )
  const used = activatePotion(state, 'p1', 'flex_potion')
  assertEqual(used.players[0].strength, 8, 'the unavailable gain is ignored at the cap')
  assertEqual(used.players[0].strengthLossAtEndOfTurn, 1, 'the separate end-of-turn loss is still scheduled')
  const ended = beginEndPlayerTurn(used)
  assertEqual(ended.players[0].strength, 7)
  assert(ended.log.includes('Ironclad loses 1 Strength at end of turn'))
})

check('a lethal potion ends combat immediately and cannot be used outside the Player Turn', () => {
  const state = combat(
    [makePlayer({ potions: ['fire_potion'] })],
    [makeEnemy({ hp: 4, maxHp: 4 })],
  )
  const won = activatePotion(state, 'p1', 'fire_potion', { enemyUid: 'e1' })
  assertEqual(won.phase, 'won')
  assert(won.enemies[0].dead)
  const enemyTurnState = { ...state, phase: 'enemy' }
  assert(
    activatePotion(enemyTurnState, 'p1', 'fire_potion', { enemyUid: 'e1' }) === enemyTurnState,
    'potions are not usable during the Enemy Turn',
  )
})

check('Combust damages its chosen row and boss once per turn', () => {
  for (const upgraded of [false, true]) {
    const power = instance('combust', upgraded)
    const state = combat(
      [makePlayer({ powers: [power] })],
      [
        makeEnemy({ uid: 'left', row: 0, hp: 6 }),
        makeEnemy({ uid: 'left-two', row: 0, hp: 6 }),
        makeEnemy({ uid: 'right', row: 1, hp: 6 }),
        makeEnemy({ uid: 'boss', row: 2, isBoss: true, hp: 6 }),
      ],
    )
    const missing = activatePower(state, 'p1', power.uid)
    assertEqual(missing, state, 'Combust needs a live row target')
    const used = activatePower(state, 'p1', power.uid, { enemyRow: 0 })
    const damage = upgraded ? 2 : 1
    assertDeepEqual(used.enemies.map((enemy) => enemy.hp), [6 - damage, 6 - damage, 6, 6 - damage])
    assert(used.powerTriggersUsedThisTurn.includes(`p1/power:${power.uid}`))
    assertEqual(activatePower(used, 'p1', power.uid, { enemyRow: 1 }), used,
      'Combust cannot activate twice in one turn')
  }
})

check('Combust can choose an empty player row, but pauses for a forced card', () => {
  const power = instance('combust')
  const state = combat(
    [makePlayer({ powers: [power] }), makePlayer({ id: 'p2', name: 'Ally', row: 1 })],
    [makeEnemy({ uid: 'left', row: 0 }), makeEnemy({ uid: 'boss', isBoss: true, hp: 6 })],
  )
  const emptyRow = activatePower(state, 'p1', power.uid, { enemyRow: 1 })
  assertDeepEqual(emptyRow.enemies.map((enemy) => enemy.hp), [6, 5], 'only the boss occupies the empty row')
  const forced = {
    ...state,
    startTurnProgress: { choices: [], forcedCard: {
      playerId: 'p2', cardUid: 'forced', sourceCardId: 'havoc', exhaustNonPower: false,
    } },
  }
  assertEqual(activatePower(forced, 'p1', power.uid, { enemyRow: 0 }), forced,
    'Combust bypassed the unresolved forced card')
})

check('Double Tap plays the next Attack twice with separate targets and modifiers', () => {
  const doubleTap = instance('double_tap')
  const strike = instance('strike_ironclad')
  const state = combat(
    [makePlayer({ hand: [doubleTap, strike] })],
    [
      makeEnemy({ uid: 'first', hp: 6, maxHp: 6, vulnerable: 1 }),
      makeEnemy({ uid: 'second', hp: 6, maxHp: 6, row: 1 }),
    ],
  )
  const primed = playCard(state, 'p1', doubleTap.uid, { enemyUid: null, playerId: 'p1' })
  assertEqual(primed.players[0].doubledAttacksThisTurn, 1)
  assertEqual(primed.players[0].energy, 2)

  const first = playCard(primed, 'p1', strike.uid, { enemyUid: 'first', playerId: 'p1' })
  assertEqual(first.phase, 'copy')
  assertEqual(first.enemies[0].hp, 4, 'the first play separately spent Vulnerable')
  assertEqual(first.enemies[0].vulnerable, 0)
  assertEqual(first.enemies[1].hp, 6)
  assertEqual(first.players[0].attacksPlayedThisTurn, 1)
  assertEqual(first.players[0].doubledAttacksThisTurn, 0)
  assert(playCard(first, 'p1', doubleTap.uid, { enemyUid: null, playerId: 'p1' }) === first,
    'another card bypassed the unresolved copy')
  assert(playCardCopy(first, 'p1', { enemyUid: null, playerId: 'p1' }) === first,
    'a targetless copied Strike was accepted')

  const copied = playCardCopy(first, 'p1', { enemyUid: 'second', playerId: 'p1' })
  assertEqual(copied.phase, 'player')
  assertEqual(copied.enemies[0].hp, 4)
  assertEqual(copied.enemies[1].hp, 5, 'the copy used its own target')
  assertEqual(copied.players[0].attacksPlayedThisTurn, 2)
  assertEqual(copied.players[0].energy, 1, 'the virtual copy costs no extra Energy')
  assertEqual(copied.players[0].discard.filter((card) => card.uid === strike.uid).length, 1,
    'the physical Attack is cleaned up exactly once')
})

check('Double Tap copies pay their own card-effect choices from the current hand', () => {
  const doubleTap = instance('double_tap', true)
  const rampage = instance('rampage', true)
  const firstCost = instance('strike_ironclad')
  const secondCost = instance('defend_ironclad')
  const state = combat(
    [makePlayer({ hand: [doubleTap, rampage, firstCost, secondCost] })],
    [makeEnemy({ hp: 10, maxHp: 10 })],
  )
  const primed = playCard(state, 'p1', doubleTap.uid, { enemyUid: null, playerId: 'p1' })
  const first = playCard(primed, 'p1', rampage.uid, {
    enemyUid: 'e1', playerId: 'p1', exhaustUids: [firstCost.uid],
  })
  assertEqual(first.phase, 'copy')
  assertDeepEqual(first.players[0].hand.map((card) => card.uid), [secondCost.uid])
  assert(playCardCopy(first, 'p1', {
    enemyUid: 'e1', playerId: 'p1', exhaustUids: [firstCost.uid],
  }) === first, 'the copy reused a card already Exhausted by the first play')
  const copied = playCardCopy(first, 'p1', {
    enemyUid: 'e1', playerId: 'p1', exhaustUids: [secondCost.uid],
  })
  assertEqual(copied.enemies[0].hp, 7,
    'the copy recounts the Exhaust pile after paying its own second cost')
  assertDeepEqual(copied.players[0].exhaust.map((card) => card.uid), [firstCost.uid, secondCost.uid])
  assertEqual(copied.players[0].energy, 2, 'Double Tap+ itself was free and Rampage paid once')
})

check('multiple Double Taps copy multiple subsequent Attacks, never one Attack more than twice', () => {
  const taps = [instance('double_tap', true), instance('double_tap', true)]
  const strikes = [instance('strike_ironclad'), instance('strike_ironclad')]
  let state = combat([makePlayer({ hand: [...taps, ...strikes] })], [makeEnemy({ hp: 10, maxHp: 10 })])
  state = playCard(state, 'p1', taps[0].uid, { enemyUid: null, playerId: 'p1' })
  state = playCard(state, 'p1', taps[1].uid, { enemyUid: null, playerId: 'p1' })
  assertEqual(state.players[0].doubledAttacksThisTurn, 2)
  for (const strike of strikes) {
    state = playCard(state, 'p1', strike.uid, { enemyUid: 'e1', playerId: 'p1' })
    assertEqual(state.phase, 'copy')
    state = playCardCopy(state, 'p1', { enemyUid: 'e1', playerId: 'p1' })
  }
  assertEqual(state.enemies[0].hp, 6)
  assertEqual(state.players[0].attacksPlayedThisTurn, 4)
  assertEqual(state.players[0].doubledAttacksThisTurn, 0)
})

check('a copied Attack gets a fresh private post-draw choice without advancing the preview', () => {
  const doubleTap = instance('double_tap', true)
  const dagger = instance('dagger_throw')
  const firstDraw = instance('defend_silent')
  const secondDraw = instance('strike_silent')
  let state = combat([
    makePlayer({ character: 'silent', hand: [doubleTap, dagger], draw: [firstDraw, secondDraw] }),
  ], [makeEnemy({ hp: 10, maxHp: 10 })])
  state = playCard(state, 'p1', doubleTap.uid, { enemyUid: null, playerId: 'p1' })
  const firstPreview = previewCardChoice(state, 'p1', dagger.uid)
  assertDeepEqual(firstPreview.cards.map((card) => card.uid), [firstDraw.uid])
  state = playCard(state, 'p1', dagger.uid, {
    enemyUid: 'e1', playerId: 'p1', discardUids: [firstDraw.uid],
  })
  const before = structuredClone(state)
  const copyPreview = previewCardCopyChoice(state, 'p1')
  assertDeepEqual(copyPreview.cards.map((card) => card.uid), [secondDraw.uid])
  assertDeepEqual(state, before, 'previewing the copied draw changed the authoritative state')
  state = playCardCopy(state, 'p1', {
    enemyUid: 'e1', playerId: 'p1', discardUids: [secondDraw.uid],
  })
  assertEqual(state.enemies[0].hp, 6)
  assertEqual(state.phase, 'player')
})

check('the physical Attack stays outside every pile until its Double Tap copy finishes', () => {
  const doubleTap = instance('double_tap', true)
  const headbutt = instance('headbutt')
  const recovered = instance('defend_ironclad')
  let state = combat([
    makePlayer({ hand: [doubleTap, headbutt], discard: [recovered] }),
  ], [makeEnemy({ hp: 10, maxHp: 10 })])
  state = playCard(state, 'p1', doubleTap.uid, { enemyUid: null, playerId: 'p1' })
  state = playCard(state, 'p1', headbutt.uid, {
    enemyUid: 'e1', playerId: 'p1', recoverDiscardUid: recovered.uid,
  })
  assertEqual(state.phase, 'copy')
  assertDeepEqual(state.players[0].discard.map((card) => card.uid), [doubleTap.uid],
    'the copy could illegally recover the still-resolving Headbutt')
  assertEqual(state.players[0].draw.at(-1).uid, recovered.uid)
  state = playCardCopy(state, 'p1', {
    enemyUid: 'e1', playerId: 'p1', recoverDiscardUid: doubleTap.uid,
  })
  assertDeepEqual(state.players[0].discard.map((card) => card.uid), [headbutt.uid])
  assertEqual(state.enemies[0].hp, 6)
})

report('combat')
