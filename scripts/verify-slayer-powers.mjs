// The Slayer Pack, the powers group: Powers that stay in play and react to the game.
//
// Brutality, Infernal Blade, Caltrops, Eviscerate, Phantasmal Killer, Fasting,
// Chrysalis, Bandage Up, Panic Button, Companion and Metamorphosis. Every check
// plays the real engine (solo, hot-seat and the room server share it) and reads
// the outcome off the board, for both printed faces of each card.
import {
  activatePower,
  beginEndPlayerTurn,
  beginEndTurnResolution,
  cardIsPlayable,
  createCombat,
  endPlayerTurn,
  endTurnAbilities,
  endTurnResolutionAbility,
  enemyTurn,
  metamorphosisCost,
  pendingTriggerAbility,
  playCard,
  preparePlayerTurn,
  previewCardDamage,
  resolveEndTurnAbility,
  resolvePendingTrigger,
  resolveStartPlayerTurn,
  selfExhaustEndTurnTarget,
  spendShiv,
  startPlayerTurn,
  startTurnAbilities,
  chooseEndTurnTarget,
  resolveDeterministicForcedCard,
} from '../src/game/combat.ts'
import { CARDS, faceOf } from '../src/game/cards.ts'
import { metamorphosisPlayEffects } from '../src/game/combat/queries.ts'
import { settle } from '../src/game/combat/effects.ts'
import { ENEMIES } from '../src/game/enemies.ts'
import { createRng } from '../src/game/rng.ts'
import { canUpgradeCard, resolveCampfire } from '../src/game/run.ts'
import { postNeowRun } from './lib/post-neow-run.mjs'
import { apply, createRoom, createStore, joinRoom, markDisconnected, snapshotFor, startRun } from './lib/rooms.mjs'
import { suite, check, assert, assertDeepEqual, assertEqual, report } from './lib/harness.mjs'

let uid = 0
const instance = (defId, upgraded = false) => ({ uid: `c${uid++}`, defId, upgraded })
const deck = (n = 10, id = 'strike_ironclad') => Array.from({ length: n }, () => instance(id))

const player = (over = {}) => ({
  id: 'p1', name: 'Ann', character: 'ironclad', row: 0,
  hp: 10, maxHp: 10, block: 0, energy: 3, gold: 0,
  deck: [], draw: deck(), hand: [], discard: [], exhaust: [], powers: [],
  relics: [], potions: [], cardRewards: [], rareRewards: [],
  strength: 0, vulnerable: 0, weak: 0, shivs: 0, miracles: 0,
  stance: 'neutral', orbs: [null, null, null], dead: false, ...over,
})

// Fixture enemies with fixed, readable intents.
ENEMIES.g2b_double_hitter = {
  id: 'g2b_double_hitter', name: 'Double Hitter', hpByPlayers: [30, 30, 30, 30],
  pattern: { kind: 'single', actions: [{ kind: 'attack', amount: 1, times: 2 }] },
}
ENEMIES.g2b_hitter = {
  id: 'g2b_hitter', name: 'Hitter', hpByPlayers: [30, 30, 30, 30],
  pattern: { kind: 'single', actions: [{ kind: 'attack', amount: 3 }] },
}
ENEMIES.g2b_idler = {
  id: 'g2b_idler', name: 'Idler', hpByPlayers: [30, 30, 30, 30],
  pattern: { kind: 'single', actions: [{ kind: 'idle' }] },
}
ENEMIES.g2b_area = {
  id: 'g2b_area', name: 'Area Hitter', hpByPlayers: [30, 30, 30, 30],
  pattern: { kind: 'single', actions: [{ kind: 'attack', amount: 1, aoe: true }] },
}

const enemy = (over = {}) => ({
  uid: 'e1', defId: 'g2b_idler', row: 0, isBoss: false,
  hp: 30, maxHp: 30, block: 0,
  strength: 0, vulnerable: 0, weak: 0, poison: 0, actionIndex: 0, abilityUsed: true, dead: false, ...over,
})

const combat = (players, enemies) => createCombat(createRng(7), players, enemies)
const play = (state, card, context = {}, playerId = 'p1') =>
  playCard(state, playerId, card.uid, { enemyUid: null, playerId, ...context })
const hpOf = (state) => state.enemies.map((target) => target.hp)
/** Plays the round out to the next Start of Turn, with its abilities not yet resolved. */
const nextRound = (state) => preparePlayerTurn(enemyTurn(endPlayerTurn(state)))

suite('slayer powers — Brutality')

check('both faces draw 1 card when played and stay in play', () => {
  for (const upgraded of [false, true]) {
    const brutality = instance('slayer_brutality', upgraded)
    const state = combat([player({ hand: [brutality], energy: 0 })], [enemy()])
    const next = play(state, brutality)
    assert(next !== state, 'Brutality costs 0 on both faces')
    assertEqual(next.players[0].hand.length, 1, `Brutality${upgraded ? '+' : ''} draws 1 card`)
    assertDeepEqual(next.players[0].powers.map((power) => power.uid), [brutality.uid])
  }
})

check('the last round\'s HP loss is captured at the next Reset and forgotten one round later', () => {
  const start = startPlayerTurn(combat([player()], [enemy({ defId: 'g2b_hitter' })]))
  assertEqual(start.players[0].lostHpLastRound, undefined, 'nothing was lost before the first round')
  const hit = nextRound(start)
  assertEqual(hit.players[0].hp, 7, 'the Hitter landed 3 damage')
  assertEqual(hit.players[0].lostHpLastRound, true, 'the Enemy Turn loss belongs to the round that just ended')
  assertEqual(hit.players[0].hpLostThisRound, 0, 'this round starts clean')

  const blocked = startPlayerTurn({ ...combat([player({ block: 0 })], [enemy({ defId: 'g2b_idler' })]) })
  const quiet = nextRound(blocked)
  assertEqual(quiet.players[0].lostHpLastRound, undefined, 'no loss leaves no field behind')
})

check('Brutality fires once for a round of HP loss, not again after a second round without any', () => {
  const brutal = combat([player({ powers: [instance('slayer_brutality')] })], [enemy({ defId: 'g2b_hitter' })])
  const resolveBrutality = (prepared) => {
    const [ability] = startTurnAbilities(prepared)
    return resolveStartPlayerTurn(prepared, [{ id: ability.id, enemyUid: 'e1', shivEnemyUids: [] }])
  }
  const hit = nextRound(startPlayerTurn(brutal))
  assertEqual(hit.players[0].lostHpLastRound, true, 'the Hitter took HP')
  const fired = resolveBrutality(hit)
  assertEqual(fired.enemies[0].vulnerable, 1, 'the first round after the loss fires it')
  const idle = { ...fired, enemies: fired.enemies.map((foe) => ({ ...foe, defId: 'g2b_idler', vulnerable: 0 })) }
  const quiet = nextRound(idle)
  assertEqual(quiet.players[0].lostHpLastRound, undefined, 'a round with no loss forgets the flag')
  assertEqual(resolveBrutality(quiet).enemies[0].vulnerable, 0, 'so Brutality does not fire a second time')
})

check('Start of turn: Vulnerable on the chosen enemy only after losing HP last round', () => {
  const brutality = instance('slayer_brutality')
  const base = combat([player({ powers: [brutality] })], [enemy(), enemy({ uid: 'e2', row: 1 })])
  const lost = preparePlayerTurn({ ...base, players: [{ ...base.players[0], hpLostThisRound: 2 }] })
  const [ability] = startTurnAbilities(lost)
  assertDeepEqual(ability.targets.map((target) => target.uid), ['e1', 'e2'], 'the owner picks the enemy')
  assert(resolveStartPlayerTurn(lost, [{ id: ability.id, shivEnemyUids: [] }]) === lost,
    'the Vulnerable cannot resolve without its enemy')
  const resolved = resolveStartPlayerTurn(lost, [{ id: ability.id, enemyUid: 'e2', shivEnemyUids: [] }])
  assertDeepEqual(resolved.enemies.map((target) => target.vulnerable), [0, 1])

  const calm = preparePlayerTurn(base)
  const [idle] = startTurnAbilities(calm)
  assert((idle.targets?.length ?? 0) <= 1, 'with no HP lost the target choice changes nothing, so none is asked')
  const nothing = resolveStartPlayerTurn(calm, [{ id: idle.id, enemyUid: idle.targets?.[0]?.uid, shivEnemyUids: [] }])
  assertDeepEqual(nothing.enemies.map((target) => target.vulnerable), [0, 0], 'no HP lost, no Vulnerable')
})

check('Brutality+ puts Vulnerable on a whole chosen row and the boss', () => {
  const brutality = instance('slayer_brutality', true)
  const base = combat([player({ powers: [brutality] })], [
    enemy(), enemy({ uid: 'e2', row: 0 }), enemy({ uid: 'e3', row: 1 }), enemy({ uid: 'boss', row: 2, isBoss: true }),
  ])
  const prepared = preparePlayerTurn({ ...base, players: [{ ...base.players[0], hpLostThisRound: 1 }] })
  const [ability] = startTurnAbilities(prepared)
  const resolved = resolveStartPlayerTurn(prepared, [{ id: ability.id, enemyUid: 'e3', shivEnemyUids: [] }])
  assertDeepEqual(resolved.enemies.map((target) => target.vulnerable), [0, 0, 1, 1], 'row 2 and the boss')
})

suite('slayer powers — Infernal Blade')

check('activates once per turn only while a Status or Curse is in hand', () => {
  for (const upgraded of [false, true]) {
    const blade = instance('slayer_infernal_blade', upgraded)
    const played = play(combat([player({ hand: [blade], energy: 1 })], [enemy(), enemy({ uid: 'e2' })]), blade)
    assertEqual(played.players[0].energy, upgraded ? 1 : 0, `Infernal Blade${upgraded ? '+' : ''} costs ${upgraded ? 0 : 1}`)
    const clean = { ...played, players: [{ ...played.players[0], hand: [instance('strike_ironclad')] }] }
    assert(activatePower(clean, 'p1', blade.uid, { enemyUid: 'e2' }) === clean, 'no Status or Curse in hand')
    for (const junk of ['daze', 'burn', 'slimed', 'regret']) {
      const ready = { ...played, players: [{ ...played.players[0], hand: [instance(junk)] }] }
      const used = activatePower(ready, 'p1', blade.uid, { enemyUid: 'e2' })
      assertDeepEqual(used.enemies.map((target) => target.weak), [0, 1], `${junk} in hand enables the Weak`)
      assert(activatePower(used, 'p1', blade.uid, { enemyUid: 'e1' }) === used, 'once per turn')
    }
  }
})

check('the once-per-turn use comes back next turn', () => {
  const blade = instance('slayer_infernal_blade')
  const state = startPlayerTurn(combat([player({ powers: [blade], draw: [instance('daze'), ...deck(9)] })], [enemy()]))
  const used = activatePower(state, 'p1', blade.uid, { enemyUid: 'e1' })
  assertEqual(used.enemies[0].weak, 1)
  const later = startPlayerTurn(enemyTurn(endPlayerTurn(used)))
  const withDaze = { ...later, players: [{ ...later.players[0], hand: [...later.players[0].hand, instance('daze')] }] }
  const again = activatePower(withDaze, 'p1', blade.uid, { enemyUid: 'e1' })
  assert(again !== withDaze, 'a new turn allows a new activation')
})

suite('slayer powers — Caltrops')

check('End of turn: damage per hit icon to each enemy intending to attack you', () => {
  for (const [upgraded, perIcon] of [[false, 1], [true, 2]]) {
    const caltrops = instance('slayer_caltrops', upgraded)
    const state = startPlayerTurn(combat([player({ powers: [caltrops], hp: 30, maxHp: 30 })], [
      enemy({ uid: 'twin', defId: 'g2b_double_hitter' }),
      enemy({ uid: 'other-row', row: 1, defId: 'g2b_double_hitter' }),
      enemy({ uid: 'area', row: 1, defId: 'g2b_area' }),
      enemy({ uid: 'idle', defId: 'g2b_idler' }),
      enemy({ uid: 'shielded', defId: 'g2b_hitter', block: 1 }),
    ]))
    const ended = endPlayerTurn(state)
    assertDeepEqual(hpOf(ended), [30 - 2 * perIcon, 30, 30 - perIcon, 30, 30 - (perIcon - 1)],
      `Caltrops${upgraded ? '+' : ''}: two icons in the row, none for another row, AoE counts, idle none, Block absorbs`)
  }
})

suite('slayer powers — Eviscerate')

check('a card discard deals damage per discarded card; end-of-turn discards do not', () => {
  for (const [upgraded, per] of [[false, 1], [true, 2]]) {
    const eviscerate = instance('slayer_eviscerate', upgraded)
    const survivor = instance('survivor')
    const filler = instance('strike_silent')
    const state = combat([player({ character: 'silent', powers: [eviscerate], hand: [survivor, filler] })], [enemy()])
    const next = play(state, survivor, { discardUids: [filler.uid] })
    assertEqual(next.enemies[0].hp, 30 - per, `Eviscerate${upgraded ? '+' : ''}: one discarded card`)

    const many = combat([player({ character: 'silent', powers: [eviscerate], hand: [instance('strike_silent'), instance('strike_silent')] })], [enemy()])
    assertEqual(endPlayerTurn(many).enemies[0].hp, 30, 'the end-of-turn discard is not a card\'s effect')
  }
})

check('the count follows the cards actually discarded, and the owner chooses the enemy', () => {
  const eviscerate = instance('slayer_eviscerate', true)
  const acrobatics = instance('acrobatics')
  const hand = [acrobatics, instance('strike_silent'), instance('strike_silent')]
  const allIn = combat([player({ character: 'silent', powers: [eviscerate], hand, draw: deck(5) })],
    [enemy(), enemy({ uid: 'e2' })])
  const acro = faceOf(CARDS.acrobatics, false).effects.find((effect) => effect.kind === 'discard')
  assert(acro, 'Acrobatics prints a discard')
  const discards = hand.slice(1, 1 + acro.amount).map((card) => card.uid)
  const played = play(allIn, acrobatics, { discardUids: discards })
  const pending = pendingTriggerAbility(played)
  assert(pending, 'two enemies: Eviscerate waits for its target')
  assertDeepEqual(pending.targets.map((target) => target.uid), ['e1', 'e2'])
  assert(resolvePendingTrigger(played, 'p1', pending.id, undefined, 'gone') === played, 'a stale target is refused')
  const resolved = resolvePendingTrigger(played, 'p1', pending.id, undefined, 'e2')
  assertDeepEqual(hpOf(resolved), [30, 30 - 2 * discards.length], '2 damage per discarded card on the chosen enemy')
})

check('a queued Eviscerate trigger carries its whole discard count to the chosen enemy', () => {
  for (const [upgraded, per] of [[false, 1], [true, 2]]) {
    const eviscerate = instance('slayer_eviscerate', upgraded)
    const prepared = instance('prepared', true)
    const hand = [prepared, instance('strike_silent'), instance('strike_silent'), instance('strike_silent')]
    const state = combat([player({ character: 'silent', powers: [eviscerate], hand, draw: deck(5) })],
      [enemy(), enemy({ uid: 'e2' })])
    const discards = [hand[1].uid, hand[2].uid]
    const played = play(state, prepared, { discardUids: discards })
    const pending = pendingTriggerAbility(played)
    assert(pending, 'two enemies: Eviscerate waits for its target')
    assertEqual(played.pendingTriggers.length, 1, 'one trigger for the whole discard')
    const resolved = resolvePendingTrigger(played, 'p1', pending.id, undefined, 'e2')
    assertDeepEqual(hpOf(resolved), [30, 30 - per * discards.length], `${discards.length} discards, ${per} damage each`)
  }
})

check('a second queued Eviscerate keeps its discard count when the first one\'s kill leaves it no choice', () => {
  const prepared = instance('prepared', true)
  const hand = [prepared, instance('strike_silent'), instance('strike_silent')]
  const state = combat([player({ character: 'silent', hand, draw: deck(5),
    powers: [instance('slayer_eviscerate'), instance('slayer_eviscerate')] })],
  [enemy({ hp: 2 }), enemy({ uid: 'e2' })])
  const played = play(state, prepared, { discardUids: [hand[1].uid, hand[2].uid] })
  assertEqual(played.pendingTriggers.length, 2, 'both Eviscerates wait behind the enemy choice')
  const resolved = resolvePendingTrigger(played, 'p1', pendingTriggerAbility(played).id, undefined, 'e1')
  assert(resolved.enemies[0].dead, 'the first Eviscerate killed e1 with its 2 discards')
  assertDeepEqual(hpOf(resolved), [0, 28], 'the second one, with nobody left to choose, still deals 2')
  assertEqual(resolved.pendingTriggers.length, 0)
})

check('a Start-of-Turn card discard (Tools of the Trade) carries its count to the chosen enemy', () => {
  const eviscerate = instance('slayer_eviscerate')
  const state = combat([player({ character: 'silent', powers: [instance('tools_of_the_trade'), eviscerate] })],
    [enemy(), enemy({ uid: 'e2' })])
  const started = startPlayerTurn(state)
  const pending = pendingTriggerAbility(started)
  assert(pending?.label.includes('Eviscerate'), `Eviscerate waits for a target: ${pending?.label}`)
  const resolved = resolvePendingTrigger(started, 'p1', pending.id, undefined, 'e1')
  assertDeepEqual(hpOf(resolved), [29, 30], 'one discarded card, 1 damage')
  assertEqual(resolved.phase, 'player', 'and the turn goes on')
})

suite('slayer powers — Phantasmal Killer')

check('both faces gain their printed Shivs when played', () => {
  for (const [upgraded, shivs] of [[false, 1], [true, 2]]) {
    const killer = instance('slayer_phantasmal_killer', upgraded)
    const next = play(combat([player({ character: 'silent', hand: [killer] })], [enemy()]), killer)
    assertEqual(next.players[0].shivs, shivs)
    assertEqual(next.players[0].powers.length, 1)
  }
})

check('a Shiv aimed at another row splashes that row, not the first enemy\'s', () => {
  const killer = instance('slayer_phantasmal_killer')
  const state = combat([player({ character: 'silent', powers: [killer], shivs: 1 })], [
    enemy({ uid: 'a' }), enemy({ uid: 'b' }), enemy({ uid: 'c', row: 1 }), enemy({ uid: 'd', row: 1 }),
    enemy({ uid: 'boss', row: 2, isBoss: true }),
  ])
  assertDeepEqual(hpOf(spendShiv(state, 'p1', 'c')), [30, 30, 28, 29, 29], 'row 1 and the boss only; row 0 untouched')
})

check('every Shiv also deals 1 damage to its target\'s row and the boss', () => {
  const killer = instance('slayer_phantasmal_killer')
  const state = combat([player({ character: 'silent', powers: [killer], shivs: 2 })], [
    enemy({ uid: 'a' }), enemy({ uid: 'b' }), enemy({ uid: 'c', row: 1 }), enemy({ uid: 'boss', row: 2, isBoss: true }),
  ])
  const next = spendShiv(state, 'p1', 'a')
  assertDeepEqual(hpOf(next), [28, 29, 30, 29], 'Shiv 1 + row 1 on the target; row 1 elsewhere; boss; not row 2')

  const lethal = combat([player({ character: 'silent', powers: [killer], shivs: 1 })],
    [enemy({ uid: 'a', hp: 1 }), enemy({ uid: 'b' })])
  const killed = spendShiv(lethal, 'p1', 'a')
  assert(killed.enemies[0].dead, 'the Shiv kills its target')
  assertEqual(killed.enemies[1].hp, 29, 'the target\'s row is still damaged')

  const twice = combat([player({ character: 'silent', powers: [killer, instance('slayer_phantasmal_killer')], shivs: 1 })],
    [enemy({ uid: 'a' }), enemy({ uid: 'b' })])
  assertDeepEqual(hpOf(spendShiv(twice, 'p1', 'a')), [27, 28], 'each copy in play deals its own damage')
})

check('a Shiv thrown immediately from a full supply also triggers it', () => {
  const killer = instance('slayer_phantasmal_killer')
  const blade = instance('blade_dance')
  const state = combat([player({ character: 'silent', powers: [killer], shivs: 5, hand: [blade] })],
    [enemy({ uid: 'a' }), enemy({ uid: 'b' })])
  const thrown = faceOf(CARDS.blade_dance, false).effects.find((effect) => effect.kind === 'gainShiv').amount
  const next = play(state, blade, { shivEnemyUids: Array(thrown).fill('a') })
  assertDeepEqual(hpOf(next), [30 - 2 * thrown, 30 - thrown], 'each overflow Shiv hits and splashes the row')
})

suite('slayer powers — Fasting')

check('+1 on each hit and Block icon of the owner\'s Attacks and Skills, never on Shivs', () => {
  const fasting = instance('slayer_fasting')
  const strike = instance('strike_watcher')
  const twin = instance('flurry_of_blows')
  const defend = instance('defend_watcher')
  const state = combat([player({ character: 'watcher', powers: [fasting], hand: [strike, defend, twin], shivs: 1 })], [enemy()])
  assertEqual(play(state, strike, { enemyUid: 'e1' }).enemies[0].hp, 28, 'Strike 1 + 1')
  assertEqual(play(state, defend).players[0].block, 2, 'Defend 1 + 1 Block')
  const flurry = faceOf(CARDS.flurry_of_blows, false).effects.find((effect) => effect.kind === 'hit')
  const icons = typeof flurry.times === 'number' ? flurry.times : 1
  assertEqual(30 - play(state, twin, { enemyUid: 'e1' }).enemies[0].hp, (flurry.amount + 1) * icons,
    'each hit icon of a multi-hit card gets the +1')
  assertEqual(spendShiv(state, 'p1', 'e1').enemies[0].hp, 29, 'a Shiv is a token, not a card: no bonus')
  const preview = previewCardDamage(state, 'p1', strike.uid, 'e1')
  assertDeepEqual(preview, { damage: 2, baseline: 1 }, 'the damage badge includes Fasting and marks it as a bonus')
})

check('Start of turn loses a Miracle, or discards Fasting when there is none', () => {
  for (const upgraded of [false, true]) {
    const fasting = instance('slayer_fasting', upgraded)
    const hand = combat([player({ character: 'watcher', hand: [fasting], energy: 3 })], [enemy()])
    assertEqual(play(hand, fasting).players[0].energy, upgraded ? 2 : 1, `Fasting${upgraded ? '+' : ''} cost`)
    const fed = startPlayerTurn(combat([player({ character: 'watcher', powers: [fasting], miracles: 2 })], [enemy()]))
    assertEqual(fed.players[0].miracles, 1, 'a Miracle is spent')
    assertEqual(fed.players[0].powers.length, 1, 'and Fasting stays')
    const starved = startPlayerTurn(combat([player({ character: 'watcher', powers: [fasting] })], [enemy()]))
    assertEqual(starved.players[0].powers.length, 0, 'no Miracle: Fasting leaves play')
    assertDeepEqual(starved.players[0].discard.map((card) => card.uid), [fasting.uid], 'into the discard pile')
    const strike = starved.players[0].hand.find((card) => card.defId === 'strike_ironclad')
    assertEqual(play(starved, strike, { enemyUid: 'e1' }).enemies[0].hp, 29, 'and its bonus is gone')
  }
})

suite('slayer powers — Chrysalis')

check('draws 2 on the first Skill each turn only', () => {
  for (const upgraded of [false, true]) {
    const chrysalis = instance('slayer_chrysalis', upgraded)
    const fromHand = play(combat([player({ hand: [chrysalis], energy: 3 })], [enemy()]), chrysalis)
    assertEqual(fromHand.players[0].energy, upgraded ? 2 : 1, `Chrysalis${upgraded ? '+' : ''} cost`)
    const [a, b, strike] = [instance('defend_ironclad'), instance('defend_ironclad'), instance('strike_ironclad')]
    const state = combat([player({ powers: [chrysalis], hand: [strike, a, b], draw: deck(6) })], [enemy()])
    const attacked = play(state, strike, { enemyUid: 'e1' })
    assertEqual(attacked.players[0].hand.length, 2, 'an Attack draws nothing')
    const first = play(attacked, a)
    assertEqual(first.players[0].hand.length, 3, 'the first Skill draws 2')
    const second = play(first, b)
    assertEqual(second.players[0].hand.length, 2, 'the second Skill draws nothing')
    const later = startPlayerTurn(enemyTurn(endPlayerTurn(second)))
    const defend = instance('defend_ironclad')
    const ready = { ...later, players: [{ ...later.players[0], hand: [defend], draw: deck(4) }] }
    assertEqual(play(ready, defend).players[0].hand.length, 2, 'the next turn resets it')
  }
})

suite('slayer powers — Bandage Up')

check('draws 1 when played; the next HP loss is 1 less, then it leaves play', () => {
  for (const [upgraded, pile] of [[false, 'exhaust'], [true, 'discard']]) {
    const bandage = instance('slayer_bandage_up', upgraded)
    const played = play(combat([player({ hand: [bandage], energy: 0 })], [enemy()]), bandage)
    assertEqual(played.players[0].hand.length, 1, 'draw 1')
    const struck = enemyTurn(endPlayerTurn(combat([player({ powers: [bandage] })], [enemy({ defId: 'g2b_hitter' })])))
    assertEqual(struck.players[0].hp, 8, '3 damage becomes 2 HP lost')
    assertEqual(struck.players[0].powers.length, 0)
    assertDeepEqual(struck.players[0][pile].map((card) => card.uid), [bandage.uid], `Bandage Up${upgraded ? '+' : ''} goes to ${pile}`)
  }
})

check('Block that stops the damage, or Buffer, leaves Bandage Up unspent; several copies answer in turn', () => {
  const bandage = instance('slayer_bandage_up')
  const blocked = enemyTurn(endPlayerTurn(combat([player({ powers: [bandage], block: 5 })], [enemy({ defId: 'g2b_hitter' })])))
  assertEqual(blocked.players[0].hp, 10)
  assertEqual(blocked.players[0].powers.length, 1, 'no HP lost, Bandage Up stays')

  const buffered = enemyTurn(endPlayerTurn(combat([player({ powers: [instance('buffer'), bandage] })], [enemy({ defId: 'g2b_hitter' })])))
  assertEqual(buffered.players[0].hp, 10, 'Buffer prevents the loss')
  assertDeepEqual(buffered.players[0].powers.map((power) => power.defId), ['slayer_bandage_up'], 'Bandage Up is not spent')

  const two = enemyTurn(endPlayerTurn(combat([player({ powers: [bandage, instance('slayer_bandage_up')] })], [enemy({ defId: 'g2b_hitter' })])))
  assertEqual(two.players[0].hp, 9, 'two copies take 2 off a 3-HP loss')
  assertEqual(two.players[0].exhaust.length, 2)

  const one = enemyTurn(endPlayerTurn(combat([player({ powers: [bandage, instance('slayer_bandage_up')] })],
    [enemy({ defId: 'g2b_double_hitter' })])))
  assertEqual(one.players[0].hp, 10, 'each 1-damage hit is absorbed by one copy')
  assertEqual(one.players[0].powers.length, 0, 'and each copy is spent on its own hit')

  const brink = enemyTurn(endPlayerTurn(combat([player({ powers: [instance('slayer_bandage_up')], hp: 2 })],
    [enemy({ defId: 'g2b_hitter' })])))
  assert(brink.players[0].dead || brink.phase === 'lost', 'the reduction comes off the 3, so 2 HP still falls')
})

check('self-inflicted HP loss is reduced too', () => {
  const bandage = instance('slayer_bandage_up')
  const hemo = instance('offering')
  const loss = faceOf(CARDS.offering, false).effects.find((effect) => effect.kind === 'loseOwnHp')
  assert(loss, 'Offering prints a self HP loss')
  const next = play(combat([player({ powers: [bandage], hand: [hemo] })], [enemy()]), hemo)
  assertEqual(next.players[0].hp, 10 - Math.max(0, loss.amount - 1))
})

suite('slayer powers — Panic Button')

check('you cannot lose HP; Start of turn gains Vulnerable and Exhausts it; Retain keeps it in hand', () => {
  for (const [upgraded, vulnerable] of [[false, 2], [true, 1]]) {
    const panic = instance('slayer_panic_button', upgraded)
    const kept = endPlayerTurn(combat([player({ hand: [panic] })], [enemy()]))
    assert(kept.players[0].hand.some((card) => card.uid === panic.uid), 'Retain keeps it in hand')

    const played = play(combat([player({ hand: [panic], energy: 0 })], [enemy({ defId: 'g2b_hitter' })]), panic)
    const struck = enemyTurn(endPlayerTurn(played))
    assertEqual(struck.players[0].hp, 10, 'the 3 damage takes no HP')
    assertEqual(struck.players[0].lostHpThisCombat, false)
    const next = startPlayerTurn(struck)
    assertEqual(next.players[0].vulnerable, vulnerable, `Panic Button${upgraded ? '+' : ''} gains ${vulnerable} Vulnerable`)
    assertDeepEqual(next.players[0].exhaust.map((card) => card.uid), [panic.uid], 'and Exhausts')
    assertEqual(next.players[0].lostHpLastRound, undefined, 'Brutality sees no HP lost')
  }
  const capped = startPlayerTurn(combat([player({ powers: [instance('slayer_panic_button')], vulnerable: 2 })], [enemy()]))
  assertEqual(capped.players[0].vulnerable, 3, 'Vulnerable is capped at 3')
  const hemo = instance('offering')
  const self = play(combat([player({ powers: [instance('slayer_panic_button')], hand: [hemo] })], [enemy()]), hemo)
  assertEqual(self.players[0].hp, 10, 'self-inflicted HP loss is stopped too')
})

suite('slayer powers — Companion')

check('the egg is an unplayable dead card that every upgrade path can hatch', () => {
  const egg = instance('slayer_companion')
  const state = combat([player({ hand: [egg], energy: 3 })], [enemy()])
  assert(play(state, egg) === state, 'the egg cannot be played')
  assert(!cardIsPlayable(faceOf(CARDS.slayer_companion, false), state, state.players[0]))
  assert(canUpgradeCard(egg), 'the egg can be upgraded')
  const run = postNeowRun(11, [{ id: 'p1', name: 'Ann', character: 'ironclad' }])
  const campfireId = run.map.rows[run.map.rows.length - 2][0]
  const atFire = { ...run, phase: 'room', map: { ...run.map, position: campfireId },
    players: run.players.map((member) => ({ ...member, deck: [...member.deck, egg] })) }
  const smithed = resolveCampfire(atFire, { p1: { choice: 'smith', cardUid: egg.uid } })
  assert(smithed.players[0].deck.find((card) => card.uid === egg.uid)?.upgraded, 'Smith hatches the dragon')
  const dragon = faceOf(CARDS.slayer_companion, true)
  assertEqual(dragon.cost, 1)
  assertEqual(dragon.unplayable, false)
})

check('the dragon deals 4 at end of turn and may also Exhaust itself for 3 Block', () => {
  const dragon = instance('slayer_companion', true)
  const played = play(combat([player({ hand: [dragon], energy: 1 })], [enemy()]), dragon)
  assertEqual(played.players[0].powers.length, 1, 'the hatched Companion is a Power for 1 Energy')

  const state = combat([player({ powers: [dragon] })], [enemy(), enemy({ uid: 'e2', row: 1 })])
  const ability = endTurnAbilities(state).find((candidate) => candidate.id.includes(dragon.uid))
  assertDeepEqual(ability.targets.map((target) => target.uid),
    ['e1', 'e2', selfExhaustEndTurnTarget('e1'), selfExhaustEndTurnTarget('e2')], 'each enemy, with and without Exhaust')
  const begun = beginEndTurnResolution(state)
  assert(endTurnResolutionAbility(begun), 'the owner must choose')
  assert(resolveEndTurnAbility(begun, chooseEndTurnTarget(ability.id, 'nobody')) === begun, 'an invalid target is refused')
  const kept = resolveEndTurnAbility(begun, chooseEndTurnTarget(ability.id, 'e2'))
  assertDeepEqual(hpOf(kept), [30, 26])
  assertEqual(kept.players[0].block, 0)
  assertEqual(kept.players[0].powers.length, 1, 'Companion stays without the Exhaust')
  const spent = resolveEndTurnAbility(begun, chooseEndTurnTarget(ability.id, selfExhaustEndTurnTarget('e1')))
  assertDeepEqual(hpOf(spent), [26, 30])
  assertEqual(spent.players[0].block, 3, 'the Exhaust grants 3 Block')
  assertDeepEqual(spent.players[0].exhaust.map((card) => card.uid), [dragon.uid])

  const solo = combat([player({ powers: [dragon] })], [enemy()])
  const soloBegun = beginEndTurnResolution(solo)
  assert(endTurnResolutionAbility(soloBegun), 'even one enemy asks, because the Exhaust is optional')
})

check('Companion\'s Exhaust removes only itself, never the owner\'s other Powers', () => {
  const dragon = instance('slayer_companion', true)
  const others = [instance('slayer_caltrops'), instance('slayer_fasting')]
  const state = combat([player({ powers: [others[0], dragon, others[1]] })], [enemy()])
  const begun = beginEndTurnResolution(state)
  const ability = endTurnAbilities(state).find((candidate) => candidate.id.includes(dragon.uid))
  const spent = resolveEndTurnAbility(begun, chooseEndTurnTarget(ability.id, selfExhaustEndTurnTarget('e1')))
  assertDeepEqual(spent.players[0].exhaust.map((card) => card.uid), [dragon.uid], 'only Companion was Exhausted')
  assertDeepEqual(spent.players[0].powers.map((power) => power.uid), others.map((power) => power.uid),
    'the other Powers stay in play in order')
})

suite('slayer powers — Metamorphosis')

check('needs an active Power and exactly the copied cost (+1 on the base face)', () => {
  const caltrops = instance('slayer_caltrops')
  for (const [upgraded, x] of [[false, 2], [true, 1]]) {
    const meta = instance('slayer_metamorphosis', upgraded)
    const empty = combat([player({ hand: [meta], energy: 3 })], [enemy()])
    assert(!cardIsPlayable(faceOf(CARDS.slayer_metamorphosis, upgraded), empty, empty.players[0]), 'no Power, no play')
    assert(play(empty, meta, { energySpent: 0 }) === empty)
    const state = combat([player({ hand: [meta], powers: [caltrops], energy: 3 })], [enemy()])
    assertEqual(metamorphosisCost(state.players[0], caltrops.uid, upgraded), x)
    assert(play(state, meta, { energySpent: x }) === state, 'the attached Power must be named')
    assert(play(state, meta, { energySpent: x + 1, metamorphosisPowerUid: caltrops.uid }) === state, 'X is fixed')
    assert(play(state, meta, { energySpent: x, metamorphosisPowerUid: 'gone' }) === state, 'a stale Power is refused')
    const next = play(state, meta, { energySpent: x, metamorphosisPowerUid: caltrops.uid })
    assertEqual(next.players[0].energy, 3 - x, `Metamorphosis${upgraded ? '+' : ''} costs ${x}`)
    const copy = next.players[0].powers.find((power) => power.uid === meta.uid)
    assertEqual(copy.defId, 'slayer_caltrops', 'it is in play as a copy of Caltrops')
    assertDeepEqual(copy.metamorphosis, { upgraded, sourceUid: caltrops.uid })
    const poor = { ...state, players: [{ ...state.players[0], energy: x - 1 }] }
    assert(play(poor, meta, { energySpent: x, metamorphosisPowerUid: caltrops.uid }) === poor, 'unaffordable')
  }
})

check('the copy doubles the Power\'s effect and keeps its own once-per-turn use', () => {
  const caltrops = instance('slayer_caltrops')
  const meta = instance('slayer_metamorphosis')
  const state = startPlayerTurn(combat([player({ hand: [meta], powers: [caltrops], energy: 3, hp: 30, maxHp: 30 })],
    [enemy({ defId: 'g2b_double_hitter' })]))
  const attached = play(state, meta, { energySpent: 2, metamorphosisPowerUid: caltrops.uid })
  assertEqual(endPlayerTurn(attached).enemies[0].hp, 26, 'two Caltrops: 2 x 2 icons')

  const blade = instance('slayer_infernal_blade')
  const meta2 = instance('slayer_metamorphosis', true)
  const twin = play(combat([player({ hand: [meta2, instance('daze')], powers: [blade], energy: 3 })],
    [enemy(), enemy({ uid: 'e2' })]), meta2, { energySpent: 1, metamorphosisPowerUid: blade.uid })
  const first = activatePower(twin, 'p1', blade.uid, { enemyUid: 'e1' })
  const second = activatePower(first, 'p1', meta2.uid, { enemyUid: 'e2' })
  assertDeepEqual(second.enemies.map((target) => target.weak), [1, 1], 'each copy activates once')
})

check('copying a lasting modifier applies it again', () => {
  const accuracy = instance('accuracy')
  const meta = instance('slayer_metamorphosis', true)
  const created = combat([player({ character: 'silent', hand: [meta], powers: [accuracy], energy: 3 })], [enemy()])
  const state = { ...created, players: [{ ...created.players[0], shivDamageBonus: 1 }] }
  const cost = metamorphosisCost(state.players[0], accuracy.uid, true)
  const next = play(state, meta, { energySpent: cost, metamorphosisPowerUid: accuracy.uid })
  assertEqual(next.players[0].shivDamageBonus, 2, 'a second Accuracy')
})

check('it leaves play with the copied Power, as the Metamorphosis card', () => {
  const panic = instance('slayer_panic_button')
  const meta = instance('slayer_metamorphosis', true)
  const attached = play(combat([player({ hand: [meta], powers: [panic], energy: 0 })], [enemy()]), meta,
    { energySpent: 0, metamorphosisPowerUid: panic.uid })
  const next = startPlayerTurn(attached)
  assertEqual(next.players[0].powers.length, 0, 'Panic Button exhausted itself and the copy followed')
  assertDeepEqual(next.players[0].exhaust.map((card) => card.defId).sort(), ['slayer_metamorphosis', 'slayer_panic_button'])
  const restored = next.players[0].exhaust.find((card) => card.uid === meta.uid)
  assertDeepEqual(restored, { uid: meta.uid, defId: 'slayer_metamorphosis', upgraded: true }, 'its own identity back')

  const fasting = instance('slayer_fasting')
  const meta2 = instance('slayer_metamorphosis')
  const fed = play(combat([player({ character: 'watcher', hand: [meta2], powers: [fasting], energy: 3, miracles: 1 })], [enemy()]),
    meta2, { energySpent: 3, metamorphosisPowerUid: fasting.uid })
  const strike = instance('strike_watcher')
  const withStrike = { ...fed, players: [{ ...fed.players[0], hand: [strike], energy: 1 }] }
  assertEqual(play(withStrike, strike, { enemyUid: 'e1' }).enemies[0].hp, 27, 'two Fastings: Strike 1 + 2')
  const oneMiracle = startPlayerTurn(fed)
  assertEqual(oneMiracle.players[0].miracles, 0, 'the original pays the only Miracle')
  assertDeepEqual(oneMiracle.players[0].powers.map((power) => power.uid), [fasting.uid], 'the copy has none and leaves alone')
  assertDeepEqual(oneMiracle.players[0].discard.map((card) => card.defId), ['slayer_metamorphosis'])
  const starved = startPlayerTurn({ ...fed, players: [{ ...fed.players[0], miracles: 0 }] })
  assertEqual(starved.players[0].powers.length, 0, 'the original Fasting was discarded and the copy followed')
  assertDeepEqual(starved.players[0].discard.map((card) => card.defId).sort(), ['slayer_fasting', 'slayer_metamorphosis'])
})

check('a copied Bandage Up answers the same HP loss before following its original out', () => {
  const bandage = instance('slayer_bandage_up')
  const meta = instance('slayer_metamorphosis', true)
  const attached = play(combat([player({ hand: [meta], powers: [bandage], energy: 0 })], [enemy({ defId: 'g2b_hitter' })]),
    meta, { energySpent: 0, metamorphosisPowerUid: bandage.uid })
  const struck = enemyTurn(endPlayerTurn(attached))
  assertEqual(struck.players[0].hp, 9, 'both take 1 off the 3 damage')
  assertDeepEqual(struck.players[0].exhaust.map((card) => card.defId).sort(), ['slayer_bandage_up', 'slayer_metamorphosis'])
})

check('copying a Metamorphosis costs what that one was played for', () => {
  const caltrops = instance('slayer_caltrops')
  const first = instance('slayer_metamorphosis')
  const second = instance('slayer_metamorphosis', true)
  const state = combat([player({ hand: [first, second], powers: [caltrops], energy: 6 })], [enemy()])
  const once = play(state, first, { energySpent: 2, metamorphosisPowerUid: caltrops.uid })
  assertEqual(metamorphosisCost(once.players[0], first.uid, true), 2, 'X paid for the first copy')
  const twice = play(once, second, { energySpent: 2, metamorphosisPowerUid: first.uid })
  assertEqual(twice.players[0].powers.filter((power) => power.defId === 'slayer_caltrops').length, 3)

  // A real exit: Panic Button+ Exhausts itself, and a copy of a copy follows down the chain.
  const panic = instance('slayer_panic_button', true)
  const [m1, m2] = [instance('slayer_metamorphosis', true), instance('slayer_metamorphosis', true)]
  let chain = combat([player({ hand: [m1, m2], powers: [panic], energy: 0 })], [enemy()])
  chain = play(chain, m1, { energySpent: 0, metamorphosisPowerUid: panic.uid })
  chain = play(chain, m2, { energySpent: 0, metamorphosisPowerUid: m1.uid })
  const gone = startPlayerTurn(chain)
  assertEqual(gone.players[0].powers.length, 0, 'the whole chain follows the original out of play')
  assertDeepEqual(gone.players[0].exhaust.map((card) => card.defId).sort(),
    ['slayer_metamorphosis', 'slayer_metamorphosis', 'slayer_panic_button'])
})

suite('slayer powers — online room')

/** A two-seat room parked on a fixture combat; seat ids replace p1/p2. */
function onlineRoom(build) {
  const room = createRoom(createStore(), { code: 'GTWOB' })
  const owner = joinRoom(room, { name: 'Ann', character: 'ironclad' })
  const peer = joinRoom(room, { name: 'Bo', character: 'silent' })
  startRun(room, owner.token, { seed: 912 })
  const state = build()
  state.players[0].id = owner.playerId
  state.players[1].id = peer.playerId
  room.run = { ...room.run, phase: 'combat', combat: state }
  return { room, owner, peer }
}

check('Metamorphosis travels through the room server with its chosen Power', () => {
  const caltrops = instance('slayer_caltrops')
  const meta = instance('slayer_metamorphosis')
  const { room, owner, peer } = onlineRoom(() => combat([
    player({ hand: [meta], powers: [caltrops], energy: 3 }), player({ id: 'p2', name: 'Bo', row: 1 }),
  ], [enemy(), enemy({ uid: 'e2', row: 1 })]))
  const before = room.run.combat
  apply(room, owner.token, { kind: 'playCard', cardUid: meta.uid, energySpent: 2, metamorphosisPowerUid: 42 })
  assert(room.run.combat === before || room.run.combat.players[0].hand.length === 1, 'a malformed Power id is refused')
  apply(room, owner.token, { kind: 'playCard', cardUid: meta.uid, energySpent: 2, metamorphosisPowerUid: caltrops.uid })
  const seen = snapshotFor(room, peer.token).run.combat.players[0]
  assertEqual(seen.hand, null, 'the owner\'s hand stays private')
  assertDeepEqual(seen.powers.find((power) => power.uid === meta.uid)?.metamorphosis, { upgraded: false, sourceUid: caltrops.uid },
    'teammates see the attached copy')
  assertEqual(room.run.combat.players[0].energy, 1)
})

check('Companion\'s optional Exhaust and Brutality\'s last-round flag work for online seats', () => {
  const dragon = instance('slayer_companion', true)
  const { room, owner, peer } = onlineRoom(() => combat([
    player({ powers: [dragon], hp: 30, maxHp: 30 }), player({ id: 'p2', name: 'Bo', row: 1 }),
  ], [enemy(), enemy({ uid: 'e2', row: 1 })]))
  apply(room, owner.token, { kind: 'endTurn' })
  apply(room, peer.token, { kind: 'endTurn' })
  const published = snapshotFor(room, owner.token).endTurnAbilities?.[0]
  assert(published?.targets.some((target) => target.uid === selfExhaustEndTurnTarget('e2')), 'the Exhaust choice is published')
  assertDeepEqual(snapshotFor(room, peer.token).endTurnAbilities?.[0]?.targets.map((target) => target.uid),
    published.targets.map((target) => target.uid), 'a public Power\'s choices are visible to the table')
  let refused = false
  try {
    apply(room, peer.token, { kind: 'resolveEndTurnEffect', abilityId: published.id, targetUid: 'e2' })
  } catch { refused = true }
  assert(refused, 'only the owner resolves it')
  apply(room, owner.token, { kind: 'resolveEndTurnEffect', abilityId: published.id, targetUid: selfExhaustEndTurnTarget('e2') })
  const after = room.run.combat
  assertEqual(after.enemies[1].hp, 26)
  assert(after.players[0].exhaust.some((card) => card.uid === dragon.uid), 'Companion was Exhausted')
  assert(after.log.some((line) => /Companion\+: Ann gains 3 Block/.test(line)), 'and granted 3 Block')

  const brutal = onlineRoom(() => {
    const state = combat([player({ powers: [instance('slayer_brutality')] }), player({ id: 'p2', name: 'Bo', row: 1 })], [enemy()])
    state.players[0].lostHpLastRound = true
    return state
  })
  assertEqual(snapshotFor(brutal.room, brutal.peer.token).run.combat.players[0].lostHpLastRound, true,
    'the public last-round flag reaches every seat')
})

suite('slayer powers — audit fixes')

ENEMIES.g2b_spear = {
  id: 'g2b_spear', name: 'Facing Spear', hpByPlayers: [30, 30, 30, 30],
  pattern: { kind: 'single', actions: [{ kind: 'attack', amount: 4, facing: true }] },
}

check('Caltrops aims as the Enemy Turn does: Facing, Last Stand redirection, a second player', () => {
  const caltrops = () => instance('slayer_caltrops')
  // A Spire Spear in another row that I face hits me; one in my row facing my ally does not.
  const facing = startPlayerTurn(combat([
    player({ powers: [caltrops()], hp: 30, maxHp: 30, facingEnemyUid: 'far' }),
    player({ id: 'p2', name: 'Bo', row: 1, hp: 30, maxHp: 30, facingEnemyUid: 'near' }),
  ], [enemy({ uid: 'near', defId: 'g2b_spear' }), enemy({ uid: 'far', row: 1, defId: 'g2b_spear' })]))
  const keepFacing = (state) => ({ ...state, players: state.players.map((member, index) =>
    ({ ...member, facingEnemyUid: index === 0 ? 'far' : 'near' })) })
  const aimed = endPlayerTurn(keepFacing(facing))
  assertDeepEqual(hpOf(aimed), [30, 29], 'only the Spear I face takes Caltrops damage')

  // Last Stand: a dead row-1 player's attacker turns on me in row 0.
  const lastStand = combat([
    player({ powers: [caltrops()], hp: 30, maxHp: 30 }),
    player({ id: 'p2', name: 'Bo', row: 1, hp: 0, dead: true }),
  ], [enemy({ uid: 'redirected', row: 1, defId: 'g2b_hitter' }), enemy({ uid: 'boss', row: 2, isBoss: true })])
  lastStand.lastStand = true
  assertDeepEqual(hpOf(endPlayerTurn(lastStand)), [29, 30], 'the redirected Hit 3 is aimed at me')

  // Multi-hit icons, and each player's Caltrops answers its own attackers.
  const party = endPlayerTurn(combat([
    player({ powers: [instance('slayer_caltrops', true)], hp: 30, maxHp: 30 }),
    player({ id: 'p2', name: 'Bo', row: 1, hp: 30, maxHp: 30, powers: [caltrops()] }),
  ], [enemy({ uid: 'twin', defId: 'g2b_double_hitter' }), enemy({ uid: 'single', row: 1, defId: 'g2b_hitter' }),
    enemy({ uid: 'area', row: 1, defId: 'g2b_area' })]))
  assertDeepEqual(hpOf(party), [26, 29, 27], 'Caltrops+ 2x2 on the twin; Bo 1 on his attacker; the AoE takes 2 + 1')
})

ENEMIES.g2b_split = {
  id: 'g2b_split', name: 'Split Hitter', hpByPlayers: [30, 30, 30, 30],
  pattern: { kind: 'single', actions: [{ kind: 'attackSequence', hits: [{ amount: 1 }, { amount: 1 }, { amount: 1, aoe: true }] }] },
}

check('Caltrops counts only the hits of a multi-hit attack aimed at its owner', () => {
  const ended = endPlayerTurn(combat([
    player({ powers: [instance('slayer_caltrops')], hp: 30, maxHp: 30 }),
    player({ id: 'p2', name: 'Bo', row: 1, hp: 30, maxHp: 30 }),
  ], [enemy({ uid: 'split', row: 1, defId: 'g2b_split' })]))
  assertEqual(ended.enemies[0].hp, 29, 'two row hits land on Bo; only the AoE hit is aimed at me')
  const ally = endPlayerTurn(combat([
    player({ hp: 30, maxHp: 30 }),
    player({ id: 'p2', name: 'Bo', row: 1, hp: 30, maxHp: 30, powers: [instance('slayer_caltrops')] }),
  ], [enemy({ uid: 'split', row: 1, defId: 'g2b_split' })]))
  assertEqual(ally.enemies[0].hp, 27, 'Bo, in its row, counts all three hits')
})

check('Flame Barrier shares the same aim (Facing)', () => {
  const barrier = instance('flame_barrier')
  const state = combat([player({ hand: [barrier], energy: 2, facingEnemyUid: 'far' })],
    [enemy({ uid: 'near', defId: 'g2b_spear' }), enemy({ uid: 'far', row: 1, defId: 'g2b_spear' })])
  assertDeepEqual(hpOf(play(state, barrier)), [30, 29], 'only the faced Spear is attacking me')
})

check('Eviscerate ignores a card falling off a dead enemy, but not Survivor or Reboot discards', () => {
  const eviscerate = instance('slayer_eviscerate')
  const nightmare = instance('slayer_nightmare')
  const strike = instance('strike_silent')
  const state = combat([player({ character: 'silent', powers: [eviscerate], hand: [strike] })], [
    enemy({ uid: 'host', hp: 1, slayerAttachments: [{ card: nightmare, playerId: 'p1' }] }), enemy({ uid: 'other' }),
    enemy({ uid: 'third', row: 1 }),
  ])
  const killed = play(state, strike, { enemyUid: 'host' })
  assert(killed.enemies[0].dead, 'the host dies')
  assert(killed.players[0].discard.some((card) => card.uid === nightmare.uid) ||
    killed.players[0].exhaust.some((card) => card.uid === nightmare.uid) ||
    (killed.pendingSlayerChoices?.length ?? 0) > 0, 'Nightmare left the enemy')
  // Two enemies remain, so a fired Eviscerate would have to ask for its target.
  assertEqual(pendingTriggerAbility(killed), undefined, 'no Eviscerate target prompt')
  assertEqual(killed.pendingTriggers.length, 0, 'and no Eviscerate trigger is queued')
  assertDeepEqual(hpOf(killed).slice(1), [30, 30], 'and nothing was damaged')

  const reboot = instance('slayer_reboot')
  const rebooted = play(combat([player({ character: 'defect', powers: [eviscerate],
    hand: [reboot, instance('strike_defect'), instance('strike_defect')], draw: deck(5) })], [enemy()]), reboot)
  assertEqual(rebooted.enemies[0].hp, 28, 'Reboot discarding 2 cards deals 2')
})

check('a Metamorphosis copy takes only lasting modifiers, never one-shot "When played" lines', () => {
  const bandage = instance('slayer_bandage_up')
  const meta = instance('slayer_metamorphosis', true)
  const copied = play(combat([player({ hand: [meta], powers: [bandage], energy: 0, draw: deck(5) })], [enemy()]),
    meta, { energySpent: 0, metamorphosisPowerUid: bandage.uid })
  assertEqual(copied.players[0].hand.length, 0, 'a copied Bandage Up draws nothing')
  const electro = instance('electrodynamics')
  const meta2 = instance('slayer_metamorphosis', true)
  const cost = faceOf(CARDS.electrodynamics, false).cost
  const channelled = play(combat([player({ character: 'defect', hand: [meta2], powers: [electro], energy: cost })], [enemy()]),
    meta2, { energySpent: cost, metamorphosisPowerUid: electro.uid })
  assertDeepEqual(channelled.players[0].orbs, [null, null, null], 'a copied Electrodynamics channels nothing')
  const oneShot = new Set(['draw', 'gainShiv', 'channel', 'block', 'load', 'heal', 'gainEnergy', 'evoke', 'scry',
    'clearDebuffs', 'sequence', 'discard', 'addDaze'])
  for (const def of Object.values(CARDS).filter((card) => card.type === 'power')) {
    for (const upgraded of [false, true]) {
      const leaked = metamorphosisPlayEffects(faceOf(def, upgraded)).filter((effect) => oneShot.has(effect.kind))
      assertDeepEqual(leaked, [], `${def.id}${upgraded ? '+' : ''} leaks a one-shot play clause into a copy`)
    }
  }
})

check('a copy of a copy reproduces the original X-cost Power as played', () => {
  const blade = instance('conjure_blade')
  const first = instance('slayer_metamorphosis')
  const second = instance('slayer_metamorphosis', true)
  let state = combat([player({ character: 'watcher', hand: [blade, first, second], energy: 6 })], [enemy()])
  state = play(state, blade, { energySpent: 2 })
  const once = state.players[0].starterStrikeDamageBonus
  state = { ...state, players: [{ ...state.players[0], energy: 6 }] }
  state = play(state, first, { energySpent: 3, metamorphosisPowerUid: blade.uid })
  assertEqual(state.players[0].starterStrikeDamageBonus, once * 2, 'the copy adds the X = 2 effect again')
  state = play(state, second, { energySpent: 3, metamorphosisPowerUid: first.uid })
  assertEqual(state.players[0].starterStrikeDamageBonus, once * 3, 'the copy of the copy still uses X = 2')
})

check('through a play window the fixed cost is X: only a Power with exactly that X can be attached', () => {
  const caltrops = instance('slayer_caltrops')
  const demon = instance('demon_form')
  const enlightenment = instance('slayer_enlightenment')
  const meta = instance('slayer_metamorphosis', true)
  let state = combat([player({ hand: [enlightenment, meta], powers: [demon, caltrops], energy: 3, draw: deck(3) })], [enemy()])
  state = play(state, enlightenment)
  assert(state.pendingCardPlayWindows?.at(-1)?.cardUids.includes(meta.uid), 'Metamorphosis+ is offered at 1')
  assert(play(state, meta, { metamorphosisPowerUid: demon.uid }) === state, 'Demon Form needs X = 3, not the window\'s 1')
  const attached = play(state, meta, { metamorphosisPowerUid: caltrops.uid })
  assertEqual(attached.players[0].energy, state.players[0].energy - 1, 'Caltrops (X = 1) attaches for the window\'s 1')

  const transmutation = instance('slayer_transmutation')
  const base = instance('slayer_metamorphosis')
  let free = combat([player({ hand: [transmutation], powers: [caltrops], energy: 1, draw: [base] })], [enemy()])
  free = play(free, transmutation, { energySpent: 1 })
  assert(!(free.pendingCardPlayWindows?.at(-1)?.cardUids ?? []).includes(base.uid) ||
    play(free, base, { metamorphosisPowerUid: caltrops.uid }) === free,
  'base Metamorphosis cannot attach to Caltrops (X = 2) for Transmutation\'s 0')
})

check('Companion keeps "also Exhaust" when an earlier ability killed its chosen enemy', () => {
  const first = instance('slayer_companion', true)
  const second = instance('slayer_companion', true)
  const state = combat([player({ powers: [first, second], hp: 30, maxHp: 30 })],
    [enemy({ uid: 'e1', hp: 4 }), enemy({ uid: 'e2', row: 1 })])
  const abilities = endTurnAbilities(state)
  const id = (card) => abilities.find((ability) => ability.id.includes(card.uid)).id
  const order = abilities.map((ability) => ability.id === id(first) ? chooseEndTurnTarget(ability.id, 'e1')
    : ability.id === id(second) ? chooseEndTurnTarget(ability.id, selfExhaustEndTurnTarget('e1'))
      : chooseEndTurnTarget(ability.id, ability.targets?.[0]?.uid ?? '').replace(/@$/, ''))
  const ended = beginEndPlayerTurn(state, order)
  assert(ended !== state, 'the order is legal')
  assert(ended.enemies[0].dead, 'the first dragon kills e1')
  assertEqual(ended.enemies[1].hp, 26, 'the second dragon falls back to the living enemy')
  assert(ended.players[0].exhaust.some((card) => card.uid === second.uid), 'and still Exhausts itself as chosen')
  assert(ended.log.some((line) => /Companion\+: Ann gains 3 Block/.test(line)), 'for 3 Block')
})

check('a copy follows its Power out at once, before its own later ability in the same Start of Turn', () => {
  const panic = instance('slayer_panic_button', true)
  const meta = instance('slayer_metamorphosis', true)
  const exhausted = startPlayerTurn(play(combat([player({ hand: [meta], powers: [panic], energy: 0 })], [enemy()]),
    meta, { energySpent: 0, metamorphosisPowerUid: panic.uid }))
  assertEqual(exhausted.players[0].vulnerable, 1, 'the Exhausted copy never gains its own Vulnerable')

  const fasting = instance('slayer_fasting')
  const devotion = instance('devotion')
  const meta2 = instance('slayer_metamorphosis', true)
  const fed = play(combat([player({ character: 'watcher', hand: [meta2], powers: [fasting, devotion], energy: 3 })], [enemy()]),
    meta2, { energySpent: faceOf(CARDS.slayer_fasting, false).cost, metamorphosisPowerUid: fasting.uid })
  const discarded = startPlayerTurn(fed)
  assertEqual(discarded.players[0].miracles, 1, 'the discarded copy does not spend the Miracle Devotion grants later')
  assertDeepEqual(discarded.players[0].discard.map((card) => card.defId).sort(), ['slayer_fasting', 'slayer_metamorphosis'])
})

check('a dead owner\'s homeless Nightmare+ is discarded without firing anyone\'s Eviscerate', () => {
  const nightmare = instance('slayer_nightmare', true)
  const state = combat([
    player({ character: 'silent', powers: [instance('slayer_eviscerate')], hp: 0, dead: true }),
    player({ id: 'p2', name: 'Bo', character: 'silent', row: 1, powers: [instance('slayer_eviscerate', true)] }),
  ], [enemy({ uid: 'boss', isBoss: true }), enemy({ uid: 'gone', row: 1, hp: 0, dead: true })])
  state.lastStand = true
  // The only living enemy is the card's own former host, so it has nowhere to go.
  state.pendingSlayerChoices = [{ kind: 'reattach', playerId: 'p1', card: nightmare, fromUid: 'boss' }]
  const settled = settle(state)
  assert(settled.players[0].discard.some((card) => card.uid === nightmare.uid), 'Nightmare+ is discarded')
  assertEqual(settled.pendingTriggers.length, 0, 'no Eviscerate trigger is queued')
  assertEqual(settled.enemies[0].hp, 30, 'and no Eviscerate damage lands')
})

check('copying Inflame adds its Strength once more, and the copy leaving play changes nothing', () => {
  const inflame = instance('inflame')
  const meta = instance('slayer_metamorphosis', true)
  const created = combat([player({ hand: [meta], powers: [inflame], energy: 3 })], [enemy()])
  const state = { ...created, players: [{ ...created.players[0], strength: 1 }] }
  const cost = faceOf(CARDS.inflame, false).cost
  const copied = play(state, meta, { energySpent: cost, metamorphosisPowerUid: inflame.uid })
  assertEqual(copied.players[0].strength, 2, 'a second Inflame: +1 Strength, not +2')
  const gone = settle({ ...copied, players: [{ ...copied.players[0],
    powers: copied.players[0].powers.filter((power) => power.uid !== inflame.uid), discard: [inflame] }] })
  assertEqual(gone.players[0].powers.length, 0, 'the copy followed Inflame out of play')
  assertEqual(gone.players[0].strength, 2, 'and the Strength already gained stays, exactly like the original\'s')
  assertDeepEqual(gone.players[0].discard.filter((card) => card.uid === meta.uid).map((card) => card.defId),
    ['slayer_metamorphosis'], 'the orphaned copy is discarded as Metamorphosis+, not lost from the run')
})

check('Phantasmal Killer deals nothing more once its Shiv ended the fight or killed its owner', () => {
  const killers = [instance('slayer_phantasmal_killer'), instance('slayer_phantasmal_killer')]
  const last = spendShiv(combat([player({ character: 'silent', powers: killers, shivs: 1 })], [enemy({ hp: 1 })]), 'p1', 'e1')
  assertEqual(last.phase, 'won', 'the Shiv kills the last enemy and the fight ends cleanly')
  const thorny = spendShiv(combat([player({ character: 'silent', powers: killers, shivs: 1, hp: 1 })], [
    enemy({ uid: 'spiky', defId: 'guardian_defensive', isBoss: true, hp: 20, maxHp: 20 }), enemy({ uid: 'mate' }),
  ]), 'p1', 'spiky')
  assert(thorny.players[0].dead, 'Sharp Hide kills the Shiv\'s owner')
  assertDeepEqual(hpOf(thorny), [19, 30], 'only the Shiv landed; no Phantasmal Killer damage after its owner fell')
  // Last Stand: a dead Silent's Shiv can still be spent while the fight goes on, so only `actor.dead` stops the ping.
  const stand = combat([player({ character: 'silent', powers: killers, shivs: 1, hp: 1 }),
    player({ id: 'p2', name: 'Bo', character: 'silent', row: 1 })], [
    enemy({ uid: 'spiky', defId: 'guardian_defensive', isBoss: true, hp: 20, maxHp: 20 }), enemy({ uid: 'mate' }),
  ])
  stand.lastStand = true
  const fallen = spendShiv(stand, 'p1', 'spiky')
  assert(fallen.players[0].dead && fallen.phase !== 'won' && !fallen.players[1].dead, 'the owner fell while the fight goes on')
  assertDeepEqual(hpOf(fallen), [19, 30], 'a dead owner\'s Phantasmal Killers deal nothing in Last Stand')
})

check('a copy of a Power that discards itself directly (Charge Up, Prepare Crush) still returns as Metamorphosis', () => {
  for (const [id, character, enemies] of [
    ['guardian_charge_up', 'guardian', [enemy()]],
    ['slime_boss_prepare_crush', 'ironclad', [enemy({ hp: 100, maxHp: 100 })]],
  ]) {
    const original = instance(id)
    const meta = instance('slayer_metamorphosis', true)
    const cost = faceOf(CARDS[id], false).cost
    const attached = play(combat([player({ character, hand: [meta], powers: [original], energy: cost })], enemies),
      meta, { energySpent: cost, metamorphosisPowerUid: original.uid })
    assert(attached.players[0].powers.some((power) => power.uid === meta.uid), `${id}: the copy is attached`)
    const next = startPlayerTurn(attached)
    const piles = ['hand', 'draw', 'discard', 'exhaust', 'powers'].flatMap((pile) => next.players[0][pile])
    assertEqual(next.players[0].powers.length, 0, `${id}: both left play`)
    assertDeepEqual(next.players[0].discard.find((card) => card.uid === meta.uid),
      { uid: meta.uid, defId: 'slayer_metamorphosis', upgraded: true }, `${id}: the copy is back as Metamorphosis+`)
    assert(!piles.some((card) => card.metamorphosis), `${id}: no pile keeps a borrowed identity`)
  }
})

check('Panic Button under a debuff ward (Last Stand) gains no Vulnerable but still Exhausts', () => {
  for (const upgraded of [false, true]) {
    const panic = instance('slayer_panic_button', upgraded)
    const next = startPlayerTurn(combat([player({ powers: [instance('last_stand'), panic] })], [enemy()]))
    assertEqual(next.players[0].vulnerable, 0, `Panic Button${upgraded ? '+' : ''}: no Vulnerable through the ward`)
    assert(next.players[0].exhaust.some((card) => card.uid === panic.uid), `Panic Button${upgraded ? '+' : ''} still Exhausts`)
  }
})

suite('slayer powers — forced Metamorphosis')

check('Mayhem and Havoc leave a forced Metamorphosis+ to its owner when a 0-X Power is in play', () => {
  for (const via of ['mayhem', 'havoc']) {
    const meta = instance('slayer_metamorphosis', true)
    const brutality = instance('slayer_brutality')
    const caltrops = instance('slayer_caltrops')
    const setup = (powers) => {
      const havoc = instance('havoc', true)
      // Mayhem plays the top card after the Start-of-Turn draw of 5; Havoc plays it at once.
      const base = combat([player({ hand: via === 'havoc' ? [havoc] : [],
        draw: via === 'havoc' ? [meta, ...deck(6)] : [...deck(5), meta, ...deck(2)],
        powers: via === 'mayhem' ? [instance('mayhem'), ...powers] : powers })], [enemy()])
      return via === 'mayhem' ? startPlayerTurn(base) : play(base, havoc)
    }
    const parked = setup([brutality, caltrops])
    assertEqual(parked.startTurnProgress?.forcedCard?.cardUid, meta.uid, `${via}: Metamorphosis+ is the forced card`)
    assert(resolveDeterministicForcedCard(parked) === parked, `${via}: the automatic resolver leaves the Power choice open`)
    assert(playCard(parked, 'p1', meta.uid, { enemyUid: null, playerId: 'p1', metamorphosisPowerUid: caltrops.uid }) === parked,
      `${via}: X = 0 cannot attach to Caltrops (X = 1)`)
    const attached = playCard(parked, 'p1', meta.uid, { enemyUid: null, playerId: 'p1', metamorphosisPowerUid: brutality.uid })
    assertEqual(attached.players[0].powers.find((power) => power.uid === meta.uid)?.defId, 'slayer_brutality',
      `${via}: the owner attaches it to Brutality for free`)

    const nothing = setup([caltrops])
    const settled = resolveDeterministicForcedCard(nothing)
    assert(settled.players[0].discard.some((card) => card.uid === meta.uid), `${via}: with no 0-X Power it is discarded as before`)
  }
})

check('online, Mayhem\'s forced Metamorphosis+ waits for its owner\'s Power choice', () => {
  const room = createRoom(createStore(), { code: 'GMETA' })
  const owner = joinRoom(room, { name: 'Ann', character: 'ironclad' })
  const peer = joinRoom(room, { name: 'Bo', character: 'silent' })
  startRun(room, owner.token, { seed: 913 })
  const meta = instance('slayer_metamorphosis', true)
  const brutality = instance('slayer_brutality')
  const parked = startPlayerTurn(combat([
    player({ id: owner.playerId, draw: [...deck(5), meta, ...deck(2)], powers: [instance('mayhem'), brutality] }),
    player({ id: peer.playerId, name: 'Bo', row: 1 }),
  ], [enemy()]))
  room.run = { ...room.run, phase: 'combat', combat: parked }
  // A teammate leaving runs the room's forced-card settlement, which plays deterministic cards itself.
  markDisconnected(room, peer.token)
  assertEqual(room.run.combat.startTurnProgress?.forcedCard?.cardUid, meta.uid, 'the room did not discard it for the owner')
  apply(room, owner.token, { kind: 'playCard', cardUid: meta.uid, metamorphosisPowerUid: brutality.uid })
  assertEqual(room.run.combat.players[0].powers.find((power) => power.uid === meta.uid)?.defId, 'slayer_brutality')
})

suite('slayer powers — discard phase after the last end-of-turn effect')

check('online: resolving the last end-of-turn effect lands in the enemy phase when only a disconnected seat owes a Retain choice', () => {
  const room = createRoom(createStore(), { code: 'GDISC' })
  const ann = joinRoom(room, { name: 'Ann', character: 'ironclad' })
  const bea = joinRoom(room, { name: 'Bea', character: 'silent' })
  startRun(room, ann.token, { seed: 9 })
  const annId = snapshotFor(room, ann.token).you.playerId
  const players = room.run.players.map((candidate) => ({
    ...candidate, hand: candidate.id === annId ? [] : [instance('strike_silent'), instance('defend_silent')],
    draw: [], discard: [], energy: 3, hp: 30, maxHp: 30,
    // Companion+ needs a target at end of turn; Well-Laid Plans+ gives Bea a Retain choice there.
    powers: [instance(candidate.id === annId ? 'slayer_companion' : 'well_laid_plans', true)],
  }))
  room.run = { ...room.run, phase: 'combat', combat: createCombat(createRng(3), players, [enemy({ uid: 'e1' }), enemy({ uid: 'e2' })]) }
  markDisconnected(room, bea.token)
  apply(room, ann.token, { kind: 'endTurn' })
  const published = snapshotFor(room, ann.token).endTurnAbilities?.[0]
  assertEqual(room.run.combat.phase, 'player', 'Ann\'s Companion+ still waits for its target')
  assert(published?.playerId === annId, 'the effect is Ann\'s')
  apply(room, ann.token, { kind: 'resolveEndTurnEffect', abilityId: published.id, targetUid: 'e1' })
  assertEqual(room.run.combat.phase, 'enemy', 'the turn did not stall in the discard phase owing only an absent seat')
  assertEqual(room.run.combat.enemies[0].hp, 26, 'Companion+ hit the chosen enemy')
  const view = snapshotFor(room, ann.token)
  assertDeepEqual(view.endTurnDecided, [], 'no stale discard bookkeeping reaches the enemy phase')
  assertEqual(view.discardOrder, undefined)
})

report('slayer powers')
