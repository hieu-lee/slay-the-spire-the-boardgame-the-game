// The Slayer Pack, the attach and hits group: attach, targeting and hit modifiers. Dropkick,
// Reaper, Searing Blow, Nightmare, Glass Knife, Endless Agony, Pressure Points,
// Bowling Bash, Wave of the Hand, Bite and Ritual Dagger, both faces each.
// Contract: docs/slayer-pack.md; decisions: docs/slayer-pack-notes-attach-and-hits.md.
import {
  adjacentEnemies,
  createCombat,
  endPlayerTurn,
  enemyTurn,
  playCard,
  playCardCopy,
  previewCardDamage,
  resolveSlayerChoice,
  spendShiv,
  startPlayerTurn,
} from '../src/game/combat.ts'
import { createRng } from '../src/game/rng.ts'
import { cardDef, faceOf } from '../src/game/cards.ts'
import { amountOf } from '../src/game/combat/queries.ts'
import { createRun } from '../src/game/state.ts'
import { resolveCombat } from '../src/game/run.ts'
import { chooseCharacter, createRoom, createStore, joinRoom, markDisconnected, snapshotFor, startRun, apply } from './lib/rooms.mjs'
import { suite, check, assert, assertDeepEqual, assertEqual, report } from './lib/harness.mjs'

let uid = 0
const card = (defId, upgraded = false, over = {}) => ({ uid: `g${uid++}`, defId, upgraded, ...over })
const filler = (n = 10) => Array.from({ length: n }, () => card('defend_ironclad'))

const player = (over = {}) => ({
  id: 'p1', name: 'Ann', character: 'ironclad', row: 0,
  hp: 8, maxHp: 10, block: 0, energy: 3, gold: 0,
  deck: [], draw: filler(), hand: [], discard: [], exhaust: [], powers: [],
  relics: [], potions: [], cardRewards: [], rareRewards: [],
  strength: 0, vulnerable: 0, weak: 0, shivs: 0, miracles: 0,
  stance: 'neutral', orbs: [null, null, null], dead: false, ...over,
})
const ally = (over = {}) => player({ id: 'p2', name: 'Bea', character: 'silent', row: 1, ...over })
const enemy = (uid, over = {}) => ({
  uid, defId: 'cultist', row: 0, isBoss: false, hp: 20, maxHp: 20, block: 0,
  strength: 0, vulnerable: 0, weak: 0, poison: 0, actionIndex: 0, abilityUsed: true, dead: false,
  goldReward: 0, cardReward: null, ...over,
})
const boss = (uid = 'boss', over = {}) => enemy(uid, { defId: 'hexaghost', isBoss: true, hp: 40, maxHp: 40, ...over })

const combat = (players, enemies) => createCombat(createRng(11), players, enemies)
const play = (state, held, context = {}, playerId = 'p1') =>
  playCard(state, playerId, held.uid, { enemyUid: 'e1', playerId, ...context })
const hp = (state, id) => state.enemies.find((candidate) => candidate.uid === id).hp
const me = (state, id = 'p1') => state.players.find((candidate) => candidate.id === id)
const lost = (before, after, id = 'e1') => hp(before, id) - hp(after, id)
const withHand = (state, cards, id = 'p1') => ({
  ...state, players: state.players.map((candidate) => candidate.id === id
    ? { ...candidate, hand: [...candidate.hand, ...cards] } : candidate),
})

// Every answer names the choice it is for; these stamp the one the owner is currently asked.
const answer = (state, playerId, decision) =>
  resolveSlayerChoice(state, playerId, { choiceId: state.pendingSlayerChoices?.[0]?.id, ...decision })
const owedId = (room) => room.run.combat.pendingSlayerChoices?.[0]?.id

suite('Slayer Pack attach and hits')

check('Dropkick: +2 (+3) folds into the hit before Vulnerable doubles it; previews agree', () => {
  for (const [upgraded, printed, bonus] of [[false, 2, 2], [true, 3, 3]]) {
    const kick = card('slayer_dropkick', upgraded)
    const plain = combat([player({ hand: [kick] })], [enemy('e1')])
    assertEqual(lost(plain, play(plain, kick)), printed, `${upgraded ? 'Dropkick+' : 'Dropkick'} without Vulnerable`)
    const vulnerable = combat([player({ hand: [kick] })], [enemy('e1', { vulnerable: 1 })])
    const after = play(vulnerable, kick)
    assertEqual(lost(vulnerable, after), (printed + bonus) * 2, 'bonus first, then double (author FAQ)')
    assertEqual(after.enemies[0].vulnerable, 0, 'the hit spends one Vulnerable')
    assertEqual(previewCardDamage(vulnerable, 'p1', kick.uid, 'e1').damage, (printed + bonus) * 2, 'the badge reads the same engine')
  }
  const kick = card('slayer_dropkick')
  const strong = combat([player({ hand: [kick], strength: 1 })], [enemy('e1', { vulnerable: 2 })])
  assertEqual(lost(strong, play(strong, kick)), 10, 'Strength joins the bonus before the double')
  const weak = combat([player({ hand: [kick], weak: 1 })], [enemy('e1', { vulnerable: 1 })])
  assertEqual(lost(weak, play(weak, kick)), 4, 'Weak into Vulnerable cancels both, but the target still has Vulnerable')
})

check('Reaper: one AoE hit on the row and the boss; Block equals the HP it took from all of them, capped at 20', () => {
  const reaper = card('slayer_reaper')
  const state = combat([player({ hand: [reaper], energy: 3 })], [
    enemy('e1', { block: 1 }), enemy('e2', { hp: 1 }), enemy('e3', { row: 1 }), boss(),
  ])
  const after = play(state, reaper)
  assertEqual(lost(state, after, 'e1'), 1, 'Block absorbs 1 of the 2')
  assert(after.enemies.find((candidate) => candidate.uid === 'e2').dead, 'the 1-HP enemy dies')
  assertEqual(lost(state, after, 'e3'), 0, 'another row is untouched')
  assertEqual(lost(state, after, 'boss'), 2, 'the boss is in every row')
  assertEqual(me(after).block, 1 + 1 + 2, 'unblocked damage only: overkill and Block do not count')
  assertEqual(me(after).energy, 1, 'costs 2')

  const plus = card('slayer_reaper', true)
  const capped = combat([player({ hand: [plus], block: 18 })], [enemy('e1'), enemy('e2')])
  const full = play(capped, plus)
  assertEqual(lost(capped, full, 'e2'), 3, 'Reaper+ hits for 3')
  assertEqual(me(full).block, 20, 'Block stops at 20')
  const walled = combat([player({ hand: [card('slayer_reaper')] })], [enemy('e1', { block: 5 })])
  assertEqual(me(play(walled, walled.players[0].hand[0])).block, 0, 'nothing unblocked, no Block')
})

check('Searing Blow: +2 per upgraded card in hand; Searing Blow+ +3 per OTHER upgraded card; previews agree', () => {
  const blow = card('slayer_searing_blow')
  const hand = [blow, card('strike_ironclad', true), card('defend_ironclad', true), card('bash')]
  const state = combat([player({ hand })], [enemy('e1')])
  assertEqual(lost(state, play(state, blow)), 3 + 2 * 2)
  assertEqual(previewCardDamage(state, 'p1', blow.uid, 'e1').damage, 7)

  const plus = card('slayer_searing_blow', true)
  const upgradedHand = combat([player({ hand: [plus, card('strike_ironclad', true), card('slayer_searing_blow', true)] })], [enemy('e1')])
  assertEqual(lost(upgradedHand, play(upgradedHand, plus)), 3 + 2 * 3, 'never counts itself (author FAQ)')
  assertEqual(previewCardDamage(upgradedHand, 'p1', plus.uid, 'e1').damage, 9)
  const alone = combat([player({ hand: [card('slayer_searing_blow', true)] })], [enemy('e1')])
  assertEqual(lost(alone, play(alone, alone.players[0].hand[0])), 3, 'alone in hand: the printed 3')
  // Read while the card is still in hand (as a hand-card number would be): it still never counts itself.
  const held = me(upgradedHand).hand.find((candidate) => candidate.uid === plus.uid)
  assertEqual(amountOf(faceOf(cardDef(held.defId), true).effects[0].amount, upgradedHand, me(upgradedHand),
    upgradedHand.enemies[0], { enemyUid: 'e1', playerId: 'p1', sourceCardUid: held.uid }), 3 + 2 * 3)
})

check('Glass Knife: +3 (+5) unless it was Retained last turn, and the real end of turn sets that flag', () => {
  for (const [upgraded, bonus] of [[false, 3], [true, 5]]) {
    const knife = card('slayer_glass_knife', upgraded)
    const fresh = combat([player({ hand: [knife] })], [enemy('e1')])
    assertEqual(lost(fresh, play(fresh, knife)), 2 + bonus, 'a freshly drawn knife deals the bonus')
    const kept = card('slayer_glass_knife', upgraded, { retainedLastTurn: true })
    const retained = combat([player({ hand: [kept] })], [enemy('e1')])
    assertEqual(lost(retained, play(retained, kept)), 2, 'a Retained knife does not')
    assertEqual(previewCardDamage(retained, 'p1', kept.uid, 'e1').damage, 2)
  }
  const knife = card('slayer_glass_knife')
  let state = combat([player({ hand: [knife] })], [enemy('e1', { hp: 40, maxHp: 40 })])
  state = endPlayerTurn(state)
  state = enemyTurn(state)
  state = startPlayerTurn(state)
  const held = me(state).hand.find((candidate) => candidate.uid === knife.uid)
  assert(held?.retainedLastTurn, 'Retain kept the knife in hand and remembered it')
  assertEqual(lost(state, play(state, held)), 2, 'next turn it is the plain 2')
})

check('Endless Agony: +1 per own Weak and Vulnerable, back on top of the draw pile, and still Ethereal in hand', () => {
  const agony = card('slayer_endless_agony')
  const state = combat([player({ hand: [agony], vulnerable: 2, weak: 1 })], [enemy('e1', { weak: 3, vulnerable: 0 })])
  const after = play(state, agony)
  assertEqual(lost(state, after), 3 + 3 - 1, 'counts the player\'s 3 tokens; Weak still takes 1 off the hit')
  assertEqual(me(after).draw[0].uid, agony.uid, 'it goes on top of the draw pile, not to discard')
  assert(!me(after).discard.some((candidate) => candidate.uid === agony.uid))
  const plus = card('slayer_endless_agony', true)
  const clean = combat([player({ hand: [plus] })], [enemy('e1')])
  assertEqual(lost(clean, play(clean, plus)), 4, 'Endless Agony+ prints 4')

  const idle = card('slayer_endless_agony')
  const ended = endPlayerTurn(combat([player({ hand: [idle] })], [enemy('e1')]))
  assert(me(ended).exhaust.some((candidate) => candidate.uid === idle.uid), 'left in hand at end of turn it Exhausts')
})

check('Nightmare: attaches, pings 1 per own Attack that strikes its enemy (Shivs too), never for others or elsewhere', () => {
  const nightmare = card('slayer_nightmare')
  const strike = card('strike_ironclad')
  const elsewhere = card('strike_ironclad')
  const reaper = card('slayer_reaper')
  let state = combat([player({ hand: [nightmare, strike, elsewhere, reaper], energy: 6, shivs: 1 }),
    ally({ hand: [card('strike_silent')] })], [enemy('e1'), enemy('e2'), enemy('e3', { row: 1 })])
  state = play(state, nightmare)
  assertDeepEqual(state.enemies[0].slayerAttachments, [{ card: { uid: nightmare.uid, defId: 'slayer_nightmare', upgraded: false }, playerId: 'p1' }])
  assert(![...me(state).hand, ...me(state).discard, ...me(state).exhaust].some((held) => held.uid === nightmare.uid),
    'the physical card sits on the enemy, in no pile')
  assertEqual(me(state).energy, 5)

  let next = play(state, strike)
  assertEqual(lost(state, next), 2, 'Strike 1 + Nightmare 1')
  state = next
  next = play(state, elsewhere, { enemyUid: 'e2' })
  assertEqual(lost(state, next, 'e1'), 0, 'an Attack against another enemy does nothing')
  state = next
  next = play(state, reaper)
  assertEqual(lost(state, next, 'e1'), 3, 'an AoE that includes the host pings once, not per enemy')
  state = next
  next = spendShiv(state, 'p1', 'e1')
  assertEqual(lost(state, next, 'e1'), 2, 'a Shiv is an Attack against the target')
  state = next
  const allyStrike = me(state, 'p2').hand[0]
  next = playCard(state, 'p2', allyStrike.uid, { enemyUid: 'e1', playerId: 'p2' })
  assertEqual(lost(state, next, 'e1'), 1, '"you" is the card\'s owner: an ally\'s Attack does not trigger it')
})

check('copies: a Burst copy of Nightmare attaches nothing; a Double Tap copy pings', () => {
  const burst = card('burst')
  const nightmare = card('slayer_nightmare')
  let state = combat([player({ character: 'silent', hand: [burst, nightmare], energy: 3 })], [enemy('e1'), enemy('e2')])
  state = play(state, burst)
  state = play(state, nightmare)
  assertEqual(state.phase, 'copy', 'the virtual copy resolved first')
  assertEqual(state.enemies[0].slayerAttachments, undefined, 'and attached nothing: it has no physical card')
  state = playCardCopy(state, 'p1', { enemyUid: 'e2', playerId: 'p1' })
  assertDeepEqual(state.enemies.map((candidate) => candidate.slayerAttachments?.length ?? 0), [0, 1], 'the physical card attaches once')
  assert(!me(state).discard.some((held) => held.uid === nightmare.uid))

  const tap = card('double_tap')
  const strike = card('strike_ironclad')
  let tapped = combat([player({ hand: [tap, strike], energy: 3 })], [enemy('e1', {
    slayerAttachments: [{ card: { uid: 'nm-on-e1', defId: 'slayer_nightmare', upgraded: false }, playerId: 'p1' }],
  })])
  const before = tapped
  tapped = play(play(tapped, tap), strike)
  tapped = playCardCopy(tapped, 'p1', { enemyUid: 'e1', playerId: 'p1' })
  assertEqual(lost(before, tapped), 4, 'each resolution of a doubled Strike is an Attack against the host: (1 + 1) x 2')

})

check('Ritual Dagger played twice (Double Tap): whichever resolution kills earns the reward, once', () => {
  const setup = (upgraded, enemies) => {
    const dagger = card('slayer_ritual_dagger', upgraded)
    let state = combat([player({ hand: [card('double_tap'), dagger], deck: [{ ...dagger }], energy: 3,
      rareRewards: ['offering', 'barricade'] })], enemies)
    state = play(state, me(state).hand[0])
    return { dagger, state: play(state, dagger, { enemyUid: enemies[0].uid }) }
  }
  // The copy's kill ends the fight: the physical original never resolves, the reward still lands.
  const won = setup(false, [enemy('e1', { hp: 2 })])
  assertEqual(won.state.phase, 'won')
  assertEqual(me(won.state).deck[0].upgraded, true, 'Ritual Dagger: the copy\'s winning kill upgrades the deck card')
  const wonPlus = setup(true, [enemy('e1', { hp: 3 })])
  assertEqual(wonPlus.state.phase, 'won')
  assertEqual(wonPlus.state.pendingSlayerChoices?.length, 1, 'Ritual Dagger+: the copy\'s winning kill reveals once')

  for (const upgraded of [false, true]) {
    const face = upgraded ? 'Ritual Dagger+' : 'Ritual Dagger'
    const lethal = upgraded ? 3 : 2
    // Copy kills e1; the original then kills e2 too: still one reward, granted after the card is Exhausted.
    const twice = setup(upgraded, [enemy('e1', { hp: lethal }), enemy('e2', { hp: lethal }), enemy('e3')])
    assertEqual(twice.state.phase, 'copy')
    assertEqual(twice.state.pendingSlayerChoices, undefined, `${face}: nothing is granted while the card is still in play`)
    assertEqual(me(twice.state).deck[0].upgraded, upgraded)
    const both = playCardCopy(twice.state, 'p1', { enemyUid: 'e2', playerId: 'p1' })
    assert(both.enemies[0].dead && both.enemies[1].dead, `${face}: both resolutions killed`)
    if (upgraded) {
      assertEqual(both.pendingSlayerChoices?.length, 1, 'one reveal for two kills')
      const replaced = answer(both, 'p1', { replace: true })
      assertDeepEqual(me(replaced).exhaust.map((held) => held.defId), ['offering'], 'Replace finds the dagger in the Exhaust pile')
    } else {
      assertEqual(me(both).exhaust.find((held) => held.uid === twice.dagger.uid)?.upgraded, true, 'Exhausted, upgraded')
      assertEqual(me(both).deck[0].upgraded, true)
    }
    // Only the second resolution kills.
    const late = setup(upgraded, [enemy('e1'), enemy('e2', { hp: lethal })])
    const lateDone = playCardCopy(late.state, 'p1', { enemyUid: 'e2', playerId: 'p1' })
    assert(lateDone.enemies[1].dead)
    assertEqual(upgraded ? lateDone.pendingSlayerChoices?.length : me(lateDone).deck[0].upgraded ? 1 : 0, 1,
      `${face}: the original's own kill still earns it`)
    // No kill at all.
    const none = setup(upgraded, [enemy('e1'), enemy('e2')])
    const noneDone = playCardCopy(none.state, 'p1', { enemyUid: 'e2', playerId: 'p1' })
    assertEqual(noneDone.pendingSlayerChoices, undefined, `${face}: no kill, no reveal`)
    assertEqual(me(noneDone).deck[0].upgraded, upgraded, `${face}: no kill, no upgrade`)
  }
})

check('Nightmare: different owners and several cards coexist on one enemy; its death discards each to its owner', () => {
  const mine = card('slayer_nightmare')
  const theirs = card('slayer_nightmare')
  const pressure = card('slayer_pressure_points')
  const strike = card('strike_ironclad')
  let state = combat([player({ character: 'watcher', hand: [mine, pressure, strike], energy: 6 }),
    ally({ hand: [theirs] })], [enemy('e1', { hp: 5, maxHp: 5 }), enemy('e2')])
  state = play(state, mine)
  state = play(state, pressure)
  state = playCard(state, 'p2', theirs.uid, { enemyUid: 'e1', playerId: 'p2' })
  assertEqual(state.enemies[0].slayerAttachments.length, 3)
  const before = state
  state = play(state, strike)
  assertEqual(lost(before, state), 2, 'only the attacker\'s own Nightmare answers')
  state = { ...state, enemies: state.enemies.map((candidate) => candidate.uid === 'e1' ? { ...candidate, hp: 1 } : candidate) }
  const finisher = card('strike_ironclad')
  state = play(withHand(state, [finisher]), finisher)
  assert(state.enemies[0].dead, 'the host dies')
  assertEqual(state.enemies[0].slayerAttachments, undefined, 'nothing stays on a corpse')
  assert(me(state).discard.some((held) => held.uid === mine.uid), 'my Nightmare is discarded to my pile')
  assert(me(state).discard.some((held) => held.uid === pressure.uid), 'Pressure Points too')
  assert(me(state, 'p2').discard.some((held) => held.uid === theirs.uid), 'the ally\'s Nightmare goes to the ally')
  assertEqual(state.pendingSlayerChoices, undefined, 'the base face asks nothing')
})

check('Nightmare+: on death it moves to the only other enemy, or its owner chooses among several', () => {
  const plus = card('slayer_nightmare', true)
  const finisher = card('strike_ironclad', true)
  let state = combat([player({ hand: [plus, finisher] })], [enemy('e1', { hp: 3, maxHp: 3 }), enemy('e2')])
  state = play(state, plus)
  state = play(state, finisher)
  assert(state.enemies[0].dead)
  assertEqual(state.enemies[1].slayerAttachments?.[0]?.card.uid, plus.uid, 'one candidate: no question to ask')
  assertEqual(state.pendingSlayerChoices, undefined)

  const again = card('slayer_nightmare', true)
  const kill = card('strike_ironclad', true)
  let crowd = combat([player({ hand: [again, kill, card('strike_ironclad')] })],
    [enemy('e1', { hp: 3, maxHp: 3 }), enemy('e2'), enemy('e3', { row: 1 })])
  crowd = play(crowd, again)
  crowd = play(crowd, kill)
  assertEqual(crowd.pendingSlayerChoices?.length, 1, 'two candidates: the owner chooses')
  assertEqual(crowd.pendingSlayerChoices[0].kind, 'reattach')
  assertEqual(play(crowd, me(crowd).hand[0], { enemyUid: 'e2' }), crowd, 'the choice blocks other plays until answered')
  assertEqual(answer(crowd, 'p1', { enemyUid: 'e1' }), crowd, 'not the enemy that died')
  assertEqual(answer(crowd, 'p1', { enemyUid: null }), crowd, 'not a discard while enemies remain')
  assertEqual(answer(crowd, 'p2', { enemyUid: 'e3' }), crowd, 'not someone else\'s choice')
  assertEqual(answer(crowd, 'p1', { replace: true }), crowd, 'not a Ritual Dagger answer')
  assertEqual(answer(crowd, 'p1', { enemyUid: 'e3', replace: false }), crowd, 'not a mixed answer')
  const moved = answer(crowd, 'p1', { enemyUid: 'e3' })
  assertEqual(moved.enemies[2].slayerAttachments[0].card.uid, again.uid)
  assertEqual(moved.pendingSlayerChoices, undefined)
  const swing = play(moved, me(moved).hand[0], { enemyUid: 'e3' })
  assertEqual(lost(moved, swing, 'e3'), 2, 'and keeps working on its new enemy')
})

check('an attached enemy\'s death waits until the card finishes resolving', () => {
  // Reaper kills e1 (Nightmare+) and e2 in one burst. Had e1's death resolved mid-burst, e2
  // would still have been alive and the owner asked to choose; at the card's end only e3 is left.
  const reaper = card('slayer_reaper')
  const state = combat([player({ hand: [reaper] })], [
    enemy('e1', { hp: 1, slayerAttachments: [{ card: { uid: 'nm-w', defId: 'slayer_nightmare', upgraded: true }, playerId: 'p1' }] }),
    enemy('e2', { hp: 1 }), enemy('e3', { row: 1 }),
  ])
  const after = play(state, reaper)
  assert(after.enemies[0].dead && after.enemies[1].dead)
  assertEqual(after.pendingSlayerChoices, undefined, 'no choice: e2 was already dead when e1\'s card moved')
  assertEqual(after.enemies[2].slayerAttachments?.[0]?.card.uid, 'nm-w')
})

check('a Nightmare+ that moves during a play waits for the next play, in either board order', () => {
  const plus = (uid) => ({ card: { uid, defId: 'slayer_nightmare', upgraded: true }, playerId: 'p1' })
  const ordered = (enemies, flip) => flip ? [...enemies].reverse() : enemies
  for (const flip of [false, true]) {
    const where = flip ? ' (e2 listed first)' : ''
    // Reaper strikes both; its ping kills e1 and Nightmare+ moves to e2 mid-play.
    const reaper = card('slayer_reaper')
    const row = combat([player({ hand: [reaper] })],
      ordered([enemy('e1', { hp: 3, slayerAttachments: [plus('nm-r')] }), enemy('e2')], flip))
    const swept = play(row, reaper)
    assert(swept.enemies.find((candidate) => candidate.uid === 'e1').dead, `the ping finishes e1${where}`)
    assertEqual(lost(row, swept, 'e2'), 2, `e2 takes only Reaper's 2${where}`)
    assertEqual(swept.enemies.find((candidate) => candidate.uid === 'e2').slayerAttachments?.[0]?.card.uid, 'nm-r')
    const strike = card('strike_ironclad')
    const next = play(withHand(swept, [strike]), strike, { enemyUid: 'e2' })
    assertEqual(lost(swept, next, 'e2'), 2, `the next Attack does ping its new enemy${where}`)

    // Reaper itself kills the host: Nightmare+ moves to the other struck enemy before the pings.
    const sweep = card('slayer_reaper')
    const crowd = combat([player({ hand: [sweep] })],
      ordered([enemy('e1', { hp: 2, slayerAttachments: [plus('nm-k')] }), enemy('e2')], flip))
    const killed = play(crowd, sweep)
    assertEqual(killed.enemies.find((candidate) => candidate.uid === 'e2').slayerAttachments?.[0]?.card.uid, 'nm-k')
    assertEqual(lost(crowd, killed, 'e2'), 2, `a card moved by this play's kill does not answer it${where}`)

    // Two Nightmare+ on one host: the first ping kills it and both move; the second does not ping.
    const blocked = card('strike_ironclad')
    const pair = combat([player({ hand: [blocked] })], ordered([
      enemy('e1', { hp: 1, block: 1, slayerAttachments: [plus('nm-a'), plus('nm-b')] }), enemy('e2')], flip))
    const popped = play(pair, blocked)
    assert(popped.enemies.find((candidate) => candidate.uid === 'e1').dead, `the first ping kills the host${where}`)
    assertEqual(lost(pair, popped, 'e2'), 0, `the second card, now elsewhere, does not answer${where}`)
    assertDeepEqual(popped.enemies.find((candidate) => candidate.uid === 'e2').slayerAttachments.map((entry) => entry.card.uid),
      ['nm-a', 'nm-b'])

    // A Double Tap copy kills the host; the original that follows is a new play and pings.
    const tap = card('double_tap')
    const hit = card('strike_ironclad')
    let doubled = combat([player({ hand: [tap, hit] })],
      ordered([enemy('e1', { hp: 2, slayerAttachments: [plus('nm-d')] }), enemy('e2')], flip))
    const start = doubled
    doubled = play(play(doubled, tap), hit)
    assertEqual(lost(start, doubled, 'e2'), 0, `the copy's kill moves Nightmare+ without a ping${where}`)
    doubled = playCardCopy(doubled, 'p1', { enemyUid: 'e2', playerId: 'p1' })
    assertEqual(lost(start, doubled, 'e2'), 2, `the original Strike is its own Attack: 1 + 1${where}`)

    // A Shiv is a play of its own too.
    let shivs = combat([player({ character: 'silent', shivs: 2 })],
      ordered([enemy('e1', { hp: 2, slayerAttachments: [plus('nm-s')] }), enemy('e2')], flip))
    const before = shivs
    shivs = spendShiv(shivs, 'p1', 'e1')
    assertEqual(lost(before, shivs, 'e2'), 0, `the killing Shiv does not ping the new host${where}`)
    shivs = spendShiv(shivs, 'p1', 'e2')
    assertEqual(lost(before, shivs, 'e2'), 2, `the next Shiv does${where}`)

    // Pressure Points kills the shared host with a Skill; Nightmare+ moves, answers no Skill.
    const defend = card('defend_watcher')
    const shared = combat([player({ character: 'watcher', hand: [defend] })], ordered([
      enemy('e1', { hp: 1, slayerAttachments: [plus('nm-p'),
        { card: { uid: 'pp-p', defId: 'slayer_pressure_points', upgraded: false }, playerId: 'p1' }] }),
      enemy('e2', { slayerAttachments: [{ card: { uid: 'pp-q', defId: 'slayer_pressure_points', upgraded: false }, playerId: 'p1' }] }),
    ], flip))
    const after = play(shared, defend, { enemyUid: null })
    assert(after.enemies.find((candidate) => candidate.uid === 'e1').dead)
    assertEqual(lost(shared, after, 'e2'), 1, `only e2's own Pressure Points answers the Skill${where}`)
    assert(me(after).discard.some((held) => held.uid === 'pp-p'), 'the dead host\'s Pressure Points is discarded')
    assertDeepEqual(after.enemies.find((candidate) => candidate.uid === 'e2').slayerAttachments.map((entry) => entry.card.uid).sort(),
      ['nm-p', 'pp-q'])
  }
})

check('Pressure Points: costs 2 on a Boss, pings its enemy on each of its owner\'s Skills (1, or 2 upgraded)', () => {
  const points = card('slayer_pressure_points')
  const poor = combat([player({ character: 'watcher', hand: [points], energy: 1 })], [enemy('e1'), boss()])
  assertEqual(play(poor, points, { enemyUid: 'boss' }), poor, '1 Energy cannot pay the Boss price')
  const cheap = play(poor, points)
  assertEqual(me(cheap).energy, 0, 'an ordinary enemy pays the printed 1')
  const rich = combat([player({ character: 'watcher', hand: [points], energy: 3 })], [enemy('e1'), boss()])
  const onBoss = play(rich, points, { enemyUid: 'boss' })
  assertEqual(me(onBoss).energy, 1, 'the Boss costs 2')
  assertEqual(lost(rich, onBoss, 'boss'), 0, 'its own play does not trigger it')
  const free = combat([player({ character: 'watcher', hand: [card('slayer_pressure_points', false, { freeThisTurn: true })], energy: 0 })], [boss()])
  assert(play(free, me(free).hand[0], { enemyUid: 'boss' }) !== free, 'a free card stays free on a Boss')

  for (const [upgraded, amount] of [[false, 1], [true, 2]]) {
    const pp = card('slayer_pressure_points', upgraded)
    const defend = card('defend_watcher')
    const strike = card('strike_watcher')
    const second = card('slayer_pressure_points')
    let state = combat([player({ character: 'watcher', hand: [pp, defend, strike, second], energy: 6 }),
      ally({ hand: [card('defend_silent')] })], [enemy('e1'), enemy('e2')])
    state = play(state, pp)
    let next = play(state, defend)
    assertEqual(lost(state, next), amount, 'a Skill pings the enemy')
    state = next
    next = play(state, strike, { enemyUid: 'e2' })
    assertEqual(lost(state, next), 0, 'an Attack does not')
    state = next
    next = play(state, second, { enemyUid: 'e2' })
    assertEqual(lost(state, next), amount, 'another Pressure Points is a Skill too')
    assertEqual(lost(state, next, 'e2'), 0, 'and does not ping its own new enemy')
    state = next
    next = playCard(state, 'p2', me(state, 'p2').hand[0].uid, { enemyUid: null, playerId: 'p2' })
    assertEqual(lost(state, next), 0, 'an ally\'s Skill does not')
  }
})

check('Bowling Bash: the hit, then plain damage to 2 adjacent enemies on real row geometry', () => {
  const board = () => [
    enemy('a'), enemy('b'), enemy('c'),
    enemy('d', { row: 1 }), enemy('e', { row: 1 }),
  ]
  const two = combat([player(), ally()], board())
  const ids = (target) => adjacentEnemies(two, target).map((candidate) => candidate.uid).sort().join('')
  assertEqual(ids('b'), 'ace', 'left, right and below')
  assertEqual(ids('a'), 'bd', 'a corner has two')
  assertEqual(ids('e'), 'bd', 'left and above')
  const withBoss = combat([player(), ally()], [...board(), boss()])
  assertEqual(adjacentEnemies(withBoss, 'a').map((candidate) => candidate.uid).sort().join(''), 'bbossd', 'a boss borders everyone')
  assertEqual(adjacentEnemies(withBoss, 'boss').length, 5, 'and everyone borders it')
  const gap = combat([player(), ally()], board().map((candidate) => candidate.uid === 'b' ? { ...candidate, dead: true, hp: 0 } : candidate))
  assertEqual(adjacentEnemies(gap, 'a').map((candidate) => candidate.uid).sort().join(''), 'cd', 'the dead leave the table; the row closes up')

  const bash = card('slayer_bowling_bash')
  const state = combat([player({ character: 'watcher', hand: [bash], strength: 2 }), ally()],
    board().map((candidate) => candidate.uid === 'a' ? { ...candidate, vulnerable: 1 } : candidate))
  assertEqual(play(state, bash, { enemyUid: 'b' }), state, 'three candidates: two must be chosen')
  assertEqual(play(state, bash, { enemyUid: 'b', enemyUids: ['a', 'd'] }), state, 'd is not adjacent to b')
  assertEqual(play(state, bash, { enemyUid: 'b', enemyUids: ['a', 'a'] }), state, 'two different enemies')
  assertEqual(play(state, bash, { enemyUid: 'b', enemyUids: ['a'] }), state, 'exactly two')
  const after = play(state, bash, { enemyUid: 'b', enemyUids: ['a', 'e'] })
  assertEqual(lost(state, after, 'b'), 4, 'the hit takes Strength')
  assertEqual(lost(state, after, 'a'), 2, 'plain damage: no Strength, no Vulnerable double')
  assertEqual(after.enemies.find((candidate) => candidate.uid === 'a').vulnerable, 1, 'and spends no Vulnerable')
  assertEqual(lost(state, after, 'e'), 2)
  assertEqual(lost(state, after, 'c'), 0)

  const plus = card('slayer_bowling_bash', true)
  const exact = combat([player({ character: 'watcher', hand: [plus] }), ally()], board())
  assertEqual(play(exact, plus, { enemyUid: 'b' }), exact, 'Bowling Bash+ still damages only 2 of 3 candidates: they must be chosen')
  const picked = play(exact, plus, { enemyUid: 'b', enemyUids: ['c', 'e'] })
  assertDeepEqual(picked.enemies.map((candidate) => lost(exact, picked, candidate.uid)), [0, 3, 3, 0, 3],
    'Bowling Bash+: 3 to the target, 3 to each chosen neighbour')
  const corner = combat([player({ character: 'watcher', hand: [plus] }), ally()],
    board().map((candidate) => candidate.uid === 'a' ? { ...candidate, hp: 3 } : candidate))
  const swept = play(corner, plus, { enemyUid: 'a' })
  assert(swept.enemies[0].dead, 'Bowling Bash+ hits for 3: exactly enough')
  assertEqual(lost(corner, swept, 'b'), 3, 'its neighbours still take 3 after it died')
  assertEqual(lost(corner, swept, 'd'), 3)
  const lone = combat([player({ character: 'watcher', hand: [card('slayer_bowling_bash')] })], [enemy('e1')])
  assertEqual(lost(lone, play(lone, me(lone).hand[0])), 2, 'nothing adjacent: just the hit')
})

check('Wave of the Hand: every face x Stance gives a Miracle and that Stance; only Wave+ applies Weak to the chosen enemy', () => {
  for (const upgraded of [false, true]) {
    for (const [mode, stance] of [[0, 'calm'], [1, 'wrath']]) {
      const label = `${upgraded ? 'Wave+' : 'Wave'} ${stance}`
      const wave = card('slayer_wave_of_the_hand', upgraded)
      const state = combat([player({ character: 'watcher', hand: [wave] })], [enemy('e1'), enemy('e2')])
      assertEqual(play(state, wave, { enemyUid: 'e2' }), state, `${label}: the Stance is a real choice`)
      const after = play(state, wave, { mode, enemyUid: 'e2' })
      assert(after !== state, `${label} plays`)
      assertEqual(me(after).stance, stance, `${label}: enters ${stance}`)
      assertEqual(me(after).miracles, 1, `${label}: gains a Miracle`)
      assertDeepEqual(after.enemies.map((candidate) => candidate.weak), upgraded ? [0, 1] : [0, 0],
        `${label}: ${upgraded ? 'Weak on the chosen enemy only' : 'no Weak'}`)
      if (upgraded) assertEqual(play(state, wave, { mode, enemyUid: null }), state, `${label}: the Weak needs an enemy`)

      const already = combat([player({ character: 'watcher', hand: [wave], stance })], [enemy('e1'), enemy('e2')])
      const stay = play(already, wave, { mode, enemyUid: 'e2' })
      assertEqual(me(stay).stance, stance, `${label}: already in ${stance}, nothing changes`)
      assertEqual(me(stay).energy, 2, `${label}: re-entering pays no Calm Energy`)
      assertEqual(me(stay).miracles, 1, `${label}: the Miracle still comes`)
      assertEqual(stay.enemies[1].weak, upgraded ? 1 : 0, `${label}: and so does the Weak`)
    }
  }
  const leaving = card('slayer_wave_of_the_hand')
  const calmFirst = combat([player({ character: 'watcher', hand: [leaving], stance: 'calm' })], [enemy('e1')])
  assertEqual(me(play(calmFirst, leaving, { mode: 1 })).energy, 2 + 2, 'leaving Calm for Wrath still pays 2 Energy')
  const capped = combat([player({ character: 'watcher', hand: [leaving], miracles: 5 })], [enemy('e1')])
  assertEqual(me(play(capped, leaving, { mode: 0 })).miracles, 5, 'Miracles stop at 5')
})

check('Bite: heals 1 only when it killed its target, also on the killing blow that wins the fight', () => {
  for (const [upgraded, damage] of [[false, 2], [true, 3]]) {
    const bite = card('slayer_bite', upgraded)
    const survive = combat([player({ hand: [bite] })], [enemy('e1'), enemy('e2')])
    const noKill = play(survive, bite)
    assertEqual(lost(survive, noKill), damage, `${upgraded ? 'Bite+' : 'Bite'} hits for ${damage}`)
    assertEqual(me(noKill).hp, 8, 'no kill, no heal')
    assert(me(noKill).exhaust.some((held) => held.uid === bite.uid), 'Exhaust')
    const killable = combat([player({ hand: [bite] })], [enemy('e1', { hp: damage }), enemy('e2')])
    assertEqual(me(play(killable, bite)).hp, 9, `${upgraded ? 'Bite+' : 'Bite'} kills and heals 1`)
  }
  const bite = card('slayer_bite')
  const blocked = combat([player({ hand: [bite] })], [enemy('e1', { hp: 2, block: 1 }), enemy('e2')])
  assertEqual(me(play(blocked, bite)).hp, 8, 'Block saved it: no heal')
  const doubled = combat([player({ hand: [bite] })], [enemy('e1', { hp: 4, vulnerable: 1 }), enemy('e2')])
  assertEqual(me(play(doubled, bite)).hp, 9, 'a Vulnerable kill counts')
  const last = combat([player({ hand: [bite] })], [enemy('e1', { hp: 2 })])
  const won = play(last, bite)
  assertEqual(won.phase, 'won')
  assertEqual(me(won).hp, 9, 'the heal outlasts the fight')
  const full = combat([player({ hand: [bite], hp: 10 })], [enemy('e1', { hp: 2 }), enemy('e2')])
  assertEqual(me(play(full, bite)).hp, 10, 'never above max HP')
})

check('Ritual Dagger: a kill upgrades the exhausted card and its deck copy, even on the winning blow', () => {
  const dagger = card('slayer_ritual_dagger')
  const deck = [{ ...dagger }, card('strike_ironclad')]
  const miss = combat([player({ hand: [dagger], deck })], [enemy('e1'), enemy('e2')])
  const missed = play(miss, dagger)
  assertEqual(lost(miss, missed), 2, 'Ritual Dagger hits for 2')
  const plusMiss = combat([player({ hand: [card('slayer_ritual_dagger', true)] })], [enemy('e1'), enemy('e2')])
  assertEqual(lost(plusMiss, play(plusMiss, me(plusMiss).hand[0])), 3, 'Ritual Dagger+ hits for 3')
  assertEqual(me(missed).exhaust.find((held) => held.uid === dagger.uid).upgraded, false, 'no kill, no upgrade')
  assertEqual(me(missed).deck[0].upgraded, false)
  const kill = combat([player({ hand: [dagger], deck })], [enemy('e1', { hp: 2 }), enemy('e2')])
  const killed = play(kill, dagger)
  assertEqual(me(killed).exhaust.find((held) => held.uid === dagger.uid).upgraded, true, 'Exhausted, upgraded')
  assertEqual(me(killed).deck.find((held) => held.uid === dagger.uid).upgraded, true, 'and the deck card too')
  const last = combat([player({ hand: [dagger], deck })], [enemy('e1', { hp: 2 })])
  const won = play(last, dagger)
  assertEqual(won.phase, 'won')
  assertEqual(me(won).deck.find((held) => held.uid === dagger.uid).upgraded, true, 'the winning blow still upgrades')
})

check('Ritual Dagger+: its owner privately sees the top rare reward and bottoms it or Replaces the dagger', () => {
  const dagger = card('slayer_ritual_dagger', true)
  const setup = () => combat([player({ hand: [dagger, card('strike_ironclad')], deck: [{ ...dagger }],
    rareRewards: ['offering', 'demon_form', 'barricade'] })], [enemy('e1', { hp: 3 }), enemy('e2')])
  const miss = combat([player({ hand: [dagger], rareRewards: ['offering'] })], [enemy('e1'), enemy('e2')])
  assertEqual(play(miss, dagger).pendingSlayerChoices, undefined, 'no kill, no reveal')
  const killed = play(setup(), dagger)
  assertDeepEqual(killed.pendingSlayerChoices, [{ id: 0, kind: 'ritualDagger', playerId: 'p1', cardUid: dagger.uid, revealed: 'offering' }])
  assertEqual(play(killed, me(killed).hand[0], { enemyUid: 'e2' }), killed, 'answer first')
  assertEqual(answer(killed, 'p1', {}), killed, 'bottom or replace must be said')
  assertEqual(answer(killed, 'p1', { enemyUid: 'e2' }), killed, 'not a Nightmare answer')
  assertEqual(answer(killed, 'p1', { replace: true, enemyUid: 'e2' }), killed, 'not a mixed answer')
  const lostFight = { ...killed, phase: 'lost' }
  assertEqual(answer(lostFight, 'p1', { replace: true }), lostFight, 'a lost fight takes no answers')
  // A reveal that no longer matches the top of the rare deck changes nothing (the choice is spent).
  const stale = { ...killed, pendingSlayerChoices: [{ ...killed.pendingSlayerChoices[0], revealed: 'barricade' }] }
  const spent = answer(stale, 'p1', { replace: true })
  assertEqual(spent.pendingSlayerChoices, undefined)
  assertDeepEqual(me(spent).rareRewards, ['offering', 'demon_form', 'barricade'])
  assertEqual(me(spent).deck[0].defId, 'slayer_ritual_dagger')

  const bottomed = answer(killed, 'p1', { replace: false })
  assertDeepEqual(me(bottomed).rareRewards, ['demon_form', 'barricade', 'offering'])
  assertEqual(me(bottomed).deck[0].defId, 'slayer_ritual_dagger', 'the dagger stays in the deck')
  assert(!bottomed.log.some((line) => line.includes('Offering')), 'a bottomed reveal is never named in the public log')

  const replaced = answer(killed, 'p1', { replace: true })
  assertDeepEqual(me(replaced).rareRewards, ['demon_form', 'barricade'])
  assertDeepEqual(me(replaced).deck[0], { uid: dagger.uid, defId: 'offering', upgraded: false }, 'the unupgraded rare takes its place in the deck')
  assert(me(replaced).exhaust.some((held) => held.uid === dagger.uid && held.defId === 'offering'), 'and in the Exhaust pile')
  assert(!me(replaced).exhaust.some((held) => held.defId === 'slayer_ritual_dagger'))

  const empty = combat([player({ hand: [dagger] })], [enemy('e1', { hp: 3 }), enemy('e2')])
  assertEqual(play(empty, dagger).pendingSlayerChoices, undefined, 'an empty rare deck reveals nothing')
})

check('Ritual Dagger+ on the winning blow: the fight waits for the answer, then folds the swap into the run', () => {
  let run = createRun(5, [{ id: 'p1', name: 'Ann', character: 'ironclad' }])
  const dagger = card('slayer_ritual_dagger', true)
  const owner = { ...run.players[0], hand: [], deck: [...run.players[0].deck, { ...dagger }] }
  const top = owner.rareRewards[0]
  const fight = combat([{ ...owner, hand: [dagger], draw: [], hp: 5 }], [enemy('e1', { hp: 3 })])
  const won = play(fight, dagger)
  assertEqual(won.phase, 'won')
  assertEqual(won.pendingSlayerChoices?.[0]?.revealed, top, 'the reveal survives the victory')
  const healed = me(won).hp
  run = { ...run, phase: 'combat', players: [owner], combat: won }
  assertEqual(resolveCombat(run), run, 'the run does not move on while the owner decides')
  const answered = answer(won, 'p1', { replace: true })
  assertEqual(answered.phase, 'won')
  assertEqual(me(answered).hp, healed, 'answering does not end the combat a second time (no second Burning Blood)')
  const folded = resolveCombat({ ...run, combat: answered })
  assert(folded !== run && folded.combat === null, 'then the combat resolves')
  assert(folded.players[0].deck.some((held) => held.uid === dagger.uid && held.defId === top && !held.upgraded),
    'the run deck keeps the rare in the dagger\'s place')
  assert(!folded.players[0].deck.some((held) => held.defId === 'slayer_ritual_dagger'))
  assertEqual(folded.players[0].rareRewards[0] === top, false, 'and it left the rare deck')
})

check('online: the room charges the Boss price, validates and redacts Slayer choices, and covers an absent owner', () => {
  const room = createRoom(createStore(), { code: 'SLAYG3' })
  const ann = joinRoom(room, { name: 'Ann', character: 'ironclad' })
  const bea = joinRoom(room, { name: 'Bea', character: 'watcher' })
  chooseCharacter(room, bea.token, 'watcher')
  startRun(room, ann.token, { seed: 9 })
  const annId = snapshotFor(room, ann.token).you.playerId
  const beaId = snapshotFor(room, bea.token).you.playerId
  const dagger = card('slayer_ritual_dagger', true)
  const points = card('slayer_pressure_points')
  const players = room.run.players.map((candidate) => ({
    ...candidate,
    hand: candidate.id === annId ? [dagger, card('strike_ironclad')] : [points],
    draw: [], energy: 1,
    rareRewards: candidate.id === annId ? ['offering', 'barricade'] : candidate.rareRewards,
  }))
  room.run = { ...room.run, phase: 'combat', combat: createCombat(createRng(3), players,
    [enemy('e1', { hp: 3 }), enemy('e2'), boss()]) }
  let refused = false
  try { apply(room, bea.token, { kind: 'playCard', cardUid: points.uid, enemyUid: 'boss', playerId: beaId, preflight: true }) }
  catch { refused = true }
  assert(refused, 'the server refuses Pressure Points on a Boss without 2 Energy')
  assert(apply(room, bea.token, { kind: 'playCard', cardUid: points.uid, enemyUid: 'e2', playerId: beaId }).changed,
    'but plays it on an ordinary enemy for 1')
  assertEqual(room.run.combat.enemies.find((candidate) => candidate.uid === 'e2').slayerAttachments.length, 1)

  apply(room, ann.token, { kind: 'playCard', cardUid: dagger.uid, enemyUid: 'e1', playerId: annId })
  assertEqual(room.run.combat.pendingSlayerChoices?.length, 1)
  assertEqual(snapshotFor(room, ann.token).run.combat.pendingSlayerChoices[0].revealed, 'offering', 'its owner sees the card')
  assertEqual(snapshotFor(room, bea.token).run.combat.pendingSlayerChoices[0].revealed, null, 'nobody else does')
  let rejected = false
  try { apply(room, ann.token, { kind: 'resolveSlayerChoice', choiceId: owedId(room), replace: 'yes' }) } catch { rejected = true }
  assert(rejected, 'a malformed answer is refused')
  rejected = false
  try { apply(room, bea.token, { kind: 'resolveSlayerChoice', choiceId: owedId(room), replace: true }) } catch { rejected = true }
  assert(rejected, 'another seat cannot answer it')
  joinRoom(room, { token: ann.token, connected: false })
  assertEqual(room.run.combat.pendingSlayerChoices, undefined, 'an absent owner keeps the rare on the bottom')
  assertDeepEqual(room.run.combat.players.find((candidate) => candidate.id === annId).rareRewards, ['barricade', 'offering'])
})

// An end-of-turn effect (Caltrops+ here) kills a Nightmare+ host while another end-of-turn ability is still
// to resolve. The mandatory choice holds that ability, so the choice has to be answerable mid-ordering.
function nightmareEndTurnRoom(code, powersFor) {
  const room = createRoom(createStore(), { code })
  const ann = joinRoom(room, { name: 'Ann', character: 'ironclad' })
  const bea = joinRoom(room, { name: 'Bea', character: 'watcher' })
  chooseCharacter(room, bea.token, 'watcher')
  startRun(room, ann.token, { seed: 9 })
  const annId = snapshotFor(room, ann.token).you.playerId
  const beaId = snapshotFor(room, bea.token).you.playerId
  const nightmare = { card: card('slayer_nightmare', true), playerId: annId }
  const players = room.run.players.map((candidate) => ({
    ...candidate, hand: [], draw: [], energy: 3, hp: 30, maxHp: 30, powers: powersFor(candidate.id, annId),
  }))
  room.run = { ...room.run, phase: 'combat', combat: createCombat(createRng(3), players, [
    enemy('e1', { defId: 'jaw_worm', hp: 2, slayerAttachments: [nightmare] }),
    enemy('e2', { row: 1 }), enemy('e3', { row: 1 }),
  ]) }
  apply(room, ann.token, { kind: 'endTurn' })
  apply(room, bea.token, { kind: 'endTurn' })
  return { room, ann, bea, annId, beaId }
}

const rejects = (room, token, action) => {
  try { apply(room, token, action) } catch { return true }
  return false
}
const rejectionOf = (room, token, action) => {
  try { apply(room, token, action) } catch (error) { return error.message }
  return null
}

check('online: the owner answers a Nightmare+ move mid end-of-turn ordering, then finishes the ordering', () => {
  const { room, ann, bea, annId } = nightmareEndTurnRoom('SLAYEO1', (id, annId) => id === annId
    ? [card('slayer_caltrops', true), card('slayer_companion', true)] : [])
  const published = snapshotFor(room, ann.token).endTurnAbilities?.[0]
  assert(room.run.combat.enemies[0].dead && published?.playerId === annId, 'Caltrops+ killed the host and Companion+ waits')
  assertEqual(room.run.combat.pendingSlayerChoices?.[0]?.kind, 'reattach')
  assert(rejects(room, ann.token, { kind: 'resolveEndTurnEffect', abilityId: published.id, targetUid: 'e2' }),
    'the owed choice holds the end-turn effect')
  assert(rejects(room, bea.token, { kind: 'resolveSlayerChoice', choiceId: owedId(room), enemyUid: 'e2' }), 'another seat cannot answer it')
  assert(rejects(room, ann.token, { kind: 'playCard', cardUid: 'nothing', enemyUid: 'e2' }),
    'other actions stay closed while ordering')
  const answeredId = owedId(room)
  assert(apply(room, ann.token, { kind: 'resolveSlayerChoice', choiceId: answeredId, enemyUid: 'e2' }).changed, 'the owner answers while ordering')
  assertEqual(room.run.combat.enemies[1].slayerAttachments?.[0]?.playerId, annId, 'Nightmare+ moved to the chosen enemy')
  assertEqual(room.run.combat.pendingSlayerChoices, undefined)
  const next = snapshotFor(room, ann.token).endTurnAbilities?.[0]
  assert(next?.playerId === annId && next.label.includes('Companion'), 'the ordering is still published for the owner')
  assertEqual(snapshotFor(room, bea.token).endTurnAbilities?.[0]?.id, next.id, 'and for the table, under one public id')
  // No choice is owed now, so only the ordering gate can refuse other actions: a real hand card must not play.
  const annPlayer = room.run.combat.players.find((candidate) => candidate.id === annId)
  annPlayer.hand = [card('strike_ironclad')]
  for (const action of [
    { kind: 'playCard', cardUid: annPlayer.hand[0].uid, enemyUid: 'e2' },
    { kind: 'previewCard', cardUid: annPlayer.hand[0].uid },
  ]) {
    assertEqual(rejectionOf(room, ann.token, action), 'The party is ordering end-of-turn abilities', `${action.kind} stays closed while ordering`)
  }
  assert(rejects(room, ann.token, { kind: 'resolveSlayerChoice', choiceId: answeredId, enemyUid: 'e3' }), 'the answer is spent')
  assert(apply(room, ann.token, { kind: 'resolveEndTurnEffect', abilityId: next.id, targetUid: 'e3' }).changed)
  assertEqual(snapshotFor(room, ann.token).endTurnAbilities, undefined, 'the ordering finishes')
  assertEqual(room.run.combat.enemies[2].hp, 16, 'Companion+ hit the chosen enemy')
})

check('online: a teammate\'s end-of-turn effect resolves while a Nightmare+ answer is owed, which stays answerable', () => {
  const { room, ann, bea, beaId } = nightmareEndTurnRoom('SLAYEO2', (id, annId) => id === annId
    ? [card('slayer_caltrops', true)] : [card('slayer_companion', true)])
  const published = snapshotFor(room, bea.token).endTurnAbilities?.[0]
  assertEqual(published?.playerId, beaId)
  assert(apply(room, bea.token, { kind: 'resolveEndTurnEffect', abilityId: published.id, targetUid: 'e2' }).changed,
    'Ann\'s owed choice does not hold Bea\'s own effect')
  assertEqual(room.run.combat.pendingSlayerChoices?.length, 1, 'the choice is still owed')
  assert(apply(room, ann.token, { kind: 'resolveSlayerChoice', choiceId: owedId(room), enemyUid: 'e3' }).changed)
  assertEqual(room.run.combat.pendingSlayerChoices, undefined)
  assertEqual(room.run.combat.enemies[2].slayerAttachments?.length, 1)
})

check('online: a Nightmare+ owner who leaves mid end-of-turn ordering does not strand the table', () => {
  const { room, ann, bea, annId } = nightmareEndTurnRoom('SLAYEO3', (id, annId) => id === annId
    ? [card('slayer_caltrops', true), card('slayer_companion', true)] : [])
  joinRoom(room, { token: ann.token, connected: false })
  assertEqual(room.run.combat.pendingSlayerChoices, undefined, 'the absent owner\'s choice is answered for them')
  assert(room.run.combat.enemies.slice(1).some((candidate) => candidate.slayerAttachments?.length === 1))
  assertEqual(snapshotFor(room, bea.token).endTurnAbilities?.[0]?.playerId === annId, false, 'nothing waits on the absent owner')
})

// An owed Nightmare+ answer is never held back by another window its owner has open (their card's copy, a
// Distilled Chaos pick, a Golden Eye Scry, a private card reveal, a forced card); each window comes back
// untouched once it is answered, and the answer still holds back everything else.
function nightmareWindowRoom(code, { annHand = [], beaHand = [], hostHp = 2, ann = {} }) {
  const room = createRoom(createStore(), { code })
  const annSeat = joinRoom(room, { name: 'Ann', character: 'ironclad' })
  const beaSeat = joinRoom(room, { name: 'Bea', character: 'watcher' })
  chooseCharacter(room, beaSeat.token, 'watcher')
  startRun(room, annSeat.token, { seed: 9 })
  const annId = snapshotFor(room, annSeat.token).you.playerId
  const beaId = snapshotFor(room, beaSeat.token).you.playerId
  const nightmare = { card: card('slayer_nightmare', true), playerId: annId }
  const players = room.run.players.map((candidate) => ({
    ...candidate, hand: candidate.id === annId ? annHand : beaHand,
    draw: Array.from({ length: 6 }, () => card('defend_ironclad')), energy: 5, hp: 30, maxHp: 30,
    ...(candidate.id === annId ? ann : {}),
  }))
  room.run = { ...room.run, phase: 'combat', combat: createCombat(createRng(3), players, [
    enemy('e1', { hp: hostHp, slayerAttachments: [nightmare] }), enemy('e2'), enemy('e3', { row: 1 }),
  ]) }
  return { room, ann: annSeat, bea: beaSeat, annId, beaId }
}
const attachmentsByEnemy = (room) => room.run.combat.enemies.map((candidate) => candidate.slayerAttachments?.length ?? 0)
const answerNightmare = (room, ann) => apply(room, ann.token, { kind: 'resolveSlayerChoice', choiceId: owedId(room), enemyUid: 'e3' })
const copyAnswer = (room, enemyUid = 'e2') => {
  const copy = room.run.combat.pendingCardCopy
  return { kind: 'playCardCopy', cardUid: copy.card.uid, copyId: copy.id, enemyUid, energySpent: 0 }
}
const killHostWith = (room, bea, beaId, strike) =>
  apply(room, bea.token, { kind: 'playCard', cardUid: strike.uid, enemyUid: 'e1', playerId: beaId })

check('online: a Nightmare+ answer owed inside the owner\'s own Double Tap copy window is accepted, and the copy then plays once', () => {
  const doubleTap = card('double_tap')
  const strike = card('strike_ironclad')
  const { room, ann, annId } = nightmareWindowRoom('SLAYWN1', { annHand: [doubleTap, strike] })
  apply(room, ann.token, { kind: 'playCard', cardUid: doubleTap.uid })
  apply(room, ann.token, { kind: 'playCard', cardUid: strike.uid, enemyUid: 'e1', playerId: annId })
  const copy = room.run.combat.pendingCardCopy
  assertEqual(room.run.combat.phase, 'copy', 'the copy window is open')
  assertEqual(room.run.combat.pendingSlayerChoices?.length, 1, 'and the Strike killed Nightmare+\'s host')
  assertEqual(rejectionOf(room, ann.token, copyAnswer(room)), 'Finish the Nightmare choice', 'the copy waits for the choice')
  assert(answerNightmare(room, ann).changed, 'the choice is answerable through the copy window')
  assertEqual(room.run.combat.pendingSlayerChoices, undefined)
  assertEqual(room.run.combat.pendingCardCopy?.id, copy.id, 'the very same copy window is still open')
  assertEqual(room.run.combat.phase, 'copy')
  assertDeepEqual(attachmentsByEnemy(room), [0, 0, 1], 'Nightmare+ moved once')
  assert(apply(room, ann.token, copyAnswer(room)).changed, 'the copy plays afterwards')
  assertEqual(room.run.combat.phase, 'player')
  assertEqual(room.run.combat.enemies[1].hp, 19, 'the copy hit once')
  assertDeepEqual(attachmentsByEnemy(room), [0, 0, 1], 'and nothing was attached twice')
})

check('online: a teammate\'s kill of a Nightmare+ host reaches an owner with an open copy window, which survives the answer', () => {
  const doubleTap = card('double_tap')
  const strike = card('strike_ironclad')
  const finisher = card('strike_watcher')
  const { room, ann, bea, annId, beaId } = nightmareWindowRoom('SLAYWN2',
    { annHand: [doubleTap, strike], beaHand: [finisher], hostHp: 1 })
  apply(room, ann.token, { kind: 'playCard', cardUid: doubleTap.uid })
  apply(room, ann.token, { kind: 'playCard', cardUid: strike.uid, enemyUid: 'e2', playerId: annId })
  const copy = room.run.combat.pendingCardCopy
  killHostWith(room, bea, beaId, finisher)
  assertEqual(room.run.combat.pendingSlayerChoices?.[0]?.playerId, annId, 'Ann owes the answer')
  assertEqual(room.run.combat.pendingCardCopy?.id, copy.id, 'while her copy window is open')
  assertEqual(rejectionOf(room, ann.token, copyAnswer(room)), 'Finish the Nightmare choice')
  assert(rejects(room, bea.token, { kind: 'resolveSlayerChoice', choiceId: owedId(room), enemyUid: 'e3' }), 'only Ann can answer')
  assert(answerNightmare(room, ann).changed)
  assertEqual(room.run.combat.pendingCardCopy?.id, copy.id, 'her copy window is intact')
  assertDeepEqual(attachmentsByEnemy(room), [0, 0, 1])
  assert(apply(room, ann.token, copyAnswer(room)).changed)
  assertEqual(room.run.combat.phase, 'player')
  assertDeepEqual(attachmentsByEnemy(room), [0, 0, 1])
})

check('online: a Nightmare+ answer is accepted while the owner holds a Distilled Chaos pick, which stays private and resumes', () => {
  const finisher = card('strike_watcher')
  const picks = [card('defend_ironclad'), card('defend_ironclad'), card('defend_ironclad')]
  const { room, ann, bea, beaId } = nightmareWindowRoom('SLAYWN3', {
    beaHand: [finisher], hostHp: 1, ann: { draw: picks, potions: ['distilled_chaos'] },
  })
  apply(room, ann.token, { kind: 'usePotion', potionId: 'distilled_chaos', preflight: true })
  killHostWith(room, bea, beaId, finisher)
  assertEqual(room.run.combat.pendingSlayerChoices?.length, 1)
  assert(rejects(room, ann.token, { kind: 'chooseDistilledCard', cardUid: picks[0].uid }), 'the pick waits for the choice')
  assert(answerNightmare(room, ann).changed, 'the choice is answerable through the Distilled Chaos pick')
  assertDeepEqual(room.run.combat.pendingDistilled.cards.map((held) => held.uid), picks.map((held) => held.uid),
    'the same cards are still offered')
  for (const held of picks) {
    assert(!JSON.stringify(snapshotFor(room, bea.token)).includes(held.uid), 'a teammate never sees the picks')
  }
  assert(apply(room, ann.token, { kind: 'chooseDistilledCard', cardUid: picks[0].uid }).changed, 'and the pick resumes')
  assertDeepEqual(attachmentsByEnemy(room), [0, 0, 1])
})

check('online: a Nightmare+ answer is accepted while the owner holds a Golden Eye Scry, which stays private and resumes', () => {
  const finisher = card('strike_watcher')
  const { room, ann, bea, beaId } = nightmareWindowRoom('SLAYWN4', {
    beaHand: [finisher], hostHp: 1, ann: { relics: [{ defId: 'golden_eye', spent: false }] },
  })
  apply(room, ann.token, { kind: 'activateRelic', relicIndex: 0 })
  const scry = room.run.combat.pendingRelicScry
  killHostWith(room, bea, beaId, finisher)
  assertEqual(room.run.combat.pendingSlayerChoices?.length, 1)
  assert(rejects(room, ann.token, { kind: 'activateRelic', relicIndex: 0, relicScryId: scry.id, scryDiscardUids: [] }),
    'the Scry waits for the choice')
  assert(answerNightmare(room, ann).changed, 'the choice is answerable through the Scry')
  assertEqual(room.run.combat.pendingRelicScry?.id, scry.id, 'the same Scry is still open')
  for (const held of scry.cards) {
    assert(!JSON.stringify(snapshotFor(room, bea.token)).includes(held.uid), 'a teammate never sees the Scry cards')
  }
  assert(apply(room, ann.token, { kind: 'activateRelic', relicIndex: 0, relicScryId: scry.id, scryDiscardUids: [] }).changed)
  assertEqual(room.run.combat.pendingRelicScry, undefined)
  assertDeepEqual(attachmentsByEnemy(room), [0, 0, 1])
})

check('online: a Nightmare+ answer is accepted while the owner has a private card reveal open, which stays locked', () => {
  const finisher = card('strike_watcher')
  const thinking = card('thinking_ahead')
  const { room, ann, bea, annId, beaId } = nightmareWindowRoom('SLAYWN5', {
    annHand: [thinking], beaHand: [finisher], hostHp: 1,
  })
  const revealed = apply(room, ann.token, { kind: 'previewCard', cardUid: thinking.uid }).snapshot.cardPreview
  killHostWith(room, bea, beaId, finisher)
  assertEqual(room.run.combat.pendingSlayerChoices?.length, 1)
  assert(room.cardPreviews?.[annId], 'Ann\'s reveal is locked')
  assertEqual(rejectionOf(room, ann.token, { kind: 'playCard', cardUid: thinking.uid, topdeckUids: [revealed.cards[0].uid] }),
    'Finish the Nightmare choice')
  assert(answerNightmare(room, ann).changed, 'the choice is answerable through the reveal')
  assert(room.cardPreviews?.[annId], 'the reveal is still locked')
  assertDeepEqual(snapshotFor(room, ann.token).cardPreview.cards.map((held) => held.uid), revealed.cards.map((held) => held.uid))
  assertEqual(snapshotFor(room, bea.token).cardPreview, undefined, 'a teammate never sees it')
  assert(apply(room, ann.token, { kind: 'playCard', cardUid: thinking.uid, topdeckUids: [revealed.cards[0].uid] }).changed)
  assertEqual(room.cardPreviews?.[annId], undefined, 'finishing the card closes the reveal')
  assertDeepEqual(attachmentsByEnemy(room), [0, 0, 1])
})

check('online: a Nightmare+ answer is accepted while the owner has a forced card to play, which stays forced', () => {
  const finisher = card('strike_watcher')
  const havoc = card('havoc')
  const top = card('strike_ironclad')
  const { room, ann, bea, annId, beaId } = nightmareWindowRoom('SLAYWN6', {
    annHand: [havoc], beaHand: [finisher], hostHp: 1, ann: { draw: [top, card('defend_ironclad')] },
  })
  apply(room, ann.token, { kind: 'playCard', cardUid: havoc.uid })
  assertEqual(room.run.combat.startTurnProgress?.forcedCard?.cardUid, top.uid, 'Havoc forces the top card')
  killHostWith(room, bea, beaId, finisher)
  assertEqual(room.run.combat.pendingSlayerChoices?.length, 1)
  assertEqual(rejectionOf(room, ann.token, { kind: 'playCard', cardUid: top.uid, enemyUid: 'e2', playerId: annId }),
    'Finish the Nightmare choice')
  assert(answerNightmare(room, ann).changed, 'the choice is answerable before the forced card')
  assertEqual(room.run.combat.startTurnProgress?.forcedCard?.cardUid, top.uid, 'the card is still forced')
  assert(apply(room, ann.token, { kind: 'playCard', cardUid: top.uid, enemyUid: 'e2', playerId: annId }).changed)
  assertEqual(room.run.combat.startTurnProgress?.forcedCard, undefined)
  assertDeepEqual(attachmentsByEnemy(room), [0, 0, 1])
})

check('online: a Ritual Dagger+ winning blow is answered after the victory, then the room resolves the combat', () => {
  const room = createRoom(createStore(), { code: 'SLAYG3W' })
  const ann = joinRoom(room, { name: 'Ann', character: 'ironclad' })
  const bea = joinRoom(room, { name: 'Bea', character: 'watcher' })
  chooseCharacter(room, bea.token, 'watcher')
  startRun(room, ann.token, { seed: 9 })
  const annId = snapshotFor(room, ann.token).you.playerId
  const dagger = card('slayer_ritual_dagger', true)
  const players = room.run.players.map((candidate) => ({
    ...candidate, hand: candidate.id === annId ? [dagger] : [], draw: [], energy: 3,
    deck: candidate.id === annId ? [...candidate.deck, { ...dagger }] : candidate.deck,
    rareRewards: candidate.id === annId ? ['offering', 'barricade'] : candidate.rareRewards,
  }))
  room.run = { ...room.run, phase: 'combat', combat: createCombat(createRng(3), players, [enemy('e1', { hp: 3 })]) }
  apply(room, ann.token, { kind: 'playCard', cardUid: dagger.uid, enemyUid: 'e1', playerId: annId })
  assertEqual(room.run.combat.phase, 'won')
  let waited = false
  try { apply(room, bea.token, { kind: 'resolveCombat' }) } catch { waited = true }
  assert(waited && room.run.phase === 'combat', 'nobody can fold the fight away before the owner answers')
  assert(apply(room, ann.token, { kind: 'resolveSlayerChoice', choiceId: owedId(room), replace: true }).changed)
  assert(apply(room, bea.token, { kind: 'resolveCombat' }).changed)
  assertEqual(room.run.combat, null)
  assertDeepEqual(room.run.players.find((candidate) => candidate.id === annId).deck.find((held) => held.uid === dagger.uid),
    { uid: dagger.uid, defId: 'offering', upgraded: false })
})

check('online: another seat acting, or winning the fight, never drops a pending Ritual Dagger+ reveal', () => {
  const room = createRoom(createStore(), { code: 'SLAYG3X' })
  const ann = joinRoom(room, { name: 'Ann', character: 'ironclad' })
  const bea = joinRoom(room, { name: 'Bea', character: 'watcher' })
  chooseCharacter(room, bea.token, 'watcher')
  startRun(room, ann.token, { seed: 9 })
  const annId = snapshotFor(room, ann.token).you.playerId
  const beaId = snapshotFor(room, bea.token).you.playerId
  const dagger = card('slayer_ritual_dagger', true)
  const jab = card('strike_watcher', true)
  const finisher = card('strike_watcher', true)
  const players = room.run.players.map((candidate) => ({
    ...candidate, draw: [], energy: 3,
    hand: candidate.id === annId ? [dagger] : [jab, finisher],
    deck: candidate.id === annId ? [...candidate.deck, { ...dagger }] : candidate.deck,
    rareRewards: candidate.id === annId ? ['offering', 'barricade'] : candidate.rareRewards,
  }))
  room.run = { ...room.run, phase: 'combat', combat: createCombat(createRng(3), players,
    [enemy('e1', { hp: 3 }), enemy('e2', { hp: 4 })]) }
  apply(room, ann.token, { kind: 'playCard', cardUid: dagger.uid, enemyUid: 'e1', playerId: annId })
  assertEqual(room.run.combat.pendingSlayerChoices?.[0]?.playerId, annId)
  // A Heel Hook-style choice of Ann's is set aside in the same way while Bea acts.
  room.run = { ...room.run, combat: { ...room.run.combat, pendingPlayerChoices: [
    { id: 7, playerId: annId, sourceLabel: 'Heel Hook', kind: 'drawOrDiscard' }] } }
  assert(apply(room, bea.token, { kind: 'playCard', cardUid: jab.uid, enemyUid: 'e2', playerId: beaId }).changed,
    'Bea keeps acting while Ann decides')
  assertEqual(room.run.combat.pendingSlayerChoices?.[0]?.revealed, 'offering', 'Ann\'s reveal is put back after Bea\'s play')
  assertEqual(room.run.combat.pendingPlayerChoices?.[0]?.id, 7, 'and so is her other choice')
  assert(apply(room, bea.token, { kind: 'playCard', cardUid: finisher.uid, enemyUid: 'e2', playerId: beaId }).changed)
  assertEqual(room.run.combat.phase, 'won', 'Bea\'s blow wins the fight')
  assertDeepEqual(room.run.combat.pendingSlayerChoices, [{ id: 0, kind: 'ritualDagger', playerId: annId, cardUid: dagger.uid, revealed: 'offering' }],
    'Ann still owes her Ritual Dagger+ answer')
  assertEqual(room.run.combat.pendingPlayerChoices, undefined, 'mid-turn choices end with the combat, as in solo')
  assertEqual(snapshotFor(room, bea.token).run.combat.pendingSlayerChoices[0].revealed, null, 'still private')
  let waited = false
  try { apply(room, bea.token, { kind: 'resolveCombat' }) } catch { waited = true }
  assert(waited, 'the room waits for Ann')
  assert(apply(room, ann.token, { kind: 'resolveSlayerChoice', choiceId: owedId(room), replace: false }).changed)
  assert(apply(room, bea.token, { kind: 'resolveCombat' }).changed)
  assertEqual(room.run.combat, null)
  assertDeepEqual(room.run.players.find((candidate) => candidate.id === annId).rareRewards, ['barricade', 'offering'])
})

check('a dead owner\'s Slayer choice resolves itself and never holds the table (Last Stand)', () => {
  const lastStand = (players, enemies) => createCombat(createRng(11), players, enemies, 'g3-last-stand', [], 3, {}, true)
  const plus = { card: { uid: 'nm-dead', defId: 'slayer_nightmare', upgraded: true }, playerId: 'p2' }
  const strike = card('strike_ironclad', true)
  const fight = lastStand([player({ hand: [strike] }), ally({ dead: true, hp: 0 })],
    [enemy('e1', { hp: 2, slayerAttachments: [plus] }), enemy('e2'), enemy('e3', { row: 1 }), boss()])
  const after = play(fight, strike)
  assert(after.enemies[0].dead)
  assertEqual(after.pendingSlayerChoices, undefined, 'nobody waits for a dead owner')
  assertEqual(after.enemies[1].slayerAttachments?.[0]?.card.uid, 'nm-dead', 'Nightmare+ moves to the first other living enemy')

  // A state that already owes a dead player's reveal (loaded, or the owner died since).
  const owed = { kind: 'ritualDagger', playerId: 'p2', cardUid: 'rd-dead', revealed: 'offering' }
  const next = card('strike_ironclad')
  const loaded = { ...lastStand([player({ hand: [next] }), ally({ dead: true, hp: 0, rareRewards: ['offering', 'barricade'] })],
    [enemy('e1'), boss()]), pendingSlayerChoices: [owed] }
  const played = play(loaded, next)
  assert(played !== loaded, 'the living player is not locked out')
  assertEqual(played.pendingSlayerChoices, undefined)
  assertDeepEqual(me(played, 'p2').rareRewards, ['barricade', 'offering'], 'the reveal goes to the bottom')
  const alive = { ...lastStand([player({ hand: [card('strike_ironclad')], rareRewards: ['offering'] }), ally()],
    [enemy('e1'), boss()]), pendingSlayerChoices: [{ ...owed, playerId: 'p1' }] }
  assertEqual(play(alive, me(alive).hand[0]), alive, 'a living owner still holds the table until they answer')

  // Mixed table: p1 answers; only the dead p2's reveal settles itself, the living p3 still owes theirs.
  const third = player({ id: 'p3', name: 'Cal', row: 2, rareRewards: ['offering', 'barricade'] })
  const mixed = { ...lastStand([player({ rareRewards: ['offering', 'barricade'] }),
    ally({ dead: true, hp: 0, rareRewards: ['offering', 'barricade'] }), third], [enemy('e1'), boss()]),
  pendingSlayerChoices: [{ ...owed, playerId: 'p1' }, owed, { ...owed, playerId: 'p3' }] }
  const answered = answer(mixed, 'p1', { replace: false })
  assertDeepEqual(me(answered).rareRewards, ['barricade', 'offering'], 'p1 bottomed theirs')
  assertDeepEqual(me(answered, 'p2').rareRewards, ['barricade', 'offering'], 'the dead p2\'s reveal went to the bottom')
  assertDeepEqual(me(answered, 'p3').rareRewards, ['offering', 'barricade'], 'the living p3\'s rare deck is untouched')
  assertDeepEqual(answered.pendingSlayerChoices?.map((choice) => choice.playerId), ['p3'], 'and p3 still owes the answer')
})

check('online Last Stand: a dead seat\'s pending reveal is settled, and the living seat plays on', () => {
  const room = createRoom(createStore(), { code: 'SLAYG3D' })
  const ann = joinRoom(room, { name: 'Ann', character: 'ironclad' })
  const bea = joinRoom(room, { name: 'Bea', character: 'watcher' })
  chooseCharacter(room, bea.token, 'watcher')
  startRun(room, ann.token, { seed: 9 })
  const annId = snapshotFor(room, ann.token).you.playerId
  const beaId = snapshotFor(room, bea.token).you.playerId
  const strike = card('strike_ironclad')
  const players = room.run.players.map((candidate) => ({
    ...candidate, draw: [], energy: 3,
    hand: candidate.id === annId ? [strike] : [],
    ...(candidate.id === beaId ? { dead: true, hp: 0, rareRewards: ['offering', 'barricade'] } : {}),
  }))
  room.run = { ...room.run, phase: 'combat', combat: {
    ...createCombat(createRng(3), players, [enemy('e1'), boss()], 'g3-room-last-stand', [], 3, {}, true),
    pendingSlayerChoices: [{ kind: 'ritualDagger', playerId: beaId, cardUid: 'rd-dead', revealed: 'offering' }],
  } }
  assert(apply(room, ann.token, { kind: 'playCard', cardUid: strike.uid, enemyUid: 'e1', playerId: annId }).changed,
    'Ann is not told to wait for a dead seat')
  assertEqual(room.run.combat.pendingSlayerChoices, undefined)
  assertDeepEqual(room.run.combat.players.find((candidate) => candidate.id === beaId).rareRewards, ['barricade', 'offering'])
})

check('attached cards deal nothing while their owner deals no damage this turn', () => {
  const strike = card('strike_ironclad')
  const defend = card('defend_watcher')
  const state = combat([player({ character: 'watcher', hand: [strike, defend], damageDealtZeroThisTurn: true })], [enemy('e1', {
    slayerAttachments: [
      { card: { uid: 'nm-z', defId: 'slayer_nightmare', upgraded: false }, playerId: 'p1' },
      { card: { uid: 'pp-z', defId: 'slayer_pressure_points', upgraded: true }, playerId: 'p1' },
    ],
  })])
  const after = play(play(state, strike), defend, { enemyUid: null })
  assertEqual(lost(state, after), 0, 'no Strike damage, no Nightmare ping, no Pressure Points ping')
  const normal = combat([player({ character: 'watcher', hand: [strike, defend] })], [enemy('e1', { slayerAttachments: state.enemies[0].slayerAttachments })])
  assertEqual(lost(normal, play(play(normal, strike), defend, { enemyUid: null })), 1 + 1 + 2, 'the same plays otherwise deal 4')
})

check('Bowling Bash: on a no-damage turn the adjacent clause deals nothing and still resolves', () => {
  const board = [enemy('a'), enemy('b'), enemy('c', { row: 1 })]
  const bash = card('slayer_bowling_bash', true)
  const zero = combat([player({ character: 'watcher', hand: [bash], damageDealtZeroThisTurn: true }), ally()], board)
  const after = play(zero, bash, { enemyUid: 'a' })
  assert(after !== zero && !me(after).hand.length, 'the card is still played')
  assertDeepEqual(after.enemies.map((candidate) => lost(zero, after, candidate.uid)), [0, 0, 0])
  const normal = combat([player({ character: 'watcher', hand: [bash] }), ally()], board)
  const hit = play(normal, bash, { enemyUid: 'a' })
  assertDeepEqual(hit.enemies.map((candidate) => lost(normal, hit, candidate.uid)), [3, 3, 3], 'otherwise 3, 3 and 3')
})

check('a card that falls off mid-resolution never pings: The Champ revives after the first Pressure Points kill', () => {
  const pp = (uid) => ({ card: { uid, defId: 'slayer_pressure_points', upgraded: false }, playerId: 'p1' })
  const defend = card('defend_watcher')
  const state = combat([player({ character: 'watcher', hand: [defend] })], [
    enemy('champ', { defId: 'the_champ', isBoss: true, hp: 1, maxHp: 40, abilityUsed: false, slayerAttachments: [pp('pp-1'), pp('pp-2')] }),
  ])
  const after = play(state, defend, { enemyUid: null })
  const champ = after.enemies[0]
  assertEqual(champ.defId, 'the_champ_fury', 'the first ping kills The Champ, who returns at once')
  assertEqual(champ.hp, 40, 'the second Pressure Points fell off with the first death and does not ping the revived Champ')
  assertEqual(champ.slayerAttachments, undefined)
  assertDeepEqual(me(after).discard.map((held) => held.uid).filter((uid) => uid.startsWith('pp-')).sort(), ['pp-1', 'pp-2'])
})

check('a host that leaves combat (Looter) is not dead: its cards, Nightmare+ included, are discarded and never ping', () => {
  const pp = { card: { uid: 'pp-l', defId: 'slayer_pressure_points', upgraded: true }, playerId: 'p1' }
  const plus = { card: { uid: 'nm-l', defId: 'slayer_nightmare', upgraded: true }, playerId: 'p1' }
  let state = combat([player({ character: 'watcher', hp: 20, maxHp: 20, gold: 5 })], [
    enemy('looter', { defId: 'looter', hp: 9, maxHp: 9, actionIndex: 2, slayerAttachments: [pp, plus] }),
    enemy('e2', { row: 1 }), enemy('e3', { row: 1 }),
  ])
  state = enemyTurn(endPlayerTurn(state))
  const looter = state.enemies[0]
  assert(looter.dead, 'the Looter left combat')
  assertEqual(looter.slayerAttachments, undefined, 'nothing stays on it')
  assertDeepEqual(me(state).discard.map((held) => held.uid).filter((uid) => uid === 'pp-l' || uid === 'nm-l').sort(), ['nm-l', 'pp-l'],
    'both cards go to their owner\'s discard pile')
  assertEqual(state.pendingSlayerChoices, undefined, 'leaving is not dying: Nightmare+ does not move')
  assert(state.enemies.slice(1).every((candidate) => !candidate.slayerAttachments), 'and is not attached anywhere else')

  // An older state that still has a card on a departed enemy: no ping, no damage counted.
  const defend = card('defend_watcher')
  const stale = combat([player({ character: 'watcher', hand: [defend] })], [
    enemy('gone', { dead: true, slayerAttachments: [pp] }), enemy('e2'),
  ])
  const after = play(stale, defend, { enemyUid: null })
  assertEqual(after.enemies[0].hp, stale.enemies[0].hp)
  assert(!after.log.some((line) => line.includes('Pressure Points')), 'no ping is logged against a departed enemy')
})

// A Mayhem-forced card can kill a Nightmare+ host or a Ritual Dagger+ target while Start of Turn is
// paused. The owed answer has to be accepted then, or the Start-of-Turn gate and the mandatory-choice
// gate refuse each other forever.
function mayhemStartRoom(code, { second = false } = {}) {
  const room = createRoom(createStore(), { code })
  const ann = joinRoom(room, { name: 'Ann', character: 'silent' })
  const bea = second ? joinRoom(room, { name: 'Bea', character: 'ironclad' }) : null
  startRun(room, ann.token, { seed: 9 })
  const annId = snapshotFor(room, ann.token).you.playerId
  const dagger = card('slayer_ritual_dagger', true)
  const beaForced = card('defend_ironclad')
  const defends = (id, n) => Array.from({ length: n }, () => card(id))
  const players = room.run.players.map((candidate) => ({
    ...candidate, hand: [], discard: [], energy: 3, hp: 30, maxHp: 30, rareRewards: ['offering', 'barricade'],
    // Mayhem plays the card right after each seat's Start-of-Turn draw (Silent draws 7 with Ring of the Snake, Ironclad 5).
    draw: candidate.id === annId
      ? [...defends('defend_silent', 7), dagger, ...defends('defend_silent', 4)]
      : [...defends('defend_ironclad', 5), beaForced, ...defends('defend_ironclad', 4)],
    powers: candidate.id === annId && !second
      ? [card('mayhem'), card('tools_of_the_trade')] : [card('mayhem')],
  }))
  room.run = { ...room.run, phase: 'combat', combat: startPlayerTurn(createCombat(createRng(3), players,
    [enemy('e1', { hp: 2 }), enemy('e2')])) }
  return { room, ann, bea, annId, dagger, beaForced }
}

check('online: a Mayhem-forced Ritual Dagger+ kill is answerable while Start of Turn waits on Tools of the Trade', () => {
  const { room, ann, annId, dagger } = mayhemStartRoom('SLAYMA1')
  assertEqual(room.run.combat.startTurnProgress?.forcedCard?.cardUid, dagger.uid, 'Mayhem forces the dagger')
  apply(room, ann.token, { kind: 'playCard', cardUid: dagger.uid, enemyUid: 'e1', playerId: annId })
  assertEqual(room.run.combat.phase, 'start', 'Start of Turn is still paused on the Tools of the Trade discard')
  assertEqual(room.run.combat.pendingSlayerChoices?.[0]?.kind, 'ritualDagger')
  const discard = snapshotFor(room, ann.token).startTurnDiscard
  assert(discard, 'the discard prompt is open')
  assertEqual(rejectionOf(room, ann.token, { kind: 'resolveStartTurnDiscard', sourceId: discard.sourceId, discardUid: discard.cards[0].uid }),
    'Finish the Ritual Dagger choice', 'the owed answer comes first')
  assert(apply(room, ann.token, { kind: 'resolveSlayerChoice', choiceId: owedId(room), replace: false }).changed,
    'the answer is accepted during Start of Turn')
  assertEqual(room.run.combat.pendingSlayerChoices, undefined)
  assertEqual(room.run.combat.phase, 'start', 'the paused Start of Turn is still waiting on its discard')
  apply(room, ann.token, { kind: 'resolveStartTurnDiscard', sourceId: discard.sourceId, discardUid: discard.cards[0].uid })
  assertEqual(room.run.combat.phase, 'player', 'and then finishes')
})

check('online: Mayhem on two seats: the first seat\'s Dagger+ answer resumes the second seat\'s forced card', () => {
  const { room, ann, bea, annId, dagger, beaForced } = mayhemStartRoom('SLAYMA2', { second: true })
  assertEqual(room.run.combat.startTurnProgress?.forcedCard?.cardUid, dagger.uid)
  apply(room, ann.token, { kind: 'playCard', cardUid: dagger.uid, enemyUid: 'e1', playerId: annId })
  assertEqual(room.run.combat.pendingSlayerChoices?.[0]?.playerId, annId)
  assertEqual(room.run.combat.startTurnProgress?.forcedCard?.cardUid, beaForced.uid, 'Bea\'s forced card is next')
  assertEqual(rejectionOf(room, bea.token, { kind: 'playCard', cardUid: beaForced.uid, enemyUid: 'e2' }),
    'Wait for the Ritual Dagger choice', 'Bea waits for Ann\'s answer')
  assert(apply(room, ann.token, { kind: 'resolveSlayerChoice', choiceId: owedId(room), replace: true }).changed)
  assertEqual(room.run.combat.phase, 'player', 'Start of Turn resumed and finished')
  assert(room.run.combat.players.find((candidate) => candidate.id !== annId).discard.some((held) => held.uid === beaForced.uid),
    'Bea\'s forced card was played automatically')
  assertEqual(room.run.combat.players.find((candidate) => candidate.id === annId).exhaust.some((held) => held.defId === 'offering'), true,
    'Replace put the revealed rare where the dagger was')
})

check('online: a disconnected Mayhem-forced Dagger+ owner is answered for and the next forced card plays', () => {
  const { room, ann, annId, dagger, beaForced } = mayhemStartRoom('SLAYMA3', { second: true })
  apply(room, ann.token, { kind: 'playCard', cardUid: dagger.uid, enemyUid: 'e1', playerId: annId })
  assertEqual(room.run.combat.pendingSlayerChoices?.length, 1)
  markDisconnected(room, ann.token)
  assertEqual(room.run.combat.pendingSlayerChoices, undefined, 'the absent owner kept the rare on the bottom')
  assertEqual(room.run.combat.phase, 'player')
  assert(room.run.combat.players.find((candidate) => candidate.id !== annId).discard.some((held) => held.uid === beaForced.uid))
})

// Each Slayer choice carries a public id and every answer names it, so a double-click (or a replayed
// message) cannot resolve the owner's next choice with the answer meant for the first.
function twoNightmaresDie() {
  const plus = (uid) => ({ card: { uid, defId: 'slayer_nightmare', upgraded: true }, playerId: 'p1' })
  const strike = card('strike_ironclad')
  const state = combat([player({ hand: [strike] }), ally()], [
    enemy('e1', { hp: 1, slayerAttachments: [plus('nm-a'), plus('nm-b')] }), enemy('e2'), enemy('e3', { row: 1 }),
  ])
  return play(state, strike)
}

check('Slayer choices carry distinct ids, and an answer must name the choice it is for', () => {
  const crowd = twoNightmaresDie()
  const [first, second] = crowd.pendingSlayerChoices
  assertEqual(crowd.pendingSlayerChoices.length, 2, 'both Nightmare+ owe a choice')
  assert(Number.isSafeInteger(first.id) && Number.isSafeInteger(second.id) && first.id !== second.id, 'each has its own id')
  assertEqual(resolveSlayerChoice(crowd, 'p1', { enemyUid: 'e2' }), crowd, 'an answer with no id is refused')
  assertEqual(resolveSlayerChoice(crowd, 'p1', { choiceId: second.id, enemyUid: 'e2' }), crowd,
    'the second choice cannot be answered ahead of the first')
  assertEqual(resolveSlayerChoice(crowd, 'p1', { choiceId: first.id + 100, enemyUid: 'e2' }), crowd, 'an unknown id is refused')
  const once = resolveSlayerChoice(crowd, 'p1', { choiceId: first.id, enemyUid: 'e2' })
  assertEqual(once.pendingSlayerChoices.length, 1, 'only the first choice resolved')
  assertEqual(once.pendingSlayerChoices[0].id, second.id)
  assertEqual(once.enemies[1].slayerAttachments?.length, 1, 'one card moved to e2')
  // The same answer sent twice (a double-click): the repeat is the first choice's, which is spent.
  assertEqual(resolveSlayerChoice(once, 'p1', { choiceId: first.id, enemyUid: 'e2' }), once, 'the repeat is refused')
  const twice = resolveSlayerChoice(once, 'p1', { choiceId: second.id, enemyUid: 'e3' })
  assertEqual(twice.pendingSlayerChoices, undefined)
  assertEqual(twice.enemies[2].slayerAttachments?.length, 1, 'the second answer reached the second card')
  // The counter is shared with player choices and never reissues an id.
  assert(twice.nextPlayerChoiceId > second.id, 'the shared counter moved past both ids')
})

check('a Slayer choice saved before ids existed is still answerable, without one', () => {
  const crowd = twoNightmaresDie()
  const legacy = structuredClone(crowd)
  for (const choice of legacy.pendingSlayerChoices) delete choice.id
  delete legacy.nextPlayerChoiceId
  assertEqual(resolveSlayerChoice(legacy, 'p1', { choiceId: 0, enemyUid: 'e2' }), legacy, 'an id cannot answer an id-less choice')
  const answered = resolveSlayerChoice(legacy, 'p1', { enemyUid: 'e2' })
  assertEqual(answered.pendingSlayerChoices.length, 1)
  assertEqual(answered.pendingSlayerChoices[0].id, undefined)
})

check('online: the room refuses a Slayer answer with a repeated, stale, missing or malformed id', () => {
  const { room, ann, bea, annId } = nightmareEndTurnRoom('SLAYID1', () => [])
  const plus = (uid) => ({ card: card('slayer_nightmare', true, { uid }), playerId: annId })
  room.run.combat = { ...room.run.combat, phase: 'player', endTurnProgress: undefined,
    enemies: room.run.combat.enemies.map((candidate) => candidate.uid === 'e1'
      ? { ...candidate, dead: false, hp: 1, slayerAttachments: [plus('nm-a'), plus('nm-b')] } : { ...candidate, dead: false }) }
  room.endTurnReady = undefined
  room.endTurnAbilities = undefined
  const strike = card('strike_ironclad')
  room.run.combat.players.find((candidate) => candidate.id === annId).hand = [strike]
  apply(room, ann.token, { kind: 'playCard', cardUid: strike.uid, enemyUid: 'e1', playerId: annId })
  const [first, second] = room.run.combat.pendingSlayerChoices
  assertEqual(room.run.combat.pendingSlayerChoices.length, 2)
  assertDeepEqual(snapshotFor(room, bea.token).run.combat.pendingSlayerChoices.map((choice) => choice.id), [first.id, second.id],
    'the ids are public: the table sees which choice is which')
  assert(rejects(room, ann.token, { kind: 'resolveSlayerChoice', enemyUid: 'e2' }), 'no id')
  assert(rejects(room, ann.token, { kind: 'resolveSlayerChoice', choiceId: String(first.id), enemyUid: 'e2' }), 'a malformed id')
  assert(rejects(room, ann.token, { kind: 'resolveSlayerChoice', choiceId: 1.5, enemyUid: 'e2' }), 'a fractional id')
  assert(rejects(room, ann.token, { kind: 'resolveSlayerChoice', choiceId: second.id, enemyUid: 'e2' }), 'the second ahead of the first')
  assert(apply(room, ann.token, { kind: 'resolveSlayerChoice', choiceId: first.id, enemyUid: 'e2' }).changed)
  assertEqual(rejectionOf(room, ann.token, { kind: 'resolveSlayerChoice', choiceId: first.id, enemyUid: 'e2' }),
    'That choice is no longer legal', 'the double-click\'s second message is refused')
  assertEqual(room.run.combat.pendingSlayerChoices.length, 1, 'and it did not resolve the second choice')
  assertEqual(room.run.combat.enemies[1].slayerAttachments?.length, 1)
  assert(apply(room, ann.token, { kind: 'resolveSlayerChoice', choiceId: second.id, enemyUid: 'e3' }).changed)
  assertEqual(room.run.combat.pendingSlayerChoices, undefined)
  assertEqual(room.run.combat.enemies[2].slayerAttachments?.length, 1)
})

report('slayer-attach-and-hits')
