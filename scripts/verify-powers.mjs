// Powers: cards that stay in front of you and react to the game.
//
// A Power's `effects` fire on its TRIGGER, not when it is played — playing
// Demon Form grants nothing until the next Start of Turn. Relics and Powers
// share one dispatcher, so these also cover the relic side reacting to events.
import {
  MAX_TRIGGER_DEPTH,
  beginEndPlayerTurn,
  createCombat,
  endPlayerTurn,
  enemyTurn,
  playCard,
  preparePlayerTurn,
  resolveStartPlayerTurn,
  startPlayerTurn,
  startTurnAbilities,
} from '../src/game/combat.ts'
import { CARDS, faceOf } from '../src/game/cards.ts'
import { triggerMatches } from '../src/game/triggers.ts'
import { createRng } from '../src/game/rng.ts'
import { suite, check, assert, assertDeepEqual, assertEqual, report } from './lib/harness.mjs'

let uid = 0
const instance = (defId, upgraded = false) => ({ uid: `c${uid++}`, defId, upgraded })
const deck = (n = 10, id = 'strike_ironclad') => Array.from({ length: n }, () => instance(id))

const player = (over = {}) => ({
  id: 'p1', name: 'Ironclad', character: 'ironclad', row: 0,
  hp: 10, maxHp: 10, block: 0, energy: 3, gold: 0,
  deck: [], draw: [], hand: [], discard: [], exhaust: [], powers: [],
  relics: [], potions: [], cardRewards: [], rareRewards: [],
  strength: 0, vulnerable: 0, weak: 0, shivs: 0, miracles: 0,
  stance: 'neutral', orbs: [null, null, null], dead: false, ...over,
})

const enemy = (over = {}) => ({
  uid: 'e1', defId: 'green_louse', row: 0, isBoss: false,
  hp: 30, maxHp: 30, block: 0,
  strength: 0, vulnerable: 0, weak: 0, poison: 0, actionIndex: 0, abilityUsed: true, dead: false, ...over,
})

const combat = (players, enemies) => createCombat(createRng(31), players, enemies)

suite('powers')

check('playing a Power puts it in front of you and does nothing yet', () => {
  const demon = instance('demon_form')
  const state = combat([player({ hand: [demon], energy: 3 })], [enemy()])
  const next = playCard(state, 'p1', demon.uid, { enemyUid: 'e1', playerId: 'p1' })
  assertEqual(next.players[0].powers.length, 1, 'the Power stays in play')
  assertEqual(next.players[0].discard.length, 0, 'and never reaches the discard pile')
  assertEqual(
    next.players[0].strength,
    0,
    'Demon Form grants Strength at the START OF TURN, not when played',
  )
})

check('Demon Form grants Strength at the start of every turn', () => {
  let state = combat(
    [player({ powers: [instance('demon_form')], draw: deck() })],
    [enemy()],
  )
  state = startPlayerTurn(state)
  assertEqual(state.players[0].strength, 1, 'one Strength on the first turn')

  // Round two is reached by playing the round out, not by asking for a second
  // Start of Turn on the same round.
  state = startPlayerTurn(enemyTurn(endPlayerTurn(state)))
  assertEqual(state.turn, 2, 'the second round has begun')
  assertEqual(state.players[0].strength, 2, 'and Demon Form fires again')
})

check('Metallicize grants Block at the end of every turn', () => {
  const state = endPlayerTurn(
    combat([player({ powers: [instance('metallicize')] })], [enemy()]),
  )
  assertEqual(state.players[0].block, 1, 'Metallicize blocks at end of turn')
})

// Feel No Pain and Dark Embrace both react to exhausting a card, which is how
// the Ironclad's exhaust deck pays off.
check('Feel No Pain grants Block for each card exhausted', () => {
  const grit = instance('true_grit')
  const doomed = instance('strike_ironclad')
  const state = combat(
    [player({ hand: [grit, doomed], powers: [instance('feel_no_pain')] })],
    [enemy()],
  )
  const next = playCard(state, 'p1', grit.uid, {
    enemyUid: null,
    playerId: 'p1',
    exhaustUids: [doomed.uid],
  })
  // True Grit grants 1 Block itself, Feel No Pain adds 1 for the exhaust.
  assertEqual(next.players[0].block, 2, 'the exhaust should trigger the Power')
  assertEqual(next.players[0].exhaust.length, 1)
})

check('Dark Embrace draws a card for each card exhausted', () => {
  const grit = instance('true_grit')
  const doomed = instance('strike_ironclad')
  const state = combat(
    [
      player({
        hand: [grit, doomed],
        draw: deck(5, 'defend_ironclad'),
        powers: [instance('dark_embrace')],
      }),
    ],
    [enemy()],
  )
  const next = playCard(state, 'p1', grit.uid, {
    enemyUid: null,
    playerId: 'p1',
    exhaustUids: [doomed.uid],
  })
  assertEqual(next.players[0].hand.length, 1, 'the exhaust draws a replacement')
  assertEqual(next.players[0].draw.length, 4, 'from the draw pile')
})

check('After Image gains one Block per discard effect, not per discarded card', () => {
  CARDS.fixture_discard_two = {
    id: 'fixture_discard_two', name: 'Fixture Discard Two', owner: 'silent',
    type: 'skill', rarity: 'common', cost: 0,
    effects: [{ kind: 'discard', amount: 2 }],
  }
  const source = instance('fixture_discard_two')
  const first = instance('slice')
  const second = instance('deflect')
  const state = playCard(combat([
    player({
      character: 'silent', hand: [source, first, second],
      powers: [instance('after_image')],
    }),
  ], [enemy()]), 'p1', source.uid, {
    enemyUid: null, playerId: null, discardUids: [first.uid, second.uid],
  })
  assertEqual(state.players[0].block, 1)
  assertEqual(state.players[0].discard.length, 3)
})

check('two exhaust Powers both fire on the same exhaust', () => {
  const grit = instance('true_grit')
  const doomed = instance('strike_ironclad')
  const state = combat(
    [
      player({
        hand: [grit, doomed],
        draw: deck(5, 'defend_ironclad'),
        powers: [instance('feel_no_pain'), instance('dark_embrace')],
      }),
    ],
    [enemy()],
  )
  const next = playCard(state, 'p1', grit.uid, {
    enemyUid: null,
    playerId: 'p1',
    exhaustUids: [doomed.uid],
  })
  assertEqual(next.players[0].block, 2, 'Feel No Pain fires')
  assertEqual(next.players[0].hand.length, 1, 'and so does Dark Embrace')
})

// These fire once PER card, not once per event. With a single card exhausted
// or drawn the two are indistinguishable, so use several.
check('an exhaust Power fires once for each card exhausted', () => {
  // True Grit only ever exhausts one card — its upgrade raises the Block, not
  // the exhaust count — so a fixture is needed to exhaust two at once.
  CARDS.fixture_exhaust_two = {
    id: 'fixture_exhaust_two',
    name: 'Fixture Exhaust Two',
    owner: 'ironclad',
    type: 'skill',
    rarity: 'common',
    cost: 0,
    effects: [{ kind: 'exhaustFromHand', amount: 2 }],
  }
  const purge = instance('fixture_exhaust_two')
  const a = instance('strike_ironclad')
  const b = instance('strike_ironclad')
  const state = combat(
    [player({ hand: [purge, a, b], powers: [instance('feel_no_pain')] })],
    [enemy()],
  )
  const next = playCard(state, 'p1', purge.uid, {
    enemyUid: null,
    playerId: 'p1',
    exhaustUids: [a.uid, b.uid],
  })
  assertEqual(next.players[0].exhaust.length, 2, 'both cards are exhausted')
  assertEqual(next.players[0].block, 2, 'Feel No Pain fires once per card, not once per play')
})

check('a draw Power fires once for each card drawn', () => {
  CARDS.fixture_draw_watcher = {
    id: 'fixture_draw_watcher',
    name: 'Fixture Draw Watcher',
    owner: 'ironclad',
    type: 'power',
    rarity: 'rare',
    cost: 0,
    trigger: { kind: 'onDraw' },
    effects: [{ kind: 'block', amount: 1 }],
  }
  CARDS.fixture_draw_three = {
    id: 'fixture_draw_three',
    name: 'Fixture Draw Three',
    owner: 'ironclad',
    type: 'skill',
    rarity: 'common',
    cost: 0,
    effects: [{ kind: 'draw', amount: 3 }],
  }
  const drawer = instance('fixture_draw_three')
  const state = combat(
    [
      player({
        hand: [drawer],
        draw: deck(5, 'defend_ironclad'),
        powers: [instance('fixture_draw_watcher')],
      }),
    ],
    [enemy()],
  )
  const next = playCard(state, 'p1', drawer.uid, { enemyUid: null, playerId: 'p1' })
  assertEqual(next.players[0].hand.length, 3, 'three cards drawn')
  assertEqual(next.players[0].block, 3, 'and the Power fired three times')
})

check('a draw that draws nothing fires nothing', () => {
  const drawer = instance('fixture_draw_three')
  const state = combat(
    [player({ hand: [drawer], draw: [], discard: [], powers: [instance('fixture_draw_watcher')] })],
    [enemy()],
  )
  const next = playCard(state, 'p1', drawer.uid, { enemyUid: null, playerId: 'p1' })
  assertEqual(next.players[0].block, 0, 'an empty deck draws nothing, so nothing triggers')
})

// Defend+ blocks an ALLY. The ally is the one who gained Block, so the ally's
// Power is the one that should react.
check('a Block Power fires for whoever received the Block', () => {
  CARDS.fixture_block_watcher = {
    id: 'fixture_block_watcher',
    name: 'Fixture Block Watcher',
    owner: 'ironclad',
    type: 'power',
    rarity: 'rare',
    cost: 0,
    trigger: { kind: 'onGainBlock' },
    effects: [{ kind: 'gainStrength', amount: 1 }],
  }
  const defendPlus = instance('defend_ironclad', true)
  const state = combat(
    [
      // The caster carries the SAME Power. Without that, "not the caster" holds
      // whether or not the dispatcher scopes correctly — the caster would have
      // nothing to fire either way, and the assertion proves nothing.
      player({ id: 'p1', hand: [defendPlus], powers: [instance('fixture_block_watcher')] }),
      player({ id: 'p2', row: 1, powers: [instance('fixture_block_watcher')] }),
    ],
    [enemy()],
  )
  const next = playCard(state, 'p1', defendPlus.uid, { enemyUid: null, playerId: 'p2' })
  assertEqual(next.players[1].block, 2, 'the ally receives the Block')
  assertEqual(next.players[1].strength, 1, "and the ALLY's Power reacts to gaining it")
  assertEqual(next.players[0].strength, 0, 'the caster gained no Block, so their identical Power stays silent')
})

// p.12: abilities triggered by a card do not fire until the card has finished
// resolving all of its text.
check('an on-play Power fires only after the card has fully resolved', () => {
  CARDS.fixture_skill_watcher = {
    id: 'fixture_skill_watcher',
    name: 'Fixture Skill Watcher',
    owner: 'ironclad',
    type: 'power',
    rarity: 'rare',
    cost: 0,
    trigger: { kind: 'onPlayCard', cardType: 'skill' },
    effects: [{ kind: 'gainStrength', amount: 1 }],
  }
  const defend = instance('defend_ironclad')
  const strike = instance('strike_ironclad')
  const state = combat(
    [player({ hand: [defend, strike], powers: [instance('fixture_skill_watcher')] })],
    [enemy({ hp: 30 })],
  )

  const afterSkill = playCard(state, 'p1', defend.uid, { enemyUid: null, playerId: 'p1' })
  assertEqual(afterSkill.players[0].strength, 1, 'a Skill triggers it')
  assertEqual(
    afterSkill.players[0].discard.length,
    1,
    'and the card has already reached the discard pile by then (p.12)',
  )

  const afterAttack = playCard(state, 'p1', strike.uid, { enemyUid: 'e1', playerId: 'p1' })
  assertEqual(afterAttack.players[0].strength, 0, 'an Attack does not, since the trigger names Skills')
  assertEqual(afterAttack.enemies[0].hp, 29, 'the Strike still lands its printed 1')
})

check('a Power on one player never fires for another', () => {
  let state = combat(
    [
      player({ id: 'p1', powers: [instance('demon_form')], draw: deck() }),
      player({ id: 'p2', row: 1, draw: deck() }),
    ],
    [enemy()],
  )
  state = startPlayerTurn(state)
  assertEqual(state.players[0].strength, 1, 'the owner gains the Strength')
  assertEqual(state.players[1].strength, 0, 'the other player gains nothing')
})

check('a dead player\'s Powers do not fire', () => {
  let state = combat(
    [player({ powers: [instance('demon_form')], dead: true, hp: 0, draw: deck() })],
    [enemy()],
  )
  state = startPlayerTurn(state)
  assertEqual(state.players[0].strength, 0, 'the dead gain nothing')
})

check('an upgraded Power keeps its trigger and changes only what the card says', () => {
  const state = endPlayerTurn(
    combat([player({ powers: [instance('metallicize', true)] })], [enemy()]),
  )
  assertEqual(state.players[0].block, 1, 'Metallicize+ still blocks 1; only its cost drops')
})

// A Power that reacts to the very thing it does would recurse forever. No such
// card exists in the box, but the engine must not hang if one is ever entered.
check('a self-feeding trigger chain terminates instead of hanging', () => {
  CARDS.fixture_loop = {
    id: 'fixture_loop',
    name: 'Fixture Loop',
    owner: 'ironclad',
    type: 'power',
    rarity: 'rare',
    cost: 0,
    trigger: { kind: 'onGainBlock' },
    effects: [{ kind: 'block', amount: 1 }],
  }
  const defend = instance('defend_ironclad')
  const state = combat(
    [player({ hand: [defend], powers: [instance('fixture_loop')] })],
    [enemy()],
  )
  // No wall-clock assertion here: without a cap this recurses until the stack
  // blows and THROWS, long before any timeout would fire. The depth assertion
  // below is what actually proves termination.
  const next = playCard(state, 'p1', defend.uid, { enemyUid: null, playerId: 'p1' })
  // The exact depth, not a range: Defend's 1 Block, then the Power feeds
  // itself once per level until the cap stops it. A range passes for almost
  // any cap, leaving the documented constant unverified in either direction.
  assertEqual(
    next.players[0].block,
    1 + MAX_TRIGGER_DEPTH,
    "Defend's 1 Block plus one per level down to the depth cap",
  )
  // The line above imports the constant it checks, so it pins the SHAPE of the
  // chain but not the number. state.ts tells the reader the cap is 8; this is
  // what stops that prose going stale.
  assertEqual(MAX_TRIGGER_DEPTH, 8, 'state.ts documents a trigger depth cap of 8')
})

suite('trigger matching')

check('a trigger only fires for its own event', () => {
  assert(triggerMatches({ kind: 'startOfTurn' }, { kind: 'startOfTurn' }))
  assert(!triggerMatches({ kind: 'startOfTurn' }, { kind: 'endOfTurn' }))
  assert(triggerMatches({ kind: 'onDiscard' }, { kind: 'onDiscard' }))
})

check('a die trigger reads the roll', () => {
  const trigger = { kind: 'dieRelic', faces: [3, 4] }
  assert(triggerMatches(trigger, { kind: 'dieRelic', die: 3 }), 'fires on a 3')
  assert(triggerMatches(trigger, { kind: 'dieRelic', die: 4 }), 'fires on a 4')
  assert(!triggerMatches(trigger, { kind: 'dieRelic', die: 5 }), 'stays silent on a 5')
  assert(!triggerMatches(trigger, { kind: 'dieRelic' }), 'and on no roll at all')
})

check('a card-type trigger narrows to that type, or matches any', () => {
  const anyCard = { kind: 'onPlayCard' }
  const skillsOnly = { kind: 'onPlayCard', cardType: 'skill' }
  assert(triggerMatches(anyCard, { kind: 'onPlayCard', cardType: 'attack' }), 'any card')
  assert(triggerMatches(skillsOnly, { kind: 'onPlayCard', cardType: 'skill' }), 'a skill')
  assert(!triggerMatches(skillsOnly, { kind: 'onPlayCard', cardType: 'attack' }), 'not an attack')
})

check('a stance trigger narrows to that stance, or matches any', () => {
  const anyStance = { kind: 'onEnterStance' }
  const wrathOnly = { kind: 'onEnterStance', stance: 'wrath' }
  assert(triggerMatches(anyStance, { kind: 'onEnterStance', stance: 'calm' }))
  assert(triggerMatches(wrathOnly, { kind: 'onEnterStance', stance: 'wrath' }))
  assert(!triggerMatches(wrathOnly, { kind: 'onEnterStance', stance: 'calm' }))
})

check('every Power declares exactly one resolution model', () => {
  for (const def of Object.values(CARDS)) {
    if (def.type !== 'power') continue
    const persistent = def.corruptSkills === true || def.retainBlock === true
    assert(
      [def.trigger !== undefined, def.resolvesOnPlay === true, persistent].filter(Boolean).length === 1,
      `${def.id} must either trigger later, resolve once when played, or declare a persistent modifier`,
    )
  }
})

check('no non-Power card carries a trigger', () => {
  for (const def of Object.values(CARDS)) {
    if (def.type === 'power') continue
    assert(
      def.trigger === undefined && def.resolvesOnPlay !== true &&
        def.corruptSkills !== true && def.retainBlock !== true,
      `${def.id} is a ${def.type} with Power-only resolution metadata`,
    )
  }
})

suite('every path that draws, blocks or exhausts')

// The bug a trigger system grows: a second place that draws cards or grants
// Block, added later, that forgets to tell anyone. Each check below pins one
// such path, because each one was found broken.

const blockWatcher = () => {
  CARDS.fixture_block_watcher = {
    id: 'fixture_block_watcher',
    name: 'Fixture Block Watcher',
    owner: 'ironclad',
    type: 'power',
    rarity: 'rare',
    cost: 0,
    trigger: { kind: 'onGainBlock' },
    effects: [{ kind: 'gainStrength', amount: 1 }],
  }
  return instance('fixture_block_watcher')
}

check('the Start of Turn draw of 5 fires an on-draw Power five times', () => {
  // The biggest draw in the game, and it used to bypass the trigger path.
  CARDS.fixture_draw_blocker = {
    id: 'fixture_draw_blocker',
    name: 'Fixture Draw Blocker',
    owner: 'ironclad',
    type: 'power',
    rarity: 'rare',
    cost: 0,
    trigger: { kind: 'onDraw' },
    effects: [{ kind: 'block', amount: 1 }],
  }
  const state = startPlayerTurn(
    combat([player({ powers: [instance('fixture_draw_blocker')], draw: deck(10) })], [enemy()]),
  )
  assertEqual(state.players[0].hand.length, 5, 'five cards drawn')
  assertEqual(state.players[0].block, 5, 'and the Power fired once per card')
})

check('Reset finishes for the whole party before anyone draws', () => {
  // p.12 prints Reset and Draw as two numbered steps. Interleaved per player,
  // a draw-triggered Power that blocks the PARTY has that Block wiped for
  // everyone whose reset has not happened yet.
  CARDS.fixture_party_draw_block = {
    id: 'fixture_party_draw_block',
    name: 'Fixture Party Draw Block',
    owner: 'ironclad',
    type: 'power',
    rarity: 'rare',
    cost: 0,
    trigger: { kind: 'onDraw' },
    supportTarget: 'allPlayers',
    effects: [{ kind: 'block', amount: 1, toChosen: true }],
  }
  const state = startPlayerTurn(
    combat(
      [
        player({ id: 'p1', powers: [instance('fixture_party_draw_block')], draw: deck(10) }),
        player({ id: 'p2', row: 1, draw: deck(10) }),
      ],
      [enemy()],
    ),
  )
  assertEqual(state.players[0].block, 5, 'the owner keeps the Block from five draws')
  assertEqual(state.players[1].block, 5, "and so does the ally whose reset came later")
})

check('start-of-combat abilities fire on turn 1 only', () => {
  // Ring of the Snake draws 2 extra at the start of combat. Without the turn
  // gate it re-fires every round and the hand grows without limit.
  let state = startPlayerTurn(
    combat([player({ character: 'silent', relics: [{ defId: 'ring_of_the_snake', spent: false }], draw: deck(20) })], [enemy()]),
  )
  assertEqual(state.players[0].hand.length, 7, 'five plus the relic-s two on turn 1')

  state = startPlayerTurn(enemyTurn(endPlayerTurn(state)))
  assertEqual(state.turn, 2, 'precondition: the second round has begun')
  assertEqual(state.players[0].hand.length, 5, 'and turn 2 is a plain five-card hand')
})

check('Infinite Blades resolves shared-supply overflow in the chosen Start-of-Turn order', () => {
  const first = instance('infinite_blades')
  const second = instance('infinite_blades', true)
  const prepared = preparePlayerTurn(combat([
    player({ id: 'p1', name: 'Ann', character: 'silent', powers: [first], shivs: 4, draw: deck() }),
    player({ id: 'p2', name: 'Bo', character: 'silent', row: 1, powers: [second], draw: deck() }),
  ], [enemy({ uid: 'e1', hp: 20 }), enemy({ uid: 'e2', row: 1, hp: 20 })]))
  assertEqual(prepared.phase, 'start')
  const abilities = startTurnAbilities(prepared)
  assertEqual(abilities.find((ability) => ability.id.includes(first.uid)).overflowShivs, 0)
  assertEqual(abilities.find((ability) => ability.id.includes(second.uid)).overflowShivs, 2)

  const resolved = resolveStartPlayerTurn(prepared, abilities.map((ability) => ({
    id: ability.id,
    shivEnemyUids: ability.id.includes(second.uid) ? ['e1', 'e2'] : [],
  })))
  assertEqual(resolved.phase, 'player')
  assertEqual(resolved.players.reduce((sum, owner) => sum + owner.shivs, 0), 5)
  assertEqual(resolved.players[1].attacksPlayedThisTurn, 2)
  assertEqual(resolved.enemies[0].hp, 19)
  assertEqual(resolved.enemies[1].hp, 19)

  const reverse = [...abilities].reverse().map((ability) => ability.id)
  assertEqual(startTurnAbilities(prepared, reverse)[0].overflowShivs, 1,
    'the upgraded Power takes one cube before its second Shiv overflows')
  assertEqual(startTurnAbilities(prepared, reverse)[1].overflowShivs, 1,
    'the later base Power then overflows too')

  assert(resolveStartPlayerTurn(prepared, abilities.map((ability) => ({
    id: ability.id,
    shivEnemyUids: ability.id.includes(second.uid) ? ['e1'] : [],
  }))) === prepared, 'every overflow Shiv needs an explicit target or skip')
  const lethal = structuredClone(prepared)
  lethal.enemies[0].hp = 1
  assert(resolveStartPlayerTurn(lethal, abilities.map((ability) => ({
    id: ability.id,
    shivEnemyUids: ability.id.includes(second.uid) ? ['e1', 'e1'] : [],
  }))) === lethal, 'a target killed by an earlier queued Shiv makes the whole choice stale')
  const skipped = resolveStartPlayerTurn(prepared, abilities.map((ability) => ({
    id: ability.id,
    shivEnemyUids: ability.id.includes(second.uid) ? [null, null] : [],
  })))
  assertEqual(skipped.enemies[0].hp, 20, 'explicit skips deal no damage')
})

check('Noxious Fumes targets one enemy next turn, while its upgrade poisons all enemies', () => {
  const fumes = instance('noxious_fumes')
  const beforePlay = combat(
    [player({ id: 'p1', name: 'Ann', character: 'silent', hand: [fumes], energy: 1, draw: deck() })],
    [enemy({ uid: 'e1' }), enemy({ uid: 'e2', row: 1 })],
  )
  const played = playCard(beforePlay, 'p1', fumes.uid, {})
  assertDeepEqual(played.enemies.map((target) => target.poison), [0, 0],
    'a Start-of-Turn Power fired when it was played')

  const prepared = preparePlayerTurn({ ...played, phase: 'roundEnd' })
  const [ability] = startTurnAbilities(prepared)
  assertDeepEqual(ability.targets.map((target) => target.uid), ['e1', 'e2'])
  assert(resolveStartPlayerTurn(prepared, [{ id: ability.id, shivEnemyUids: [] }]) === prepared,
    'base Noxious Fumes resolved without its enemy choice')
  const chosen = resolveStartPlayerTurn(prepared, [{
    id: ability.id,
    enemyUid: 'e2',
    shivEnemyUids: [],
  }])
  assertDeepEqual(chosen.enemies.map((target) => target.poison), [0, 1])

  const upgraded = startPlayerTurn(combat(
    [player({
      id: 'p1', name: 'Ann', character: 'silent',
      powers: [instance('noxious_fumes', true)], draw: deck(),
    })],
    [enemy({ uid: 'e1' }), enemy({ uid: 'e2', row: 1 })],
  ))
  assertDeepEqual(upgraded.enemies.map((target) => target.poison), [1, 1])
})

check('the Start of Turn reshuffle fires an on-shuffle Power', () => {
  // An empty draw pile at Start of Turn is where nearly every shuffle in a real
  // game actually happens.
  CARDS.fixture_shuffle_watcher = {
    id: 'fixture_shuffle_watcher',
    name: 'Fixture Shuffle Watcher',
    owner: 'ironclad',
    type: 'power',
    rarity: 'rare',
    cost: 0,
    trigger: { kind: 'onShuffle' },
    effects: [{ kind: 'gainStrength', amount: 1 }],
  }
  const state = startPlayerTurn(
    combat(
      [player({ powers: [instance('fixture_shuffle_watcher')], draw: [], discard: deck(10) })],
      [enemy()],
    ),
  )
  assertEqual(state.players[0].hand.length, 5, 'the empty draw pile was refilled')
  assertEqual(state.players[0].strength, 1, 'and the reshuffle fired the Power')
})

check('the shuffle fires in the MIDDLE of the draw that caused it', () => {
  // Drawing 3 off a 1-card pile: one card comes off the top, THEN the discard
  // is shuffled in, then two more. Counting the triggers cannot tell the three
  // possible orderings apart, so the shuffle grants Strength and each draw
  // throws a punch — every ordering then lands on a different total.
  //
  //   shuffle after the 1st draw (correct):  1 + 6 + 6 = 13
  //   shuffle before every draw:             6 + 6 + 6 = 18
  //   shuffle after every draw:              1 + 1 + 1 =  3
  CARDS.fixture_order_draw = {
    id: 'fixture_order_draw',
    name: 'Fixture Order Draw',
    owner: 'ironclad',
    type: 'power',
    rarity: 'rare',
    cost: 0,
    trigger: { kind: 'onDraw' },
    effects: [{ kind: 'hit', amount: 1 }],
  }
  CARDS.fixture_order_shuffle = {
    id: 'fixture_order_shuffle',
    name: 'Fixture Order Shuffle',
    owner: 'ironclad',
    type: 'power',
    rarity: 'rare',
    cost: 0,
    trigger: { kind: 'onShuffle' },
    effects: [{ kind: 'gainStrength', amount: 5 }],
  }
  CARDS.fixture_draw_three_cards = {
    id: 'fixture_draw_three_cards',
    name: 'Fixture Draw Three',
    owner: 'ironclad',
    type: 'skill',
    rarity: 'common',
    cost: 0,
    effects: [{ kind: 'draw', amount: 3 }],
  }

  const card = instance('fixture_draw_three_cards')
  const next = playCard(
    combat(
      [
        player({
          hand: [card],
          draw: deck(1),
          discard: deck(4),
          powers: [instance('fixture_order_draw'), instance('fixture_order_shuffle')],
        }),
      ],
      [enemy({ hp: 40 })],
    ),
    'p1',
    card.uid,
    { enemyUid: 'e1', playerId: 'p1' },
  )
  assertEqual(next.players[0].hand.length, 3, 'three cards were drawn')
  assertEqual(next.players[0].strength, 5, 'and the pile was shuffled exactly once')
  assertEqual(next.enemies[0].hp, 40 - 13, 'the shuffle landed between the first draw and the rest')
})

check('a Frost orb evoked for Block fires a Block Power', () => {
  CARDS.fixture_evoke = {
    id: 'fixture_evoke',
    name: 'Fixture Evoke',
    owner: 'defect',
    type: 'skill',
    rarity: 'common',
    cost: 0,
    effects: [{ kind: 'evoke', times: 1 }],
  }
  const card = instance('fixture_evoke')
  const state = combat(
    [player({ hand: [card], orbs: ['frost', null, null], powers: [blockWatcher()] })],
    [enemy()],
  )
  const next = playCard(state, 'p1', card.uid, {
    enemyUid: null, playerId: 'p1', evokeSlots: [0], evokeEnemyUids: [null],
  })
  assertEqual(next.players[0].block, 1, 'the Frost orb granted its Block')
  assertEqual(next.players[0].strength, 1, 'and the Block Power saw it')
})

check('a Frost orb ticking at end of turn fires a Block Power', () => {
  const state = endPlayerTurn(
    combat([player({ orbs: ['frost', null, null], powers: [blockWatcher()] })], [enemy()]),
  )
  assertEqual(state.players[0].strength, 1, 'the end-of-turn Frost tick fired the Power')
})

check('a Block Power stays silent when the cap swallowed the gain', () => {
  // At the cap the gain is a no-op, and a Power paying out for a no-op is free
  // value no card in the box grants.
  const defend = instance('defend_ironclad')
  const state = combat(
    [player({ hand: [defend], block: 20, powers: [blockWatcher()] })],
    [enemy()],
  )
  const next = playCard(state, 'p1', defend.uid, { enemyUid: null, playerId: 'p1' })
  assertEqual(next.players[0].block, 20, 'Block is capped at 20')
  assertEqual(next.players[0].strength, 0, 'so nothing was gained and nothing fired')
})

check('a card that exhausts ITSELF fires an exhaust Power', () => {
  CARDS.fixture_self_exhaust = {
    id: 'fixture_self_exhaust',
    name: 'Fixture Self Exhaust',
    owner: 'ironclad',
    type: 'skill',
    rarity: 'common',
    cost: 0,
    exhaust: true,
    effects: [],
  }
  const card = instance('fixture_self_exhaust')
  const state = combat(
    [player({ hand: [card], powers: [instance('feel_no_pain')] })],
    [enemy()],
  )
  const next = playCard(state, 'p1', card.uid, { enemyUid: null, playerId: 'p1' })
  assertEqual(next.players[0].exhaust.length, 1, 'the card exhausted itself')
  assertEqual(next.players[0].block, 1, 'and Feel No Pain counted it')
})

check('scrying an empty draw pile fires nothing', () => {
  CARDS.fixture_scry_watcher = {
    id: 'fixture_scry_watcher',
    name: 'Fixture Scry Watcher',
    owner: 'watcher',
    type: 'power',
    rarity: 'rare',
    cost: 0,
    trigger: { kind: 'onScry' },
    effects: [{ kind: 'gainStrength', amount: 1 }],
  }
  CARDS.fixture_scry_two = {
    id: 'fixture_scry_two',
    name: 'Fixture Scry Two',
    owner: 'watcher',
    type: 'skill',
    rarity: 'common',
    cost: 0,
    effects: [{ kind: 'scry', amount: 2 }],
  }
  const looked = instance('fixture_scry_two')
  const seen = playCard(
    combat(
      [player({ hand: [looked], draw: deck(4), powers: [instance('fixture_scry_watcher')] })],
      [enemy()],
    ),
    'p1',
    looked.uid,
    { enemyUid: null, playerId: 'p1' },
  )
  assertEqual(seen.players[0].strength, 1, 'scrying a real pile fires the Power')

  const empty = instance('fixture_scry_two')
  const nothing = playCard(
    combat(
      [player({ hand: [empty], draw: [], discard: [], powers: [instance('fixture_scry_watcher')] })],
      [enemy()],
    ),
    'p1',
    empty.uid,
    { enemyUid: null, playerId: 'p1' },
  )
  assertEqual(nothing.players[0].strength, 0, 'but scrying nothing is not scrying')
})

check('entering a stance fires a stance Power, and only the named stance', () => {
  CARDS.fixture_stance_watcher = {
    id: 'fixture_stance_watcher',
    name: 'Fixture Stance Watcher',
    owner: 'watcher',
    type: 'power',
    rarity: 'rare',
    cost: 0,
    trigger: { kind: 'onEnterStance', stance: 'wrath' },
    effects: [{ kind: 'gainStrength', amount: 1 }],
  }
  CARDS.fixture_enter_wrath = {
    id: 'fixture_enter_wrath',
    name: 'Fixture Enter Wrath',
    owner: 'watcher',
    type: 'skill',
    rarity: 'common',
    cost: 0,
    effects: [{ kind: 'enterStance', stance: 'wrath' }],
  }
  const card = instance('fixture_enter_wrath')
  const next = playCard(
    combat([player({ hand: [card], powers: [instance('fixture_stance_watcher')] })], [enemy()]),
    'p1',
    card.uid,
    { enemyUid: null, playerId: 'p1' },
  )
  assertEqual(next.players[0].stance, 'wrath', 'the stance was entered')
  assertEqual(next.players[0].strength, 1, 'and the stance Power fired')

  CARDS.fixture_enter_calm = {
    ...CARDS.fixture_enter_wrath,
    id: 'fixture_enter_calm',
    effects: [{ kind: 'enterStance', stance: 'calm' }],
  }
  const calmCard = instance('fixture_enter_calm')
  const calm = playCard(
    combat([player({ hand: [calmCard], powers: [instance('fixture_stance_watcher')] })], [enemy()]),
    'p1',
    calmCard.uid,
    { enemyUid: null, playerId: 'p1' },
  )
  assertEqual(calm.players[0].strength, 0, 'a Wrath trigger ignores entering Calm')
})

suite('a Power and the card that played it')

check('a Power does not trigger off its own entry into play', () => {
  // It was not in front of you when that card was played, so it does not see
  // it. Without this it pays out immediately — the exact thing Powers firing
  // on their trigger rather than on play exists to prevent.
  CARDS.fixture_play_watcher = {
    id: 'fixture_play_watcher',
    name: 'Fixture Play Watcher',
    owner: 'ironclad',
    type: 'power',
    rarity: 'rare',
    cost: 0,
    trigger: { kind: 'onPlayCard' },
    effects: [{ kind: 'gainStrength', amount: 1 }],
  }
  const watcher = instance('fixture_play_watcher')
  const strike = instance('strike_ironclad')
  let state = combat([player({ hand: [watcher, strike] })], [enemy()])

  state = playCard(state, 'p1', watcher.uid, { enemyUid: 'e1', playerId: 'p1' })
  assertEqual(state.players[0].strength, 0, 'it did not see itself being played')

  state = playCard(state, 'p1', strike.uid, { enemyUid: 'e1', playerId: 'p1' })
  assertEqual(state.players[0].strength, 1, 'but it does see the NEXT card')
})

check('a Power honours the target scope it declares', () => {
  // A declared-but-unhonoured flag is worse than a missing one: it reads as
  // implemented. The dispatcher used to hardcode single-target.
  CARDS.fixture_sweep = {
    id: 'fixture_sweep',
    name: 'Fixture Sweep',
    owner: 'ironclad',
    type: 'power',
    rarity: 'rare',
    cost: 0,
    trigger: { kind: 'startOfTurn' },
    target: 'allEnemies',
    effects: [{ kind: 'damage', amount: 1 }],
  }
  const state = startPlayerTurn(
    combat(
      [player({ powers: [instance('fixture_sweep')], draw: deck(10) })],
      [enemy({ uid: 'e1', hp: 5 }), enemy({ uid: 'e2', row: 1, hp: 5 })],
    ),
  )
  assertEqual(state.enemies[0].hp, 4, 'the first enemy was hit')
  assertEqual(state.enemies[1].hp, 4, 'and so was the second — the scope says all')
})

check('a Power honours the support scope it declares', () => {
  CARDS.fixture_party_block = {
    id: 'fixture_party_block',
    name: 'Fixture Party Block',
    owner: 'ironclad',
    type: 'power',
    rarity: 'rare',
    cost: 0,
    trigger: { kind: 'startOfTurn' },
    supportTarget: 'allPlayers',
    effects: [{ kind: 'block', amount: 2, toChosen: true }],
  }
  const state = startPlayerTurn(
    combat(
      [
        player({ id: 'p1', powers: [instance('fixture_party_block')], draw: deck(10) }),
        player({ id: 'p2', row: 1, draw: deck(10) }),
      ],
      [enemy()],
    ),
  )
  assertEqual(state.players[0].block, 2, 'the owner is blocked')
  assertEqual(state.players[1].block, 2, 'and so is the ally — the scope says all')
})

check('a start-of-turn Power that kills the last enemy ends the combat', () => {
  const state = startPlayerTurn(
    combat([player({ powers: [instance('fixture_sweep')], draw: deck(10) })], [enemy({ uid: 'e1', hp: 1 })]),
  )
  assert(state.enemies[0].dead, 'the enemy died to the start-of-turn Power')
  assertEqual(state.phase, 'won', 'and the combat was settled rather than left running')
})

suite('support scope')

// The card-level supportTarget says the card asks you to choose an ally. The
// effect's own `toChosen` says which clause actually goes to them. Both are
// needed: the printed text attaches "to any player" to ONE clause.
check('only the clause marked toChosen goes to the chosen player', () => {
  const SUPPORTIVE = [
    { kind: 'heal', amount: 3, read: (player) => player.hp, from: { hp: 5 }, mine: 8, theirs: 8, alone: 5 },
    { kind: 'gainStrength', amount: 2, read: (player) => player.strength, from: {}, mine: 2, theirs: 2, alone: 0 },
    { kind: 'gainEnergy', amount: 1, read: (player) => player.energy, from: { energy: 0 }, mine: 1, theirs: 1, alone: 0 },
    { kind: 'gainShiv', amount: 2, read: (player) => player.shivs, from: {}, mine: 2, theirs: 2, alone: 0 },
    { kind: 'gainMiracle', amount: 1, read: (player) => player.miracles, from: {}, mine: 1, theirs: 1, alone: 0 },
    { kind: 'draw', amount: 1, read: (player) => player.hand.length, from: {}, mine: 1, theirs: 1, alone: 0 },
    { kind: 'block', amount: 2, read: (player) => player.block, from: {}, mine: 2, theirs: 2, alone: 0 },
  ]

  for (const supportive of SUPPORTIVE) {
    const { read, from, mine, theirs, alone, ...effect } = supportive
    const play = (toChosen) => {
      CARDS.fixture_party_support = {
        id: 'fixture_party_support',
        name: 'Fixture Party Support',
        owner: 'ironclad',
        type: 'skill',
        rarity: 'common',
        cost: 0,
        supportTarget: 'allPlayers',
        effects: [toChosen ? { ...effect, toChosen: true } : { ...effect }],
      }
      const card = instance('fixture_party_support')
      return playCard(
        combat(
          [
            player({ id: 'p1', hand: [card], draw: deck(5), ...from }),
            player({ id: 'p2', row: 1, draw: deck(5), ...from }),
          ],
          [enemy()],
        ),
        'p1',
        card.uid,
        { enemyUid: null, playerId: 'p1' },
      )
    }

    const shared = play(true)
    assertEqual(read(shared.players[0]), mine, `${effect.kind} reaches the caster when shared`)
    assertEqual(read(shared.players[1]), theirs, `${effect.kind} reaches the ally when shared`)

    const selfish = play(false)
    assertEqual(read(selfish.players[0]), mine, `${effect.kind} still reaches the caster`)
    assertEqual(read(selfish.players[1]), alone, `${effect.kind} stays with the caster otherwise`)
  }
})

// The card that proves the flag has to be per effect rather than per card.
check('Vigilance blocks an ALLY but keeps Calm for the Watcher', () => {
  // Printed: "2 Block to any player. Enter Calm." A card-level reading handed
  // the stance to the ally — who can never legally be in one — and left the
  // Watcher having paid 2 Energy for nothing.
  const vigilance = instance('vigilance')
  const next = playCard(
    combat(
      [
        player({ id: 'p1', character: 'watcher', hand: [vigilance], energy: 3 }),
        player({ id: 'p2', character: 'ironclad', row: 1 }),
      ],
      [enemy()],
    ),
    'p1',
    vigilance.uid,
    { enemyUid: null, playerId: 'p2' },
  )
  assertEqual(next.players[1].block, 2, 'the Block goes to the chosen ally')
  assertEqual(next.players[0].block, 0, 'and not to the caster')
  assertEqual(next.players[0].stance, 'calm', 'the Watcher enters Calm')
  assertEqual(next.players[1].stance, 'neutral', 'the ally does NOT enter a stance')
})

check('a turn cannot be ended outside the Player Turn', () => {
  // Reachable from the network. Without the guard, ending the turn again at
  // roundEnd flips the phase back and the enemies act twice in one round.
  const base = combat([player({ draw: deck(10) })], [enemy()])
  for (const phase of ['enemy', 'roundEnd', 'won', 'lost']) {
    const parked = { ...base, phase }
    assert(endPlayerTurn(parked) === parked, `endPlayerTurn should be refused during ${phase}`)
  }
})

check('a settled combat cannot be restarted', () => {
  const base = combat([player({ draw: deck(10) })], [enemy()])
  for (const phase of ['won', 'lost']) {
    const parked = { ...base, phase, turn: 3 }
    assert(startPlayerTurn(parked) === parked, `startPlayerTurn should be refused after ${phase}`)
  }
})

check('a Power is never asked for a target it will not use', () => {
  // A Power resolves nothing on play, so requiring an enemy would prompt for a
  // choice that is thrown away — and refuse the play if none was given.
  CARDS.fixture_striking_power = {
    id: 'fixture_striking_power',
    name: 'Fixture Striking Power',
    owner: 'ironclad',
    type: 'power',
    rarity: 'rare',
    cost: 0,
    trigger: { kind: 'endOfTurn' },
    effects: [{ kind: 'damage', amount: 1 }],
  }
  const card = instance('fixture_striking_power')
  const state = combat([player({ hand: [card] })], [enemy({ hp: 5 })])
  const next = playCard(state, 'p1', card.uid, { enemyUid: null, playerId: 'p1' })
  assert(next !== state, 'the Power should be playable with no enemy chosen')
  assertEqual(next.players[0].powers.length, 1, 'and it enters play')
  assertEqual(next.enemies[0].hp, 5, 'while dealing nothing yet')
})

check('an end-of-turn draw is preserved when a discard order was submitted', () => {
  CARDS.fixture_end_draw = {
    id: 'fixture_end_draw',
    name: 'Fixture End Draw',
    owner: 'ironclad',
    type: 'power',
    rarity: 'rare',
    cost: 0,
    trigger: { kind: 'endOfTurn' },
    effects: [{ kind: 'draw', amount: 1 }],
  }
  const bash = instance('bash')
  const defend = instance('defend_ironclad')
  const drawn = instance('strike_ironclad')
  const state = combat([
    player({ hand: [defend, bash], draw: [drawn], powers: [instance('fixture_end_draw')] }),
  ], [enemy()])
  const prepared = beginEndPlayerTurn(state)
  assertEqual(prepared.phase, 'discard', 'the post-trigger hand is offered for ordering')
  assertEqual(prepared.players[0].hand.length, 3, 'the drawn card is present in that choice')
  const next = endPlayerTurn(prepared, { p1: [bash.uid, drawn.uid, defend.uid] })
  assertEqual(next.players[0].hand.length, 0, 'the post-trigger hand is discarded')
  assertEqual(next.players[0].discard.length, 3, 'the drawn card is not lost')
  assertEqual(next.players[0].discard.at(-1).uid, defend.uid, 'the post-trigger choice controls the top')
  delete CARDS.fixture_end_draw
})

check('relics resolve before Powers on the same event', () => {
  // Both fire on the same trigger, so the order decides the outcome whenever
  // one feeds the other. Fixed order beats "whichever was pushed first".
  CARDS.fixture_order_power = {
    id: 'fixture_order_power',
    name: 'Fixture Order Power',
    owner: 'ironclad',
    type: 'power',
    rarity: 'rare',
    cost: 0,
    trigger: { kind: 'startOfTurn' },
    // Reads the Strength the relic just granted: 1 base + whatever is there.
    effects: [{ kind: 'hit', amount: 1 }],
  }
  const state = startPlayerTurn(
    combat(
      [
        player({
          // Burning Blood is endOfCombat; use a start-of-turn die relic that
          // grants Strength so the two land on the same event.
          powers: [instance('fixture_order_power'), instance('demon_form')],
          draw: deck(10),
        }),
      ],
      [enemy({ hp: 40 })],
    ),
  )
  // Demon Form is pushed after the hitting Power, so the hit lands BEFORE the
  // Strength — 1 damage, not 2. Pinning the order stops a silent reshuffle of
  // the sources list from changing outcomes.
  assertEqual(state.players[0].strength, 1, 'Demon Form granted its Strength')
  assertEqual(state.enemies[0].hp, 39, 'and the earlier Power hit for 1, before that Strength existed')
})

suite('what the table can see')

check('a Power says what it did, and when', () => {
  // Powers are a recurring effect the table has to track. Firing them in
  // silence left the log claiming the round contained nothing at all.
  let state = combat(
    [player({ powers: [instance('metallicize'), instance('demon_form')], draw: deck(10) })],
    [enemy()],
  )
  state = startPlayerTurn(state)
  const strengthLine = state.log.find((line) => line.includes('Demon Form'))
  assert(strengthLine, `Demon Form fired silently: ${state.log.join(' | ')}`)
  assert(strengthLine.includes('Strength'), `and should say what it gave: ${strengthLine}`)

  state = endPlayerTurn(state)
  const blockLine = state.log.find((line) => line.includes('Metallicize'))
  assert(blockLine, `Metallicize fired silently: ${state.log.join(' | ')}`)
  assert(blockLine.includes('Block'), `and should say what it gave: ${blockLine}`)
})

check('the round divider opens the round it belongs to', () => {
  // Written after the start-of-turn abilities, anything they logged rendered
  // on the far side of the divider and read as part of the previous turn.
  const state = startPlayerTurn(
    combat([player({ powers: [instance('demon_form')], draw: deck(10) })], [enemy()]),
  )
  const divider = state.log.findIndex((line) => /^Turn 1 begins/.test(line))
  const fired = state.log.findIndex((line) => line.includes('Demon Form'))
  assert(divider >= 0 && fired >= 0, `expected both lines: ${state.log.join(' | ')}`)
  assert(divider < fired, `the divider must open the round: ${state.log.join(' | ')}`)
})

check("the party's own effects are logged, not just the enemies'", () => {
  const defend = instance('defend_ironclad')
  const next = playCard(
    combat([player({ hand: [defend] })], [enemy()]),
    'p1',
    defend.uid,
    { enemyUid: null, playerId: 'p1' },
  )
  assert(
    next.log.some((line) => line.includes('Block')),
    `gaining Block went unlogged: ${next.log.join(' | ')}`,
  )
})

suite('power card data')

// The triggers are covered above; this pins the transcription itself. Cost is
// the detail nothing else checks, and two of these Powers change ONLY their
// cost when upgraded — so for them, cost is the whole upgrade.
//
// Every number here was read off the card scan in public/assets/cards, not
// copied out of cards.ts. A table copied from the code it checks proves only
// that copying works.
check('the four transcribed Powers match their printed cards', () => {
  const PRINTED = [
    { id: 'metallicize', cost: 1, upgradedCost: 0, rarity: 'uncommon' },
    { id: 'demon_form', cost: 3, upgradedCost: 2, rarity: 'rare' },
    { id: 'feel_no_pain', cost: 1, upgradedCost: 0, rarity: 'uncommon' },
    { id: 'dark_embrace', cost: 2, upgradedCost: 1, rarity: 'uncommon' },
  ]
  for (const printed of PRINTED) {
    const def = CARDS[printed.id]
    assert(def, `${printed.id} is missing`)
    assertEqual(def.type, 'power', `${printed.id} type`)
    assertEqual(def.cost, printed.cost, `${printed.id} cost`)
    assertEqual(def.rarity, printed.rarity, `${printed.id} rarity`)
    assertEqual(faceOf(def, true).cost, printed.upgradedCost, `${printed.id}+ upgraded cost`)
  }
})

report('powers and triggers')
