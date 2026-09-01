import assert from 'node:assert/strict'
import {
  activatePower,
  cardEnemyChoiceCount,
  createCombat,
  playCard,
  playCardCopy,
  playCost,
  spendSoulburn,
  startPlayerTurnWithChoices,
  startTurnAbilities,
  resolveStartPlayerTurn,
  startPlayerTurn,
} from '../src/game/combat.ts'
import { CARDS, STARTER_DECKS, faceOf } from '../src/game/cards.ts'
import { createRng } from '../src/game/rng.ts'
import { characterRewardDeck } from '../src/game/acquisition.ts'
import { createCampaignProgress } from '../src/game/campaign.ts'

let nextUid = 1
const instance = (defId, upgraded = false) => ({ uid: `h${nextUid++}`, defId, upgraded })

function player(overrides = {}) {
  return {
    id: 'p1', name: 'Hexaghost', character: 'hexaghost', row: 0,
    hp: 9, maxHp: 9, block: 0, energy: 3, gold: 0,
    deck: [], draw: [], hand: [], discard: [], exhaust: [], powers: [],
    strength: 0, strengthLossAtEndOfTurn: 0, vulnerable: 0, weak: 0,
    drawLocked: false, lostHpThisCombat: false, attacksPlayedThisTurn: 0,
    shivs: 0, shivDamageBonus: 0, cardBlockBonus: 0, hitPoison: 0,
    miracles: 0, stance: 'neutral', wrathAttackDamageBonus: 0,
    orbs: [null, null, null], heat: 1, soulburn: 0,
    chamber: [], chamberSlots: 0, guardianMode: null, vigor: 0, vigorSpentThisTurn: 0, slimes: [],
    relics: [], potions: [], cardRewards: [], rareRewards: [], dead: false,
    ...overrides,
  }
}

function enemy(overrides = {}) {
  return {
    uid: 'e1', defId: 'cultist', row: 0, isBoss: false,
    hp: 30, maxHp: 30, block: 0, strength: 0, vulnerable: 0, weak: 0, poison: 0,
    goldReward: 0, cardReward: null, actionIndex: 0, abilityUsed: false, dead: false,
    ...overrides,
  }
}

const combat = (owner, foes = [enemy()]) => createCombat(createRng(47), [owner], foes)
const context = (enemyUid = 'e1', extra = {}) => ({ enemyUid, playerId: null, ...extra })

const cards = Object.values(CARDS).filter((def) => def.owner === 'hexaghost')
assert.equal(cards.length, 64, 'all 4 starter, 15 common, 29 uncommon, and 16 rare definitions')
assert.deepEqual(Object.fromEntries(['starter', 'common', 'uncommon', 'rare'].map((rarity) =>
  [rarity, cards.filter((def) => def.rarity === rarity).length])), {
  starter: 4, common: 15, uncommon: 29, rare: 16,
})
assert.equal(STARTER_DECKS.hexaghost.length, 10)
assert.deepEqual(Object.fromEntries([...new Set(STARTER_DECKS.hexaghost)].map((id) =>
  [id, STARTER_DECKS.hexaghost.filter((candidate) => candidate === id).length])), {
  strike_hexaghost: 4, defend_hexaghost: 4, kindle: 1, sear: 1,
})
assert(cards.every((def) => def.upgrade), 'every physical Hexaghost card has an upgraded face')
const progress = createCampaignProgress()
assert.equal(characterRewardDeck('hexaghost', false, progress).length, 61, 'physical reward deck count')
assert.equal(characterRewardDeck('hexaghost', true, progress).length, 16, 'physical rare deck count')

// Advance and Retract count at the caps, so their Powers still see the event.
{
  const kindle = instance('kindle')
  const visage = instance('volcano_visage')
  const poltergeist = instance('poltergeist')
  const state = combat(player({ heat: 6, hand: [kindle], powers: [visage, poltergeist] }))
  const next = playCard(state, 'p1', kindle.uid, context())
  assert.equal(next.players[0].heat, 6)
  assert.equal(next.players[0].block, 2, 'Kindle block plus capped Advance trigger')
  assert.equal(next.enemies[0].hp, 28, 'Poltergeist sees capped Advance')
}

// Soulburn is plain damage: Heat and Heat Crush apply, combat Attack modifiers do not.
{
  const state = combat(player({
    heat: 4, soulburn: 1, strength: 6, weak: 2,
  }), [enemy({ block: 1, vulnerable: 3 })])
  state.players[0].nextSoulburnDamageBonus = 3
  const next = spendSoulburn(state, 'p1', 'e1')
  assert.equal(next.enemies[0].hp, 24, '7 plain damage spends 1 Block and 6 HP')
  assert.equal(next.enemies[0].vulnerable, 3)
  assert.equal(next.players[0].weak, 2)
  assert.equal(next.players[0].soulburn, 0)
  assert.equal(next.players[0].nextSoulburnDamageBonus, 0)
  assert.equal(next.players[0].soulburnUsedThisTurn, true)
  assert.deepEqual(next.presentationEvents.at(-1), {
    seq: 1,
    kind: 'card',
    actorId: 'p1',
    sourceId: 'strike_hexaghost',
    upgraded: false,
    copied: false,
    energy: 0,
    resolvedType: 'attack',
    enemyIds: ['e1'],
    playerIds: [],
  }, 'spending Soulburn reuses Hexaghost green-flame flight, impact, and SFX presentation')
}

// Corrupted Shard grants every character the full foreign-character board resource loop.
{
  const state = combat(player({
    name: 'Shardbearer', character: 'ironclad', heat: 3, soulburn: 1,
    relics: [{ defId: 'corrupted_shard', spent: false }],
  }))
  const next = spendSoulburn(state, 'p1', 'e1')
  assert.equal(next.enemies[0].hp, 27)
  assert.equal(next.players[0].soulburn, 0)
  const withoutShard = combat(player({ character: 'ironclad', heat: 3, soulburn: 1 }))
  assert.equal(spendSoulburn(withoutShard, 'p1', 'e1'), withoutShard)
}

// Soulburn gains clamp at six and serialize all new state without hidden runtime objects.
{
  const flash = instance('fleeting_flash')
  const state = combat(player({ soulburn: 6, hand: [flash] }))
  const next = playCard(state, 'p1', flash.uid, context())
  assert.equal(next.players[0].soulburn, 6)
  assert.deepEqual(JSON.parse(JSON.stringify(next)).players[0].soulburn, 6)
}

// Incineration uses every token, fires ordinary plain damage, then restores exactly what it used.
{
  const incineration = instance('incineration')
  const state = combat(player({ heat: 3, soulburn: 2, hand: [incineration] }))
  const next = playCard(state, 'p1', incineration.uid, context('e1', { soulburnEnemyUids: ['e1', 'e1'] }))
  assert.equal(next.enemies[0].hp, 24)
  assert.equal(next.players[0].soulburn, 2)
  assert(next.players[0].exhaust.some((card) => card.uid === incineration.uid))

  const stale = instance('incineration')
  const staleState = combat(player({ heat: 3, soulburn: 2, hand: [stale] }), [
    enemy({ hp: 3, maxHp: 3 }), enemy({ uid: 'e2', row: 1, hp: 10, maxHp: 10 }),
  ])
  const staleNext = playCard(staleState, 'p1', stale.uid,
    context('e1', { soulburnEnemyUids: ['e1', 'e1'] }))
  assert.notEqual(staleNext, staleState, 'a Soulburn target killed earlier in the sequence rolled the play back')
  assert.deepEqual(staleNext.enemies.map((held) => held.hp), [0, 10])
  assert.equal(staleNext.players[0].soulburn, 2, 'Incineration did not regain a staged stale Soulburn')

  const empty = instance('incineration')
  const emptyState = combat(player({ soulburn: 0, hand: [empty] }))
  const emptyNext = playCard(emptyState, 'p1', empty.uid, context())
  assert.notEqual(emptyNext, emptyState, 'Incineration remains playable at zero Soulburn')
}

// Devour Flame does not Exhaust itself; it marks and consumes the next physical card.
{
  const devour = instance('devour_flame')
  const strike = instance('strike_hexaghost')
  let state = combat(player({ energy: 3, hand: [devour, strike] }))
  state = playCard(state, 'p1', devour.uid, context())
  assert(state.players[0].discard.some((card) => card.uid === devour.uid))
  state = playCard(state, 'p1', strike.uid, context())
  assert(state.players[0].exhaust.some((card) => card.uid === strike.uid))
  assert.equal(state.players[0].exhaustNextCardAfterUid, undefined)
}

// Active Power payment is atomic and once per turn.
{
  const shades = instance('lingering_shades')
  const state = combat(player({ energy: 1, powers: [shades] }))
  const next = activatePower(state, 'p1', shades.uid)
  assert.equal(next.players[0].energy, 0)
  assert.equal(next.players[0].soulburn, 1)
  assert.equal(activatePower(next, 'p1', shades.uid), next)
}

// Triggered Powers retain branch conditions across every clause and reset Heat correctly.
{
  const infernal = instance('infernal_form')
  const atSix = startPlayerTurn(combat(player({ heat: 6, powers: [infernal], draw: [] })))
  assert.equal(atSix.players[0].heat, 1)
  assert.equal(atSix.players[0].strength, 2)

  const belowSix = startPlayerTurn(combat(player({ heat: 5, powers: [infernal], draw: [] })))
  assert.equal(belowSix.players[0].heat, 6)
  assert.equal(belowSix.players[0].strength, 0)
}

// Worthy Sacrifice exposes and consumes its owner-authoritative Start-of-Turn hand choice.
{
  const worthy = instance('worthy_sacrifice')
  const first = instance('strike_hexaghost')
  const chosen = instance('defend_hexaghost')
  const prepared = startPlayerTurnWithChoices(combat(player({ powers: [worthy], draw: [first, chosen] })))
  const [ability] = startTurnAbilities(prepared)
  assert.deepEqual(ability.exhaustCards.map((card) => card.uid), [first.uid, chosen.uid])
  const started = resolveStartPlayerTurn(prepared, [{ id: ability.id, exhaustUids: [chosen.uid], shivEnemyUids: [] }])
  assert.equal(started.players[0].block, 1)
  assert(started.players[0].exhaust.some((card) => card.uid === chosen.uid))
  assert(started.players[0].hand.some((card) => card.uid === first.uid))
}

// Independent Bright Ritual tokens can be split across enemies, then Retract still happens twice.
{
  const ritual = instance('bright_ritual')
  const state = combat(player({ heat: 3, hand: [ritual] }), [enemy(), enemy({ uid: 'e2', row: 1 })])
  const next = playCard(state, 'p1', ritual.uid, context('e1', { enemyUids: ['e1', 'e2', 'e2', 'e1'] }))
  assert.equal(next.enemies[0].weak, 1)
  assert.equal(next.enemies[1].weak, 1)
  assert.equal(next.enemies[0].vulnerable, 1)
  assert.equal(next.enemies[1].vulnerable, 1)
  assert.equal(next.players[0].heat, 1)

  const coldRitual = instance('bright_ritual')
  const coldState = combat(player({ heat: 2, hand: [coldRitual] }))
  assert.equal(cardEnemyChoiceCount(faceOf(CARDS.bright_ritual, false), undefined,
    coldState, coldState.players[0]), 0)
}

// Living Bomb spends the newly gained token too and each token damages its chosen whole row.
{
  const bomb = instance('living_bomb')
  const state = combat(player({ heat: 2, soulburn: 2, hand: [bomb] }), [
    enemy(), enemy({ uid: 'e2', row: 0 }), enemy({ uid: 'e3', row: 1 }),
  ])
  const next = playCard(state, 'p1', bomb.uid, context('e1', { soulburnEnemyUids: ['e1', 'e1', 'e3'] }))
  assert.equal(next.enemies[0].hp, 26)
  assert.equal(next.enemies[1].hp, 26)
  assert.equal(next.enemies[2].hp, 28)
  assert.equal(next.players[0].soulburn, 0)
}

// Heat Shield observes Soulburn but is limited to one payout per turn.
{
  const shield = instance('heat_shield')
  let state = combat(player({ heat: 2, soulburn: 2, powers: [shield] }))
  state = spendSoulburn(state, 'p1', 'e1')
  assert.equal(state.players[0].block, 2)
  state = spendSoulburn(state, 'p1', 'e1')
  assert.equal(state.players[0].block, 2)
}

// Haunting Echo copies the latest Attack by any player through the ordinary reconnect-safe copy state.
{
  const strike = instance('strike_hexaghost')
  const echo = instance('haunting_echo')
  let state = combat(player({ heat: 5, energy: 3, hand: [strike, echo] }))
  state = playCard(state, 'p1', strike.uid, context())
  state = playCard(state, 'p1', echo.uid, context())
  assert.equal(state.phase, 'copy')
  assert.deepEqual(state.pendingCardCopy.sourceNames, ['Haunting Echo'])
  state = playCardCopy(state, 'p1', context())
  assert.equal(state.enemies[0].hp, 26)
}

// Extra Crispy is opt-in, spends its once-per-turn marker, and doubles the whole modified token.
{
  const crispy = instance('extra_crispy')
  const state = combat(player({ heat: 4, soulburn: 2, powers: [crispy] }))
  const doubled = spendSoulburn(state, 'p1', 'e1', crispy.uid)
  assert.equal(doubled.enemies[0].hp, 22)
  const refused = spendSoulburn(doubled, 'p1', 'e1', crispy.uid)
  assert.equal(refused, doubled)
}

// Cost tracks use the live serialized player board.
{
  const incorporeal = faceOf(CARDS.incorporeal, false)
  const stoke = faceOf(CARDS.stoke_the_fire, false)
  assert.equal(incorporeal.heatCostReduction, 1)
  assert.equal(stoke.exhaustCostReduction, 1)
  assert.equal(playCost(incorporeal, player({ heat: 4 })), 2)
  assert.equal(playCost(stoke, player({ exhaust: [instance('strike_hexaghost'), instance('sear'), instance('kindle')] })), 1)
}

// The official embedded starting relic grants one token during opening setup.
{
  const relic = { defId: 'hexaghost_starting_relic', spent: false }
  const started = startPlayerTurn(combat(player({ relics: [relic], draw: [] })))
  assert.equal(started.players[0].soulburn, 1)
}

console.log('downfall hexaghost verification passed')
