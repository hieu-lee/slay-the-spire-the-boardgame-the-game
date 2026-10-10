// Slayer Pack the discard and orbs group: discard-pile movers, any-player effects and Orb cards.
// Dual Wield, Armaments, Heel Hook, Rebound, Creative AI, Aggregate, Hello World,
// Biased Cognition, Reboot, Master Reality, Wheel Kick, Magnetism — both faces of
// each, in solo, multi-player ownership and through the authoritative room server.
// Rules and rulings: docs/slayer-pack.md and docs/slayer-pack-notes-discard-and-orbs.md.
import {
  activatePower,
  beginEndPlayerTurn,
  beginEndTurnResolution,
  orbEndTurnAmount,
  defaultPendingPlayerChoice,
  lapseStrandedPlayerChoices,
  mandatoryChoicePending,
  createCombat,
  defaultStartTurnChoices,
  endPlayerTurn,
  enemyTurn,
  playCard,
  playCardCopy,
  preparePlayerTurn,
  resolvePendingPlayerChoice,
  resolveStartPlayerTurn,
  startTurnAbilities,
} from '../src/game/combat.ts'
import { cardDef, faceOf } from '../src/game/cards.ts'
import { createRng } from '../src/game/rng.ts'
import { apply, createRoom, createStore, joinRoom, markDisconnected, snapshotFor, startRun } from './lib/rooms.mjs'
import { suite, check, assert, assertDeepEqual, assertEqual, assertThrows, report } from './lib/harness.mjs'

let uid = 0
const card = (defId, upgraded = false) => ({ uid: `g${uid++}`, defId, upgraded })
const strikes = (n) => Array.from({ length: n }, () => card('strike_ironclad'))

const player = (over = {}) => ({
  id: 'p1', name: 'Ann', character: 'ironclad', row: 0,
  hp: 20, maxHp: 20, block: 0, energy: 3, gold: 0,
  deck: [], draw: [], hand: [], discard: [], exhaust: [], powers: [],
  relics: [], potions: [], cardRewards: [], rareRewards: [],
  strength: 0, vulnerable: 0, weak: 0, shivs: 0, miracles: 0,
  stance: 'neutral', orbs: [null, null, null], dead: false, drawLocked: false, ...over,
})
const ally = (over = {}) => player({ id: 'p2', name: 'Bo', character: 'silent', row: 1, ...over })
const enemy = (over = {}) => ({
  uid: 'e1', defId: 'green_louse', row: 0, isBoss: false,
  hp: 30, maxHp: 30, block: 0,
  strength: 0, vulnerable: 0, weak: 0, poison: 0, actionIndex: 0, abilityUsed: true, dead: false, ...over,
})

const combat = (players, enemies = [enemy()]) => createCombat(createRng(7), players, enemies)
const play = (state, playerId, held, context = {}) =>
  playCard(state, playerId, held.uid, { enemyUid: 'e1', playerId, ...context })
const who = (state, id = 'p1') => state.players.find((candidate) => candidate.id === id)
const uids = (cards) => cards.map((held) => held.uid)
const hpOf = (state, id = 'e1') => state.enemies.find((candidate) => candidate.uid === id).hp
/** Starts a fresh turn and rolls `die`, leaving the ordered Start-of-Turn abilities to resolve. */
function startWithDie(state, die) {
  const prepared = preparePlayerTurn(state)
  assertEqual(prepared.phase, 'start', 'the turn reached its Start-of-Turn abilities')
  prepared.die = die
  return prepared
}
const startTurn = (state, die = 1) => {
  const prepared = startWithDie(state, die)
  return resolveStartPlayerTurn(prepared, defaultStartTurnChoices(prepared))
}

suite('Slayer Pack discard and orbs')

check('every card in the group has both faces transcribed from its scan', () => {
  const expected = {
    slayer_dual_wield: [1, 0], slayer_armaments: [1, 1], slayer_heel_hook: [1, 1], slayer_rebound: [1, 0],
    slayer_creative_ai: [1, 1], slayer_aggregate: [1, 1], slayer_hello_world: [2, 1], slayer_biased_cognition: [2, 1],
    slayer_reboot: [0, 0], slayer_master_reality: [1, 1], slayer_wheel_kick: [1, 1], slayer_magnetism: [1, 1],
  }
  for (const [id, [base, upgraded]] of Object.entries(expected)) {
    const def = cardDef(id)
    assert(def.effects.length > 0, `${id} has printed effects`)
    assertEqual(def.cost, base, `${id} base cost`)
    assertEqual(faceOf(def, true).cost, upgraded, `${id}+ cost`)
  }
  assertEqual(faceOf(cardDef('slayer_aggregate'), false).exhaust, true, 'Aggregate Exhausts')
  assertEqual(faceOf(cardDef('slayer_aggregate'), true).exhaust, false, 'Aggregate+ does not')
  assertEqual(faceOf(cardDef('slayer_reboot'), true).retain, true, 'Reboot+ Retains')
  assertEqual(faceOf(cardDef('slayer_reboot'), true).exhaust, true, 'Reboot+ still Exhausts')
})

// ---------------------------------------------------------------- Dual Wield

check('Dual Wield returns the topmost card of your own discard pile, never itself', () => {
  for (const upgraded of [false, true]) {
    const [bottom, top] = strikes(2)
    const wield = card('slayer_dual_wield', upgraded)
    const state = combat([player({ hand: [wield], discard: [bottom, top] })])
    const after = play(state, 'p1', wield)
    assert(after !== state, 'Dual Wield is playable')
    assertDeepEqual(uids(who(after).hand), [top.uid], 'the topmost card (end of the pile) came back')
    assertDeepEqual(uids(who(after).discard), [bottom.uid, wield.uid], 'Dual Wield itself lands on the pile afterwards')
    assertEqual(who(after).energy, upgraded ? 3 : 2, `Dual Wield${upgraded ? '+' : ''} costs ${upgraded ? 0 : 1}`)
  }
})

check("Dual Wield takes any living player's topmost discard back to that player's hand", () => {
  const mine = card('defend_ironclad')
  const [theirBottom, theirTop] = [card('strike_silent'), card('neutralize')]
  const wield = card('slayer_dual_wield')
  const state = combat([
    player({ hand: [wield], discard: [mine] }),
    ally({ discard: [theirBottom, theirTop] }),
  ])
  const after = play(state, 'p1', wield, { playerId: 'p2' })
  assertDeepEqual(uids(who(after, 'p2').hand), [theirTop.uid], "the ally's card goes to the ally's hand")
  assertDeepEqual(uids(who(after, 'p2').discard), [theirBottom.uid])
  assertDeepEqual(uids(who(after).hand), [], "the caster's hand is untouched")
  assertDeepEqual(uids(who(after).discard), [mine.uid, wield.uid])
  const dead = combat([player({ hand: [wield] }), ally({ dead: true, hp: 0, discard: [theirTop] })])
  assertEqual(play(dead, 'p1', wield, { playerId: 'p2' }), dead, 'a dead player cannot be chosen')
  const empty = combat([player({ hand: [wield] }), ally()])
  const fizzled = play(empty, 'p1', wield, { playerId: 'p2' })
  assert(fizzled !== empty, 'an empty discard pile still lets the card be played')
  assertEqual(who(fizzled, 'p2').hand.length, 0)
})

// ---------------------------------------------------------------- Rebound

check("Rebound hits for 2 and puts any player's topmost discard on top of THEIR draw pile", () => {
  for (const upgraded of [false, true]) {
    const rebound = card('slayer_rebound', upgraded)
    const [old, top] = [card('strike_silent'), card('backflip')]
    const drawn = card('defend_silent')
    const state = combat([
      player({ hand: [rebound], discard: [card('defend_ironclad')] }),
      ally({ draw: [drawn], discard: [old, top] }),
    ])
    const after = play(state, 'p1', rebound, { playerId: 'p2' })
    assertEqual(hpOf(after), 28, 'Rebound deals 2 on both faces')
    assertDeepEqual(uids(who(after, 'p2').draw), [top.uid, drawn.uid], 'the card is now the next one the ally draws')
    assertDeepEqual(uids(who(after, 'p2').discard), [old.uid])
    assertEqual(who(after).discard.length, 2, "the caster's own pile only gains Rebound")
    assertEqual(who(after).energy, upgraded ? 3 : 2, `Rebound${upgraded ? '+' : ''} costs ${upgraded ? 0 : 1}`)
  }
})

// ---------------------------------------------------------------- Wheel Kick

check('Rebound with every discard pile empty still hits for 2 and moves nothing', () => {
  const rebound = card('slayer_rebound')
  const allyDraw = strikes(1)
  const state = combat([player({ hand: [rebound] }), ally({ draw: allyDraw })])
  for (const target of ['p1', 'p2']) {
    const after = play(state, 'p1', rebound, { playerId: target })
    assert(after !== state, `Rebound on ${target} is legal`)
    assertEqual(hpOf(after), 28)
    assertDeepEqual(uids(who(after, 'p2').draw), uids(allyDraw), "the ally's draw pile is untouched")
    assertDeepEqual(uids(who(after).draw), [])
  }
})

check("Wheel Kick: an Auto-Shields the ally draws plays itself for the ally", () => {
  const kick = card('slayer_wheel_kick')
  const shields = card('slayer_auto_shields')
  const state = combat([player({ hand: [kick] }), ally({ draw: [shields, ...strikes(2)] })])
  const after = play(state, 'p1', kick, { playerId: 'p2' })
  assertEqual(who(after, 'p2').block, 3, "Auto-Shields' 3 Block goes to the ally who drew it")
  assertEqual(who(after).block, 0, 'not to the caster')
  assert(!who(after, 'p2').hand.some((held) => held.uid === shields.uid), 'it left the ally\'s hand')
  assert(who(after, 'p2').discard.some((held) => held.uid === shields.uid), "and went to the ally's discard pile")
  // Auto-Shields resolves as it is drawn, so Wheel Kick's second draw takes the Daze it put on top.
  assert([...who(after, 'p2').hand, ...who(after, 'p2').draw].some((held) => held.defId === 'daze'),
    "its Daze is the ally's, not the caster's")
  assertEqual(who(after, 'p2').hand.length + who(after, 'p2').discard.length, 2, 'the ally drew exactly 2')
})

check('Wheel Kick hits for 2 (3) and the chosen player draws 2', () => {
  for (const [upgraded, damage] of [[false, 2], [true, 3]]) {
    const kick = card('slayer_wheel_kick', upgraded)
    const state = combat([player({ hand: [kick], draw: strikes(3) }), ally({ draw: strikes(3) })])
    const after = play(state, 'p1', kick, { playerId: 'p2' })
    assertEqual(hpOf(after), 30 - damage)
    assertEqual(who(after, 'p2').hand.length, 2, 'the ally draws 2')
    assertEqual(who(after).hand.length, 0, 'the caster draws nothing when an ally was chosen')
    const self = play(state, 'p1', kick, { playerId: 'p1' })
    assertEqual(who(self).hand.length, 2, 'the caster may choose themselves')
  }
})

// ---------------------------------------------------------------- Heel Hook

check('Heel Hook without a Weak target is only the hit', () => {
  const hook = card('slayer_heel_hook')
  const state = combat([player({ hand: [hook], draw: strikes(2) })])
  const after = play(state, 'p1', hook)
  assertEqual(hpOf(after), 28)
  assertEqual(who(after).energy, 2, 'no Energy back')
  assertEqual(after.pendingPlayerChoices, undefined, 'nobody is asked to draw or discard')
})

check('a queued player choice takes its public id from its own counter, never the masked trigger counter', () => {
  const hook = card('slayer_heel_hook')
  const state = combat([player({ hand: [hook], draw: strikes(2) })], [enemy({ weak: 1 })])
  state.nextTriggerId = 9
  const first = play(state, 'p1', hook)
  assertEqual(first.pendingPlayerChoices[0].id, 0)
  assertEqual(first.nextTriggerId, 9, 'a public choice does not advance the private trigger count')
  assertEqual(first.nextPlayerChoiceId, 1)
  assertEqual(state.nextPlayerChoiceId, undefined, 'a combat that never queues a choice gains no field')
})

check('a loaded state with a missing or stale choice counter never reuses a pending choice id', () => {
  for (const counter of [undefined, 0, Number.NaN, -3]) {
    const hook = card('slayer_heel_hook')
    const state = combat([player({ hand: [hook], draw: strikes(2) })], [enemy({ weak: 1 })])
    // Owned by nobody seated, so it blocks nothing and is still pending when the new one is queued.
    state.pendingPlayerChoices = [{ id: 4, playerId: 'p9', sourceLabel: 'Old', kind: 'drawOrDiscard' }]
    if (counter !== undefined) state.nextPlayerChoiceId = counter
    const after = play(state, 'p1', hook)
    assertDeepEqual(after.pendingPlayerChoices.map((choice) => choice.id), [5], `counter ${counter}: past the pending id 4`)
    assertEqual(after.nextPlayerChoiceId, 6, `counter ${counter}`)
  }
})

check('a live choice counter above every pending id is honoured: counter 7 with nothing pending queues id 7, then 8', () => {
  const hook = card('slayer_heel_hook')
  const state = combat([player({ hand: [hook], draw: strikes(2) })], [enemy({ weak: 1 })])
  state.nextPlayerChoiceId = 7
  const after = play(state, 'p1', hook)
  assertDeepEqual(after.pendingPlayerChoices.map((choice) => choice.id), [7])
  assertEqual(after.nextPlayerChoiceId, 8)
})

check('Heel Hook on a Weak target gains 1 Energy, then the chosen player may draw, discard or decline', () => {
  for (const [upgraded, damage] of [[false, 2], [true, 3]]) {
    const hook = card('slayer_heel_hook', upgraded)
    const keep = card('strike_ironclad')
    const state = combat([player({ hand: [hook, keep], draw: strikes(2) })], [enemy({ weak: 1 })])
    const after = play(state, 'p1', hook)
    assertEqual(hpOf(after), 30 - damage)
    assertEqual(who(after).energy, 3, 'paid 1, gained 1 back')
    const [choice] = after.pendingPlayerChoices
    assertEqual(choice.kind, 'drawOrDiscard')
    assertEqual(choice.playerId, 'p1')
    assertEqual(playCard(after, 'p1', keep.uid, { enemyUid: 'e1', playerId: 'p1' }), after,
      'nothing else is played while the choice is open')
    const drew = resolvePendingPlayerChoice(after, 'p1', { choiceId: choice.id, draw: true })
    assertEqual(who(drew).hand.length, 2, 'draw a card')
    assertEqual(drew.pendingPlayerChoices, undefined)
    const discarded = resolvePendingPlayerChoice(after, 'p1', { choiceId: choice.id, discardUid: keep.uid })
    assertEqual(who(discarded).hand.length, 0)
    assertEqual(who(discarded).discard.at(-1).uid, keep.uid, 'the chosen card is discarded on top')
    assert(discarded.discardedThisTurn.includes('p1'), 'it counts as a discard this turn')
    const declined = resolvePendingPlayerChoice(after, 'p1', { choiceId: choice.id })
    assertEqual(who(declined).hand.length, 1, '"may": declining changes nothing')
    assertEqual(declined.pendingPlayerChoices, undefined)
  }
})

check('Heel Hook rejects stale, foreign and malformed answers without touching the state', () => {
  const hook = card('slayer_heel_hook')
  const keep = card('strike_ironclad')
  const state = combat([player({ hand: [hook], draw: strikes(2) }), ally({ hand: [keep] })], [enemy({ weak: 2 })])
  const after = play(state, 'p1', hook, { playerId: 'p2' })
  const [choice] = after.pendingPlayerChoices
  assertEqual(choice.playerId, 'p2', 'the chosen ally owes the choice, not the caster')
  for (const [label, playerId, answer] of [
    ['the caster answering for the ally', 'p1', { choiceId: choice.id, draw: true }],
    ['a stale id', 'p2', { choiceId: choice.id + 1, draw: true }],
    ['draw and discard together', 'p2', { choiceId: choice.id, draw: true, discardUid: keep.uid }],
    ['a card from another hand', 'p2', { choiceId: choice.id, discardUid: hook.uid }],
    ['a count on a draw/discard choice', 'p2', { choiceId: choice.id, count: 1 }],
    ['an empty draw pile', 'p2', { choiceId: choice.id, draw: true }],
  ]) assertEqual(resolvePendingPlayerChoice(after, playerId, answer), after, `refused: ${label}`)
  const discarded = resolvePendingPlayerChoice(after, 'p2', { choiceId: choice.id, discardUid: keep.uid })
  assertEqual(who(discarded, 'p2').discard.at(-1).uid, keep.uid, "the ally discards from the ally's own hand")
  const fallen = combat([player({ hand: [hook] }), ally({ dead: true, hp: 0, hand: [keep] })], [enemy({ weak: 1 })])
  assertEqual(play(fallen, 'p1', hook, { playerId: 'p2' }), fallen, 'a dead player cannot be handed the choice')
  assertEqual(play(fallen, 'p1', hook, { playerId: 'nobody' }), fallen, 'nor an unknown one')
})

check("Heel Hook's discard is a card-effect discard: reactions and onDiscard Powers fire for its chooser", () => {
  const hook = card('slayer_heel_hook')
  const tactician = card('tactician')
  const state = combat([player({ hand: [hook] }), ally({ hand: [tactician], energy: 0, powers: [card('after_image')] })],
    [enemy({ weak: 1 })])
  const after = play(state, 'p1', hook, { playerId: 'p2' })
  const resolved = resolvePendingPlayerChoice(after, 'p2', { choiceId: after.pendingPlayerChoices[0].id, discardUid: tactician.uid })
  assertEqual(who(resolved, 'p2').energy, 2, "Tactician's discard reaction pays its owner")
  assertEqual(who(resolved, 'p2').block, 1, "After Image answers the ally's discard")
})

check('Heel Hook played twice (Double Tap) asks twice, and each answer stands alone', () => {
  const hook = card('slayer_heel_hook')
  const [first, second] = strikes(2)
  const state = combat([player({ hand: [hook, first, second] })], [enemy({ weak: 1 })])
  state.players[0].doubledAttacksThisTurn = 1
  const copied = play(state, 'p1', hook)
  assertEqual(copied.phase, 'copy')
  const both = playCardCopy(copied, 'p1', { enemyUid: 'e1', playerId: 'p1' })
  assertEqual(both.phase, 'player')
  assertEqual(hpOf(both), 26, 'two hits of 2')
  assertEqual(who(both).energy, 4, 'paid 1, gained 1 twice')
  assertEqual(both.pendingPlayerChoices.length, 2)
  const [a, b] = both.pendingPlayerChoices
  const once = resolvePendingPlayerChoice(both, 'p1', { choiceId: b.id, discardUid: second.uid })
  const twice = resolvePendingPlayerChoice(once, 'p1', { choiceId: a.id, discardUid: first.uid })
  assertEqual(twice.pendingPlayerChoices, undefined)
  assertEqual(who(twice).hand.length, 0)
})

check('the turn cannot end around an owed choice: Heel Hook (solo and hot-seat), Nightmare+ and Ritual Dagger+', () => {
  const hook = card('slayer_heel_hook')
  const solo = combat([player({ character: 'silent', hand: [hook, ...strikes(2)], draw: strikes(6) })], [enemy({ weak: 1 })])
  const asked = play(solo, 'p1', hook)
  assertEqual(beginEndTurnResolution(asked), asked, 'the drag-to-resolve end of turn waits for the answer')
  assertEqual(beginEndPlayerTurn(asked), asked, 'as does the ordered one')
  const answered = resolvePendingPlayerChoice(asked, 'p1', { choiceId: asked.pendingPlayerChoices[0].id, draw: true })
  assertEqual(who(answered).hand.length, 3, 'the draw lands in this Player Turn, before the discard step')
  const ended = beginEndTurnResolution(answered)
  assert(ended !== answered && ended.phase !== 'player', 'once answered, the turn ends')
  assertEqual(who(ended).hand.length, 0, 'and the drawn card is discarded with the rest')

  const hotSeat = combat([player({ hand: [hook] }), ally({ hand: strikes(1), draw: strikes(2) })], [enemy({ weak: 1 })])
  const allyOwes = play(hotSeat, 'p1', hook, { playerId: 'p2' })
  assertEqual(beginEndTurnResolution(allyOwes), allyOwes, "the caster cannot end the turn while the ally's choice is open")

  for (const pending of [
    { kind: 'reattach', playerId: 'p1', card: card('slayer_nightmare', true), fromUid: 'e9' },
    { kind: 'ritualDagger', playerId: 'p1', cardUid: 'dagger', revealed: 'slayer_smite' },
  ]) {
    const owed = combat([player({ hand: strikes(1) })])
    owed.pendingSlayerChoices = [pending]
    assertEqual(beginEndTurnResolution(owed), owed, `nor while a ${pending.kind} choice is owed`)
  }
})

check('Heel Hook still pays out when its hit kills the Weak target', () => {
  const hook = card('slayer_heel_hook')
  const state = combat([player({ hand: [hook], draw: strikes(1) })], [enemy({ hp: 2, weak: 1 }), enemy({ uid: 'e2', row: 0 })])
  const after = play(state, 'p1', hook)
  assert(after.enemies[0].dead, 'the target died')
  assertEqual(who(after).energy, 3)
  assertEqual(after.pendingPlayerChoices?.length, 1)
})

// ---------------------------------------------------------------- Armaments

const endTurnKeeping = (state, playerId, keep) => {
  const hand = who(state, playerId).hand
  return endPlayerTurn(state, { [playerId]: uids(hand.filter((held) => !keep.includes(held.uid))) })
}

check('Armaments lets you Retain up to 2 (3), paying 1 Block per card kept, and stops further card plays', () => {
  for (const [upgraded, limit] of [[false, 2], [true, 3]]) {
    const arm = card('slayer_armaments', upgraded)
    const hand = strikes(4)
    const state = combat([player({ hand: [arm, ...hand] })])
    const played = play(state, 'p1', arm)
    assert(who(played).cardPlayLocked, "you can't play additional cards this turn")
    assertEqual(play(played, 'p1', hand[0]), played)
    for (let kept = 0; kept <= limit; kept++) {
      const ended = endTurnKeeping(played, 'p1', uids(hand.slice(0, kept)))
      assertEqual(ended.phase, 'enemy', `retaining ${kept} ends the turn`)
      assertEqual(who(ended).block, kept, `${kept} Retained → ${kept} Block`)
      assertEqual(who(ended).hand.length, kept)
      assertEqual(who(ended).retainBlockAllowance, undefined, 'the allowance is spent by the discard step')
    }
    const greedy = endTurnKeeping(played, 'p1', uids(hand.slice(0, limit + 1)))
    assertEqual(greedy.phase, 'discard', `keeping ${limit + 1} is refused and the discard prompt stays open`)
  }
})

check('Armaments pays only for cards it Retained: innate Retain and other allowances do not count', () => {
  const arm = card('slayer_armaments')
  const reboot = card('slayer_reboot', true)
  const hand = strikes(3)
  const state = combat([player({ hand: [arm, reboot, ...hand], powers: [card('well_laid_plans')] })])
  const played = play(state, 'p1', arm)
  // Well-Laid Plans adds one more optional Retain at end of turn.
  const all = endTurnKeeping(played, 'p1', [reboot.uid, ...uids(hand)])
  assertEqual(who(all).hand.length, 4)
  assertEqual(who(all).block, 2, 'three optional Retains, but only Armaments\' two pay Block; Reboot+ keeps itself')
  const one = endTurnKeeping(played, 'p1', [reboot.uid, hand[0].uid])
  assertEqual(who(one).block, 1)
})

check("Armaments' Block icon takes Fasting's and Footwork's per-icon bonuses for each card it Retained", () => {
  const arm = card('slayer_armaments')
  const hand = strikes(2)
  const fasting = endTurnKeeping(play(combat([player({ hand: [arm, ...hand], powers: [card('slayer_fasting')] })]), 'p1', arm),
    'p1', uids(hand))
  assertEqual(who(fasting).block, 2 * (1 + 1), 'Fasting: 1 + 1 Block per Retained card')
  const both = combat([player({ hand: [arm, ...hand], powers: [card('slayer_fasting')] })])
  both.players[0].cardBlockBonus = 1
  assertEqual(who(endTurnKeeping(play(both, 'p1', arm), 'p1', uids(hand))).block, 2 * (1 + 1 + 1),
    'Footwork and Fasting stack on each icon')
})

check('Armaments Block is kept through the Enemy Turn', () => {
  const arm = card('slayer_armaments')
  const hand = strikes(2)
  const state = combat([player({ hand: [arm, ...hand], hp: 20 })], [enemy({ defId: 'jaw_worm' })])
  const played = play(state, 'p1', arm)
  const kept = endTurnKeeping(played, 'p1', uids(hand))
  const none = endTurnKeeping(played, 'p1', [])
  assertEqual(who(kept).block, 2)
  const damage = 20 - who(enemyTurn(none)).hp
  assert(damage > 0, 'the fixture enemy attacks')
  assertEqual(20 - who(enemyTurn(kept)).hp, Math.max(0, damage - 2), 'the 2 Block soaks the attack')
})

check('a manual Retain without Armaments (Well-Laid Plans) pays no Armaments Block', () => {
  const hand = strikes(2)
  const state = combat([player({ hand, powers: [card('well_laid_plans')] })])
  assertEqual(who(state).retainBlockAllowance, undefined, 'no Armaments, no Block allowance')
  const kept = endTurnKeeping(state, 'p1', [hand[0].uid])
  assertEqual(kept.phase, 'enemy', 'the Well-Laid Plans Retain is legal')
  assertEqual(who(kept).hand.length, 1, 'the card was Retained')
  assertEqual(who(kept).block, 0, 'but nothing paid Block')
})

// ---------------------------------------------------------------- Reboot

check('Reboot discards the hand, shuffles the discard pile into the draw pile, draws 5 and Exhausts', () => {
  for (const upgraded of [false, true]) {
    const reboot = card('slayer_reboot', upgraded)
    const hand = strikes(2)
    const discard = strikes(2)
    const draw = strikes(3)
    const state = combat([player({ hand: [reboot, ...hand], draw, discard })])
    const after = play(state, 'p1', reboot)
    const me = who(after)
    assertEqual(me.hand.length, 5, 'draw 5 cards')
    assertEqual(me.draw.length, 2, 'all 7 other cards were shuffled together; 2 remain')
    assertEqual(me.discard.length, 0)
    assertDeepEqual(uids(me.exhaust), [reboot.uid], 'Reboot Exhausts on both faces')
    assertEqual(me.shuffledThisCombat, true, 'it is a shuffle for Red Skull')
    assert(after.discardedThisTurn.includes('p1'), 'the hand was discarded by a card effect')
    assertDeepEqual(uids(who(play(state, 'p1', reboot)).hand), uids(me.hand), 'the shuffle is seeded and replayable')
  }
})

check('Reboot fires discard reactions and shuffle Powers, after the card finishes resolving', () => {
  const reboot = card('slayer_reboot')
  const tactician = card('tactician')
  const state = combat([player({
    hand: [reboot, tactician], energy: 0, draw: strikes(6),
    powers: [card('a_thousand_cuts')],
  })])
  const after = play(state, 'p1', reboot)
  assertEqual(who(after).energy, 2, 'Tactician pays 2 Energy')
  assertEqual(who(after).exhaust.some((held) => held.uid === tactician.uid), true, 'and Exhausts itself')
  assertEqual(who(after).hand.length, 5, 'Tactician was discarded before the shuffle, so it was not drawn')
  assertEqual(hpOf(after), 25, 'A Thousand Cuts answers the shuffle')
})

check('Reboot with nothing in hand, draw or discard pile shuffles nothing: no onShuffle, no Red Skull shuffle', () => {
  const reboot = card('slayer_reboot')
  const state = combat([player({ hand: [reboot], powers: [card('a_thousand_cuts')] })])
  const after = play(state, 'p1', reboot)
  assert(after !== state, 'Reboot is still playable')
  assertEqual(who(after).shuffledThisCombat, false, 'no shuffle is recorded')
  assertEqual(hpOf(after), 30, 'A Thousand Cuts does not answer a shuffle that never happened')
  assertEqual(after.rng.calls, state.rng.calls, 'and no shuffle is rolled')
  assertDeepEqual(uids(who(after).exhaust), [reboot.uid])
})

check('Reboot+ Retains in the discard step', () => {
  const reboot = card('slayer_reboot', true)
  const state = combat([player({ hand: [reboot, ...strikes(1)] })])
  const ended = endPlayerTurn(state)
  assert(who(ended).hand.some((held) => held.uid === reboot.uid), 'Reboot+ stays in hand')
  const base = card('slayer_reboot')
  const plain = endPlayerTurn(combat([player({ hand: [base] })]))
  assertEqual(who(plain).hand.length, 0, 'base Reboot is discarded')
})

// ---------------------------------------------------------------- Aggregate

check('Aggregate Evokes every Orb twice, each application choosing its own target', () => {
  for (const upgraded of [false, true]) {
    const aggregate = card('slayer_aggregate', upgraded)
    const state = combat([player({ character: 'defect', hand: [aggregate], orbs: ['lightning', 'frost', 'dark'] })],
      [enemy(), enemy({ uid: 'e2', row: 1 })])
    const after = play(state, 'p1', aggregate, {
      evokeSlots: [0, 1, 2],
      evokeEnemyUids: ['e1', 'e2', null, null, 'e2', 'e1'],
    })
    assert(after !== state, 'Aggregate resolves with one target per Lightning/Dark application')
    assertEqual(hpOf(after, 'e1'), 30 - 2 - 3, 'Lightning 2 then Dark 3 on e1')
    assertEqual(hpOf(after, 'e2'), 30 - 2 - 3, 'Lightning 2 then Dark 3 on e2')
    assertEqual(who(after).block, 2, 'Frost 1 Block twice')
    assertDeepEqual(who(after).orbs, [null, null, null], 'every Orb is removed once')
    assertEqual(who(after).exhaust.length, upgraded ? 0 : 1, upgraded ? 'Aggregate+ is discarded' : 'Aggregate Exhausts')
    assertEqual(play(state, 'p1', aggregate, { evokeSlots: [0, 1, 2], evokeEnemyUids: ['e1'] }), state,
      'a missing target is refused')
  }
})

check('Aggregate with no Orbs is still a legal card play', () => {
  const aggregate = card('slayer_aggregate')
  const state = combat([player({ character: 'defect', hand: [aggregate] })])
  const after = play(state, 'p1', aggregate, { evokeSlots: [], evokeEnemyUids: [] })
  assert(after !== state)
  assertEqual(hpOf(after), 30)
})

// ---------------------------------------------------------------- Biased Cognition

check('Biased Cognition, played for real: Orb Evoke effects get +3, End of turn effects get -1 (never below 0)', () => {
  const afterBias = (upgraded, orbs, extra = []) => {
    const bias = card('slayer_biased_cognition', upgraded)
    const state = combat([player({ character: 'defect', hand: [bias, ...extra], orbs, energy: 3 })])
    const played = play(state, 'p1', bias)
    assert(played !== state, 'Biased Cognition is playable')
    assert(played.log.includes("Ann's Orb end-of-turn effects get -1"), 'the log prints the -1 with its own sign')
    assert(played.log.includes("Ann's Orb Evoke effects get +3"), 'and the +3 with a plus')
    assert(!played.log.some((line) => line.includes('+-')), 'never "+-1"')
    assertEqual(who(played).energy, upgraded ? 2 : 1, `Biased Cognition${upgraded ? '+' : ''} costs ${upgraded ? 1 : 2}`)
    return played
  }
  for (const upgraded of [false, true]) {
    for (const [orb, check] of [
      ['lightning', (after) => assertEqual(hpOf(after), 30 - 2 * (2 + 3), 'Lightning Evoke 2 + 3, twice')],
      // Dark: 3 + 1 per Power in play (Biased Cognition itself) + 3.
      ['dark', (after) => assertEqual(hpOf(after), 30 - 2 * (3 + 1 + 3), 'Dark Evoke 3 + 1 Power + 3, twice')],
      ['frost', (after) => assertEqual(who(after).block, 2 * (1 + 3), 'Frost Evoke 1 + 3, twice')],
    ]) {
      const dual = card('dual_cast')
      const played = afterBias(upgraded, [orb, null, null], [dual])
      check(play(played, 'p1', dual, { evokeSlots: [0], evokeEnemyUids: orb === 'frost' ? [null, null] : ['e1', 'e1'] }))
    }
    const orbs = ['lightning', 'frost', 'dark']
    const plain = endPlayerTurn(combat([player({ character: 'defect', orbs })]), {})
    assertEqual(hpOf(plain), 29, 'control: without the card Lightning deals its printed 1')
    assertEqual(who(plain).block, 1, 'control: without the card Frost gives its printed 1')
    const ended = endPlayerTurn(afterBias(upgraded, orbs))
    assertEqual(ended.phase, 'enemy', 'a 0-damage Lightning Orb asks for no target')
    assertEqual(hpOf(ended), 30, 'Lightning end of turn deals 1 - 1 = 0')
    assertEqual(who(ended).block, 0, 'Frost end of turn gives 1 - 1 = 0 Block')
    assertDeepEqual(who(ended).orbs, orbs, 'end of turn removes no Orb; Dark has no end-of-turn effect to reduce')
  }
  // Two copies take the end-of-turn effects to -1; they stay at 0, never negative.
  const [first, second] = [card('slayer_biased_cognition', true), card('slayer_biased_cognition', true)]
  const twice = play(play(combat([player({ character: 'defect', hand: [first, second], orbs: ['lightning', 'frost', null] })]),
    'p1', first), 'p1', second)
  assertEqual(who(twice).orbEndTurnBonus, -2)
  const floored = endPlayerTurn(twice)
  assertEqual(hpOf(floored), 30, 'Lightning never heals its target')
  assertEqual(who(floored).block, 0, 'Frost never takes Block away')
  const defragged = endPlayerTurn(combat([player({
    character: 'defect', orbs: ['frost', null, null], orbEndTurnBonus: 0,
  })]))
  assertEqual(who(defragged).block, 1, 'Defragment +1 and Biased Cognition -1 cancel back to the printed 1')
})

check("a Lightning-only end-of-turn bonus raises Lightning's amount and never Frost's or Dark's", () => {
  const bonus = { orbEndTurnBonus: 0, lightningEndTurnBonus: 2 }
  assertEqual(orbEndTurnAmount(bonus, 'lightning'), 3)
  assertEqual(orbEndTurnAmount(bonus, 'frost'), 1)
  assertEqual(orbEndTurnAmount(bonus, 'dark'), 0)
  const ended = endPlayerTurn(combat([player({ character: 'defect', orbs: ['frost', null, null], lightningEndTurnBonus: 2 })]))
  assertEqual(who(ended).block, 1, 'Frost still gives its printed 1 Block at end of turn')
})

// ---------------------------------------------------------------- Hello World

check('Hello World Channels the Orb the round die is on at Start of Turn: 1-2 Lightning, 3-4 Frost, 5-6 Dark', () => {
  for (const upgraded of [false, true]) {
    const base = combat([player({ character: 'defect', powers: [card('slayer_hello_world', upgraded)], draw: strikes(10) })])
    for (const [die, orb] of [[1, 'lightning'], [2, 'lightning'], [3, 'frost'], [4, 'frost'], [5, 'dark'], [6, 'dark']]) {
      const started = startTurn(base, die)
      assertEqual(started.phase, 'player')
      assertDeepEqual(who(started).orbs, [orb, null, null], `die ${die} channels ${orb}`)
      assertEqual(who(started).hand.length, 5, 'after the Start-of-Turn draw')
    }
  }
  assertEqual(cardDef('slayer_hello_world').cost, 2)
})

check('Hello World with full slots Evokes the Orb its owner picks to make room', () => {
  const state = combat([player({
    character: 'defect', powers: [card('slayer_hello_world')], draw: strikes(10), orbs: ['frost', 'lightning', 'frost'],
  })])
  const prepared = startWithDie(state, 6)
  const [ability] = startTurnAbilities(prepared)
  assert(ability.evokeChoice, 'a full row asks which Orb to Evoke')
  const started = resolveStartPlayerTurn(prepared, [{
    id: ability.id, shivEnemyUids: [], evokeSlots: [1], evokeEnemyUids: ['e1'],
  }])
  assertDeepEqual(who(started).orbs, ['frost', 'dark', 'frost'], 'the Lightning was Evoked, then Dark channelled')
  assertEqual(hpOf(started), 28, 'its Evoke dealt 2')
})

check('Biased Cognition\'s +3 Evoke counts in the Start-of-Turn plan: a lethal first Evoke needs no second pick, and the submit that stops there is valid', () => {
  // Hello World with a second channel, so a full row has two Evokes to plan (the real card has one).
  const def = cardDef('slayer_hello_world')
  const printed = def.effects
  def.effects = [...printed, ...printed]
  try {
    const run = (orbEvokeBonus) => {
      const state = combat([player({
        character: 'defect', powers: [card('slayer_hello_world')], draw: strikes(10),
        orbs: ['lightning', 'lightning', 'lightning'], orbEvokeBonus,
      })], [enemy({ hp: 5 })])
      const prepared = startWithDie(state, 1)
      const choice = { id: startTurnAbilities(prepared)[0].id, shivEnemyUids: [], evokeSlots: [0], evokeEnemyUids: ['e1'] }
      return { ability: startTurnAbilities(prepared, undefined, [choice])[0], resolved: resolveStartPlayerTurn(prepared, [choice]), prepared }
    }
    const plain = run(0)
    assert(plain.ability.evokeChoice, 'control: a 2-damage Evoke leaves the second Evoke to pick')
    assertEqual(plain.resolved, plain.prepared, 'control: the submit that stops after one Evoke is refused')
    const biased = run(3)
    assertEqual(biased.ability.evokeChoice, undefined, 'the +3 makes the first Evoke lethal, so the plan asks for no second pick')
    assert(biased.resolved !== biased.prepared, 'and the submit that stops there is accepted')
    assertEqual(hpOf(biased.resolved), 0, 'it dealt 2 + 3')
  } finally { def.effects = printed }
})

// Mayhem plans as "a card that must be played" and parks every later ability's Evoke pick behind it. When
// its drawn card is unplayable (discarded at once) nothing resumes the order: the pick has to be asked then.
const unplayableTops = ['daze', 'regret', 'slayer_companion']
function mayhemHelloWorldState(top, { order = ['mayhem', 'slayer_hello_world'], orbs = ['frost', 'lightning', 'frost'] } = {}) {
  const topCard = card(top)
  const state = combat([player({
    character: 'defect', orbs, powers: order.map((id) => card(id)),
    draw: [...strikes(5), topCard, ...strikes(5)],
  })], [enemy(), enemy({ uid: 'e2', row: 1 })])
  return { state: startWithDie(state, 6), topCard }
}

check('Mayhem before Hello World with full orbs and an unplayable top card still asks for the Evoke pick', () => {
  for (const top of unplayableTops) {
    const { state, topCard } = mayhemHelloWorldState(top)
    const parked = resolveStartPlayerTurn(state, defaultStartTurnChoices(state))
    assert(parked !== state, `${top}: the order is not refused`)
    assertEqual(parked.phase, 'start', `${top}: Start of Turn waits for the pick`)
    assertEqual(parked.startTurnProgress?.forcedCard, undefined, `${top}: nothing is left to play`)
    assert(who(parked).discard.some((held) => held.uid === topCard.uid), `${top}: Mayhem discarded the unplayable card`)
    assertEqual(who(parked).hand.length, 5, `${top}: Mayhem's draw happened exactly once`)
    const [ability] = startTurnAbilities(parked)
    assert(ability.evokeChoice, `${top}: Hello World now asks which Orb to Evoke`)
    assertEqual(ability.deferredAfterForcedCard, undefined, `${top}: and nothing is parked behind a card any more`)
    const done = resolveStartPlayerTurn(parked, [{
      id: ability.id, shivEnemyUids: [], evokeSlots: [1], evokeEnemyUids: ['e2'],
    }])
    assertEqual(done.phase, 'player', `${top}: the picked Evoke finishes Start of Turn`)
    assertDeepEqual(who(done).orbs, ['frost', 'dark', 'frost'], `${top}: the Lightning was Evoked, then Dark channelled`)
    assertEqual(hpOf(done, 'e2'), 28, `${top}: the Evoke hit the enemy it was aimed at`)
    // Solo and hot-seat auto-advance with the default plan, which picks the first Orb.
    const defaulted = resolveStartPlayerTurn(parked, defaultStartTurnChoices(parked))
    assertEqual(defaulted.phase, 'player', `${top}: the default pick also finishes it`)
  }
})

check('Mayhem before Hello World still waits for a playable top card, then asks for the pick; the other order is unchanged', () => {
  const { state, topCard } = mayhemHelloWorldState('strike_ironclad')
  const forced = resolveStartPlayerTurn(state, defaultStartTurnChoices(state))
  assertEqual(forced.startTurnProgress?.forcedCard?.cardUid, topCard.uid, 'a playable card is still forced')
  const played = playCard(forced, 'p1', topCard.uid, { enemyUid: 'e1', playerId: 'p1' })
  assertEqual(played.phase, 'start')
  assert(startTurnAbilities(played)[0].evokeChoice, 'the pick is asked once the card was played')
  const first = mayhemHelloWorldState('daze', { order: ['slayer_hello_world', 'mayhem'] }).state
  assert(startTurnAbilities(first)[0].evokeChoice, 'Hello World first asks up front')
  assertEqual(resolveStartPlayerTurn(first, defaultStartTurnChoices(first)).phase, 'player')
})

check('a parked Evoke pick that targets nothing legal is still refused, and the refusal keeps the whole turn intact', () => {
  const { state } = mayhemHelloWorldState('daze')
  const parked = resolveStartPlayerTurn(state, defaultStartTurnChoices(state))
  const [ability] = startTurnAbilities(parked)
  for (const evoke of [{ evokeSlots: [], evokeEnemyUids: [] }, { evokeSlots: [7], evokeEnemyUids: ['e1'] },
    { evokeSlots: [1], evokeEnemyUids: ['ghost'] }]) {
    assertEqual(resolveStartPlayerTurn(parked, [{ id: ability.id, shivEnemyUids: [], ...evoke }]), parked,
      `${JSON.stringify(evoke)} changes nothing`)
  }
})

// ---------------------------------------------------------------- Master Reality

check('Master Reality returns your topmost discard once per Player Turn, never with an empty pile', () => {
  for (const upgraded of [false, true]) {
    const power = card('slayer_master_reality', upgraded)
    const [bottom, top] = strikes(2)
    const state = combat([player({ character: 'watcher', powers: [power], discard: [bottom, top], draw: strikes(10) })])
    const used = activatePower(state, 'p1', power.uid)
    assertDeepEqual(uids(who(used).hand), [top.uid])
    assertEqual(Boolean(who(used).hand[0].mayRetainThisTurn), upgraded, 'only the upgraded face offers its Retain')
    assertEqual(activatePower(used, 'p1', power.uid), used, 'once per turn')
    const empty = combat([player({ character: 'watcher', powers: [power] })])
    assertEqual(activatePower(empty, 'p1', power.uid), empty, 'nothing to return keeps the use for later')
    const nextTurn = startTurn(enemyTurn(endPlayerTurn(used)))
    const again = activatePower(nextTurn, 'p1', power.uid)
    assert(again !== nextTurn, 'usable again the next Player Turn')
  }
})

check('Master Reality cannot take back the end-of-turn discard: the ability closes with the Player Turn', () => {
  const power = card('slayer_master_reality')
  const state = combat([player({ character: 'watcher', powers: [power], hand: strikes(2) })])
  const ended = endPlayerTurn(state)
  assertEqual(ended.phase, 'enemy')
  assertEqual(who(ended).discard.length, 2)
  assertEqual(activatePower(ended, 'p1', power.uid), ended, 'no activation during the Enemy Turn')
})

check('Master Reality+ lets its owner choose, in the discard step, whether to Retain the returned card', () => {
  const power = card('slayer_master_reality', true)
  const top = card('strike_ironclad')
  const other = card('defend_ironclad')
  const state = combat([player({ character: 'watcher', powers: [power], discard: [top], hand: [other] })])
  const used = activatePower(state, 'p1', power.uid)
  const asked = beginEndPlayerTurn(used)
  assertEqual(asked.phase, 'discard', 'the Retain is a real choice, so the discard step asks')
  const kept = endPlayerTurn(asked, { p1: [other.uid] })
  assertDeepEqual(uids(who(kept).hand), [top.uid], 'Retained this turn')
  assertEqual(who(kept).hand[0].mayRetainThisTurn, undefined, 'the offer does not carry into the next turn')
  const tossed = endPlayerTurn(asked, { p1: [other.uid, top.uid] })
  assertEqual(who(tossed).hand.length, 0, 'or discarded like any card')
  assertEqual(endPlayerTurn(asked, { p1: [] }), asked, 'the offer covers only the returned card')
  const basePower = card('slayer_master_reality')
  const base = activatePower(combat([player({ character: 'watcher', powers: [basePower], discard: [top], hand: [other] })]),
    'p1', basePower.uid)
  const baseEnded = beginEndPlayerTurn(base)
  assertEqual(baseEnded.phase, 'enemy', 'the base face offers no Retain, so nothing is asked')
  assertEqual(who(baseEnded).hand.length, 0)
})

// ---------------------------------------------------------------- Creative AI

check('Creative AI removes one chosen Orb (no Evoke) to return the topmost discard, once per turn', () => {
  const power = card('slayer_creative_ai')
  const [bottom, top] = strikes(2)
  const state = combat([player({ character: 'defect', powers: [power], discard: [bottom, top], orbs: ['lightning', 'dark', null] })])
  const used = activatePower(state, 'p1', power.uid, { orbSlots: [1] })
  assertDeepEqual(who(used).orbs, ['lightning', null, null], 'the chosen Dark Orb is removed')
  assertEqual(hpOf(used), 30, 'removing is not Evoking')
  assertDeepEqual(uids(who(used).hand), [top.uid])
  assertEqual(activatePower(used, 'p1', power.uid, { orbSlots: [0] }), used, 'once per turn')
  for (const [label, slots] of [['no Orb chosen', []], ['an empty slot', [2]], ['two Orbs on the base face', [0, 1]],
    ['a duplicate', [0, 0]], ['a non-index', ['length']]]) {
    assertEqual(activatePower(state, 'p1', power.uid, { orbSlots: slots }), state, `refused: ${label}`)
  }
  const noOrbs = combat([player({ character: 'defect', powers: [power], discard: [top] })])
  assertEqual(activatePower(noOrbs, 'p1', power.uid, { orbSlots: [0] }), noOrbs, 'it does not work without Orbs (FAQ)')
  const noCards = combat([player({ character: 'defect', powers: [power], orbs: ['frost', null, null] })])
  assertEqual(activatePower(noCards, 'p1', power.uid, { orbSlots: [0] }), noCards, 'nor without a card to return')
})

check('Creative AI+ removes any number of Orbs to return that many topmost discards', () => {
  const power = card('slayer_creative_ai', true)
  const [a, b, c] = strikes(3)
  const state = combat([player({ character: 'defect', powers: [power], discard: [a, b, c], orbs: ['lightning', 'frost', 'dark'] })])
  const two = activatePower(state, 'p1', power.uid, { orbSlots: [0, 2] })
  assertDeepEqual(who(two).orbs, [null, 'frost', null])
  assertDeepEqual(uids(who(two).hand), [c.uid, b.uid], 'the top two, topmost first')
  assertDeepEqual(uids(who(two).discard), [a.uid])
  for (const orbSlots of [[], undefined]) {
    assertEqual(activatePower(state, 'p1', power.uid, orbSlots ? { orbSlots } : {}), state,
      'removing no Orb returns nothing and keeps the once-per-turn use')
  }
  const short = combat([player({ character: 'defect', powers: [power], discard: [a], orbs: ['lightning', 'frost', null] })])
  assertEqual(activatePower(short, 'p1', power.uid, { orbSlots: [0, 1] }), short,
    'removing more Orbs than there are cards to return is refused')
})

// ---------------------------------------------------------------- Magnetism

check('Magnetism asks its owner at Start of Turn and returns 0 or 1 (up to 2) topmost discards', () => {
  for (const [upgraded, upTo] of [[false, 1], [true, 2]]) {
    const [a, b, c] = strikes(3)
    const state = combat([player({ powers: [card('slayer_magnetism', upgraded)], draw: strikes(10), discard: [a, b, c] })])
    const paused = startTurn(state)
    assertEqual(paused.phase, 'start', 'the Start of Turn waits for the owner')
    const [choice] = paused.pendingPlayerChoices
    assertEqual(choice.kind, 'returnDiscardTop')
    assertEqual(choice.upTo, upTo)
    assertEqual(resolvePendingPlayerChoice(paused, 'p1', { choiceId: choice.id, count: upTo + 1 }), paused,
      `more than ${upTo} is refused`)
    assertEqual(resolvePendingPlayerChoice(paused, 'p1', { choiceId: choice.id, draw: true }), paused)
    const all = resolvePendingPlayerChoice(paused, 'p1', { choiceId: choice.id, count: upTo })
    assertEqual(all.phase, 'player', 'answering resumes the turn')
    assertDeepEqual(uids(who(all).hand).slice(5), uids([c, b].slice(0, upTo)), 'topmost first, after the drawn five')
    const none = resolvePendingPlayerChoice(paused, 'p1', { choiceId: choice.id, count: 0 })
    assertEqual(none.phase, 'player')
    assertEqual(who(none).hand.length, 5, '"may": the owner can return nothing')
  }
})

check('Magnetism with an empty discard pile asks nothing', () => {
  const state = combat([player({ powers: [card('slayer_magnetism')], draw: strikes(10) })])
  const started = startTurn(state)
  assertEqual(started.phase, 'player')
  assertEqual(started.pendingPlayerChoices, undefined)
})

check('Magnetism pauses the ordered Start of Turn: later abilities wait for its answer', () => {
  const top = card('defend_ironclad')
  const state = combat([player({
    character: 'silent', powers: [card('slayer_magnetism'), card('infinite_blades')], draw: strikes(10), discard: [top],
  })])
  const prepared = startWithDie(state, 1)
  const abilities = startTurnAbilities(prepared)
  assertEqual(abilities.length, 2)
  const paused = resolveStartPlayerTurn(prepared, abilities.map((ability) => ({ id: ability.id, shivEnemyUids: [] })))
  assertEqual(who(paused).shivs, 0, 'Infinite Blades has not resolved yet')
  assertEqual(resolveStartPlayerTurn(paused, defaultStartTurnChoices(paused)), paused,
    'the rest of the order cannot be forced past the open choice')
  const resumed = resolvePendingPlayerChoice(paused, 'p1', { choiceId: paused.pendingPlayerChoices[0].id, count: 1 })
  assertEqual(resumed.phase, 'player')
  assertEqual(who(resumed).shivs, 1, 'then the rest of the order resolves')
  assert(who(resumed).hand.some((held) => held.uid === top.uid))
})

// ---------------------------------------------------------------- Dead owners and mutation guards

const guardianBoss = (over = {}) => enemy({ uid: 'boss', defId: 'guardian_defensive', isBoss: true, hp: 80, maxHp: 80,
  abilityUsed: false, weak: 1, ...over })
const lastStand = (players, enemies) => createCombat(createRng(7), players, enemies, 'g2a-last-stand', [], 3, {}, true)

check('Last Stand: Sharp Hide kills the Heel Hook chooser before they answer; the choice lapses and nothing is wedged', () => {
  for (const owner of [{ hp: 1 }]) {
    const hook = card('slayer_heel_hook')
    const strike = card('strike_ironclad')
    const state = lastStand([player({ character: 'silent', hand: [hook], draw: strikes(2), ...owner }),
      ally({ character: 'ironclad', hand: [strike] })], [guardianBoss()])
    const after = play(state, 'p1', hook, { enemyUid: 'boss', playerId: 'p1' })
    assert(who(after).dead, `Sharp Hide's 1 damage kills the chooser at ${owner.hp} HP`)
    assertEqual(after.phase, 'player', 'Last Stand keeps the fight going for Bo')
    assertEqual(after.pendingPlayerChoices, undefined, "the dead chooser's choice lapsed")
    assert(!mandatoryChoicePending(after), 'nothing holds the table')
    const bo = playCard(after, 'p2', strike.uid, { enemyUid: 'boss', playerId: 'p2' })
    assert(bo !== after, 'Bo can still play')
    assertEqual(beginEndPlayerTurn(bo).phase === 'player', false, 'and the turn can end')
  }
})

check('a stranded choice in a loaded state blocks nothing and lapses deterministically', () => {
  const strike = card('strike_ironclad')
  const state = combat([player({ dead: true, hp: 0 }), ally({ hand: [strike] })])
  state.pendingPlayerChoices = [{ id: 4, playerId: 'p1', sourceLabel: 'Heel Hook', kind: 'drawOrDiscard' },
    { id: 5, playerId: 'ghost', sourceLabel: 'Heel Hook', kind: 'drawOrDiscard' }]
  assert(!mandatoryChoicePending(state), "a dead or departed owner's choice holds nobody")
  assertEqual(resolvePendingPlayerChoice(state, 'p1', { choiceId: 4, draw: true }), state, 'a dead owner can only decline')
  const lapsed = lapseStrandedPlayerChoices(state)
  assertEqual(lapsed.pendingPlayerChoices, undefined, 'both lapse')
  assertDeepEqual(lapseStrandedPlayerChoices(lapsed) === lapsed, true, 'and nothing more happens')
  const played = playCard(state, 'p2', strike.uid, { enemyUid: 'e1', playerId: 'p2' })
  assertEqual(played.pendingPlayerChoices, undefined, 'any settled action also sweeps them in the Player Turn')
})

check("a Magnetism choice whose owner died mid-pause lapses and the rest of the Start-of-Turn order resolves", () => {
  // Last Stand: the fight goes on after the owner falls.
  const state = lastStand([player({ powers: [card('slayer_magnetism')], draw: strikes(10), discard: [card('defend_ironclad')] }),
    ally({ character: 'silent', powers: [card('infinite_blades')], draw: strikes(10) })], [guardianBoss({ weak: 0 })])
  const prepared = startWithDie(state, 1)
  const abilities = startTurnAbilities(prepared)
  const order = [...abilities].sort((left) => left.playerId === 'p1' ? -1 : 1)
  const paused = resolveStartPlayerTurn(prepared, order.map((ability) => ({ id: ability.id, shivEnemyUids: [] })))
  assertEqual(paused.phase, 'start')
  assertEqual(who(paused, 'p2').shivs, 0, "Bo's Infinite Blades waits behind the open choice")
  paused.players[0].dead = true
  paused.players[0].hp = 0
  assert(!mandatoryChoicePending(paused))
  const resumed = lapseStrandedPlayerChoices(paused)
  assertEqual(resumed.phase, 'player', 'the order resumes')
  assertEqual(who(resumed, 'p2').shivs, 1, 'and its later ability resolves')
  const owned = defaultPendingPlayerChoice(paused, 'p1')
  assertEqual(owned.phase, 'player', 'the disconnect fallback lapses a dead owner the same way')
})

check('Heel Hook asks nobody who can neither draw nor discard', () => {
  for (const [label, over] of [['no cards anywhere', {}], ['an empty hand and a draw lock', { drawLocked: true, draw: strikes(2) }]]) {
    const hook = card('slayer_heel_hook')
    const state = combat([player({ hand: [hook] }), ally(over)], [enemy({ weak: 1 })])
    const after = play(state, 'p1', hook, { playerId: 'p2' })
    assert(after !== state)
    assertEqual(after.pendingPlayerChoices, undefined, `no choice for an ally with ${label}`)
  }
  const hook = card('slayer_heel_hook')
  const handOnly = play(combat([player({ hand: [hook] }), ally({ drawLocked: true, hand: strikes(1) })], [enemy({ weak: 1 })]),
    'p1', hook, { playerId: 'p2' })
  assertEqual(handOnly.pendingPlayerChoices?.length, 1, 'a hand to discard from is enough')
})

check('Creative AI+ refuses a forged duplicate Orb slot', () => {
  const power = card('slayer_creative_ai', true)
  const state = combat([player({ character: 'defect', powers: [power], discard: strikes(3), orbs: ['lightning', 'frost', null] })])
  assertEqual(activatePower(state, 'p1', power.uid, { orbSlots: [0, 0] }), state, 'one Orb cannot pay for two cards')
  assertEqual(activatePower(state, 'p1', power.uid, { orbSlots: [1, 1, 1] }), state)
  assert(activatePower(state, 'p1', power.uid, { orbSlots: [0, 1] }) !== state, 'two different Orbs can')
})

check('Biased Cognition: a 0-damage Lightning deals nothing and needs no aiming, even with several enemies', () => {
  const orbs = ['lightning', null, null]
  const two = [enemy({ abilityUsed: false }), enemy({ uid: 'e2', row: 1, abilityUsed: false })]
  const plain = beginEndTurnResolution(combat([player({ character: 'defect', orbs })], two))
  assert(plain.endTurnProgress?.interactive, 'control: a 1-damage Lightning waits to be aimed between two enemies')
  const biased = combat([player({ character: 'defect', orbs, orbEndTurnBonus: -1, powers: [card('slayer_biased_cognition')] })], two)
  const resolved = beginEndTurnResolution(biased)
  assertEqual(resolved.endTurnProgress, undefined, 'with Biased Cognition there is nothing to aim')
  assert(resolved.phase !== 'player', 'the turn moves on to the discard step')
  assertDeepEqual(resolved.enemies.map((foe) => [foe.hp, foe.block]), [[30, 0], [30, 0]], 'no enemy is touched')
  assert(!resolved.log.some((line) => /Lightning orb/.test(line)), 'and no Lightning damage is logged')
  assert(!resolved.presentationEvents.some((event) => event.sourceId === 'orb-end-turn'), 'nor animated')
  // Two copies take the amount to 1 - 2 = -1, which floors at 0: still nothing to aim.
  const stacked = combat([player({ character: 'defect', orbs, orbEndTurnBonus: -2,
    powers: [card('slayer_biased_cognition'), card('slayer_biased_cognition')] })], two)
  assertEqual(orbEndTurnAmount(who(stacked), 'lightning'), 0, 'the amount never goes below 0')
  assertEqual(beginEndTurnResolution(stacked).endTurnProgress, undefined, 'a floored Lightning is not aimed either')
})

check("Master Reality+'s card is kept outside Armaments' allowance and never pays Armaments' Block", () => {
  const power = card('slayer_master_reality', true)
  const arm = card('slayer_armaments')
  const returned = card('eruption')
  const hand = strikes(2)
  const state = combat([player({ character: 'watcher', powers: [power], hand: [arm, ...hand], discard: [returned] })])
  const ready = play(activatePower(state, 'p1', power.uid), 'p1', arm)
  const all = endPlayerTurn(beginEndPlayerTurn(ready), { p1: [] })
  assertEqual(all.phase, 'enemy', 'the returned card plus Armaments\' two Retains is a legal discard order')
  assertEqual(who(all).hand.length, 3)
  assertEqual(who(all).block, 2, "only Armaments' own two Retains pay Block")
  const one = endPlayerTurn(beginEndPlayerTurn(ready), { p1: [hand[0].uid, hand[1].uid] })
  assertEqual(who(one).hand.length, 1)
  assertEqual(who(one).block, 0, 'keeping only the returned card pays nothing')
})

// ---------------------------------------------------------------- Online (authoritative room server)

function onlineRoom(players, enemies = [enemy()]) {
  const room = createRoom(createStore(), { code: 'SLAYG2' })
  const a = joinRoom(room, { name: 'Ann', character: 'ironclad' })
  const b = joinRoom(room, { name: 'Bo', character: 'silent' })
  startRun(room, a.token, { seed: 31 })
  const ids = [a.playerId, b.playerId]
  room.run = {
    ...room.run, phase: 'combat',
    combat: createCombat(createRng(9), players.map((entry, index) => ({ ...entry, id: ids[index] })), enemies),
  }
  return { room, a, b }
}
const onlineSeat = (room, index) => room.seats[index]
const rejectionOf = (room, token, action) => {
  try { apply(room, token, action) } catch (error) { return error.message }
  return null
}
const rejects = (room, token, action) => rejectionOf(room, token, action) !== null
const seatPlayer = (room, seat) => room.run.combat.players.find((candidate) => candidate.id === seat.playerId)

check("online: Heel Hook's ally choice is the ally's alone, private, and does not block the caster", () => {
  const hook = card('slayer_heel_hook')
  const strike = card('strike_ironclad')
  const allyCard = card('neutralize')
  const { room, a, b } = onlineRoom([
    player({ hand: [hook, strike], draw: strikes(2) }),
    ally({ hand: [allyCard], draw: strikes(2) }),
  ], [enemy({ weak: 1, hp: 40, maxHp: 40 })])
  apply(room, a.token, { kind: 'playCard', cardUid: hook.uid, enemyUid: 'e1', playerId: b.playerId })
  const [choice] = room.run.combat.pendingPlayerChoices
  assertEqual(choice.playerId, b.playerId)
  const casterView = snapshotFor(room, a.token).run.combat
  assertEqual(casterView.pendingPlayerChoices[0].playerId, b.playerId, 'the table can see who owes the choice')
  assertEqual(casterView.players.find((entry) => entry.id === b.playerId).hand, null, "but not the ally's hand")
  assertThrows(() => apply(room, a.token, { kind: 'resolvePlayerChoice', choiceId: choice.id, draw: true }),
    'the caster cannot answer for the ally')
  apply(room, a.token, { kind: 'playCard', cardUid: strike.uid, enemyUid: 'e1', playerId: a.playerId })
  assertEqual(seatPlayer(room, a).hand.length, 0, 'the caster keeps playing during the simultaneous Player Turn')
  assertEqual(room.run.combat.pendingPlayerChoices.length, 1, "the ally's choice survives the caster's action")
  apply(room, a.token, { kind: 'endTurn' })
  assertEqual(room.run.combat.phase, 'player', 'the turn cannot end around an open choice')
  assertThrows(() => apply(room, b.token, { kind: 'endTurn' }), 'the ally must answer before ending the turn')
  assertThrows(() => apply(room, b.token, { kind: 'resolvePlayerChoice', choiceId: choice.id, discardUid: strike.uid }),
    "a card outside the ally's hand is refused")
  assertThrows(() => apply(room, b.token, { kind: 'resolvePlayerChoice', choiceId: choice.id, discardUid: [allyCard.uid] }),
    'a malformed id is refused')
  apply(room, b.token, { kind: 'resolvePlayerChoice', choiceId: choice.id, discardUid: allyCard.uid })
  assertEqual(seatPlayer(room, b).discard.at(-1).uid, allyCard.uid)
  assertEqual(room.run.combat.pendingPlayerChoices, undefined)
})

check('online: malformed choice answers are refused at the room, leaving the state and the choice untouched', () => {
  const hook = card('slayer_heel_hook')
  const keep = card('neutralize')
  const magnet = card('slayer_magnetism', true)
  const { room, b } = onlineRoom([player({ hand: [hook], draw: strikes(2) }), ally({ hand: [keep], draw: strikes(1) })],
    [enemy({ weak: 1 })])
  apply(room, onlineSeat(room, 0).token, { kind: 'playCard', cardUid: hook.uid, enemyUid: 'e1', playerId: b.playerId })
  const refuse = (seat, answer, pattern, label) => {
    const before = JSON.stringify(room.run.combat)
    assertThrows(() => apply(room, seat.token, { kind: 'resolvePlayerChoice', ...answer }), `refused: ${label}`)
    let message = ''
    try { apply(room, seat.token, { kind: 'resolvePlayerChoice', ...answer }) } catch (error) { message = error.message }
    assert(pattern.test(message), `${label} is refused by the room's own check, not by luck: ${message}`)
    assertEqual(JSON.stringify(room.run.combat), before, `${label} leaves the combat untouched`)
    assertEqual(room.run.combat.pendingPlayerChoices?.length, 1, `${label} leaves the choice pending`)
  }
  const id = room.run.combat.pendingPlayerChoices[0].id
  for (const [draw, label] of [['true', 'draw as a string'], [1, 'draw as a number'], [{}, 'draw as an object']]) {
    refuse(b, { choiceId: id, draw }, /Draw must be true or false/, label)
  }
  for (const [discardUid, label] of [[7, 'discardUid as a number'], [[keep.uid], 'discardUid as a list'], [{ uid: keep.uid }, 'discardUid as an object']]) {
    refuse(b, { choiceId: id, discardUid }, /Discard must be a card id/, label)
  }
  // Every key outside the answer's own fields is refused, even beside an otherwise legal draw.
  for (const key of ['cardUid', 'enemyUid', 'replace', 'sneaky', 'constructor', 'prototype', '__proto__']) {
    refuse(b, JSON.parse(JSON.stringify({ choiceId: id, draw: true }).replace('{', `{"${key}":1,`)),
      /carries only/, `an extra "${key}" key`)
  }
  refuse(b, { choiceId: 'x', draw: true }, /No card choice is pending/, 'a non-integer choice id')
  refuse(b, { choiceId: id, draw: true, discardUid: keep.uid }, /no longer legal/, 'draw and discard together')

  // Magnetism's count: whole, in range, safe.
  room.run.combat = createCombat(createRng(9), [
    { ...player({ powers: [magnet], draw: strikes(10), discard: strikes(3) }), id: onlineSeat(room, 0).playerId },
    { ...ally({ draw: strikes(10) }), id: b.playerId },
  ], [enemy()])
  room.run.combat = startTurn(room.run.combat)
  const owner = onlineSeat(room, 0)
  const countId = room.run.combat.pendingPlayerChoices[0].id
  for (const [count, pattern, label] of [
    [1.5, /whole number/, 'a fractional count'], ['2', /whole number/, 'a string count'],
    [2 ** 60, /whole number/, 'an unsafe huge count'], [Infinity, /whole number/, 'an infinite count'],
    [-1, /no longer legal/, 'a negative count'], [3, /no longer legal/, 'more than up to two'],
    [1e9, /no longer legal/, 'a huge count'],
  ]) refuse(owner, { choiceId: countId, count }, pattern, label)
  apply(room, owner.token, { kind: 'resolvePlayerChoice', choiceId: countId, count: 2 })
  assertEqual(room.run.combat.pendingPlayerChoices, undefined, 'a well-formed answer still goes through')
})

check('online, Last Stand: the dead Heel Hook chooser never wedges the other seat', () => {
  const room = createRoom(createStore(), { code: 'SLAYLS' })
  const a = joinRoom(room, { name: 'Ann', character: 'silent' })
  const b = joinRoom(room, { name: 'Bo', character: 'ironclad' })
  startRun(room, a.token, { seed: 31 })
  const hook = card('slayer_heel_hook')
  const strike = card('strike_ironclad')
  room.run = { ...room.run, phase: 'combat', combat: createCombat(createRng(9), [
    { ...player({ character: 'silent', hand: [hook], draw: strikes(2), hp: 1 }), id: a.playerId },
    { ...ally({ hand: [strike, card('strike_ironclad')] }), id: b.playerId },
  ], [guardianBoss()], 'g2a-online-last-stand', [], 3, {}, true) }
  apply(room, a.token, { kind: 'playCard', cardUid: hook.uid, enemyUid: 'boss', playerId: a.playerId })
  assert(seatPlayer(room, a).dead, 'Sharp Hide killed Ann')
  assertEqual(room.run.combat.pendingPlayerChoices, undefined, "Ann's choice lapsed")
  apply(room, b.token, { kind: 'playCard', cardUid: strike.uid, enemyUid: 'boss', playerId: b.playerId })
  apply(room, b.token, { kind: 'endTurn' })
  assert(room.run.combat.phase !== 'player', 'Bo ends the turn')
  // A state saved with the stranded choice already in it is swept by the room as well.
  room.run.combat = createCombat(createRng(9), [
    { ...player({ dead: true, hp: 0 }), id: a.playerId }, { ...ally({ hand: [strike] }), id: b.playerId },
  ], [enemy()], 'g2a-loaded', [], 3, {}, true)
  room.run.combat.pendingPlayerChoices = [{ id: 1, playerId: a.playerId, sourceLabel: 'Heel Hook', kind: 'drawOrDiscard' }]
  apply(room, b.token, { kind: 'playCard', cardUid: strike.uid, enemyUid: 'e1', playerId: b.playerId })
  assertEqual(room.run.combat.pendingPlayerChoices, undefined)
})

check('online: a dead owner\'s Magnetism pause is lapsed by the room and Start of Turn resumes', () => {
  const room = createRoom(createStore(), { code: 'SLAYMG' })
  const a = joinRoom(room, { name: 'Ann', character: 'ironclad' })
  const b = joinRoom(room, { name: 'Bo', character: 'silent' })
  startRun(room, a.token, { seed: 31 })
  room.run = { ...room.run, phase: 'combat', combat: startTurn(createCombat(createRng(9), [
    { ...player({ powers: [card('slayer_magnetism')], draw: strikes(10), discard: [card('defend_ironclad')] }), id: a.playerId },
    { ...ally({ draw: strikes(10) }), id: b.playerId },
  ], [guardianBoss({ weak: 0 })], 'g2a-online-magnet', [], 3, {}, true)) }
  assertEqual(room.run.combat.pendingPlayerChoices?.length, 1, 'Ann owes the Magnetism choice')
  seatPlayer(room, a).dead = true
  seatPlayer(room, a).hp = 0
  // Any room settle pass (here Bo dropping off) sweeps the dead owner's choice, whatever Ann's connection.
  markDisconnected(room, b.token)
  assertEqual(room.run.combat.pendingPlayerChoices, undefined, "the dead owner's choice lapsed")
  assertEqual(room.run.combat.phase, 'player', 'and Start of Turn resumed')
})

check("online: Creative AI+'s duplicate slot guard is the server's only defence and holds", () => {
  const power = card('slayer_creative_ai', true)
  const { room, a } = onlineRoom([player({ character: 'defect', powers: [power], discard: strikes(3), orbs: ['frost', null, null] }), ally()])
  const before = JSON.stringify(room.run.combat)
  assertThrows(() => apply(room, a.token, { kind: 'activatePower', powerUid: power.uid, orbSlots: [0, 0], preflight: true }),
    'one Frost Orb cannot be removed twice')
  assertEqual(JSON.stringify(room.run.combat), before)
})

check("online: a seat with a revealed Power (Gem Finder) can still answer a choice another seat's Heel Hook hands it", () => {
  const finder = card('guardian_gem_finder')
  const hook = card('slayer_heel_hook')
  const { room, a, b } = onlineRoom([
    player({ character: 'guardian', powers: [finder], draw: strikes(4) }),
    ally({ hand: [hook], draw: strikes(2) }),
  ], [enemy({ weak: 1 })])
  apply(room, a.token, { kind: 'previewPowerChoice', powerUid: finder.uid })
  assert(room.powerPreviews?.[a.playerId], 'Ann has Gem Finder\'s private reveal open')
  apply(room, b.token, { kind: 'playCard', cardUid: hook.uid, enemyUid: 'e1', playerId: a.playerId })
  const [choice] = room.run.combat.pendingPlayerChoices
  assertEqual(choice.playerId, a.playerId, 'now Ann owes a Heel Hook choice')
  assertThrows(() => apply(room, a.token, { kind: 'playCard', cardUid: 'nothing', enemyUid: 'e1', playerId: a.playerId }),
    'other actions still wait for the revealed Power')
  apply(room, a.token, { kind: 'resolvePlayerChoice', choiceId: choice.id, draw: true })
  assertEqual(room.run.combat.pendingPlayerChoices, undefined, 'the reveal does not deadlock the answer')
})

// An owed card-given choice is answerable whatever other window its owner has open: the window waits,
// then resumes exactly as it was (see docs/slayer-pack-notes-discard-and-orbs.md).
const openCopyWindow = (room, seat, strike) => {
  const doubleTap = room.run.combat.players.find((entry) => entry.id === seat.playerId).hand
    .find((held) => held.defId === 'double_tap')
  apply(room, seat.token, { kind: 'playCard', cardUid: doubleTap.uid })
  apply(room, seat.token, { kind: 'playCard', cardUid: strike.uid, enemyUid: 'e2', playerId: seat.playerId })
  assertEqual(room.run.combat.phase, 'copy', 'a Double Tap copy window is open')
  return room.run.combat.pendingCardCopy
}
const copyOf = (copy, enemyUid = 'e2') => ({
  kind: 'playCardCopy', cardUid: copy.card.uid, copyId: copy.id, enemyUid, energySpent: 0,
})

check("online: Heel Hook's choice on its own caster is answerable inside the Double Tap copy window, then the copy runs", () => {
  const doubleTap = card('double_tap')
  const hook = card('slayer_heel_hook')
  const { room, a } = onlineRoom([
    player({ hand: [doubleTap, hook], draw: strikes(6) }), ally(),
  ], [enemy({ uid: 'e2', weak: 1, hp: 40, maxHp: 40 })])
  apply(room, a.token, { kind: 'playCard', cardUid: doubleTap.uid })
  apply(room, a.token, { kind: 'playCard', cardUid: hook.uid, enemyUid: 'e2', playerId: a.playerId })
  const copy = room.run.combat.pendingCardCopy
  const [choice] = room.run.combat.pendingPlayerChoices
  assertEqual(room.run.combat.phase, 'copy')
  assertEqual(choice.playerId, a.playerId, 'Ann owes her own Heel Hook choice')
  assertEqual(rejectionOf(room, a.token, copyOf(copy)), 'Finish the Heel Hook choice', 'the copy waits for the choice')
  const handBefore = seatPlayer(room, a).hand.length
  apply(room, a.token, { kind: 'resolvePlayerChoice', choiceId: choice.id, draw: true })
  assertEqual(seatPlayer(room, a).hand.length, handBefore + 1, 'the answer drew a card')
  assertEqual(room.run.combat.pendingPlayerChoices, undefined)
  assertEqual(room.run.combat.pendingCardCopy?.id, copy.id, 'the copy window is intact')
  apply(room, a.token, copyOf(copy))
  assertEqual(room.run.combat.phase, 'player', 'the copy played')
  const [second] = room.run.combat.pendingPlayerChoices
  assertEqual(second.playerId, a.playerId, 'and it owes its own, separate choice')
  assert(second.id !== choice.id, 'with a fresh id')
  apply(room, a.token, { kind: 'resolvePlayerChoice', choiceId: second.id })
  assertEqual(room.run.combat.pendingPlayerChoices, undefined)
})

check("online: a teammate's Heel Hook choice reaches an owner with a copy window or Distilled Chaos pick open, and neither is lost", () => {
  const doubleTap = card('double_tap')
  const strike = card('strike_ironclad')
  const hook = card('slayer_heel_hook')
  const copyRoom = onlineRoom([
    player({ hand: [doubleTap, strike], draw: strikes(6) }), ally({ hand: [hook] }),
  ], [enemy({ uid: 'e2', weak: 1, hp: 40, maxHp: 40 })])
  const copy = openCopyWindow(copyRoom.room, copyRoom.a, strike)
  apply(copyRoom.room, copyRoom.b.token, { kind: 'playCard', cardUid: hook.uid, enemyUid: 'e2', playerId: copyRoom.a.playerId })
  const [choice] = copyRoom.room.run.combat.pendingPlayerChoices
  assertEqual(choice.playerId, copyRoom.a.playerId)
  assertEqual(rejectionOf(copyRoom.room, copyRoom.a.token, copyOf(copy)), 'Finish the Heel Hook choice')
  apply(copyRoom.room, copyRoom.a.token, { kind: 'resolvePlayerChoice', choiceId: choice.id, draw: true })
  assertEqual(copyRoom.room.run.combat.pendingCardCopy?.id, copy.id, 'her copy window is intact')
  apply(copyRoom.room, copyRoom.a.token, copyOf(copy))
  assertEqual(copyRoom.room.run.combat.phase, 'player')

  const picks = strikes(3)
  const distilledRoom = onlineRoom([
    player({ draw: picks, potions: ['distilled_chaos'] }), ally({ hand: [hook] }),
  ], [enemy({ weak: 1, hp: 40, maxHp: 40 })])
  const { room, a, b } = distilledRoom
  apply(room, a.token, { kind: 'usePotion', potionId: 'distilled_chaos', preflight: true })
  apply(room, b.token, { kind: 'playCard', cardUid: hook.uid, enemyUid: 'e1', playerId: a.playerId })
  const [owed] = room.run.combat.pendingPlayerChoices
  assertEqual(owed.playerId, a.playerId)
  assert(rejects(room, a.token, { kind: 'chooseDistilledCard', cardUid: picks[0].uid }), 'the pick waits for the choice')
  apply(room, a.token, { kind: 'resolvePlayerChoice', choiceId: owed.id, draw: false, discardUid: undefined })
  assertDeepEqual(room.run.combat.pendingDistilled.cards.map((held) => held.uid), picks.map((held) => held.uid),
    'the same Distilled Chaos cards are still offered')
  for (const held of picks) {
    assert(!JSON.stringify(snapshotFor(room, b.token)).includes(held.uid), 'a teammate never sees the picks')
  }
  assert(apply(room, a.token, { kind: 'chooseDistilledCard', cardUid: picks[0].uid }).changed, 'and the pick resumes')
})

check("online: a disconnected seat's Retain choice never stalls the discard phase; a connected seat's still waits", () => {
  const arm = card('slayer_armaments')
  const hand = strikes(2)
  const lone = onlineRoom([player({ hand: strikes(1) }), ally({ hand: [arm, ...hand] })])
  apply(lone.room, lone.b.token, { kind: 'playCard', cardUid: arm.uid, enemyUid: 'e1', playerId: lone.b.playerId })
  markDisconnected(lone.room, lone.b.token)
  apply(lone.room, lone.a.token, { kind: 'endTurn' })
  assertEqual(lone.room.run.combat.phase, 'enemy', 'nobody connected owes a Retain choice, so the turn ended')
  assertEqual(seatPlayer(lone.room, lone.b).hand.length, 0, 'the absent seat discarded by default')
  assertEqual(seatPlayer(lone.room, lone.b).block, 0, 'and Retained nothing, so Armaments paid no Block')
  joinRoom(lone.room, { token: lone.b.token })
  assertEqual(lone.room.run.combat.phase, 'enemy', 'coming back changes nothing')
  assertEqual(snapshotFor(lone.room, lone.b.token).discardOrder, undefined)

  const both = onlineRoom([player({ hand: [card('slayer_armaments'), ...strikes(2)] }), ally({ hand: [arm, ...hand] })])
  const [annArm, bo] = [seatPlayer(both.room, both.a).hand[0], both.b]
  apply(both.room, both.a.token, { kind: 'playCard', cardUid: annArm.uid, enemyUid: 'e1', playerId: both.a.playerId })
  apply(both.room, bo.token, { kind: 'playCard', cardUid: arm.uid, enemyUid: 'e1', playerId: bo.playerId })
  markDisconnected(both.room, bo.token)
  apply(both.room, both.a.token, { kind: 'endTurn' })
  assertEqual(both.room.run.combat.phase, 'discard', 'the connected Retain choice still holds the discard phase')
  apply(both.room, both.a.token, { kind: 'discardHand', discardOrder: [] })
  assertEqual(both.room.run.combat.phase, 'enemy', 'and answering it ends the turn')
  assertEqual(seatPlayer(both.room, bo).hand.length, 0)
})

// Both seats play Armaments and end the turn: the room is in the discard phase owing two Retain choices.
function bothOweRetain() {
  const armAnn = card('slayer_armaments')
  const armBo = card('slayer_armaments')
  const setup = onlineRoom([player({ hand: [armAnn, ...strikes(2)] }), ally({ hand: [armBo, ...strikes(2)] })])
  apply(setup.room, setup.a.token, { kind: 'playCard', cardUid: armAnn.uid, enemyUid: 'e1', playerId: setup.a.playerId })
  apply(setup.room, setup.b.token, { kind: 'playCard', cardUid: armBo.uid, enemyUid: 'e1', playerId: setup.b.playerId })
  apply(setup.room, setup.a.token, { kind: 'endTurn' })
  apply(setup.room, setup.b.token, { kind: 'endTurn' })
  assertEqual(setup.room.run.combat.phase, 'discard', 'both Retain choices hold the discard phase')
  return setup
}

check("online: the last connected Retain owner disconnecting after the other one answered ends the discard phase", () => {
  const { room, a, b } = bothOweRetain()
  apply(room, a.token, { kind: 'discardHand', discardOrder: [] })
  assertEqual(room.run.combat.phase, 'discard', 'Bo still owes a Retain choice')
  markDisconnected(room, b.token)
  assertEqual(room.run.combat.phase, 'enemy', 'nobody connected owes anything now, so the turn moved on')
  assertEqual(seatPlayer(room, a).hand.length, 2, 'Ann kept the cards she Retained')
  // Nothing from the finished discard step lingers for a reconnecting or watching seat.
  for (const seat of [a, b]) {
    const view = snapshotFor(room, seat.token)
    assertDeepEqual(view.endTurnDecided, [], 'a stale discard decision survived into the enemy phase')
    assertEqual(view.discardOrder, undefined, 'a stale discard order survived into the enemy phase')
  }
  joinRoom(room, { token: b.token })
  assertEqual(room.run.combat.phase, 'enemy', 'coming back changes nothing')
})

check('online: the discard phase never advances while every seat is disconnected, and resumes for the first one back', () => {
  const { room, a, b } = bothOweRetain()
  markDisconnected(room, a.token)
  assertEqual(room.run.combat.phase, 'discard', 'Bo is still connected and owes a Retain choice')
  markDisconnected(room, b.token)
  assertEqual(room.run.combat.phase, 'discard', 'with the whole table away nobody has agreed to anything')
  joinRoom(room, { token: a.token })
  assertEqual(room.run.combat.phase, 'discard', 'Ann is back and still owes her own Retain choice')
  apply(room, a.token, { kind: 'discardHand', discardOrder: [] })
  assertEqual(room.run.combat.phase, 'enemy', 'her answer ends the turn: Bo is absent')
})

check("online: another seat's card preview survives while one seat owes a card choice", () => {
  const hook = card('slayer_heel_hook')
  const seek = card('seek')
  const { room, a, b } = onlineRoom([
    player({ hand: [seek], draw: strikes(3) }),
    ally({ hand: [hook], draw: strikes(2) }),
  ], [enemy({ weak: 1 })])
  apply(room, a.token, { kind: 'previewCard', cardUid: seek.uid, enemyUid: null })
  assert(snapshotFor(room, a.token).cardPreview, 'Ann reveals her draw pile for Seek')
  apply(room, b.token, { kind: 'playCard', cardUid: hook.uid, enemyUid: 'e1', playerId: a.playerId })
  assertEqual(room.run.combat.pendingPlayerChoices?.[0].playerId, a.playerId, 'now Ann owes a Heel Hook choice')
  assert(room.cardPreviews?.[a.playerId], "Ann's open reveal is still valid")
  apply(room, a.token, { kind: 'resolvePlayerChoice', choiceId: room.run.combat.pendingPlayerChoices[0].id })
  const target = seatPlayer(room, a).draw[0].uid
  apply(room, a.token, { kind: 'playCard', cardUid: seek.uid, enemyUid: null, playerId: a.playerId, searchDrawUids: [target] })
  assert(seatPlayer(room, a).hand.some((held) => held.uid === target), 'and her Seek resolves afterwards')
})

check('online: a disconnected chosen player declines, so the table is never stuck', () => {
  const hook = card('slayer_heel_hook')
  const { room, a, b } = onlineRoom([player({ hand: [hook] }), ally({ hand: [card('neutralize')], draw: strikes(1) })],
    [enemy({ weak: 1 })])
  markDisconnected(room, b.token)
  apply(room, a.token, { kind: 'playCard', cardUid: hook.uid, enemyUid: 'e1', playerId: b.playerId })
  assertEqual(room.run.combat.pendingPlayerChoices, undefined, 'the absent seat declined')
  assertEqual(seatPlayer(room, b).hand.length, 1, 'with no draw and no discard')
})

check('online: Dual Wield, Rebound and Wheel Kick reach the chosen seat; a dead seat is refused', () => {
  const wield = card('slayer_dual_wield')
  const rebound = card('slayer_rebound')
  const kick = card('slayer_wheel_kick')
  const [returned, rebounded] = [card('backflip'), card('neutralize')]
  const { room, a, b } = onlineRoom([
    player({ hand: [wield, rebound, kick], energy: 3 }),
    ally({ discard: [rebounded, returned], draw: strikes(3) }),
  ])
  apply(room, a.token, { kind: 'playCard', cardUid: wield.uid, enemyUid: null, playerId: b.playerId })
  assertDeepEqual(uids(seatPlayer(room, b).hand), [returned.uid])
  apply(room, a.token, { kind: 'playCard', cardUid: rebound.uid, enemyUid: 'e1', playerId: b.playerId })
  const allyView = snapshotFor(room, b.token).run.combat.players.find((entry) => entry.id === b.playerId)
  assert(allyView.draw.some((held) => held.uid === rebounded.uid), 'the ally sees the card back in their draw pile')
  assertEqual(snapshotFor(room, a.token).run.combat.players.find((entry) => entry.id === b.playerId).draw, null,
    "the draw pile's order stays private")
  assertEqual(seatPlayer(room, b).draw[0].uid, rebounded.uid, 'authoritatively it is on top')
  seatPlayer(room, b).dead = true
  assertThrows(() => apply(room, a.token, { kind: 'playCard', cardUid: kick.uid, enemyUid: 'e1', playerId: b.playerId, preflight: true }),
    'a dead player cannot be chosen online')
})

check('online: Creative AI validates its Orb choice at the server', () => {
  const power = card('slayer_creative_ai', true)
  const [x, y] = strikes(2)
  const { room, a } = onlineRoom([player({ character: 'defect', powers: [power], discard: [x, y], orbs: ['frost', 'dark', null] }), ally()])
  assertThrows(() => apply(room, a.token, { kind: 'activatePower', powerUid: power.uid, orbSlots: ['length'], preflight: true }),
    'a non-index slot is refused')
  apply(room, a.token, { kind: 'activatePower', powerUid: power.uid, orbSlots: [1, 0] })
  assertDeepEqual(seatPlayer(room, a).orbs, [null, null, null])
  assertDeepEqual(uids(seatPlayer(room, a).hand), [y.uid, x.uid])
})

check('online: Magnetism pauses Start of Turn for its owner only, and an absent owner declines', () => {
  const top = card('defend_ironclad')
  const { room, a, b } = onlineRoom([
    player({ powers: [card('slayer_magnetism', true)], draw: strikes(10), discard: [top] }),
    ally({ draw: strikes(10) }),
  ])
  room.run.combat = startTurn(room.run.combat)
  const [choice] = room.run.combat.pendingPlayerChoices
  assertThrows(() => apply(room, b.token, { kind: 'resolvePlayerChoice', choiceId: choice.id, count: 1 }),
    'another seat cannot answer')
  assertThrows(() => apply(room, a.token, { kind: 'resolvePlayerChoice', choiceId: choice.id, count: 'one' }),
    'a malformed count is refused')
  apply(room, a.token, { kind: 'resolvePlayerChoice', choiceId: choice.id, count: 1 })
  assertEqual(room.run.combat.phase, 'player')
  assert(seatPlayer(room, a).hand.some((held) => held.uid === top.uid))

  const second = onlineRoom([player({ powers: [card('slayer_magnetism')], draw: strikes(10), discard: [card('strike_ironclad')] }), ally({ draw: strikes(10) })])
  second.room.run.combat = startTurn(second.room.run.combat)
  assertEqual(second.room.run.combat.pendingPlayerChoices.length, 1)
  markDisconnected(second.room, second.a.token)
  assertEqual(second.room.run.combat.pendingPlayerChoices, undefined, 'the absent owner declined')
  assertEqual(second.room.run.combat.phase, 'player', 'and the turn went on')
})

// Mayhem before Hello World with an unplayable top card, at the authoritative room server.
function mayhemHelloWorldRoom(top = 'daze') {
  const { room, a, b } = onlineRoom([
    player({ character: 'defect', orbs: ['frost', 'lightning', 'frost'], powers: [card('mayhem'), card('slayer_hello_world')],
      draw: [...strikes(5), card(top), ...strikes(5)] }),
    ally({ draw: strikes(10) }),
  ], [enemy(), enemy({ uid: 'e2', row: 1 })])
  room.run.combat = startWithDie(room.run.combat, 6)
  return { room, a, b }
}
const parkedEvokeChoice = (room, token) => {
  const [ability] = snapshotFor(room, token).startTurnAbilities
  return { id: ability.id, shivEnemyUids: [], evokeSlots: [1], evokeEnemyUids: ['e2'] }
}

check("online: Mayhem's unplayable card never leaves Hello World's Evoke pick unasked: the owner answers it", () => {
  for (const top of unplayableTops) {
    const { room, a } = mayhemHelloWorldRoom(top)
    const choices = snapshotFor(room, a.token).startTurnAbilities
      .map((ability) => ({ id: ability.id, shivEnemyUids: [], evokeSlots: [], evokeEnemyUids: [] }))
    assert(apply(room, a.token, { kind: 'resolveStartTurn', choices }).changed, `${top}: the order is accepted`)
    assertEqual(room.run.combat.phase, 'start', `${top}: the pick is still to make`)
    const view = snapshotFor(room, a.token)
    assert(view.startTurnAbilities[0].evokeChoice, `${top}: the owner is offered the Evoke`)
    assertDeepEqual(view.startTurnRequired, [a.playerId], `${top}: and only the owner owes it`)
    apply(room, a.token, { kind: 'resolveStartTurn', choices: [parkedEvokeChoice(room, a.token)] })
    assertEqual(room.run.combat.phase, 'player', `${top}: the pick finishes Start of Turn`)
    assertDeepEqual(seatPlayer(room, a).orbs, ['frost', 'dark', 'frost'], top)
  }
})

check('online: a disconnected owner of Mayhem + Hello World with an unplayable top card is defaulted, before or after the pick opens', () => {
  const before = mayhemHelloWorldRoom()
  markDisconnected(before.room, before.a.token)
  assertEqual(before.room.run.combat.phase, 'player', 'the absent owner\'s pick was defaulted')
  assertEqual(seatPlayer(before.room, before.a).orbs[0], 'dark', 'the first Orb was Evoked and Dark channelled')

  const after = mayhemHelloWorldRoom()
  const choices = snapshotFor(after.room, after.a.token).startTurnAbilities
    .map((ability) => ({ id: ability.id, shivEnemyUids: [], evokeSlots: [], evokeEnemyUids: [] }))
  apply(after.room, after.a.token, { kind: 'resolveStartTurn', choices })
  assertEqual(after.room.run.combat.phase, 'start')
  markDisconnected(after.room, after.a.token)
  assertEqual(after.room.run.combat.phase, 'player', 'leaving at the open pick defaults it too')
})

report('verify-slayer-discard-and-orbs')
