// Kratos, the playtest-only DLC character: roster gating, Rage, Unleash,
// Godslayer, Brutal Kill, and the cards that read those rules directly.
// Design and numbers: docs/kratos-design.md.
import {
  createCombat,
  endPlayerTurn,
  enemyTurn,
  playCard,
  startPlayerTurn,
} from '../src/game/combat.ts'
import { CARDS, STARTER_DECKS, cardDef, faceOf, releasedCardDefs } from '../src/game/cards.ts'
import { characterRewardDeck, createItemDecks } from '../src/game/acquisition.ts'
import { createCampaignProgress, finishCampaign, parseCampaignProgress } from '../src/game/campaign.ts'
import { STARTING_RELIC } from '../src/game/relics.ts'
import { createRng } from '../src/game/rng.ts'
import { MAX_HP } from '../src/game/run.ts'
import { readyForCombat } from '../src/game/run/encounters.ts'
import { createRun } from '../src/game/state.ts'
import { ALL_CHARACTER_IDS, CHARACTER_IDS, PLAYTEST_CHARACTER_IDS } from '../src/game/types.ts'
import { CHARACTERS, chooseCharacter, createRoom, createStore, joinRoom } from './lib/rooms.mjs'
import { suite, check, assert, assertDeepEqual, assertEqual, assertThrows, report } from './lib/harness.mjs'

let uid = 0
const card = (defId, upgraded = false) => ({ uid: `k${uid++}`, defId, upgraded })
const filler = (n = 10) => Array.from({ length: n }, () => card('strike_kratos'))

const kratos = (over = {}) => ({
  id: 'p1', name: 'Kratos', character: 'kratos', row: 0,
  hp: 10, maxHp: 10, block: 0, energy: 3, gold: 0,
  deck: [], draw: [], hand: [], discard: [], exhaust: [], powers: [],
  relics: [], potions: [], cardRewards: [], rareRewards: [],
  strength: 0, vulnerable: 0, weak: 0, shivs: 0, miracles: 0, rage: 0,
  stance: 'neutral', orbs: [null, null, null], dead: false, ...over,
})

const enemy = (over = {}) => ({
  uid: 'e1', defId: 'green_louse', row: 0, isBoss: false,
  hp: 30, maxHp: 30, block: 0,
  strength: 0, vulnerable: 0, weak: 0, poison: 0, actionIndex: 0, abilityUsed: true, dead: false, ...over,
})
const elite = (over = {}) => enemy({ uid: 'e2', defId: 'book_of_stabbing', ...over })
const boss = (over = {}) => enemy({ uid: 'e3', defId: 'hexaghost', isBoss: true, ...over })

const combat = (player, enemies = [enemy()]) => createCombat(createRng(7), [player], enemies)
const play = (state, held, context = {}) => playCard(state, 'p1', held.uid, { enemyUid: 'e1', playerId: 'p1', ...context })
const hpLost = (before, after, uid = 'e1') =>
  before.enemies.find((e) => e.uid === uid).hp - after.enemies.find((e) => e.uid === uid).hp
const kratosCards = Object.values(CARDS).filter((def) => def.owner === 'kratos')

suite('Kratos (playtest-only DLC character)')

check('Kratos is an engine character but not a released one', () => {
  assertDeepEqual([...PLAYTEST_CHARACTER_IDS], ['kratos'])
  assert(!CHARACTER_IDS.includes('kratos'), 'released character ids must not list Kratos')
  assert(ALL_CHARACTER_IDS.includes('kratos'), 'the engine id list includes Kratos')
  assert(!CHARACTERS.includes('kratos'), 'online rooms must not offer Kratos')
  const room = createRoom(createStore(), { code: 'KRATOS' })
  const seat = joinRoom(room, { name: 'Ann', character: 'ironclad' })
  assertThrows(() => chooseCharacter(room, seat.token, 'kratos'), 'online lobbies reject Kratos')
  assert(!releasedCardDefs().some((def) => def.owner === 'kratos'), 'the Compendium and stats card lists hide Kratos cards')
  assert(releasedCardDefs().some((def) => def.owner === 'hermit'), 'released pools stay listed')
})

check('a Kratos run starts with his board, relic, starter deck, and his own reward decks', () => {
  const run = createRun(11, [{ id: 'p1', name: 'Kratos', character: 'kratos' }])
  const [player] = run.players
  assertEqual(player.maxHp, 10)
  assertEqual(MAX_HP.kratos, 10)
  assertEqual(player.rage, 0)
  assertDeepEqual(player.relics.map((relic) => relic.defId), ['ashes_of_sparta'])
  assertEqual(STARTING_RELIC.kratos, 'ashes_of_sparta')
  assertDeepEqual(player.deck.map((held) => held.defId).sort(), [...STARTER_DECKS.kratos].sort())
  assertEqual(player.deck.length, 10)
  assert(player.cardRewards.length > 0 && player.cardRewards.every((id) => id === 'golden_ticket' || cardDef(id).owner === 'kratos'),
    'card rewards come only from the Kratos pool')
  assert(player.rareRewards.every((id) => cardDef(id).owner === 'kratos' && cardDef(id).rarity === 'rare'),
    'rare rewards are Kratos rares')
  assertEqual(run.meta.ruleset, 'base', 'Kratos plays the base ruleset')
})

check('released characters never draw Kratos cards from inactive reward decks', () => {
  const decks = createItemDecks(createRng(3), true, createCampaignProgress(), ['ironclad'], 'downfall')
  assert(!('kratos' in decks.characterCards) && !('kratos' in decks.characterRares), 'no Kratos inactive decks')
})

check('Kratos campaign marks are recorded and parsed without breaking released saves', () => {
  const finished = finishCampaign(createCampaignProgress(), {
    runId: 'kratos-1', characters: ['kratos'], bossesDefeated: 0, highestBossActDefeated: 0, ascensionPlayed: 0,
  })
  assertDeepEqual(finished.finishedRunIds, ['kratos-1'])
  const legacy = createCampaignProgress()
  delete legacy.characters.kratos
  assertEqual(parseCampaignProgress(JSON.parse(JSON.stringify(legacy))).characters.kratos, 8,
    'saves written before Kratos fall back to an unlocked Kratos')
})

check('the pool is 64 cards: 4 starter, 15 common, 30 uncommon, 15 rare, and every face prints its text', () => {
  const count = (rarity) => kratosCards.filter((def) => def.rarity === rarity).length
  assertEqual(kratosCards.length, 64)
  assertEqual(count('starter'), 4)
  assertEqual(count('common'), 15)
  assertEqual(count('uncommon'), 30)
  assertEqual(count('rare'), 15)
  for (const def of kratosCards) {
    if (def.id === 'strike_kratos' || def.id === 'defend_kratos') continue
    assert(def.printedText, `${def.id} prints its text`)
    assert(faceOf(def, true).printedText, `${def.id}+ prints its text`)
  }
  const deck = characterRewardDeck('kratos', false, createCampaignProgress())
  assertEqual(deck.filter((id) => id !== 'golden_ticket').length, 15 * 2 + 30)
})

check('Ashes of Sparta: 1 Rage at the start of combat and 1 per separate HP loss, capped at 5', () => {
  let state = combat(kratos({ relics: [{ defId: 'ashes_of_sparta', spent: false }], draw: filler() }), [enemy({ hp: 50, maxHp: 50 })])
  state = startPlayerTurn(state)
  assertEqual(state.players[0].rage, 1, 'start of combat grants 1 Rage')
  const hubris = card('kratos_hubris')
  state = { ...state, players: [{ ...state.players[0], hand: [...state.players[0].hand, hubris] }] }
  state = play(state, hubris)
  assertEqual(state.players[0].hp, 9)
  assertEqual(state.players[0].rage, 2, 'self-inflicted HP loss counts')
  state = { ...state, players: [{ ...state.players[0], rage: 5 }] }
  const again = card('kratos_hubris')
  state = { ...state, players: [{ ...state.players[0], hand: [...state.players[0].hand, again] }] }
  state = play(state, again)
  assertEqual(state.players[0].rage, 5, 'Rage never exceeds 5')
})

check('Unleash pays its Rage for the bonus, and "instead" keeps one hit', () => {
  const plume = card('kratos_plume_of_prometheus')
  const unleashed = combat(kratos({ hand: [plume], rage: 2 }))
  const after = play(unleashed, plume)
  assertEqual(hpLost(unleashed, after), 4, 'Unleash 2 deals 4 instead of 1')
  assertEqual(after.players[0].rage, 0, 'and spends 2 Rage')

  const short = combat(kratos({ hand: [plume], rage: 1 }))
  const weak = play(short, plume)
  assertEqual(hpLost(short, weak), 1, 'without enough Rage the base hit resolves')
  assertEqual(weak.players[0].rage, 1, 'and no Rage is spent')

  const held = combat(kratos({ hand: [plume], rage: 3 }))
  const kept = play(held, plume, { holdRage: true })
  assertEqual(hpLost(held, kept), 1, 'holding Rage skips the Unleash')
  assertEqual(kept.players[0].rage, 3)
})

check('God of War lowers Unleash by 1 (not stacking), and Ghost of Sparta pays only on spent Rage', () => {
  const kick = card('kratos_spartan_kick')
  const free = combat(kratos({ hand: [kick], powers: [card('kratos_god_of_war'), card('kratos_ghost_of_sparta')] }))
  const kicked = play(free, kick)
  assertEqual(kicked.enemies[0].weak, 1, 'Unleash 1 becomes free')
  assertEqual(kicked.players[0].block, 0, 'a free Unleash spends no Rage, so Ghost of Sparta stays quiet')

  const plume = card('kratos_plume_of_prometheus')
  const two = combat(kratos({ hand: [plume], rage: 1, powers: [card('kratos_god_of_war'), card('kratos_god_of_war'), card('kratos_ghost_of_sparta', true)] }))
  const after = play(two, plume)
  assertEqual(hpLost(two, after), 4, 'Unleash 2 costs 1')
  assertEqual(after.players[0].rage, 0)
  assertEqual(after.players[0].block, 2, 'upgraded Ghost of Sparta gives 2 Block')

  const zero = combat(kratos({ hand: [card('kratos_plume_of_prometheus')], rage: 0, powers: [card('kratos_god_of_war'), card('kratos_god_of_war')] }))
  assertEqual(hpLost(zero, play(zero, zero.players[0].hand[0])), 1, 'two copies never make Unleash 2 free')
})

check('Hyperion Charge Vulnerable doubles its own hit', () => {
  const charge = card('kratos_hyperion_charge')
  const state = combat(kratos({ hand: [charge], rage: 2 }))
  const after = play(state, charge)
  assertEqual(hpLost(state, after), 6)
  assertEqual(after.enemies[0].vulnerable, 0, 'the hit spends the Vulnerable it applied')
})

check('Godslayer and Deicide add damage only against Elites and Bosses', () => {
  for (const [target, expected] of [[enemy(), 3], [elite({ uid: 'e1' }), 5], [boss({ uid: 'e1' }), 5]]) {
    const blade = card('kratos_blade_of_artemis')
    const state = combat(kratos({ hand: [blade] }), [target])
    assertEqual(hpLost(state, play(state, blade)), expected, `Blade of Artemis against ${target.defId}`)
  }
  const patricide = card('kratos_patricide')
  const deicide = [card('kratos_deicide'), card('kratos_deicide')]
  const vsBoss = combat(kratos({ hand: [patricide], powers: deicide }), [boss({ uid: 'e1' })])
  assertEqual(hpLost(vsBoss, play(vsBoss, patricide)), 15, 'five hits of 1 + 1 Godslayer + 1 Deicide; copies do not stack')
  const strike = card('strike_kratos')
  const hallway = combat(kratos({ hand: [strike], powers: deicide }))
  assertEqual(hpLost(hallway, play(hallway, strike)), 1, 'Deicide ignores normal enemies')
})

check('Brutal Kill, Bloodlust, and Red Orbs reward only a kill by your own hit', () => {
  const rip = card('kratos_cyclops_eye_rip')
  const kill = combat(kratos({ hand: [rip], powers: [card('kratos_bloodlust'), card('kratos_red_orbs')] }), [enemy({ hp: 2 }), enemy({ uid: 'e9' })])
  const after = play(kill, rip)
  assert(after.enemies[0].dead, 'the target died')
  assertEqual(after.players[0].energy, 3 - 1 + 1 + 1, 'Brutal Kill +1 Energy and Red Orbs +1 Energy')
  assertEqual(after.players[0].rage, 5, 'Brutal Kill 2 + Bloodlust 2 + Red Orbs 1')

  const rip2 = card('kratos_cyclops_eye_rip')
  const survive = combat(kratos({ hand: [rip2], powers: [card('kratos_bloodlust')] }))
  const alive = play(survive, rip2)
  assertEqual(alive.players[0].energy, 2)
  assertEqual(alive.players[0].rage, 0, 'no kill, no reward')
})

check('Medusa\'s Gaze executes small enemies only', () => {
  const gaze = card('kratos_medusas_gaze')
  const small = combat(kratos({ hand: [gaze] }), [enemy({ hp: 3 }), enemy({ uid: 'e9' })])
  assert(play(small, gaze).enemies[0].dead, '3 HP is executed')
  const gaze2 = card('kratos_medusas_gaze')
  const large = combat(kratos({ hand: [gaze2] }), [enemy({ hp: 4 })])
  const after = play(large, gaze2)
  assertEqual(after.enemies[0].hp, 4)
  assertEqual(after.enemies[0].weak, 1)
})

check('Rage of Sparta turns all Rage into this turn\'s Strength, protects only at 5, and exhausts', () => {
  const rage = card('kratos_rage_of_sparta')
  const full = combat(kratos({ hand: [rage], rage: 5 }))
  const after = play(full, rage)
  assertEqual(after.players[0].strength, 5)
  assertEqual(after.players[0].rage, 0)
  assertEqual(after.players[0].hpLossLimitThisRound, 1, 'spending 5 Rage limits this round\'s HP loss')
  assert(after.players[0].exhaust.some((held) => held.uid === rage.uid), 'Rage of Sparta exhausts')

  const partial = card('kratos_rage_of_sparta')
  const three = play(combat(kratos({ hand: [partial], rage: 3 })), partial)
  assertEqual(three.players[0].strength, 3)
  assertEqual(three.players[0].hpLossLimitThisRound, undefined, 'less than 5 Rage gives no protection')
  assertEqual(endPlayerTurn(three).players[0].strength, 0, 'the Strength is gone at end of turn')
})

check('Blade of Olympus and Rage of the Titans count Rage, then spend all of it', () => {
  const blade = card('kratos_blade_of_olympus')
  const state = combat(kratos({ hand: [blade], rage: 4 }))
  const after = play(state, blade)
  assertEqual(hpLost(state, after), 10)
  assertEqual(after.players[0].rage, 0)

  const titans = card('kratos_rage_of_the_titans')
  const release = combat(kratos({ hand: [titans], rage: 3, strength: 2 }))
  const released = play(release, titans)
  assertEqual(hpLost(release, released), 3, 'plain damage ignores Strength')
  assertEqual(released.players[0].block, 3)
  assertEqual(released.players[0].rage, 0)
})

check('Vengeance and Spartan Resolve read Rage without spending it', () => {
  const vengeance = card('kratos_vengeance')
  const state = combat(kratos({ hand: [vengeance], rage: 5 }))
  const after = play(state, vengeance)
  assertEqual(hpLost(state, after), 6)
  assertEqual(after.players[0].rage, 5)
  const resolve = card('kratos_spartan_resolve', true)
  assertEqual(play(combat(kratos({ hand: [resolve], rage: 5 })), resolve).players[0].block, 7)
})

check('Blades of Athena adds Rage after an Attack, too late for its own Unleash', () => {
  const whip = card('kratos_nemesis_whip')
  const state = combat(kratos({ hand: [whip], powers: [card('kratos_blades_of_athena')] }))
  const after = play(state, whip)
  assertEqual(hpLost(state, after), 2, 'Nemesis Whip could not pay Unleash 1 with its own Rage')
  assertEqual(after.players[0].rage, 1)
})

check('Escape from Hades keeps Kratos alive once, then exhausts', () => {
  const pandora = card('kratos_pandoras_box')
  const escape = card('kratos_escape_from_hades')
  const state = combat(kratos({ hp: 2, hand: [pandora], powers: [escape] }))
  const after = play(state, pandora)
  assertEqual(after.players[0].hp, 1)
  assert(!after.players[0].dead, 'Kratos survives')
  assert(after.players[0].exhaust.some((held) => held.uid === escape.uid), 'the Power is exhausted')
  assertEqual(after.players[0].rage, 5, "Pandora's Box fills the meter")
})

check('Hubris draws only when it actually costs HP, so an HP-loss cap cannot loop it', () => {
  const hubris = card('kratos_hubris')
  const capped = combat(kratos({ hand: [hubris], draw: filler(5), relics: [{ defId: 'ashes_of_sparta', spent: false }] }))
  capped.players[0].hpLostThisRound = 1
  capped.players[0].hpLossLimitThisRound = 1
  const after = play(capped, hubris)
  assertEqual(after.players[0].hp, 10, 'the cap prevents the HP loss')
  assertEqual(after.players[0].hand.length, 0, 'so Hubris draws nothing')
  assertEqual(after.players[0].rage, 0, 'and prevented HP loss gives no Rage')
})

check('Rage is reset when the next combat is readied', () => {
  const ready = readyForCombat(createRng(5), kratos({ rage: 4, deck: filler(5) }))
  assertEqual(ready.rage, 0)
  const { rage: _rage, ...plain } = kratos({ deck: filler(5) })
  const ironclad = readyForCombat(createRng(5), { ...plain, character: 'ironclad' })
  assert(!('rage' in ironclad), 'other characters never grow a Rage field')
})

check('a Kratos combat runs whole rounds through the engine', () => {
  let state = combat(kratos({ relics: [{ defId: 'ashes_of_sparta', spent: false }], draw: [
    card('kratos_blades_of_chaos'), card('kratos_plume_of_prometheus'), ...filler(8),
  ] }), [enemy({ hp: 40, maxHp: 40 })])
  for (let round = 0; round < 3; round++) {
    state = startPlayerTurn(state)
    for (const held of [...state.players[0].hand]) {
      if (state.players[0].energy < 1) break
      state = play(state, held)
    }
    state = enemyTurn(endPlayerTurn(state))
  }
  assert(state.enemies[0].hp < 40, 'Kratos dealt damage across three rounds')
  assert(state.log.some((line) => line.includes('Rage')), 'Rage changes are logged')
})

// Every Kratos face, played once on a fixed board: two 30 HP enemies in one row,
// 3 Energy, five cards in the draw pile. Unlisted fields are expected unchanged;
// Energy defaults to 3 minus the face's cost, so cost upgrades are checked too.
const FACES = [
  ['strike_kratos', {}, { dmg: [1, 0] }], ['strike_kratos+', {}, { dmg: [2, 0] }],
  ['defend_kratos', {}, { block: 1 }], ['defend_kratos+', {}, { block: 2 }],
  ['kratos_blades_of_chaos', {}, { dmg: [1, 1], rage: 1 }], ['kratos_blades_of_chaos+', {}, { dmg: [2, 2], rage: 1 }],
  ['kratos_plume_of_prometheus', { rage: 2 }, { dmg: [4, 0], rage: 0 }], ['kratos_plume_of_prometheus+', { rage: 2 }, { dmg: [5, 0], rage: 0 }],
  ['kratos_orions_harpoon', {}, { dmg: [2, 0], rage: 1 }], ['kratos_orions_harpoon+', {}, { dmg: [3, 0], rage: 1 }],
  ['kratos_cyclone_of_chaos', {}, { dmg: [3, 3], rage: 1 }], ['kratos_cyclone_of_chaos+', {}, { dmg: [4, 4], rage: 1 }],
  ['kratos_spartan_kick', { rage: 1 }, { dmg: [1, 0], weak: [1, 0], rage: 0 }], ['kratos_spartan_kick+', { rage: 1 }, { dmg: [2, 0], weak: [1, 0], rage: 0 }],
  ['kratos_hyperion_charge', { rage: 2 }, { dmg: [6, 0], rage: 0 }], ['kratos_hyperion_charge+', { rage: 2 }, { dmg: [8, 0], rage: 0 }],
  ['kratos_nemesis_whip', { rage: 1 }, { dmg: [3, 0], rage: 0 }], ['kratos_nemesis_whip+', { rage: 1 }, { dmg: [4, 0], rage: 0 }],
  ['kratos_blade_of_artemis', {}, { dmg: [3, 0] }], ['kratos_blade_of_artemis+', {}, { dmg: [4, 0] }],
  ['kratos_cyclops_eye_rip', {}, { dmg: [2, 0] }], ['kratos_cyclops_eye_rip+', {}, { dmg: [3, 0] }],
  ['kratos_zeus_fury', { ctx: { enemyUids: ['e1', 'e2'] } }, { dmg: [1, 1] }],
  ['kratos_zeus_fury+', { ctx: { enemyUids: ['e1', 'e1', 'e2'] } }, { dmg: [2, 1] }],
  ['kratos_rage_of_the_gods', {}, { rage: 2, exhausted: true }], ['kratos_rage_of_the_gods+', {}, { rage: 3, exhausted: true }],
  ['kratos_parry', {}, { block: 2, rage: 1 }], ['kratos_parry+', {}, { block: 3, rage: 1 }],
  ['kratos_spartan_guard', { rage: 2 }, { block: 5, rage: 0 }], ['kratos_spartan_guard+', { rage: 2 }, { block: 6, rage: 0 }],
  ['kratos_golden_fleece', {}, { block: 2 }], ['kratos_golden_fleece+', {}, { block: 3 }],
  ['kratos_icarus_wings', {}, { block: 1, drawn: 2 }], ['kratos_icarus_wings+', {}, { block: 2, drawn: 2 }],
  ['kratos_bow_of_apollo', { rage: 1 }, { dmg: [3, 0], rage: 0 }], ['kratos_bow_of_apollo+', { rage: 1 }, { dmg: [4, 0], rage: 0 }],
  ['kratos_hermes_rush', { rage: 1 }, { block: 2, drawn: 1, rage: 0 }], ['kratos_hermes_rush+', { rage: 1 }, { block: 3, drawn: 1, rage: 0 }],
  ['kratos_servant_of_ares', {}, { power: true }], ['kratos_servant_of_ares+', {}, { power: true }],
  ['kratos_chains_of_chaos', {}, { power: true }], ['kratos_chains_of_chaos+', {}, { power: true }],
  ['kratos_bloodlust', {}, { power: true }], ['kratos_bloodlust+', {}, { power: true }],
  ['kratos_ghost_of_sparta', {}, { power: true }], ['kratos_ghost_of_sparta+', {}, { power: true }],
  ['kratos_deicide', {}, { power: true }], ['kratos_deicide+', {}, { power: true }],
  ['kratos_vengeance', { rage: 3 }, { dmg: [4, 0], rage: 3 }], ['kratos_vengeance+', { rage: 3 }, { dmg: [5, 0], rage: 3 }],
  ['kratos_poseidons_rage', { rage: 2 }, { dmg: [5, 5], rage: 0 }], ['kratos_poseidons_rage+', { rage: 2 }, { dmg: [6, 6], rage: 0 }],
  ['kratos_poseidons_rage', {}, { dmg: [3, 3] }],
  ['kratos_atlas_quake', { rage: 2 }, { dmg: [2, 2], weak: [1, 1], vulnerable: [1, 1], rage: 0 }],
  ['kratos_atlas_quake+', { rage: 2 }, { dmg: [3, 3], weak: [1, 1], vulnerable: [1, 1], rage: 0 }],
  ['kratos_cronos_rage', { ctx: { enemyUids: ['e1', 'e1', 'e2'] } }, { dmg: [2, 1], rage: 2 }],
  ['kratos_cronos_rage+', { ctx: { enemyUids: ['e1', 'e1', 'e1', 'e2'] } }, { dmg: [3, 1], rage: 2 }],
  ['kratos_tartarus_rage', { attacksPlayed: 2 }, { dmg: [2, 2] }], ['kratos_tartarus_rage+', { attacksPlayed: 2 }, { dmg: [3, 3] }],
  ['kratos_apollos_ascension', { rage: 1 }, { dmg: [2, 0], vulnerable: [1, 0], rage: 0 }],
  ['kratos_apollos_ascension+', { rage: 1 }, { dmg: [3, 0], vulnerable: [1, 0], rage: 0 }],
  // Nemean Cestus strips the 5 Block first, so the whole hit reaches HP.
  ['kratos_nemean_cestus', { enemyBlock: 5 }, { dmg: [3, 0] }], ['kratos_nemean_cestus+', { enemyBlock: 5 }, { dmg: [4, 0] }],
  ['kratos_claws_of_hades', {}, { dmg: [2, 0] }], ['kratos_claws_of_hades+', {}, { dmg: [3, 0] }],
  ['kratos_nemean_roar', { rage: 2 }, { dmg: [1, 1], weak: [1, 1], rage: 0 }], ['kratos_nemean_roar+', { rage: 2 }, { dmg: [2, 2], weak: [1, 1], rage: 0 }],
  ['kratos_army_of_sparta', {}, { dmg: [2, 2], block: 3 }], ['kratos_army_of_sparta+', {}, { dmg: [2, 2], block: 4 }],
  ['kratos_medusas_gaze', {}, { weak: [1, 0] }], ['kratos_medusas_gaze+', {}, { weak: [1, 0] }],
  ['kratos_head_of_helios', {}, { weak: [1, 1], drawn: 1, exhausted: true }], ['kratos_head_of_helios+', {}, { weak: [1, 1], drawn: 1, exhausted: true }],
  ['kratos_rage_of_the_titans', { rage: 3 }, { dmg: [3, 3], block: 3, rage: 0 }], ['kratos_rage_of_the_titans+', { rage: 3 }, { dmg: [3, 3], block: 4, rage: 0 }],
  ['kratos_spartan_resolve', { rage: 3 }, { block: 3, rage: 3 }], ['kratos_spartan_resolve+', { rage: 3 }, { block: 5, rage: 3 }],
  ['kratos_hubris', {}, { hp: 9, drawn: 2 }], ['kratos_hubris+', {}, { hp: 9, drawn: 3 }],
  ['kratos_sacrifice', { extra: true, ctx: { exhaustUids: ['extra'] } }, { rage: 2, handLost: 1 }],
  ['kratos_sacrifice+', { extra: true, ctx: { exhaustUids: ['extra'] } }, { rage: 3, handLost: 1 }],
  ['kratos_sacrifice', { ctx: { exhaustUids: [] } }, { rage: 0 }],
  ['kratos_blood_oath', {}, { hp: 9, energy: 4, exhausted: true }], ['kratos_blood_oath+', {}, { hp: 9, energy: 5, exhausted: true }],
  ['kratos_athenas_blessing', { rage: 2 }, { drawn: 3, rage: 0 }], ['kratos_athenas_blessing+', { rage: 2 }, { drawn: 4, rage: 0 }],
  ['kratos_boots_of_hermes', {}, { drawn: 1, exhausted: true }], ['kratos_boots_of_hermes+', {}, { drawn: 2, exhausted: true }],
  ['kratos_loom_of_fate', { discard: true, ctx: { recoverDiscardUid: 'old' } }, { rage: 1, recovered: true }],
  ['kratos_loom_of_fate+', { discard: true, ctx: { recoverDiscardUid: 'old' } }, { rage: 2, recovered: true }],
  ['kratos_typhons_bane', { ctx: { enemyUids: ['e1', 'e2'] } }, { weak: [1, 1] }],
  ['kratos_typhons_bane+', { ctx: { enemyUids: ['e1', 'e1', 'e2'] } }, { weak: [2, 1] }],
  ['kratos_head_of_euryale', { e1Hp: 3 }, { killed: true, weak: [1, 1], exhausted: true }],
  ['kratos_head_of_euryale+', { e1Hp: 3 }, { killed: true, weak: [1, 1], exhausted: true }],
  ['kratos_soul_summon', {}, { power: true }], ['kratos_soul_summon+', {}, { power: true }],
  ['kratos_green_orbs', {}, { power: true }], ['kratos_green_orbs+', {}, { power: true }],
  ['kratos_hercules_shoulder_guard', { rage: 1 }, { block: 5, rage: 0 }], ['kratos_hercules_shoulder_guard+', { rage: 1 }, { block: 6, rage: 0 }],
  ['kratos_rage_of_sparta', { rage: 4 }, { strength: 4, rage: 0, exhausted: true }], ['kratos_rage_of_sparta+', { rage: 4 }, { strength: 4, rage: 0, exhausted: true }],
  ['kratos_blade_of_olympus', { rage: 2 }, { dmg: [6, 0], rage: 0 }], ['kratos_blade_of_olympus+', { rage: 2 }, { dmg: [8, 0], rage: 0 }],
  ['kratos_god_of_war', {}, { power: true }], ['kratos_god_of_war+', {}, { power: true }],
  ['kratos_blades_of_athena', {}, { power: true }], ['kratos_blades_of_athena+', {}, { power: true }],
  ['kratos_army_of_hades', {}, { power: true }], ['kratos_army_of_hades+', {}, { power: true }],
  ['kratos_barbarian_hammer', { rage: 2 }, { dmg: [10, 10], vulnerable: [0, 0], rage: 0 }],
  ['kratos_barbarian_hammer+', { rage: 2 }, { dmg: [12, 12], vulnerable: [0, 0], rage: 0 }],
  ['kratos_patricide', {}, { dmg: [5, 0] }], ['kratos_patricide+', {}, { dmg: [6, 0] }],
  ['kratos_blade_of_the_gods', {}, { dmg: [3, 0] }], ['kratos_blade_of_the_gods+', {}, { dmg: [4, 0] }],
  ['kratos_spear_of_destiny', {}, { dmg: [3, 3], vulnerable: [1, 1] }], ['kratos_spear_of_destiny+', {}, { dmg: [4, 4], vulnerable: [1, 1] }],
  ['kratos_red_orbs', {}, { power: true }], ['kratos_red_orbs+', {}, { power: true }],
  ['kratos_pandoras_box', {}, { hp: 8, rage: 5, drawn: 2, exhausted: true }], ['kratos_pandoras_box+', {}, { hp: 8, rage: 5, drawn: 2, exhausted: true }],
  ['kratos_escape_from_hades', {}, { power: true }], ['kratos_escape_from_hades+', {}, { power: true }],
  ['kratos_amulet_of_the_fates', {}, { weak: [2, 2], block: 4, exhausted: true }], ['kratos_amulet_of_the_fates+', {}, { weak: [2, 2], block: 4, exhausted: true }],
  ['kratos_blades_of_exile', {}, { power: true }], ['kratos_blades_of_exile+', {}, { power: true }],
  ['kratos_fall_of_olympus', {}, { dmg: [6, 6], exhausted: true }], ['kratos_fall_of_olympus+', {}, { dmg: [8, 8], exhausted: true }],
]

check('every Kratos face does what it prints', () => {
  const faces = new Set(FACES.map(([key]) => key))
  for (const def of kratosCards) for (const key of [def.id, `${def.id}+`]) assert(faces.has(key), `${key} has an expected outcome`)
  for (const [key, setup, expected] of FACES) {
    const upgraded = key.endsWith('+')
    const defId = key.replace(/\+$/, '')
    const face = faceOf(cardDef(defId), upgraded)
    const held = card(defId, upgraded)
    const extra = setup.extra ? [{ uid: 'extra', defId: 'strike_kratos', upgraded: false }] : []
    let state = combat(kratos({
      hand: [held, ...extra], rage: setup.rage ?? 0, draw: filler(5),
      discard: setup.discard ? [{ uid: 'old', defId: 'strike_kratos', upgraded: false }] : [],
    }), [enemy({ hp: setup.e1Hp ?? 30, block: setup.enemyBlock ?? 0 }), enemy({ uid: 'e2' })])
    if (setup.attacksPlayed) state.players[0].attacksPlayedThisTurn = setup.attacksPlayed
    const after = play(state, held, setup.ctx ?? {})
    assert(after !== state, `${key} is playable`)
    const [p0, p1] = [state.players[0], after.players[0]]
    const lost = (uid) => {
      const was = state.enemies.find((e) => e.uid === uid)
      const now = after.enemies.find((e) => e.uid === uid)
      return was.hp - now.hp
    }
    const field = (uid, name) => after.enemies.find((e) => e.uid === uid)[name]
    if (expected.killed) assert(after.enemies[0].dead, `${key} kills the small target`)
    else assertDeepEqual([lost('e1'), lost('e2')], expected.dmg ?? [0, 0], `${key} damage`)
    assertDeepEqual([field('e1', 'weak'), field('e2', 'weak')], expected.weak ?? [0, 0], `${key} Weak`)
    assertDeepEqual([field('e1', 'vulnerable'), field('e2', 'vulnerable')], expected.vulnerable ?? [0, 0], `${key} Vulnerable`)
    assertEqual(p1.block, expected.block ?? 0, `${key} Block`)
    assertEqual(p1.rage ?? 0, expected.rage ?? p0.rage, `${key} Rage`)
    assertEqual(p1.energy, expected.energy ?? 3 - face.cost, `${key} Energy`)
    assertEqual(p1.hp, expected.hp ?? 10, `${key} HP`)
    assertEqual(p1.strength, expected.strength ?? 0, `${key} Strength`)
    assertEqual(p1.powers.length, expected.power ? 1 : 0, `${key} stays in play only if it is a Power`)
    assertEqual(p1.exhaust.some((c) => c.uid === held.uid), expected.exhausted === true, `${key} Exhaust`)
    const recovered = expected.recovered ? 1 : 0
    assertEqual(p1.hand.length - (p0.hand.length - 1), (expected.drawn ?? 0) + recovered - (expected.handLost ?? 0), `${key} hand size`)
  }
})

check('Kratos Powers fire on their printed triggers', () => {
  let state = combat(kratos({ draw: filler(10), powers: [card('kratos_servant_of_ares'), card('kratos_god_of_war'), card('kratos_god_of_war')] }))
  assertEqual(startPlayerTurn(state).players[0].rage, 3, 'Servant of Ares and each God of War copy add 1 Rage')

  const strike = card('strike_kratos')
  state = combat(kratos({ hand: [strike], powers: [card('kratos_soul_summon', true), card('kratos_army_of_hades')] }))
  state = play(state, strike)
  const ended = endPlayerTurn(state)
  assertEqual(30 - ended.enemies[0].hp, 1 + 2 + 1, 'the Strike, Soul Summon+ (2) and Army of Hades (1 Attack played)')

  const hit = card('kratos_hubris')
  const chains = play(combat(kratos({ hand: [hit], draw: filler(5), relics: [{ defId: 'ashes_of_sparta', spent: false }],
    powers: [card('kratos_chains_of_chaos')] })), hit)
  assertEqual(chains.players[0].rage, 2, 'Ashes of Sparta and Chains of Chaos each add 1 Rage per HP loss')
})

check('Blades of Exile adds 1 to each hit of a row or all-enemy Attack only', () => {
  const cyclone = card('kratos_cyclone_of_chaos')
  const exile = [card('kratos_blades_of_exile'), card('kratos_blades_of_exile')]
  const row = combat(kratos({ hand: [cyclone], powers: exile }))
  assertEqual(hpLost(row, play(row, cyclone)), 6, 'three hits of 2; copies do not stack')
  const strike = card('strike_kratos')
  const single = combat(kratos({ hand: [strike], powers: exile }))
  assertEqual(hpLost(single, play(single, strike)), 1, 'single-target Attacks are unchanged')
})

check('Green Orbs heals 1 HP once per combat, however many copies are in play', () => {
  const strikes = [card('strike_kratos'), card('strike_kratos')]
  const orbs = [card('kratos_green_orbs'), card('kratos_green_orbs', true)]
  let state = combat(kratos({ hp: 5, hand: strikes, powers: orbs }), [enemy({ hp: 1 }), enemy({ uid: 'e2', hp: 1 }), enemy({ uid: 'e3' })])
  state = play(state, strikes[0])
  assertEqual(state.players[0].hp, 6)
  assertEqual(state.players[0].powers.length, 0, 'every copy is exhausted together')
  state = play(state, strikes[1], { enemyUid: 'e2' })
  assertEqual(state.players[0].hp, 6, 'no more healing this combat')
})

check('Boots of Hermes makes the next Attack free this turn', () => {
  const boots = card('kratos_boots_of_hermes')
  const hammer = card('kratos_barbarian_hammer')
  let state = combat(kratos({ hand: [boots, hammer], draw: filler(5) }))
  state = play(state, boots)
  state = play(state, hammer)
  assertEqual(state.players[0].energy, 2, 'only Boots of Hermes was paid for')
})

check('regressions from code review: tokens, caps, rescues, and pointless Unleash', () => {
  // A character without Rage never grows the field, even through HP loss in combat.
  const offering = card('offering')
  const { rage: _r, ...plain } = kratos({ hand: [offering], draw: filler(5) })
  const ironclad = play(combat({ ...plain, character: 'ironclad' }), offering)
  assert(!('rage' in ironclad.players[0]), 'an Ironclad who loses HP has no Rage field')

  // Poseidon's Rage is one Attack: one Weak off Kratos, one Vulnerable off the target.
  const poseidon = card('kratos_poseidons_rage')
  const tokens = play(combat(kratos({ hand: [poseidon], rage: 2, weak: 2 }), [enemy({ vulnerable: 2 })]), poseidon)
  assertEqual(tokens.players[0].weak, 1)
  assertEqual(tokens.enemies[0].vulnerable, 1)

  // Rage of Sparta only takes back the Strength it gave under the cap of 8.
  const sparta = card('kratos_rage_of_sparta')
  const capped = play(combat(kratos({ hand: [sparta], rage: 5, strength: 5 })), sparta)
  assertEqual(capped.players[0].strength, 8)
  assertEqual(endPlayerTurn(capped).players[0].strength, 5, 'permanent Strength survives the end of turn')

  // Escape from Hades saves Kratos before Fairy in a Bottle, which then saves him next.
  const boxes = [card('kratos_pandoras_box'), card('kratos_pandoras_box')]
  let rescue = combat(kratos({ hp: 2, energy: 3, hand: boxes, potions: ['fairy_in_a_bottle'], powers: [card('kratos_escape_from_hades')] }))
  rescue = play(rescue, boxes[0])
  assertEqual(rescue.players[0].hp, 1)
  assertDeepEqual(rescue.players[0].potions, ['fairy_in_a_bottle'], 'the Fairy is kept')
  rescue = play(rescue, boxes[1])
  assert(!rescue.players[0].dead, 'the Fairy saves the second lethal loss')
  assertDeepEqual(rescue.players[0].potions, [])

  // An Unleash after a lethal hit keeps its Rage and gives no Ghost of Sparta Block.
  const kick = card('kratos_spartan_kick')
  const overkill = play(combat(kratos({ hand: [kick], rage: 3, powers: [card('kratos_ghost_of_sparta')] }),
    [enemy({ hp: 1 }), enemy({ uid: 'e9' })]), kick)
  assertEqual(overkill.players[0].rage, 3)
  assertEqual(overkill.players[0].block, 0)

  // Golden Fleece's Unleash reflects at enemies attacking Kratos.
  const fleece = card('kratos_golden_fleece')
  const attacked = { ...combat(kratos({ hand: [fleece], rage: 1 }), [enemy({ defId: 'cultist', hp: 5, maxHp: 5 })]), die: 1 }
  const reflected = play(attacked, fleece, { enemyUid: null })
  assertEqual(reflected.enemies[0].hp, 4)
  assertEqual(reflected.players[0].rage, 0)

  // Claws of Hades draws on a Brutal Kill; Medusa's Gaze kills are not hits.
  const claws = card('kratos_claws_of_hades')
  const clawed = play(combat(kratos({ hand: [claws], draw: filler(5) }), [enemy({ hp: 2 }), enemy({ uid: 'e9' })]), claws)
  assertEqual(clawed.players[0].hand.length, 2)
  const gaze = card('kratos_medusas_gaze', true)
  const stoned = play(combat(kratos({ hand: [gaze], powers: [card('kratos_bloodlust')] }), [enemy({ hp: 4 }), enemy({ uid: 'e9' })]), gaze)
  assert(stoned.enemies[0].dead)
  assertEqual(stoned.players[0].rage, 0, 'an execute is not a hit, so Bloodlust stays quiet')

  // A row card keeps its row after the hit kills the clicked enemy.
  const quake = card('kratos_atlas_quake')
  const aftershock = play(combat(kratos({ hand: [quake], rage: 2 }), [enemy({ hp: 2 }), enemy({ uid: 'e2' })]), quake)
  assert(aftershock.enemies[0].dead)
  assertDeepEqual([aftershock.enemies[1].weak, aftershock.enemies[1].vulnerable], [1, 1], 'the survivor still gets the debuffs')
  assertEqual(aftershock.players[0].rage, 0)
  const spear = card('kratos_spear_of_destiny')
  const pierced = play(combat(kratos({ hand: [spear] }), [enemy({ hp: 3 }), enemy({ uid: 'e2' })]), spear)
  assertEqual(pierced.enemies[1].vulnerable, 1)

  // Blades of Exile also boosts every-enemy Attacks.
  const fall = card('kratos_fall_of_olympus')
  const olympus = play(combat(kratos({ hand: [fall], powers: [card('kratos_blades_of_exile')] }), [enemy(), enemy({ uid: 'e2', row: 1 })]), fall)
  assertDeepEqual(olympus.enemies.map((e) => 30 - e.hp), [9, 9])
})

report('kratos')
