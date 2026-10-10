// The Slayer Pack, the play windows group: the "play & draw" cards. Each check plays the real
// card through the engine and reads the board afterwards, both faces, plus the
// edges that decide whether a card-play window can strand, leak or be abused.
import {
  activeCardPlayWindow,
  beginEndTurnResolution,
  createCombat,
  endPlayerTurn,
  finishCardPlayWindow,
  playCard,
  playCardCopy,
  playCost,
  playHermitChamberCard,
  scryPlayCardPlayable,
  resolveDeterministicForcedCard,
  previewCardChoice,
  previewCardDamage,
  spendMiracle,
  startPlayerTurn,
} from '../src/game/combat.ts'
import { shuffleCombatDraw } from '../src/game/combat/create.ts'
import { closeAllCardPlayWindows, drawInto } from '../src/game/combat/effects.ts'
import { abandonCardPlayWindows } from '../src/game/combat/play.ts'
import { readyForCombat } from '../src/game/run/encounters.ts'
import { CARDS, cardDef, faceOf } from '../src/game/cards.ts'
import { createRng, shuffle } from '../src/game/rng.ts'
import { apply, createRoom, createStore, joinRoom, markDisconnected, snapshotFor, startRun } from './lib/rooms.mjs'
import { roomChoices } from '../src/game/state.ts'
import { suite, check, assert, assertDeepEqual, assertEqual, assertThrows, report } from './lib/harness.mjs'

let uid = 0
const card = (defId, upgraded = false) => ({ uid: `${defId}-${uid++}`, defId, upgraded })

function makePlayer(over = {}) {
  return {
    id: 'p1', name: 'Ann', character: 'ironclad', row: 0, hp: 10, maxHp: 10, block: 0, energy: 3,
    deck: [], draw: [], hand: [], discard: [], exhaust: [], powers: [], gold: 0, relics: [], potions: [],
    cardRewards: [], rareRewards: [], strength: 0, vulnerable: 0, weak: 0, shivs: 0, miracles: 0,
    stance: 'neutral', orbs: [null, null, null], dead: false, ...over,
  }
}

function makeEnemy(over = {}) {
  return {
    uid: 'e1', defId: 'cultist', row: 0, isBoss: false, hp: 40, maxHp: 40, block: 0, strength: 0,
    vulnerable: 0, weak: 0, poison: 0, actionIndex: 0, abilityUsed: false, dead: false, ...over,
  }
}

/** A Player Turn with exactly these piles. `players` overrides add teammates. */
function combat(player = {}, { enemies = [makeEnemy()], players = [], die = 1 } = {}) {
  const state = createCombat(createRng(7), [makePlayer(player), ...players.map(makePlayer)], enemies)
  state.turn = 1
  state.die = die
  return state
}

const me = (state, id = 'p1') => state.players.find((player) => player.id === id)
const uids = (cards) => cards.map((held) => held.uid)
const has = (cards, held) => cards.some((candidate) => candidate.uid === held.uid)
const window = (state, id = 'p1') => activeCardPlayWindow(state, id)
const target = { enemyUid: 'e1', playerId: 'p1' }
const self = { enemyUid: null, playerId: 'p1' }
const play = (state, held, context = self, id = 'p1') => playCard(state, id, held.uid, context)
/** A bare draw effect, as a Power or relic would make one, on a mutable copy. */
const drawSome = (state, amount, id = 'p1') => drawInto(state, me(state, id), amount)

suite('Discovery')

for (const upgraded of [false, true]) {
  check(`${upgraded ? 'Discovery+' : 'Discovery'} draws 3, plays exactly one of them for 0, discards the other 2`, () => {
    const discovery = card('slayer_discovery', upgraded)
    const strike = card('strike_ironclad')
    const defend = card('defend_ironclad')
    const bash = card('bash')
    const held = card('bludgeon')
    let state = combat({ hand: [discovery, held], draw: [strike, defend, bash, card('anger')], energy: 1 })
    state = play(state, discovery)
    assertEqual(me(state).energy, 0, 'Discovery costs 1')
    assertDeepEqual(window(state).cardUids, uids([strike, defend, bash]), 'the offer is the three drawn cards')
    assertEqual(window(state).cost, 0)
    assertEqual(me(state).hand.find((c) => c.uid === bash.uid).playWindowCost, 0, 'offered cards show cost 0')
    assertEqual(me(state).hand.find((c) => c.uid === held.uid).playWindowCost, undefined)
    // A card outside the offer cannot be played, and the choice cannot be skipped.
    assertEqual(play(state, held, target), state, 'a non-drawn card is refused while the window is open')
    assertEqual(finishCardPlayWindow(state, 'p1', window(state).id), state, '"Play one" is not optional')
    assertEqual(play(state, bash), state, 'the played card still needs its own target')
    const before = me(state).cardsPlayedThisTurn
    state = play(state, bash, target)
    assertEqual(me(state).energy, 0, 'Bash cost 0 Energy through Discovery')
    assertEqual(state.enemies[0].hp, 38, 'Bash dealt its 2')
    assertEqual(state.enemies[0].vulnerable, 1)
    assertEqual(me(state).cardsPlayedThisTurn, before + 1, 'it is a real card play')
    assertEqual(window(state), undefined, 'one play closes the window')
    assert(has(me(state).discard, strike) && has(me(state).discard, defend), 'the remaining 2 are discarded')
    assert(has(me(state).discard, bash), 'Bash resolved into the discard pile')
    assertDeepEqual(uids(me(state).hand), [held.uid])
    assert(me(state).hand.every((c) => c.playWindowCost === undefined), 'no cost mark survives the window')
    assert(upgraded ? has(me(state).discard, discovery) : has(me(state).exhaust, discovery),
      upgraded ? 'Discovery+ has no Exhaust' : 'Discovery Exhausts')
  })
}

check('Discovery skips unplayable drawn cards and closes when none is playable', () => {
  const discovery = card('slayer_discovery')
  const daze = card('daze')
  const regret = card('regret')
  const strike = card('strike_ironclad')
  let state = combat({ hand: [discovery], draw: [daze, regret, strike] })
  state = play(state, discovery)
  assertDeepEqual(window(state).cardUids, uids([daze, regret, strike]))
  assertEqual(play(state, daze), state, 'an Unplayable card cannot be played even for 0')
  state = play(state, strike, target)
  assert(has(me(state).discard, daze) && has(me(state).discard, regret))

  let empty = combat({ hand: [discovery], draw: [card('daze'), card('regret')] })
  empty = play(empty, discovery)
  assertEqual(window(empty), undefined, 'nothing playable: the window closes at once')
  assertEqual(me(empty).hand.length, 0, 'and both drawn cards are discarded')
  assertEqual(me(empty).discard.length, 2)
})

check('an optional window with nothing playable and affordable closes, so other cards are playable again', () => {
  const anger = card('anger')
  let daze = combat({ hand: [card('slayer_transmutation'), anger], draw: [card('daze')], energy: 1 })
  daze = play(daze, daze.players[0].hand[0], { ...self, energySpent: 1 })
  assertEqual(window(daze), undefined, 'Transmutation drew only a Daze: nothing to play for 0')
  assertEqual(play(daze, anger, target).enemies[0].hp, 39, 'Anger plays at its printed 0')
  const broke = card('anger')
  let poor = combat({ hand: [card('slayer_enlightenment'), broke, card('bash')], draw: [card('cleave')], energy: 0 })
  poor = play(poor, poor.players[0].hand[0])
  assertEqual(window(poor), undefined, 'Enlightenment at 0 Energy: nothing can be paid for')
  const angered = play(poor, broke, target)
  assertEqual(angered.enemies[0].hp, 39, 'Anger is played for its printed 0')
  let blessed = combat({ hand: [card('slayer_enlightenment'), card('bash')], draw: [card('cleave')], energy: 0, miracles: 1 })
  blessed = play(blessed, blessed.players[0].hand[0])
  assert(window(blessed), 'a Miracle could still pay the 1, so the window stays')
})

check('a window that must be played closes once Time Warp stops card play', () => {
  const discovery = card('slayer_discovery')
  const drawn = [card('strike_ironclad'), card('anger'), card('cleave')]
  let state = combat({ hand: [discovery], draw: [...drawn] }, { enemies: [makeEnemy({ defId: 'time_eater', hp: 99, maxHp: 99 })] })
  state.players[0].cardsPlayedThisTurn = 4
  state = play(state, discovery)
  assertEqual(me(state).cardsPlayedThisTurn, 5, 'Discovery was the fifth card: Time Eater allows no more')
  assertEqual(window(state), undefined, 'nothing can be played, so the window closes')
  assertDeepEqual(uids(me(state).discard), uids(drawn), 'and Discovery discards what it drew')
  assert(beginEndTurnResolution(state) !== state, 'the turn may end')
})

check('a window does not offer a card it can never play at its cost: an X minimum, an unmatched Metamorphosis', () => {
  const minimum = combat({ character: 'defect', hand: [card('slayer_discovery')],
    draw: [card('reinforced_body'), card('daze'), card('daze')] })
  const minimumPlayed = play(minimum, minimum.players[0].hand[0])
  assertEqual(window(minimumPlayed), undefined, 'Reinforced Body needs X >= 1, so nothing can be played for 0')
  const barricade = card('barricade')
  const unmatched = combat({ hand: [card('slayer_discovery')], powers: [barricade],
    draw: [card('slayer_metamorphosis'), card('daze'), card('daze')] })
  assertEqual(window(play(unmatched, unmatched.players[0].hand[0])), undefined,
    'Metamorphosis would cost 3 with Barricade, never the 0 Discovery charges')
  const matched = combat({ hand: [card('slayer_discovery')], powers: [card('slayer_brutality')],
    draw: [card('slayer_metamorphosis', true), card('daze'), card('daze')] })
  assert(window(play(matched, matched.players[0].hand[0])), 'Metamorphosis+ on a 0-cost Power can be played for 0')
})

check('the engine reads an offered card\'s cost from the window', () => {
  const enlightenment = card('slayer_enlightenment')
  const bludgeon = card('bludgeon')
  const state = play(combat({ hand: [enlightenment, bludgeon], draw: [card('anger')] }), enlightenment)
  const held = me(state).hand.find((c) => c.uid === bludgeon.uid)
  assertEqual(playCost(faceOf(cardDef('bludgeon'), false), me(state), held), 1, 'Bludgeon costs 1 while offered')
})

check('Discovery with a short draw pile offers what it drew; an X card resolves with X = 0', () => {
  const discovery = card('slayer_discovery')
  const whirlwind = card('whirlwind')
  let state = combat({ hand: [discovery], draw: [whirlwind] })
  state = play(state, discovery)
  assertDeepEqual(window(state).cardUids, [whirlwind.uid])
  assertEqual(play(state, whirlwind, { ...target, energySpent: 1 }), state, 'X is fixed at the window cost')
  state = play(state, whirlwind, target)
  assertEqual(state.enemies[0].hp, 40, 'Whirlwind for 0 hits 0 times')
  assertEqual(me(state).energy, 2)
})

check('another player keeps acting normally while one player holds a window', () => {
  const discovery = card('slayer_discovery')
  const allyStrike = card('strike_ironclad')
  let state = combat({ hand: [discovery], draw: [card('strike_ironclad'), card('defend_ironclad'), card('bash')] },
    { players: [{ id: 'p2', name: 'Bo', hand: [allyStrike] }] })
  state = play(state, discovery)
  assert(window(state), 'Ann has a window')
  assertEqual(window(state, 'p2'), undefined)
  state = play(state, allyStrike, { enemyUid: 'e1', playerId: 'p2' }, 'p2')
  assertEqual(me(state, 'p2').energy, 2, "Bo pays Strike's normal cost")
  assert(window(state), "Ann's window is untouched")
})

suite('Enlightenment')

for (const upgraded of [false, true]) {
  check(`${upgraded ? 'Enlightenment+' : 'Enlightenment'} plays any number of hand cards for exactly 1 Energy each`, () => {
    const enlightenment = card('slayer_enlightenment', upgraded)
    const bludgeon = card('bludgeon')
    const anger = card('anger')
    const drawn = card('bash')
    let state = combat({ hand: [enlightenment, bludgeon, anger], draw: [drawn], energy: 3 })
    state = play(state, enlightenment)
    assertDeepEqual([...window(state).cardUids].sort(), uids([bludgeon, anger, drawn]).sort(),
      'the offer is the whole hand after its draw')
    assertEqual(window(state).optional, true)
    state = play(state, bludgeon, target)
    assertEqual(me(state).energy, 2, 'Bludgeon (3) cost 1')
    assertEqual(state.enemies[0].hp, 33)
    state = play(state, anger, target)
    assertEqual(me(state).energy, 1, 'a 0-cost card costs exactly 1 through the window')
    state = finishCardPlayWindow(state, 'p1', window(state).id)
    assertEqual(window(state), undefined, '"any number" may stop early')
    state = play(state, drawn, target)
    assertEqual(me(state).energy, 1, 'after the window, Bash costs its printed 2 and is unaffordable')
    assert(has(me(state).hand, drawn))
    assert(upgraded ? has(me(state).discard, enlightenment) : has(me(state).exhaust, enlightenment))
  })
}

check('Enlightenment: Energy and Miracles pay the 1, an X card resolves with X = 1, later draws are not offered', () => {
  const enlightenment = card('slayer_enlightenment')
  const pommel = card('pommel_strike')
  const whirlwind = card('whirlwind')
  const later = card('strike_ironclad')
  let state = combat({ hand: [enlightenment, pommel, whirlwind], draw: [card('defend_ironclad'), later], energy: 1, miracles: 1 })
  state = play(state, enlightenment)
  state = play(state, pommel, target)
  assertEqual(me(state).energy, 0)
  assert(has(me(state).hand, later), 'Pommel Strike drew a card')
  assert(!window(state).cardUids.includes(later.uid), 'a card drawn during the window is not offered')
  const broke = play(state, whirlwind, target)
  assertEqual(broke, state, 'no Energy left: the 1 cannot be paid')
  assert(window(state), 'an optional window stays open while its owner could still pay')
  state = spendMiracle(state, 'p1')
  state = play(state, whirlwind, target)
  assertEqual(state.enemies[0].hp, 40 - 2 - 1, 'Whirlwind hit once: X = the 1 Energy paid')
})

suite('Transmutation')

for (const upgraded of [false, true]) {
  check(`${upgraded ? 'Transmutation+' : 'Transmutation'} draws X${upgraded ? '+1' : ''} and may play any of them for 0`, () => {
    const transmutation = card('slayer_transmutation', upgraded)
    const drawn = [card('bash'), card('bludgeon'), card('defend_ironclad'), card('cleave'), card('anger')]
    let state = combat({ hand: [transmutation], draw: [...drawn], energy: 2 })
    state = play(state, transmutation, { ...self, energySpent: 2 })
    assertEqual(me(state).energy, 0)
    const offered = upgraded ? 3 : 2
    assertDeepEqual(window(state).cardUids, uids(drawn.slice(0, offered)), `exactly X${upgraded ? '+1' : ''} offered`)
    assertDeepEqual(uids(me(state).draw), uids(drawn.slice(offered)), 'and exactly that many drawn')
    state = play(state, drawn[1], target)
    assertEqual(state.enemies[0].hp, 33, 'Bludgeon for 0')
    state = finishCardPlayWindow(state, 'p1', window(state).id)
    assertEqual(window(state), undefined)
    assert(has(me(state).hand, drawn[0]), 'unplayed drawn cards stay in hand')
    assert(has(me(state).exhaust, transmutation), 'Exhaust on both faces')

    let none = combat({ hand: [transmutation], draw: [card('bash')], energy: 0 })
    none = play(none, transmutation, { ...self, energySpent: 0 })
    assertEqual(me(none).hand.length, upgraded ? 1 : 0, 'X = 0 draws 0 (1 upgraded)')
    assertEqual(window(none)?.cardUids.length ?? 0, upgraded ? 1 : 0)
  })
}

suite('Violence')

for (const upgraded of [false, true]) {
  check(`${upgraded ? 'Violence+' : 'Violence'} plays every Attack in hand for 0, in the chosen order and targets`, () => {
    const violence = card('slayer_violence', upgraded)
    const bash = card('bash')
    const bludgeon = card('bludgeon')
    const defend = card('defend_ironclad')
    let state = combat({ hand: [violence, bash, bludgeon, defend], energy: 2 },
      { enemies: [makeEnemy(), makeEnemy({ uid: 'e2', hp: 30, maxHp: 30 })] })
    state = play(state, violence)
    assertEqual(me(state).energy, 0)
    assertDeepEqual(window(state).cardUids, uids([bash, bludgeon]), 'only the Attacks')
    assertEqual(window(state).optional, false)
    assertEqual(play(state, defend), state, 'a Skill cannot be played meanwhile')
    assertEqual(finishCardPlayWindow(state, 'p1', window(state).id), state, 'Violence cannot be stopped early')
    state = play(state, bludgeon, { enemyUid: 'e2', playerId: 'p1' })
    state = play(state, bash, target)
    assertEqual(state.enemies[1].hp, 23, 'Bludgeon at the second enemy')
    assertEqual(state.enemies[0].hp, 38, 'Bash at the first')
    assertEqual(window(state), undefined)
    assertEqual(me(state).energy, 0, 'both Attacks were free')
    assert(upgraded ? has(me(state).discard, violence) : has(me(state).exhaust, violence))
  })
}

check('Violence skips an Attack that cannot be played and opens nothing with no Attack', () => {
  const violence = card('slayer_violence')
  const clash = card('clash')
  const defend = card('defend_ironclad')
  let state = combat({ hand: [violence, clash, defend] })
  state = play(state, violence)
  assertEqual(window(state), undefined, 'Clash is unplayable beside a Skill, so nothing is left to play')
  assert(has(me(state).hand, clash))
  let none = combat({ hand: [card('slayer_violence'), defend] })
  none = play(none, none.players[0].hand[0])
  assertEqual(window(none), undefined)
})

suite('Deceive Reality')

for (const upgraded of [false, true]) {
  check(`${upgraded ? 'Deceive Reality+' : 'Deceive Reality'} Scries ${upgraded ? 5 : 3} and plays one revealed card for 0`, () => {
    const deceive = card('slayer_deceive_reality', upgraded)
    const top = [card('bash'), card('daze'), card('defend_ironclad'), card('strike_ironclad'), card('anger'), card('cleave')]
    let state = combat({ character: 'watcher', hand: [deceive], draw: [...top], energy: 2 })
    const preview = previewCardChoice(state, 'p1', deceive.uid)
    assertEqual(preview.kind, 'scryToHand')
    assertDeepEqual(uids(preview.cards), uids(top.slice(0, upgraded ? 5 : 3)))
    assertEqual(play(state, deceive, { ...self, scryDiscardUids: [top[1].uid] }), state,
      'playing one revealed card is not optional')
    assertEqual(play(state, deceive, { ...self, scryToHandUid: top[1].uid }), state, 'an Unplayable reveal cannot be chosen')
    assertEqual(play(state, deceive, { ...self, scryToHandUid: top[5].uid }), state, 'only a revealed card can be chosen')
    assertEqual(play(state, deceive, { ...self, scryToHandUid: top[0].uid, scryDiscardUids: [top[0].uid] }), state)
    state = play(state, deceive, { ...self, scryToHandUid: top[0].uid, scryDiscardUids: [top[1].uid] })
    assertEqual(me(state).block, 1)
    assertEqual(me(state).energy, 0)
    assert(has(me(state).discard, top[1]), 'the Daze was Scried away')
    assertDeepEqual(uids(me(state).draw.slice(0, 2)), uids([top[2], top[3]]), 'kept cards stay on top in order')
    assertDeepEqual(window(state).cardUids, [top[0].uid])
    assertEqual(finishCardPlayWindow(state, 'p1', window(state).id), state)
    state = play(state, top[0], target)
    assertEqual(state.enemies[0].hp, 38, 'Bash was played for 0')
    assertEqual(window(state), undefined)
    assert(has(me(state).discard, deceive))
  })
}

check('Deceive Reality binning the card just below the reveal is refused', () => {
  for (const [upgraded, revealed] of [[false, 3], [true, 5]]) {
    const deceive = card('slayer_deceive_reality', upgraded)
    const top = Array.from({ length: revealed + 2 }, () => card('strike_ironclad'))
    const state = combat({ character: 'watcher', hand: [deceive], draw: top, energy: 2 })
    const base = { ...self, scryToHandUid: top[0].uid }
    assertEqual(play(state, deceive, { ...base, scryDiscardUids: [top[revealed].uid] }), state,
      `the ${revealed + 1}th card is not part of the Scry (the chosen card left it)`)
    const inside = play(state, deceive, { ...base, scryDiscardUids: [top[revealed - 1].uid] })
    assert(inside !== state, `the last revealed card can still be binned (${upgraded})`)
  }
})

check('Deceive Reality judges a reveal as it will be played: in hand, after the Scry', () => {
  const watcher = (hand, draw) => combat({ character: 'watcher', hand: [card('slayer_deceive_reality'), ...hand], draw, energy: 2 })
  const deceiveOf = (state) => state.players[0].hand[0]
  // Repro A: Signature Move will be the only Attack in hand.
  const signature = card('signature_move')
  let lone = watcher([], [signature, card('daze'), card('daze')])
  assertEqual(play(lone, deceiveOf(lone)), lone, 'a playable Signature Move must be named')
  lone = play(lone, deceiveOf(lone), { ...self, scryToHandUid: signature.uid })
  assertDeepEqual(window(lone).cardUids, [signature.uid])
  lone = play(lone, signature, target)
  assertEqual(lone.enemies[0].hp, 34, 'Signature Move was played for 0')
  // Repro B: beside a Strike it is not the only Attack, so nothing is playable.
  const blocked = card('signature_move')
  const crowded = watcher([card('strike_watcher')], [blocked, card('daze'), card('daze')])
  assertEqual(play(crowded, deceiveOf(crowded), { ...self, scryToHandUid: blocked.uid }), crowded,
    'naming a reveal that could not be played is refused')
  const plain = play(crowded, deceiveOf(crowded))
  assert(plain !== crowded && window(plain) === undefined, 'so it is a plain Scry')
  // Clash needs every card in hand to be an Attack.
  const clash = card('clash')
  const withSkill = watcher([card('defend_watcher')], [clash, card('daze')])
  assert(play(withSkill, deceiveOf(withSkill)) !== withSkill, 'beside a Skill Clash is not playable')
  const withAttack = watcher([card('strike_watcher')], [clash, card('daze')])
  assertEqual(play(withAttack, deceiveOf(withAttack)), withAttack, 'beside only Attacks Clash must be named')
  assert(play(withAttack, deceiveOf(withAttack), { ...self, scryToHandUid: clash.uid }) !== withAttack)
  // Grand Finale needs the draw pile empty once the Scry has binned the rest.
  const finale = card('grand_finale')
  const others = [card('daze'), card('regret')]
  const last = watcher([], [finale, ...others])
  assertEqual(play(last, deceiveOf(last), { ...self, scryToHandUid: finale.uid }), last,
    'kept cards stay in the draw pile, so Grand Finale cannot be played')
  const kept = play(last, deceiveOf(last))
  assert(kept !== last && window(kept) === undefined, 'keeping them is a plain Scry')
  assertEqual(play(last, deceiveOf(last), { ...self, scryDiscardUids: uids(others) }), last,
    'binning them makes Grand Finale playable, so it must be named')
  let emptied = play(last, deceiveOf(last), { ...self, scryToHandUid: finale.uid, scryDiscardUids: uids(others) })
  assertEqual(me(emptied).draw.length, 0)
  emptied = play(emptied, finale, target)
  assertEqual(emptied.enemies[0].hp, 30, 'Grand Finale was played for 0')
  // Binning the only playable reveal does not dodge the play.
  const strike = card('strike_watcher')
  const dodge = watcher([], [strike, card('daze')])
  assertEqual(play(dodge, deceiveOf(dodge), { ...self, scryDiscardUids: [strike.uid] }), dodge)
})

check('Deceive Reality is one Scry for onScry Powers, even when it reveals a single card', () => {
  for (const draw of [[card('strike_watcher')], [card('strike_watcher'), card('daze')]]) {
    let state = combat({ character: 'watcher', hand: [card('slayer_deceive_reality')], powers: [card('nirvana')],
      draw: [...draw], energy: 2 })
    state = play(state, state.players[0].hand[0], { ...self, scryToHandUid: draw[0].uid })
    assertEqual(me(state).block, 2, `${draw.length} revealed: Deceive Reality's 1 Block and Nirvana's 1, once`)
  }
})

check('the reveal probe rejects bad discards, runs discard reactions, and stops when the fight ends', () => {
  const strike = card('strike_watcher')
  const daze = card('daze')
  const probe = combat({ character: 'watcher', draw: [strike, daze] })
  assertEqual(scryPlayCardPlayable(probe, 'p1', [strike, daze], strike.uid, ['not-revealed']), false,
    'a discard outside the reveal is no Scry at all')
  assertEqual(scryPlayCardPlayable(probe, 'p1', [strike, daze], strike.uid, [daze.uid]), true)
  // Binning Reflex draws 2 first, bringing a second Attack in beside Signature Move.
  const signature = card('signature_move')
  const reflex = card('reflex')
  const reflexed = combat({ character: 'watcher', hand: [card('slayer_deceive_reality')], energy: 2,
    draw: [signature, reflex, card('daze'), card('strike_watcher'), card('strike_watcher')] })
  const deceive = reflexed.players[0].hand[0]
  assertEqual(play(reflexed, deceive, { ...self, scryToHandUid: signature.uid, scryDiscardUids: [reflex.uid] }), reflexed,
    "Reflex's draw leaves Signature Move unplayable, so it cannot be named")
  assert(play(reflexed, deceive, { ...self, scryDiscardUids: [reflex.uid] }) !== reflexed, 'binning Reflex is a plain Scry')
  // Binning the Daze sets off Eviscerate, which wins the fight before anything could be played.
  const defend = card('defend_watcher')
  const binned = card('daze')
  const ending = combat({ character: 'watcher', hand: [card('slayer_deceive_reality')], energy: 2,
    powers: [card('slayer_eviscerate')], draw: [defend, binned] }, { enemies: [makeEnemy({ hp: 1, maxHp: 1 })] })
  const won = play(ending, ending.players[0].hand[0], { ...self, scryDiscardUids: [binned.uid] })
  assertEqual(won.phase, 'won', 'no reveal had to be named: the fight ended')
})

check('Deceive Reality with only unplayable reveals is a plain Scry', () => {
  const deceive = card('slayer_deceive_reality')
  const curses = [card('daze'), card('regret')]
  let state = combat({ character: 'watcher', hand: [deceive], draw: [...curses] })
  state = play(state, deceive, { ...self, scryDiscardUids: [curses[0].uid] })
  assert(state !== undefined && me(state).discard.some((c) => c.uid === curses[0].uid))
  assertEqual(window(state), undefined)
})

suite('Auto-Shields')

for (const upgraded of [false, true]) {
  check(`${upgraded ? 'Auto-Shields+' : 'Auto-Shields'} plays itself when drawn, and its Daze is the next card drawn`, () => {
    const shields = card('slayer_auto_shields', upgraded)
    const backflip = card('backflip')
    const after = card('strike_ironclad')
    let state = combat({ character: 'defect', hand: [backflip], draw: [shields, after] })
    state = play(state, backflip)
    const block = upgraded ? 4 : 3
    assertEqual(me(state).block, 1 + block, 'Backflip 1 + Auto-Shields')
    assert(has(me(state).discard, shields), 'played into the discard pile')
    assertDeepEqual(me(state).hand.map((c) => c.defId), ['daze'], 'the Daze went on top and was the second draw')
    assertDeepEqual(uids(me(state).draw), [after.uid], 'exactly one Daze was added')
    assertEqual(me(state).cardsPlayedThisTurn, 2, 'Auto-Shields counts as a card played')
  })
}

check('Auto-Shields resolves during the Start-of-Turn draw', () => {
  const shields = card('slayer_auto_shields')
  let state = combat({ character: 'defect', draw: [card('strike_ironclad'), shields, card('defend_ironclad'),
    card('defend_ironclad'), card('defend_ironclad'), card('defend_ironclad'), card('defend_ironclad')] })
  state.turn = 0
  state.phase = 'roundEnd'
  state = startPlayerTurn({ ...state, turn: 1 })
  assertEqual(me(state).block, 3)
  assert(has(me(state).discard, shields))
  assertDeepEqual(me(state).hand.map((c) => c.defId), ['strike_ironclad', 'daze', 'defend_ironclad', 'defend_ironclad'],
    'five cards were drawn: Auto-Shields played itself and its Daze was the third')
})

check('Auto-Shields is not played at the Time Warp limit, and sets off Enraged as a Skill play', () => {
  const warped = combat({ character: 'defect', draw: [card('slayer_auto_shields')] },
    { enemies: [makeEnemy({ defId: 'time_eater', hp: 99, maxHp: 99 })] })
  warped.players[0].cardsPlayedThisTurn = 5
  drawSome(warped, 1)
  assertEqual(me(warped).hand[0].defId, 'slayer_auto_shields', 'Time Eater has stopped card play: it waits in hand')
  assertEqual(me(warped).block, 0)
  const nob = combat({ character: 'defect', draw: [card('slayer_auto_shields')] },
    { enemies: [makeEnemy({ defId: 'gremlin_nob' })] })
  nob.turn = 2
  drawSome(nob, 1)
  assertEqual(me(nob).block, 2, 'Gremlin Nob\'s Enraged hits the 3 Block for 1')
})

check('a draw Auto-Shields interrupts deals cards exactly as drawing one at a time would', () => {
  const named = (state, list) => list.map((uid) => me(state).hand.find((c) => c.uid === uid)?.defId ?? me(state).discard
    .find((c) => c.uid === uid)?.defId)
  // Discovery with Chrysalis: Strike, Auto-Shields (its Daze on top, Chrysalis takes Daze + Defend), then Zap.
  const strike = card('strike_ironclad')
  const shields = card('slayer_auto_shields')
  const defend = card('defend_ironclad')
  const zap = card('zap')
  const later = card('cleave')
  let found = combat({ character: 'defect', hand: [card('slayer_discovery')], powers: [card('slayer_chrysalis')],
    draw: [strike, shields, defend, zap, later] })
  found = play(found, found.players[0].hand[0])
  assertDeepEqual(window(found).cardUids, [strike.uid, zap.uid], 'Discovery offers Strike and Zap')
  assert(has(me(found).hand, defend) && me(found).hand.some((c) => c.defId === 'daze'), 'Chrysalis took the Daze and Defend')
  assertDeepEqual(uids(me(found).draw), [later.uid])
  // Transmutation (X = 2) with Chrysalis: Auto-Shields, then (after Chrysalis's Daze + A) B.
  const a = card('bash')
  const b = card('anger')
  let transmuted = combat({ character: 'defect', hand: [card('slayer_transmutation')], powers: [card('slayer_chrysalis')],
    draw: [card('slayer_auto_shields'), a, b, card('cleave')], energy: 2 })
  transmuted = play(transmuted, transmuted.players[0].hand[0], { ...self, energySpent: 2 })
  assertDeepEqual(window(transmuted).cardUids, [b.uid], 'Transmutation offers the second card it drew')
  assert(has(me(transmuted).hand, a))
  // Wheel Kick's draw 2: Auto-Shields, then (after Chrysalis's Daze + A) B.
  const kickA = card('defend_watcher')
  const kickB = card('eruption')
  let kicked = combat({ character: 'watcher', hand: [card('slayer_wheel_kick')], powers: [card('slayer_chrysalis')],
    draw: [card('slayer_auto_shields'), kickA, kickB, card('cleave')] })
  kicked = play(kicked, kicked.players[0].hand[0], target)
  assertDeepEqual(named(kicked, uids(me(kicked).hand)).sort(), ['daze', 'defend_watcher', 'eruption'])
  // The Start-of-Turn draw of 5: Strike, Auto-Shields (Chrysalis: Daze, D1), then D2, D3, D4.
  const decks = Array.from({ length: 6 }, () => card('defend_ironclad'))
  let turn = combat({ character: 'defect', powers: [card('slayer_chrysalis')],
    draw: [card('strike_ironclad'), card('slayer_auto_shields'), ...decks] })
  turn.phase = 'roundEnd'
  turn = startPlayerTurn(turn)
  assertDeepEqual(me(turn).hand.map((c) => c.defId), ['strike_ironclad', 'daze', 'defend_ironclad', 'defend_ironclad',
    'defend_ironclad', 'defend_ironclad'])
  assertDeepEqual(uids(me(turn).draw), uids(decks.slice(4)))
})

check('an offered card that cannot be played gets neither the window cost nor its glow', () => {
  const enlightenment = card('slayer_enlightenment')
  const daze = card('daze')
  const bash = card('bash')
  const state = play(combat({ hand: [enlightenment, daze, bash], draw: [card('regret')] }), enlightenment)
  assert(window(state).cardUids.includes(daze.uid), 'the whole hand is offered')
  assertEqual(me(state).hand.find((c) => c.uid === daze.uid).playWindowCost, undefined)
  assertEqual(me(state).hand.find((c) => c.defId === 'regret').playWindowCost, undefined)
  assertEqual(me(state).hand.find((c) => c.uid === bash.uid).playWindowCost, 1)
})

check('Auto-Shields drawn uses a free-card discount and is recorded as a played Skill', () => {
  const shields = card('slayer_auto_shields')
  const state = combat({ character: 'defect', draw: [shields, card('anger')] })
  state.players[0].freeCardsThisTurn = 1
  drawSome(state, 1)
  assertEqual(me(state).freeCardsThisTurn, 0, 'it was the next card played')
  assertDeepEqual(state.playedCardsThisTurn, [{ playerId: 'p1', card: { uid: shields.uid, defId: 'slayer_auto_shields',
    upgraded: false }, copied: false, type: 'skill' }])
})

check('Auto-Shields pays its own current cost: a next-card cost already spent leaves it free', () => {
  const shields = card('slayer_auto_shields')
  const state = combat({ character: 'defect', hand: [card('backflip')], draw: [shields, card('anger')], energy: 2 })
  state.players[0].nextCardCost = 2
  const drew = play(state, state.players[0].hand[0])
  assertEqual(me(drew).energy, 0, 'Backflip, the next card, paid the 2')
  assert(has(me(drew).discard, shields), 'so Auto-Shields cost its printed 0 and played')
  const pending = combat({ character: 'defect', draw: [card('slayer_auto_shields')], energy: 3 })
  pending.players[0].nextCardCost = 2
  drawSome(pending, 1)
  assertEqual(me(pending).energy, 1, 'drawn first, Auto-Shields is the next card and pays the 2')
  assertEqual(me(pending).nextCardCost, null)
})

check('Auto-Shields is not played after the turn has started ending or with an unpayable cost', () => {
  const shields = card('slayer_auto_shields')
  // Dark Embrace-style draws during end of turn reach drawInto with endTurnProgress set.
  const ending = combat({ character: 'defect', draw: [shields] })
  ending.endTurnProgress = { order: [] }
  const drawn = structuredClone(ending)
  drawSome(drawn, 1)
  assert(has(me(drawn).hand, shields), 'no card is played once the turn has started ending')
  const confused = combat({ character: 'defect', draw: [shields], energy: 1 })
  confused.players[0].enemyNextCardCost = 2
  drawSome(confused, 1)
  assert(has(me(confused).hand, shields), 'a cost of 2 with 1 Energy is not "able"')
  assertEqual(me(confused).energy, 1)
  const lock = combat({ character: 'defect', draw: [shields] })
  lock.players[0].cardPlayLocked = true
  drawSome(lock, 1)
  assert(has(me(lock).hand, shields), 'Conclude-style play lock')
})

check('Auto-Shields drawn by Mayhem-style plays and Discovery leaves nothing stranded', () => {
  const shields = card('slayer_auto_shields')
  let havoc = combat({ character: 'defect', hand: [card('havoc')], draw: [shields] })
  havoc = play(havoc, havoc.players[0].hand[0])
  assertEqual(havoc.startTurnProgress, undefined, 'no forced card waits for a card that already played itself')
  assert(has(me(havoc).discard, shields))
  const discovery = card('slayer_discovery')
  const strike = card('strike_ironclad')
  let state = combat({ character: 'defect', hand: [discovery], draw: [shields, strike, card('anger')] })
  state = play(state, discovery)
  assertEqual(me(state).block, 3)
  assert(!window(state).cardUids.includes(shields.uid), 'Auto-Shields already played, so it is not offered')
  assertDeepEqual(window(state).cardUids.map((uid) => me(state).hand.find((c) => c.uid === uid).defId),
    ['daze', 'strike_ironclad'], 'Discovery drew 3: Auto-Shields, then its Daze, then Strike')
  assert(me(state).draw.some((c) => c.defId === 'anger'), 'Anger was not drawn')
})

check('Burst doubles Auto-Shields; Corruption exhausts it', () => {
  const shields = card('slayer_auto_shields')
  const doubled = combat({ character: 'defect', draw: [shields, card('anger'), card('anger')] })
  doubled.players[0].doubledSkillsThisTurn = 1
  drawSome(doubled, 1)
  assertEqual(me(doubled).block, 6, 'Burst: 3 Block twice')
  assertEqual(me(doubled).doubledSkillsThisTurn, 0, 'and Burst is spent')
  assertEqual(me(doubled).draw.filter((c) => c.defId === 'daze').length, 2, 'two Dazes on top')
  const corrupt = card('corruption')
  let corrupted = combat({ character: 'defect', hand: [card('backflip')], draw: [shields], powers: [corrupt] })
  corrupted = play(corrupted, corrupted.players[0].hand[0])
  assert(has(me(corrupted).exhaust, shields), 'Corruption Exhausts the Skill it plays')
})

check('Auto-Shields played mid-card gets every per-play reaction: Pressure Points, Chrysalis, Fasting, counters', () => {
  const pressure = { card: { uid: 'pp', defId: 'slayer_pressure_points', upgraded: false }, playerId: 'p1' }
  const marked = () => [makeEnemy({ slayerAttachments: [pressure] })]
  // Deep Breath (a Skill) draws Auto-Shields (a Skill): Pressure Points answers both.
  const shields = card('slayer_auto_shields')
  const breath = card('slayer_deep_breath')
  let state = combat({ character: 'defect', hand: [breath], draw: [shields, card('anger'), card('anger')] },
    { enemies: marked() })
  state = play(state, breath)
  assert(has(me(state).discard, shields))
  assertEqual(state.enemies[0].hp, 38, 'one Pressure Points damage per Skill played')
  assertEqual(me(state).cardsPlayedThisTurn, 2)
  // An Attack's draw: Chrysalis draws 2 for the Skill, Fasting adds +1 to the Block icon.
  const chrysalis = card('slayer_chrysalis')
  const fasting = card('slayer_fasting')
  const pommel = card('pommel_strike')
  let powered = combat({ character: 'defect', hand: [pommel], powers: [chrysalis, fasting],
    draw: [card('slayer_auto_shields'), card('cleave'), card('bash'), card('anger')] }, { enemies: marked() })
  powered = play(powered, pommel, target)
  assertEqual(me(powered).block, 4, 'Fasting: 3 + 1 Block')
  assertDeepEqual(me(powered).hand.map((c) => c.defId).sort(), ['cleave', 'daze'],
    'Chrysalis drew 2 after Auto-Shields: its Daze and Cleave')
  assertEqual(powered.enemies[0].hp, 40 - 3 - 1, 'Pommel Strike (2 + Fasting 1) and one Pressure Points')
  assertEqual(me(powered).cardsPlayedThisTurn, 2)
  // Burst: two resolutions, two Skill plays, so two Pressure Points hits and two counted plays.
  let doubled = combat({ character: 'defect', hand: [card('pommel_strike')], draw: [card('slayer_auto_shields'),
    card('anger'), card('anger')] }, { enemies: marked() })
  doubled.players[0].doubledSkillsThisTurn = 1
  doubled = play(doubled, doubled.players[0].hand[0], target)
  assertEqual(me(doubled).block, 6)
  assertEqual(doubled.enemies[0].hp, 40 - 2 - 2, 'Pommel Strike 2, then Pressure Points per resolution')
  assertEqual(me(doubled).cardsPlayedThisTurn, 3)
  assertDeepEqual(doubled.playedCardsThisTurn.filter((entry) => entry.card.defId === 'slayer_auto_shields')
    .map((entry) => entry.copied), [true, false], 'a copy, then the card')
  // Discovery's draw: both Skills are answered.
  const discovery = card('slayer_discovery')
  let found = combat({ character: 'defect', hand: [discovery], draw: [card('slayer_auto_shields'), card('anger'),
    card('cleave')] }, { enemies: marked() })
  found = play(found, discovery)
  assertEqual(found.enemies[0].hp, 38)
})

suite('Deep Breath')

for (const upgraded of [false, true]) {
  check(`${upgraded ? 'Deep Breath+' : 'Deep Breath'} draws ${upgraded ? 3 : 2} only with no other Skill in hand`, () => {
    const breath = card('slayer_deep_breath', upgraded)
    const draw = [card('bash'), card('anger'), card('cleave'), card('bludgeon')]
    let alone = combat({ hand: [breath, card('strike_ironclad')], draw: [...draw] })
    alone = play(alone, breath)
    assertEqual(me(alone).hand.length, 1 + (upgraded ? 3 : 2), 'an Attack does not stop the draw')
    let crowded = combat({ hand: [breath, card('defend_ironclad')], draw: [...draw] })
    crowded = play(crowded, breath)
    assertEqual(me(crowded).hand.length, 1, 'another Skill in hand: no draw')
    assertEqual(me(crowded).energy, 3, 'cost 0')
  })
}

suite('Forethought')

check('Forethought puts 1 card on the bottom, gains its cost, draws 1, Exhausts', () => {
  const forethought = card('slayer_forethought')
  const bludgeon = card('bludgeon')
  const top = card('strike_ironclad')
  let state = combat({ hand: [forethought, bludgeon, card('anger')], draw: [top, card('defend_ironclad')], energy: 3 })
  assertEqual(play(state, forethought), state, 'the card to put back must be chosen')
  assertEqual(play(state, forethought, { ...self, topdeckUids: [bludgeon.uid, me(state).hand[2].uid] }), state,
    'exactly 1 on the base face')
  const anger = me(state).hand[2]
  const under = me(state).draw[1]
  state = play(state, forethought, { ...self, topdeckUids: [bludgeon.uid] })
  assertEqual(me(state).energy, 6, '3 + Bludgeon 3, capped at 6')
  assertDeepEqual(uids(me(state).hand), [anger.uid, top.uid], 'Anger stays; exactly 1 card is drawn: the top one')
  assertDeepEqual(uids(me(state).draw), [under.uid, bludgeon.uid], 'Bludgeon alone went to the bottom')
  assertDeepEqual(uids(me(state).exhaust), [forethought.uid])
  assertEqual(me(state).discard.length, 0)
  let empty = combat({ hand: [forethought], draw: [top] })
  empty = play(empty, forethought, { ...self, topdeckUids: [] })
  assert(has(me(empty).hand, top), 'an empty hand puts nothing back and still draws')
  let fromEmptyDraw = combat({ hand: [forethought, bludgeon], draw: [], energy: 0 })
  fromEmptyDraw = play(fromEmptyDraw, forethought, { ...self, topdeckUids: [bludgeon.uid] })
  assert(has(me(fromEmptyDraw).hand, bludgeon), 'with an empty draw pile the put-back card is drawn again')
  assertEqual(me(fromEmptyDraw).energy, 3)
})

check('a forced Forethought waits for its owner whenever the hand holds a card to choose', () => {
  for (const upgraded of [false, true]) {
    const forethought = card('slayer_forethought', upgraded)
    const forced = (hand) => {
      const state = combat({ hand: [forethought, ...hand], draw: [card('anger')] })
      state.startTurnProgress = { choices: [], forcedCard: { playerId: 'p1', cardUid: forethought.uid,
        sourceCardId: 'havoc', exhaustNonPower: true } }
      return state
    }
    const choosing = forced([card('bash')])
    assertEqual(resolveDeterministicForcedCard(choosing), choosing, `${upgraded ? 'Forethought+' : 'Forethought'}: the player chooses`)
    const alone = forced([])
    const resolved = resolveDeterministicForcedCard(alone)
    assert(resolved !== alone && has(me(resolved).hand, me(alone).draw[0]), 'an empty hand decides itself and draws')
  }
})

check('an Unplayable card put back by Forethought is worth 0 Energy, whatever cost it stores', () => {
  // No printed Unplayable card stores a cost above 0 yet; this definition stands in for one (p.24: it has none).
  CARDS.g1_unplayable_with_cost ??= { ...cardDef('regret'), id: 'g1_unplayable_with_cost', cost: 2, upgrade: {} }
  const forethought = card('slayer_forethought')
  const odd = card('g1_unplayable_with_cost')
  const state = play(combat({ hand: [forethought, odd], draw: [card('anger')], energy: 1 }), forethought,
    { ...self, topdeckUids: [odd.uid] })
  assertEqual(me(state).energy, 1)
})

check('Energy from Forethought+ stops at the cap of 6', () => {
  const forethought = card('slayer_forethought', true)
  const bludgeon = card('bludgeon')
  const bash = card('bash')
  const state = play(combat({ hand: [forethought, bludgeon, bash], draw: [card('anger')], energy: 4 }), forethought,
    { ...self, topdeckUids: [bludgeon.uid, bash.uid] })
  assertEqual(me(state).energy, 6, '4 + 3 + 2 is capped at 6')
})

check('Forethought+ puts any number back in the chosen order and gains their combined cost', () => {
  const forethought = card('slayer_forethought', true)
  const bash = card('bash')
  const whirlwind = card('whirlwind')
  const regret = card('regret')
  const cleave = card('cleave')
  let state = combat({ hand: [forethought, bash, whirlwind, regret, cleave], draw: [card('anger')], energy: 1 })
  state = play(state, forethought, { ...self, topdeckUids: [cleave.uid, regret.uid, whirlwind.uid, bash.uid] })
  assertDeepEqual(uids(me(state).draw.slice(-4)), uids([cleave, regret, whirlwind, bash]))
  assertEqual(me(state).energy, 1 + 2 + 0 + 0 + 1, 'Bash 2, X 0, Unplayable 0, Cleave 1')
  assertDeepEqual(me(state).hand.map((c) => c.defId), ['anger'], 'then draws 1 card')
  assert(has(me(state).exhaust, forethought))
  let none = combat({ hand: [forethought, bash], draw: [card('anger')] })
  none = play(none, forethought, { ...self, topdeckUids: [] })
  assert(none !== undefined && has(me(none).hand, bash), 'zero is a legal number')
  assertEqual(me(none).energy, 3)
})

suite('Secret Technique')

check('Secret Technique goes on top of the draw pile during combat setup; other decks shuffle exactly as before', () => {
  const technique = card('slayer_secret_technique')
  const deck = Array.from({ length: 8 }, () => card('strike_ironclad'))
  const ready = readyForCombat(createRng(11), makePlayer({ deck: [deck[0], deck[1], technique, ...deck.slice(2)] }))
  assertEqual(ready.draw[0].uid, technique.uid)
  const plain = readyForCombat(createRng(11), makePlayer({ deck }))
  assertDeepEqual(uids(plain.draw), uids(shuffle(createRng(11), [...deck])), 'unchanged RNG use without the card')
  const two = shuffleCombatDraw(createRng(3), [deck[0], card('slayer_secret_technique', true), deck[1], technique])
  assertDeepEqual(two.slice(0, 2).map((c) => c.defId), ['slayer_secret_technique', 'slayer_secret_technique'])
  assertEqual(two[0].upgraded, true, 'several go on top in deck order')
})

check('an enemy shuffling a Status in at combat start keeps Secret Technique on top', () => {
  const technique = card('slayer_secret_technique')
  const player = readyForCombat(createRng(5), makePlayer({ deck: [card('strike_ironclad'), technique, card('bash')] }))
  const state = createCombat(createRng(5), [player], [makeEnemy({ defId: 'downfall_witch', uid: 's1', isBoss: true })])
  assertEqual(state.players[0].draw[0].uid, technique.uid)
})

for (const upgraded of [false, true]) {
  check(`${upgraded ? 'Secret Technique+' : 'Secret Technique'} searches one card into hand, reshuffles, Exhausts`, () => {
    const technique = card('slayer_secret_technique', upgraded)
    const wanted = card('bludgeon')
    let state = combat({ hand: [technique], draw: [card('strike_ironclad'), card('anger'), wanted, card('cleave')], energy: 1 })
    const preview = previewCardChoice(state, 'p1', technique.uid)
    assertEqual(preview.kind, 'search')
    assertEqual(play(state, technique, { ...self, searchDrawUids: ['nope'] }), state)
    state = play(state, technique, { ...self, searchDrawUids: [wanted.uid] })
    assert(has(me(state).hand, wanted))
    assertEqual(me(state).draw.length, 3)
    assertEqual(me(state).energy, upgraded ? 1 : 0, upgraded ? 'costs 0' : 'costs 1')
    assert(has(me(state).exhaust, technique))
  })
}

suite('Jack of All Trades')

for (const upgraded of [false, true]) {
  check(`${upgraded ? 'Jack of All Trades+' : 'Jack of All Trades'} gains the row the shared die is on`, () => {
    const outcome = (die) => {
      const jack = card('slayer_jack_of_all_trades', upgraded)
      const state = play(combat({ hand: [jack], energy: 3 }, { die }), jack, target)
      assert(has(me(state).exhaust, jack), 'Exhaust')
      return { block: me(state).block, energy: me(state).energy, strength: me(state).strength, hp: state.enemies[0].hp }
    }
    for (const die of [1, 2]) assertDeepEqual(outcome(die), { block: upgraded ? 3 : 2, energy: 3, strength: 0, hp: 40 })
    for (const die of [3, 4]) assertDeepEqual(outcome(die), { block: 0, energy: upgraded ? 5 : 4, strength: 0, hp: 40 })
    for (const die of [5, 6]) assertDeepEqual(outcome(die), { block: 0, energy: 3, strength: 1, hp: upgraded ? 38 : 40 },
      'the upgraded hit lands after its Strength')
    const capped = card('slayer_jack_of_all_trades', upgraded)
    const full = play(combat({ hand: [capped], energy: 5 }, { die: 3 }), capped, target)
    assertEqual(me(full).energy, 6, 'Energy gain is capped at 6')
  })
}

suite('Smite')

for (const upgraded of [false, true]) {
  check(`${upgraded ? 'Smite+' : 'Smite'}: take ${upgraded ? 1 : 2} damage (blockable), then hit for current HP`, () => {
    const self = upgraded ? 1 : 2
    const plain = card('slayer_smite', upgraded)
    let state = combat({ hand: [plain], hp: 10 })
    assertEqual(previewCardDamage(state, 'p1', plain.uid, 'e1').damage, 10 - self, 'the preview reads HP after the self-damage')
    state = play(state, plain, target)
    assertEqual(me(state).hp, 10 - self)
    assertEqual(state.enemies[0].hp, 40 - (10 - self))
    const blocked = card('slayer_smite', upgraded)
    let guarded = combat({ hand: [blocked], hp: 10, block: 1, strength: 2 })
    guarded = play(guarded, blocked, target)
    assertEqual(me(guarded).block, 0)
    assertEqual(me(guarded).hp, 10 - (self - 1), 'Block absorbs the self-damage first')
    assertEqual(guarded.enemies[0].hp, 40 - (10 - (self - 1) + 2), 'Strength adds to the X hit')
  })
}

check('Smite can kill its own player before it hits', () => {
  const smite = card('slayer_smite')
  const state = play(combat({ hand: [smite], hp: 2 }), smite, target)
  assertEqual(state.phase, 'lost')
  assertEqual(state.enemies[0].hp, 40)
})

suite('card-play windows')

check('a window survives a JSON round trip and stale finishes are refused', () => {
  const enlightenment = card('slayer_enlightenment')
  const bash = card('bash')
  let state = combat({ hand: [enlightenment, bash], draw: [card('anger')] })
  state = play(state, enlightenment)
  const restored = JSON.parse(JSON.stringify(state))
  const id = window(restored).id
  assertEqual(finishCardPlayWindow(restored, 'p1', 'old-window'), restored, 'a stale window id is a no-op')
  assertEqual(finishCardPlayWindow(restored, 'p2', id), restored, 'only the owner finishes it')
  const next = play(restored, me(restored).hand.find((c) => c.uid === bash.uid), target)
  assertEqual(me(next).energy, 2)
})

check('the turn cannot end while a window that must be played can still play', () => {
  for (const [source, piles] of [
    ['slayer_discovery', { draw: [card('bash'), card('anger'), card('cleave')] }],
    ['slayer_violence', { hand: [card('bash')] }],
  ]) {
    const opener = card(source)
    let state = combat({ hand: [opener, ...(piles.hand ?? [])], draw: piles.draw ?? [] })
    state = play(state, opener)
    assert(window(state), `${source} opened its window`)
    assertEqual(beginEndTurnResolution(state), state, `${source}: ending the turn is refused`)
    assertEqual(endPlayerTurn(state), state, `${source}: and through the discard path too`)
  }
  let deceive = combat({ character: 'watcher', hand: [card('slayer_deceive_reality')], draw: [card('anger'), card('daze')] })
  deceive = play(deceive, deceive.players[0].hand[0], { ...self, scryToHandUid: deceive.players[0].draw[0].uid })
  assertEqual(beginEndTurnResolution(deceive), deceive, 'Deceive Reality: refused too')
})

check('ending the turn closes an optional window and clears the cost marks', () => {
  const enlightenment = card('slayer_enlightenment')
  let state = combat({ hand: [enlightenment, card('bash')], draw: [card('anger')] })
  state = play(state, enlightenment)
  assert(window(state))
  state = beginEndTurnResolution(state)
  assertEqual(state.pendingCardPlayWindows, undefined)
  assert([...me(state).hand, ...me(state).discard].every((c) => c.playWindowCost === undefined))
})

check("closing Discovery's window discards what it offered and was not played, Retain included", () => {
  const discovery = card('slayer_discovery')
  const bite = card('slayer_bite')
  const anger = card('anger')
  let state = combat({ hand: [discovery], draw: [bite, anger, card('daze')] })
  state = play(state, discovery)
  const closed = structuredClone(state)
  closeAllCardPlayWindows(closed)
  assert(has(me(closed).discard, bite) && has(me(closed).discard, anger), 'end-of-turn close still discards')
  assertEqual(me(closed).hand.length, 0, 'Bite is not kept by its Retain')
  const abandoned = abandonCardPlayWindows(state, 'p1')
  assertEqual(window(abandoned), undefined)
  assert(has(me(abandoned).discard, bite) && has(me(abandoned).discard, anger), 'a disconnected owner forfeits the same way')
})

check('combat ending mid-window clears it', () => {
  const violence = card('slayer_violence')
  let state = combat({ hand: [violence, card('bludgeon'), card('bash')] }, { enemies: [makeEnemy({ hp: 5, maxHp: 5 })] })
  state = play(state, violence)
  state = play(state, me(state).hand.find((c) => c.defId === 'bludgeon'), target)
  assertEqual(state.phase, 'won')
  assertEqual(state.pendingCardPlayWindows, undefined)
  assert(me(state).hand.every((c) => c.playWindowCost === undefined))
})

check('a window opened inside another stays on top until it is done', () => {
  const enlightenment = card('slayer_enlightenment')
  const violence = card('slayer_violence')
  const bash = card('bash')
  const defend = card('defend_ironclad')
  let state = combat({ hand: [enlightenment, violence, bash, defend], draw: [card('anger')], energy: 3 })
  state = play(state, enlightenment)
  state = play(state, violence)
  assertEqual(me(state).energy, 2, 'Violence cost 1 through Enlightenment')
  assertEqual(window(state).sourceCardId, 'slayer_violence')
  assertEqual(play(state, defend), state, 'Enlightenment waits beneath Violence')
  state = play(state, bash, target)
  state = play(state, me(state).hand.find((c) => c.defId === 'anger'), target)
  assertEqual(me(state).energy, 2, 'Violence plays were free')
  assertEqual(window(state).sourceCardId, 'slayer_enlightenment', 'Enlightenment resumes')
  assertDeepEqual(window(state).cardUids, [defend.uid], 'with what it offered and is still in hand')
  state = play(state, defend)
  assertEqual(me(state).energy, 1)
})

check('a Double Tapped window card finishes its copy before the window closes', () => {
  const discovery = card('slayer_discovery')
  const strike = card('strike_ironclad')
  let state = combat({ hand: [discovery], draw: [strike, card('defend_ironclad'), card('cleave')], energy: 1 })
  state.players[0].doubledAttacksThisTurn = 1
  state = play(state, discovery)
  state = play(state, strike, target)
  assertEqual(state.phase, 'copy')
  assert(window(state), 'the window waits while the copy resolves')
  state = playCardCopy(state, 'p1', target)
  assertEqual(state.enemies[0].hp, 38)
  assertEqual(window(state), undefined)
  assertEqual(me(state).hand.length, 0, 'the other two were discarded after the copy')
})

check('a window refuses private reveals of cards it does not offer, but never a mandatory Chamber play', () => {
  const discovery = card('slayer_discovery')
  const technique = card('slayer_secret_technique')
  let state = combat({ hand: [discovery, technique], draw: [card('bash'), card('anger'), card('cleave'), card('bludgeon')] })
  state = play(state, discovery)
  assertEqual(previewCardChoice(state, 'p1', technique.uid), null, 'Secret Technique cannot even reveal meanwhile')

  const chambered = card('hermit_strike')
  const enlightenment = card('slayer_enlightenment')
  let hermit = combat({ character: 'hermit', hand: [enlightenment, card('anger')], draw: [card('cleave')],
    chamber: [chambered], chamberSlots: 2 })
  hermit = play(hermit, enlightenment)
  assert(window(hermit))
  hermit.pendingHermitChamberPlays = [{ playerId: 'p1', sourceCardId: 'test', cardUids: [chambered.uid], free: true }]
  const played = playHermitChamberCard(hermit, 'p1', chambered.uid, target)
  assert(played !== hermit, 'the mandatory Chamber play goes ahead')
  assertEqual(played.pendingHermitChamberPlays?.length ?? 0, 0)
  assert(window(played), 'and the window is still there afterwards')
})

suite('online room')

function finishNeow(room) {
  for (let attempts = 0; room.run.phase === 'neow'; attempts++) {
    assert(attempts < 64, 'Neow fixture did not settle')
    for (const seat of room.seats) {
      const preview = snapshotFor(room, seat.token).run.neow?.players[seat.playerId]
      if (!preview || preview.done) continue
      if (preview.redGoldPending) apply(room, seat.token, { kind: 'neow', stage: 'redGold', gain: false })
      else if (preview.redRewardPending) apply(room, seat.token, { kind: 'neow', stage: 'red', choice: null })
      else if (preview.pendingEffect) apply(room, seat.token, { kind: 'neow', stage: 'effect', gain: false })
      else if (preview.blueOption === null) apply(room, seat.token, { kind: 'neow', stage: 'option', optionIndex: 0 })
      else if (preview.rewardKind) apply(room, seat.token, { kind: 'neow', stage: 'reward', choice: null })
    }
  }
}

function confirmStartTurn(room, seat) {
  const view = snapshotFor(room, seat.token)
  apply(room, seat.token, {
    kind: 'resolveStartTurn',
    choices: view.startTurnAbilities.map((ability) => ({
      id: ability.id,
      enemyUid: ability.playerId === seat.playerId ? ability.targets?.[0]?.uid : undefined,
      targetPlayerId: ability.playerId === seat.playerId ? ability.players?.[0]?.id : undefined,
      exhaustUids: ability.playerId === seat.playerId && ability.exhaustCards?.[0] ? [ability.exhaustCards[0].uid] : undefined,
      guardianModeShift: ability.playerId === seat.playerId && ability.guardianModeShift ? false : undefined,
      shivEnemyUids: ability.playerId === seat.playerId ? Array(ability.overflowShivs).fill(null) : [],
      evokeSlots: [], evokeEnemyUids: [],
    })),
  })
}

/** Two seats in the Player Turn of their first fight, with Ann's piles replaced. */
function roomWith(annPiles) {
  const room = createRoom(createStore(), { code: 'SLAYG1' })
  const a = joinRoom(room, { name: 'Ann', character: 'watcher' })
  const b = joinRoom(room, { name: 'Bo', character: 'silent' })
  startRun(room, a.token, { seed: 2 })
  finishNeow(room)
  apply(room, a.token, { kind: 'enterRoom', roomId: roomChoices(room.run)[0].id })
  for (let attempts = 0; room.run.combat?.phase === 'start'; attempts++) {
    assert(attempts < 64, 'Start-of-Turn fixture did not settle')
    const view = snapshotFor(room, a.token)
    const ownerId = view.startTurnRequired?.find((id) => !view.startTurnDecided?.includes(id))
    confirmStartTurn(room, room.seats.find((seat) => seat.playerId === ownerId))
  }
  assertEqual(room.run.combat.phase, 'player')
  Object.assign(room.run.combat.players.find((player) => player.id === a.playerId), { energy: 3, ...annPiles })
  return { room, a, b, enemyUid: room.run.combat.enemies.find((enemy) => !enemy.dead).uid }
}

check('only the owner sees a window; non-offered plays are refused; the owner finishes it', () => {
  const discovery = card('slayer_discovery')
  const bludgeon = card('bludgeon')
  const drawn = [card('strike_watcher'), card('defend_watcher'), card('anger')]
  const { room, a, b, enemyUid } = roomWith({ hand: [discovery, bludgeon], draw: [...drawn] })
  apply(room, a.token, { kind: 'playCard', cardUid: discovery.uid, enemyUid: null, playerId: a.playerId })
  const own = snapshotFor(room, a.token).run.combat.pendingCardPlayWindows
  assertDeepEqual(own?.map((entry) => entry.cardUids), [uids(drawn)])
  assertEqual(snapshotFor(room, b.token).run.combat.pendingCardPlayWindows, undefined, 'a teammate never sees the offer')
  assertThrows(() => apply(room, a.token, { kind: 'playCard', cardUid: bludgeon.uid, enemyUid, playerId: a.playerId,
    preflight: true }), 'the room refuses a non-offered card')
  assertThrows(() => apply(room, a.token, { kind: 'finishCardPlayWindow', windowId: own[0].id }),
    'Discovery cannot be finished while a drawn card can be played')
  assertThrows(() => apply(room, a.token, { kind: 'endTurn' }), 'nor can Ann end the turn')
  apply(room, a.token, { kind: 'playCard', cardUid: drawn[2].uid, enemyUid, playerId: a.playerId, preflight: true })
  const after = room.run.combat.players.find((player) => player.id === a.playerId)
  assertEqual(after.energy, 2, 'Anger through Discovery cost 0')
  assertEqual(room.run.combat.pendingCardPlayWindows, undefined)
  assert(has(after.discard, drawn[0]) && has(after.discard, drawn[1]))

  const enlightenment = card('slayer_enlightenment')
  const next = roomWith({ hand: [enlightenment, card('bash')], draw: [card('anger')] })
  apply(next.room, next.a.token, { kind: 'playCard', cardUid: enlightenment.uid, enemyUid: null, playerId: next.a.playerId })
  const offer = snapshotFor(next.room, next.a.token).run.combat.pendingCardPlayWindows[0]
  assertThrows(() => apply(next.room, next.b.token, { kind: 'finishCardPlayWindow', windowId: offer.id }),
    "a teammate cannot finish Ann's window")
  apply(next.room, next.a.token, { kind: 'finishCardPlayWindow', windowId: offer.id })
  assertEqual(next.room.run.combat.pendingCardPlayWindows, undefined)
})

check('with a window each, every seat sees only its own window', () => {
  const discovery = card('slayer_discovery')
  const annDrawn = [card('strike_watcher'), card('defend_watcher'), card('anger')]
  const { room, a, b } = roomWith({ hand: [discovery], draw: [...annDrawn] })
  const enlightenment = card('slayer_enlightenment')
  const boHeld = card('strike_silent')
  const boDrawn = card('defend_silent')
  Object.assign(room.run.combat.players.find((player) => player.id === b.playerId),
    { energy: 3, hand: [enlightenment, boHeld], draw: [boDrawn] })
  const annResult = apply(room, a.token, { kind: 'playCard', cardUid: discovery.uid, enemyUid: null, playerId: a.playerId })
  const boResult = apply(room, b.token, { kind: 'playCard', cardUid: enlightenment.uid, enemyUid: null, playerId: b.playerId })
  assertEqual(room.run.combat.pendingCardPlayWindows.length, 2, 'both windows are open at once')
  const views = [
    [a.playerId, snapshotFor(room, a.token), uids(annDrawn), [boHeld.uid, boDrawn.uid]],
    [b.playerId, snapshotFor(room, b.token), [boHeld.uid, boDrawn.uid], uids(annDrawn)],
    [b.playerId, boResult.snapshot, [boHeld.uid, boDrawn.uid], uids(annDrawn)],
  ]
  for (const [viewerId, view, ownUids, otherUids] of views) {
    const windows = view.run.combat.pendingCardPlayWindows
    assertDeepEqual(windows.map((entry) => entry.playerId), [viewerId], 'one window: the viewer\'s own')
    assertDeepEqual([...windows[0].cardUids].sort(), [...ownUids].sort())
    assert(otherUids.every((uid) => !JSON.stringify(view).includes(uid)), "nothing of the other seat's offer leaks")
  }
  assertDeepEqual(annResult.snapshot.run.combat.pendingCardPlayWindows.map((entry) => entry.playerId), [a.playerId])
})

check('a disconnected owner forfeits a window that must be played when the party ends the turn', () => {
  const discovery = card('slayer_discovery')
  const drawn = [card('strike_watcher'), card('defend_watcher'), card('anger')]
  const { room, a, b } = roomWith({ hand: [discovery], draw: [...drawn] })
  apply(room, a.token, { kind: 'playCard', cardUid: discovery.uid, enemyUid: null, playerId: a.playerId })
  markDisconnected(room, a.token)
  apply(room, b.token, { kind: 'endTurn' })
  assertEqual(room.run.combat.pendingCardPlayWindows, undefined)
  assert(room.run.combat.phase !== 'player' || room.endTurnAbilities, 'the turn moved on')
  const ann = room.run.combat.players.find((player) => player.id === a.playerId)
  assert(drawn.every((held) => has(ann.discard, held) || has(ann.draw, held) || has(ann.hand, held)))
})

check("a forfeited Discovery's discard can win the fight; the turn end then has nothing left to do", () => {
  const discovery = card('slayer_discovery')
  const drawn = [card('strike_watcher'), card('defend_watcher'), card('anger')]
  const { room, a, b } = roomWith({ hand: [discovery], draw: [...drawn], powers: [card('slayer_eviscerate')] })
  room.run.combat.enemies.forEach((foe, index) => Object.assign(foe, index === 0 ? { hp: 3 } : { hp: 0, dead: true }))
  apply(room, a.token, { kind: 'playCard', cardUid: discovery.uid, enemyUid: null, playerId: a.playerId })
  markDisconnected(room, a.token)
  apply(room, b.token, { kind: 'endTurn' })
  // Eviscerate dealt 1 for each of the 3 discarded cards: the fight is won (and may already be cleared away).
  assert(room.run.combat === null || room.run.combat.phase === 'won', `the fight is won: ${room.run.combat?.phase}`)
  assert(room.run.phase !== 'combat' || room.run.combat?.phase === 'won')
  assertEqual(room.endTurnReady, undefined)
})

check("a forfeited Discovery's Eviscerate trigger resolves and the turn still ends on one End Turn", () => {
  for (const eviscerate of [true, false]) {
    const discovery = card('slayer_discovery')
    const drawn = [card('strike_watcher'), card('defend_watcher'), card('anger')]
    const { room, a, b } = roomWith({ hand: [discovery], draw: [...drawn],
      powers: eviscerate ? [card('slayer_eviscerate')] : [] })
    const living = room.run.combat.enemies.filter((foe) => !foe.dead)
    if (living.length < 2) room.run.combat.enemies.push({ ...structuredClone(living[0]), uid: `${living[0].uid}-twin` })
    for (const foe of room.run.combat.enemies) Object.assign(foe, { hp: 40, maxHp: 40 })
    apply(room, a.token, { kind: 'playCard', cardUid: discovery.uid, enemyUid: null, playerId: a.playerId })
    markDisconnected(room, a.token)
    apply(room, b.token, { kind: 'endTurn' })
    const label = eviscerate ? 'with Eviscerate' : 'without Eviscerate'
    assert(room.run.combat.phase !== 'player' || room.endTurnAbilities, `${label}: the turn ended on Bo's one click`)
    assertEqual(room.run.combat.pendingCardPlayWindows, undefined, label)
    assertEqual(room.run.combat.pendingTriggers?.length ?? 0, 0, `${label}: nothing is left waiting`)
    const damage = room.run.combat.enemies.reduce((sum, foe) => sum + 40 - foe.hp, 0)
    if (eviscerate) assert(damage >= 3, `Eviscerate dealt 1 per discarded card (${damage})`)
  }
})

check('Deceive Reality goes through the private reveal before its play is accepted', () => {
  const deceive = card('slayer_deceive_reality')
  const top = [card('daze'), card('anger'), card('defend_watcher'), card('strike_watcher')]
  const { room, a, b, enemyUid } = roomWith({ hand: [deceive], draw: [...top] })
  assertThrows(() => apply(room, a.token, { kind: 'playCard', cardUid: deceive.uid, enemyUid: null, playerId: a.playerId,
    scryToHandUid: top[1].uid }), 'the card must be revealed first')
  apply(room, a.token, { kind: 'previewCard', cardUid: deceive.uid })
  const reveal = snapshotFor(room, a.token).cardPreview
  assertEqual(reveal.kind, 'scryToHand')
  assertDeepEqual(uids(reveal.cards), uids(top.slice(0, 3)), 'the owner sees the top 3')
  assert(!snapshotFor(room, b.token).cardPreview, 'the teammate gets no reveal')
  assert(!JSON.stringify(snapshotFor(room, b.token)).includes(top[1].uid), 'nor any revealed card id')
  apply(room, a.token, { kind: 'playCard', cardUid: deceive.uid, enemyUid: null, playerId: a.playerId,
    scryToHandUid: top[1].uid, scryDiscardUids: [top[0].uid], preflight: true })
  const offer = snapshotFor(room, a.token).run.combat.pendingCardPlayWindows
  assertDeepEqual(offer.map((entry) => entry.cardUids), [[top[1].uid]])
  apply(room, a.token, { kind: 'playCard', cardUid: top[1].uid, enemyUid, playerId: a.playerId, preflight: true })
  assertEqual(room.run.combat.pendingCardPlayWindows, undefined)
})

check("a disconnected owner's open Deceive Reality reveal plays the first playable revealed card", () => {
  const deceive = card('slayer_deceive_reality')
  const top = [card('daze'), card('anger'), card('defend_watcher'), card('strike_watcher')]
  const { room, a, b } = roomWith({ hand: [deceive], draw: [...top] })
  apply(room, a.token, { kind: 'previewCard', cardUid: deceive.uid })
  markDisconnected(room, a.token)
  apply(room, b.token, { kind: 'endTurn' })
  assertEqual(room.cardPreviews?.[a.playerId], undefined, 'the abandoned reveal is resolved')
  const ann = room.run.combat.players.find((player) => player.id === a.playerId)
  assert(!has(ann.hand, deceive) && has(ann.discard, deceive), 'Deceive Reality was played')
  // Daze cannot be played, so the first playable reveal (Anger, not the later Defend) left the draw pile.
  assert(has(ann.discard, top[1]) && !has(ann.draw, top[1]), 'the first playable reveal was named')
  assert(has(ann.draw, top[2]) && has(ann.draw, top[0]), 'the other reveals stayed on the draw pile')
  assert(room.run.combat.phase !== 'player' || room.endTurnAbilities, "Bo's one End Turn moved the party on")
})

check("a disconnected owner's Deceive Reality reveal with nothing playable is a plain Scry", () => {
  const deceive = card('slayer_deceive_reality')
  const { room, a, b } = roomWith({ hand: [deceive], draw: [card('daze'), card('daze'), card('daze'), card('strike_watcher')] })
  apply(room, a.token, { kind: 'previewCard', cardUid: deceive.uid })
  markDisconnected(room, a.token)
  apply(room, b.token, { kind: 'endTurn' })
  assertEqual(room.cardPreviews?.[a.playerId], undefined)
  assert(room.run.combat.phase !== 'player' || room.endTurnAbilities, "Bo's one End Turn moved the party on")
})

check("a disconnected owner's open reveal for a doubled Deceive Reality copy resolves too", () => {
  const deceive = card('slayer_deceive_reality')
  const top = [card('daze'), card('anger'), card('defend_watcher'), card('strike_watcher'), card('defend_watcher')]
  const { room, a, b } = roomWith({ hand: [deceive], draw: [...top], doubledSkillsThisTurn: 1 })
  const played = { kind: 'playCard', cardUid: deceive.uid, enemyUid: null, playerId: a.playerId }
  apply(room, a.token, { kind: 'previewCard', cardUid: deceive.uid })
  apply(room, a.token, { ...played, scryToHandUid: top[1].uid, scryDiscardUids: [top[0].uid], preflight: true })
  assertEqual(room.run.combat.phase, 'copy')
  apply(room, a.token, { kind: 'previewCardCopy', cardUid: deceive.uid, copyId: room.run.combat.pendingCardCopy.id, enemyUid: null })
  assert(room.cardPreviews[a.playerId].copy, 'the copy holds a reveal of its own')
  markDisconnected(room, a.token)
  apply(room, b.token, { kind: 'endTurn' })
  assertEqual(room.cardPreviews?.[a.playerId], undefined, 'the abandoned copy reveal is resolved')
  assertEqual(room.run.combat.pendingCardCopy, undefined)
  assert(room.run.combat.phase !== 'player' || room.endTurnAbilities, "Bo's one End Turn moved the party on")
})

/** A disconnected Ann's open Deceive Reality reveal, resolved by Bo's End Turn; `setup` may reshape the room first. */
function abandonDeceive(annPiles, { copy = false, timeEater = false } = {}) {
  const deceive = annPiles.hand.find((held) => held.defId === 'slayer_deceive_reality')
  const { room, a, b } = roomWith(annPiles)
  if (timeEater) Object.assign(room.run.combat.enemies[0], { defId: 'time_eater', hp: 99, maxHp: 99, actionIndex: 0 })
  const ann = () => room.run.combat.players.find((player) => player.id === a.playerId)
  if (copy) {
    const filler = annPiles.draw[0]
    apply(room, a.token, { kind: 'previewCard', cardUid: deceive.uid })
    apply(room, a.token, { kind: 'playCard', cardUid: deceive.uid, enemyUid: null, playerId: a.playerId,
      scryToHandUid: annPiles.draw[1].uid, scryDiscardUids: [filler.uid], preflight: true })
    assertEqual(room.run.combat.phase, 'copy')
    apply(room, a.token, { kind: 'previewCardCopy', cardUid: deceive.uid, copyId: room.run.combat.pendingCardCopy.id, enemyUid: null })
  } else apply(room, a.token, { kind: 'previewCard', cardUid: deceive.uid })
  markDisconnected(room, a.token)
  apply(room, b.token, { kind: 'endTurn' })
  assertEqual(room.cardPreviews?.[a.playerId], undefined, 'the abandoned reveal is resolved')
  assert(room.run.combat.phase !== 'player' || room.endTurnAbilities, "Bo's one End Turn moved the party on")
  return ann()
}

check("an abandoned Deceive Reality judges its reveal with the source already out of hand", () => {
  // Clash is playable only when every card in hand is an Attack; Deceive Reality, alone in hand, is leaving it.
  const clash = card('clash')
  const top = [card('daze'), clash, card('daze'), card('strike_watcher')]
  const ann = abandonDeceive({ hand: [card('slayer_deceive_reality')], draw: [...top] })
  assert(has(ann.discard, clash) && !has(ann.draw, clash), 'Clash was named and taken')
})

check("an abandoned Deceive Reality counts itself as played when judging the Time Warp limit", () => {
  const top = [card('daze'), card('anger'), card('defend_watcher'), card('strike_watcher'), card('defend_watcher')]
  for (const copy of [false, true]) {
    // Playing Deceive Reality (the Burst copy first, when doubled) reaches the limit, so nothing revealed is playable.
    const ann = abandonDeceive({ hand: [card('slayer_deceive_reality')], draw: top.map((held) => ({ ...held })),
      cardsPlayedThisTurn: copy ? 3 : 4, ...(copy ? { doubledSkillsThisTurn: 1 } : {}) }, { copy, timeEater: true })
    const label = copy ? 'Burst copy' : 'plain play'
    // The Burst copy was scripted to take Anger; the abandoned reveal is then the three cards below it.
    const revealed = copy ? top.slice(2, 5) : top.slice(0, 3)
    assert(revealed.every((held) => ann.draw.some((kept) => kept.defId === held.defId)),
      `${label}: nothing was named once Time Warp stops card play, so the reveal stays on the draw pile`)
    assertEqual(ann.draw.length, copy ? 3 : 5, `${label}: a plain Scry`)
  }
})

report('slayer play windows cards')
