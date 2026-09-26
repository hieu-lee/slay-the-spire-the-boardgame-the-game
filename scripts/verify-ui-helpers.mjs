// Pure helpers behind the UI. These looked too small to test, and a mutation
// pass proved otherwise: forcing every die to show a 1, or filing every rare
// card under the wrong directory, both went unnoticed.
import { dieIcon, iconPath, ICON_LABELS } from '../src/ui/icons.ts'
import { cardArtPath, tierOf, cardImagePath, CARD_ART_ROOT, CARD_ASSET_ROOT } from '../src/game/assets.ts'
import { CARDS, faceOf } from '../src/game/cards.ts'
import { POTIONS } from '../src/game/relics.ts'
import {
  bossAttackMotionFor,
  enemyAttackTargetPlayerIds,
  bossProjectileImagePath,
  enemyProjectileImpactPath,
  cardVfxRecipe,
  orbVfxRecipe,
  potionVfxRecipe,
  turnEffectVfxRecipe,
  vfxAssetPath,
  vfxToneColor,
} from '../src/ui/combat-vfx.ts'
import { CHARACTER_IDS } from '../src/game/types.ts'
import { cardSfxRecipe, potionSfxRecipe } from '../src/ui/combat-sfx.ts'
import {
  MIN_STAGE_SCALE,
  STAGE_GAP_REM,
  STAGE_MARGIN_REM,
  cardMotionDestination,
  displayedEnemies,
  drawnCardUids,
  healthBand,
  pendingUiSurvivesContext,
  shouldAnimateOnlineOpeningHand,
  shouldDisarmCardFlight,
  stageScaleFor,
} from '../src/ui/board-signals.ts'
import { wingBootUses } from '../src/ui/wing-boots.ts'
import { dieOutcomes, rolledTable } from '../src/ui/die-outcomes.ts'
import { defaultLootChoices, freePotionSlots, lootHolders, planEventPotions } from '../src/ui/event-loot.ts'
import { EVENT_DEFINITIONS } from '../src/game/events.ts'
import { suite, check, assert, assertDeepEqual, assertEqual, report } from './lib/harness.mjs'

suite('ui helpers')

check('enemy projectiles respect row, facing, area and living targets', () => {
  const players = [{id:'p1',row:0,dead:false,facingEnemyUid:'e'},
    {id:'p2',row:1,dead:false,facingEnemyUid:'other'}, {id:'p3',row:1,dead:true,facingEnemyUid:'e'}]
  const enemy = {uid:'e',defId:'green_louse',row:1,isBoss:false,actionIndex:0}
  const state = {players,enemies:[enemy],die:1,lastStand:false}
  assertDeepEqual(enemyAttackTargetPlayerIds(state,enemy),['p2'])
  assertDeepEqual(enemyAttackTargetPlayerIds(state,{...enemy,isBoss:true}),['p1','p2'])
  assertDeepEqual(enemyAttackTargetPlayerIds(state,{...enemy,defId:'exploder',actionIndex:2}),['p1','p2'])
  assertDeepEqual(enemyAttackTargetPlayerIds(state,{...enemy,defId:'spire_spear'}),['p1'])
  assertDeepEqual(enemyAttackTargetPlayerIds(state,{...enemy,defId:'snake_plant'}),['p2'])
  assertDeepEqual(enemyAttackTargetPlayerIds(state,{...enemy,defId:'exploder',actionIndex:1}),[])
  const lastStand = {...state,lastStand:true,enemies:[enemy,{uid:'boss',isBoss:true}],
    players:players.map(p=>p.id==='p2'?{...p,dead:true}:p)}
  assertDeepEqual(enemyAttackTargetPlayerIds(lastStand,enemy),['p1'])
  assertDeepEqual(enemyAttackTargetPlayerIds(lastStand,{...enemy,defId:'snake_plant'}),['p1'])
  assertDeepEqual(enemyAttackTargetPlayerIds({...lastStand,lastStand:false},enemy),[])
  assert(bossProjectileImagePath('gremlin_wizard').endsWith('/magic-burst.webp'))
  assert(enemyProjectileImpactPath('gremlin_wizard').endsWith('/turn-dark-evoke-impact.webp'))
})


check('every die face maps to its own icon', () => {
  for (let face = 1; face <= 6; face++) {
    assertEqual(dieIcon(face), `die${face}`, `a roll of ${face} should show the ${face} face`)
  }
  assertEqual(new Set([1, 2, 3, 4, 5, 6].map(dieIcon)).size, 6, 'all six faces must be distinct')
})

check('die faces clamp instead of pointing at an icon that does not exist', () => {
  assertEqual(dieIcon(0), 'die1', 'below the range clamps to 1')
  assertEqual(dieIcon(-4), 'die1')
  assertEqual(dieIcon(7), 'die6', 'above the range clamps to 6')
  assertEqual(dieIcon(2.7), 'die2', 'a fractional roll truncates rather than rounding up')
})

check('every icon name has a label for screen readers', () => {
  for (const name of Object.keys(ICON_LABELS)) {
    assert(ICON_LABELS[name].length > 0, `${name} needs a label`)
  }
  assertEqual(Object.keys(ICON_LABELS).length, 24, 'the rulebook set is 24 icons')
})

check('icon paths point inside the icon directory', () => {
  for (const name of Object.keys(ICON_LABELS)) {
    assertEqual(iconPath(name), `/assets/icons/${name}.png`)
  }
})

// tierOf decides which directory a card's scan lives in. A wrong tier is
// invisible until that card's art 404s in a real game.
check('cards are filed under the tier their rarity implies', () => {
  const sample = (owner, rarity) => ({ id: 'x', name: 'X', owner, type: 'skill', rarity, cost: 1, effects: [] })
  assertEqual(tierOf(sample('ironclad', 'starter')), 'ironclad/starter')
  assertEqual(tierOf(sample('ironclad', 'common')), 'ironclad/normal')
  assertEqual(tierOf(sample('ironclad', 'uncommon')), 'ironclad/normal', 'uncommons share the normal tier')
  assertEqual(tierOf(sample('ironclad', 'rare')), 'ironclad/rare')
  assertEqual(tierOf(sample('silent', 'rare')), 'silent/rare')
  assertEqual(tierOf(sample('watcher', 'common')), 'watcher/normal')
})

check('pooled cards ignore rarity and use their own directory', () => {
  const sample = (owner, rarity) => ({ id: 'x', name: 'X', owner, type: 'skill', rarity, cost: 1, effects: [] })
  assertEqual(tierOf(sample('colorless', 'rare')), 'colourless', 'the source spells it the British way')
  assertEqual(tierOf(sample('curse', 'special')), 'curses')
  assertEqual(tierOf(sample('status', 'special')), 'curses')
})

check('an upgraded face resolves to its own image', () => {
  const bash = CARDS.bash
  assert(faceOf(bash, true) === faceOf(bash, true), 'upgraded card faces are rebuilt on every render')
  const base = cardImagePath(faceOf(bash, false), false)
  const upgraded = cardImagePath(faceOf(bash, true), true)
  assert(base !== upgraded, 'the upgraded face is a separate scan, not a recolour')
  assert(upgraded.endsWith('+.webp'), `upgraded paths are marked with +, got ${upgraded}`)
  assert(base.startsWith(`${CARD_ASSET_ROOT}/`), 'paths live under the asset root')
})

check('the upgraded name suffix never leaks into the file name twice', () => {
  const path = cardImagePath(faceOf(CARDS.bash, true), true)
  assertEqual((path.match(/\+/g) ?? []).length, 1, 'exactly one + marker')
})

check('repo-native card art is keyed by stable card ID, not printed face name', () => {
  const base = cardArtPath(CARDS.bash)
  const upgraded = cardArtPath(faceOf(CARDS.bash, true))
  assertEqual(base, `${CARD_ART_ROOT}/ironclad/bash.webp`)
  assertEqual(upgraded, base, 'base and upgrade share one text-free illustration')
  assertEqual(cardArtPath(CARDS.strike_silent), `${CARD_ART_ROOT}/silent/strike_silent.webp`)
})

check('melee bosses dash while Deca and Corrupt Heart cast from their lane', () => {
  assertDeepEqual([
    'donu',
    'awakened_one_phase_1',
    'awakened_one_phase_2',
  ].map(bossAttackMotionFor), ['melee', 'melee', 'melee'])
  assertEqual(bossAttackMotionFor('deca'), 'ranged')
  assertEqual(bossAttackMotionFor('corrupt_heart'), 'ranged')
})

check('every reachable card resolves a stable combat VFX recipe for every character', () => {
  const characters = CHARACTER_IDS
  const assets = new Set(['ironclad-strike', 'ironclad-bash', 'lightning-channel', 'frost-channel', 'dark-channel', 'watcher-pray',
    'silent-poison', 'silent-shiv', 'guard-bloom', 'hexaghost-flame-impact', 'potion-burst', 'magic-burst'])
  const cards = Object.values(CARDS)
  assert(cards.filter((card) => characters.includes(card.owner)).length >= 315,
    'the integrated base and Hexaghost card pools are covered')
  for (const card of cards) {
    for (const character of characters) {
      const base = cardVfxRecipe(character, card.id)
      const upgraded = cardVfxRecipe(character, `${card.id}+`)
      assertEqual(JSON.stringify(upgraded), JSON.stringify(base),
        `${character}/${card.id}+ keeps the base visual identity`)
      for (const token of [base.asset, base.tone]) {
        assert(/^[a-z0-9-]+$/.test(token), `${character}/${card.id} has a path-safe VFX token: ${token}`)
      }
      assert(assets.has(base.asset), `${character}/${card.id} resolves to a supplied asset: ${base.asset}`)
      assertEqual(vfxAssetPath(base), `/assets/combat/vfx/actions/${base.asset}.webp`)
    }
  }
})

check('notable card identities stay distinct and portable between characters', () => {
  const strike = cardVfxRecipe('ironclad', 'strike_ironclad')
  const bash = cardVfxRecipe('ironclad', 'bash')
  assert(strike.family !== bash.family && strike.asset !== bash.asset, 'Strike is a slash; Bash is a blunt impact')
  assert(JSON.stringify(cardVfxRecipe('defect', 'zap')) !== JSON.stringify(cardVfxRecipe('defect', 'ball_lightning')),
    'Zap channels in place while Ball Lightning carries its own tone')
  assert(cardVfxRecipe('defect', 'cold_snap').asset !== 'frost-channel')
  assert(cardVfxRecipe('defect', 'darkness').asset !== 'dark-channel')
  assertDeepEqual(['lightning', 'frost', 'dark'].map((orb) => orbVfxRecipe(orb).asset),
    ['lightning-channel', 'frost-channel', 'dark-channel'])
  for (const sourceId of ['orb-end-turn', 'orb-evoke']) {
    assertDeepEqual(['lightning', 'frost', 'dark'].map((orb) => orbVfxRecipe(orb, sourceId).asset),
      ['turn-lightning-passive-impact', 'turn-frost-passive-impact', 'turn-dark-evoke-impact'])
  }
  assert(cardVfxRecipe('watcher', 'vigilance').tone !== cardVfxRecipe('watcher', 'eruption').tone,
    'Calm and Wrath cannot be text-only palette twins')
  assert(cardVfxRecipe('silent', 'deadly_poison').family !== cardVfxRecipe('silent', 'blade_dance').family,
    'Poison and Shiv cards keep separate effect languages')
  assertEqual(JSON.stringify(cardVfxRecipe('watcher', 'bash')), JSON.stringify(bash),
    'an iconic card keeps its VFX when another character plays it')

  const wishStrength = cardVfxRecipe('watcher', 'wish', 0)
  const wishBlock = cardVfxRecipe('watcher', 'wish', 1)
  const wishMiracles = cardVfxRecipe('watcher', 'wish', 2)
  assertEqual(wishStrength.family, 'buff')
  assertEqual(wishBlock.family, 'block')
  assertEqual(wishMiracles.family, 'mantra')
  const defenseWhirl = cardVfxRecipe('slime_boss', 'guardian_guardian_whirl', undefined, false, 'skill')
  assertDeepEqual([defenseWhirl.family, defenseWhirl.actorMotion], ['block', 'recoil'],
    'a foreign Guardian variable card uses its resolved Defense-mode presentation')
})

check('turn-trigger semantics use dedicated impact assets', () => {
  const effects = ['block', 'damage', 'burn', 'poison', 'weak', 'vulnerable', 'draw', 'discard', 'exhaust',
    'buff', 'strength', 'heal', 'countdown', 'blockLoss', 'strengthLoss']
  const assets = effects.map((effect) => turnEffectVfxRecipe(effect).asset)
  assertDeepEqual(assets, effects.map((effect) =>
    `turn-${effect.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}-impact`))
  assertEqual(new Set(assets).size, effects.length,
    'distinct recurring mutations cannot collapse back to the same impact art')
})

check('all physical potion IDs have explicit VFX recipes', () => {
  assertEqual(Object.keys(POTIONS).length, 34)
  const assets = new Set(['ironclad-strike', 'ironclad-bash', 'lightning-channel', 'watcher-pray',
    'silent-poison', 'silent-shiv', 'guard-bloom', 'potion-burst', 'magic-burst'])
  const toneColors = new Set()
  for (const potionId of Object.keys(POTIONS)) {
    const potion = potionVfxRecipe(potionId)
    assert(/^[a-z0-9-]+$/.test(potion.asset), `${potionId} has a path-safe asset token`)
    assert(assets.has(potion.asset), `${potionId} resolves to a supplied asset: ${potion.asset}`)
    const color = vfxToneColor(potion.tone)
    assert(/^#[0-9a-f]{6}$/.test(color), `${potionId} has a CSS-safe tone colour`)
    toneColors.add(color)
  }
  assertEqual(toneColors.size, Object.keys(POTIONS).length, 'every Potion keeps a visible tone identity')
})

check('every card and acting character resolves a bounded personal SFX recipe', () => {
  const characters = CHARACTER_IDS
  const sounds = new Set(['ui', 'card', 'draw', 'attack', 'magic', 'enemy', 'block', 'heal', 'weak'])
  for (const card of Object.values(CARDS)) {
    for (const character of characters) {
      const base = cardSfxRecipe(character, card.id)
      const upgraded = cardSfxRecipe(character, `${card.id}+`)
      assertEqual(JSON.stringify(upgraded), JSON.stringify(base), `${character}/${card.id}+ keeps its sound identity`)
      assertEqual(base.cue, `card:${character}:${card.id}:base`)
      assert(base.layers.length > 1 && base.layers.length <= 3, `${base.cue} has a compact layered recipe`)
      for (const layer of base.layers) {
        assert(sounds.has(layer.sound), `${base.cue} uses a known sound`)
        assert(layer.rate >= 0.65 && layer.rate <= 1.45, `${base.cue} playback rate stays usable`)
        assert(layer.volume > 0 && layer.volume <= 0.3, `${base.cue} volume stays below generic UI audio`)
      }
      assert(base.layers.at(-1).delayMs >= 36, `${base.cue} has a perceptible identity accent`)
    }
  }
  const accents = characters.flatMap((character) => Object.values(CARDS).map((card) =>
    JSON.stringify(cardSfxRecipe(character, card.id).layers.at(-1))))
  assertEqual(new Set(accents).size, accents.length,
    'every acting-character/card pair has a distinct sound, coarse pitch, or timing accent')
})

check('iconic cards and modes keep audible identities', () => {
  const signature = (recipe) => JSON.stringify(recipe.layers)
  assert(signature(cardSfxRecipe('ironclad', 'strike_ironclad')) !== signature(cardSfxRecipe('ironclad', 'bash')),
    'Strike and Bash cannot collapse to one impact')
  assert(signature(cardSfxRecipe('defect', 'zap')) !== signature(cardSfxRecipe('defect', 'ball_lightning')),
    'Zap and Ball Lightning have separately tuned electricity')
  assert(signature(cardSfxRecipe('watcher', 'vigilance')) !== signature(cardSfxRecipe('watcher', 'eruption')),
    'Calm and Wrath have different sound shapes')
  assert(signature(cardSfxRecipe('silent', 'deadly_poison')) !== signature(cardSfxRecipe('silent', 'blade_dance')),
    'poison and Shivs stay distinct')
  const hexaghostStrike = cardVfxRecipe('hexaghost', 'strike_hexaghost')
  assertDeepEqual([hexaghostStrike.asset, hexaghostStrike.tone], ['hexaghost-flame-impact', 'chaos-green'],
    'Hexaghost attacks use their green flame impact')
  assert(cardSfxRecipe('hexaghost', 'strike_hexaghost').layers.some((layer) => layer.sound === 'enemy'),
    'Hexaghost green flame keeps an impact cue')
  const shardSoulburn = cardVfxRecipe('ironclad', 'strike_hexaghost')
  assertDeepEqual([shardSoulburn.asset, shardSoulburn.tone], ['hexaghost-flame-impact', 'chaos-green'],
    'Corrupted Shard Soulburn uses the same green flame for non-Hexaghost actors')
  assert(cardSfxRecipe('ironclad', 'strike_hexaghost').layers.some((layer) => layer.sound === 'enemy'),
    'Corrupted Shard Soulburn keeps the green flame impact cue')
  assert(signature(cardSfxRecipe('ironclad', 'bash')) !== signature(cardSfxRecipe('watcher', 'bash')),
    'the acting character colors a cross-character card')
  assertEqual(new Set([0, 1, 2].map((mode) => signature(cardSfxRecipe('watcher', 'wish', mode)))).size, 3,
    'all Wish choices have their own sound')
})

check('all physical potions have distinct audible cues', () => {
  const recipes = Object.keys(POTIONS).map(potionSfxRecipe)
  assertEqual(recipes.length, 34)
  assertEqual(new Set(recipes.map((recipe) => recipe.cue)).size, recipes.length, 'potion cue IDs are unique')
  assertEqual(new Set(recipes.map((recipe) => JSON.stringify(recipe.layers))).size, recipes.length,
    'the potion deck does not collapse to generic drink audio')
})


check('Wing Boots uses read the printed counter and default to none', () => {
  assertEqual(wingBootUses({ relics: [{ defId: 'anchor' }, { defId: 'wing_boots', uses: 2 }] }), 2)
  assertEqual(wingBootUses({ relics: [{ defId: 'wing_boots' }] }), 0)
  assertEqual(wingBootUses({ relics: [] }), 0)
  assertEqual(wingBootUses(undefined), 0)
})

check('event die tables name every face and read the chosen option', () => {
  const lab = rolledTable(EVENT_DEFINITIONS.lab.options, [])
  const labFaces = dieOutcomes(lab)
  assertDeepEqual([1, 2, 3, 4, 5, 6].map((face) => labFaces[face].label), ['Nothing', 'Nothing', 'Nothing', 'Potion', 'Potion', 'Potion'])
  const ooze = dieOutcomes(rolledTable(EVENT_DEFINITIONS.scrap_ooze.options, ['reach_inside']))
  assertDeepEqual([1, 3, 5].map((face) => [ooze[face].label, ooze[face].tone]),
    [['Reach again or leave', 'plain'], ['2 Gold', 'good'], ['Relic', 'good']])
  assertEqual(rolledTable(EVENT_DEFINITIONS.scrap_ooze.options, ['leave']), undefined)
  const wheel = dieOutcomes(rolledTable(EVENT_DEFINITIONS.wheel_of_change.options, EVENT_DEFINITIONS.wheel_of_change.options.map((option) => option.id)))
  assertDeepEqual([wheel[2].tone, wheel[6].label], ['bad', 'Lose 2 HP'])
})

check('event loot plans Potions against the player who actually keeps them', () => {
  const seat = (id, potions, relics = []) => ({ id, potions, relics: relics.map((defId) => ({ defId })) })
  const limit = () => 2
  const viewer = seat('v', ['fire_potion', 'block_potion'])
  const mate = seat('m', [])
  const players = [viewer, mate]
  const potion = { kind: 'potion', id: 'swift_potion' }
  const plan = (holder, choices, extra = {}) => planEventPotions({
    offers: [potion], choices, recipients: [''], replacements: [null], actorId: 'v', holders: [holder], players,
    free: freePotionSlots(players, limit, 'v', [holder]), ...extra,
  })
  // A one-player payout to a teammate with room: no swap on the viewer's full belt.
  assertDeepEqual(plan('m', ['take']), { legal: true, swaps: [false], blocked: [false], recipients: ['m'] })
  // The viewer's own full belt asks for a swap, and only a held Potion answers it.
  assertDeepEqual(plan('v', ['take']), { legal: false, swaps: [true], blocked: [false], recipients: ['v'] })
  assert(plan('v', ['take'], { replacements: ['fire_potion'] }).legal)
  assert(!plan('v', ['take'], { replacements: ['ghost_potion'] }).legal)
  // A teammate's full belt cannot be swapped from here.
  const fullMate = [viewer, seat('m', ['a', 'b'])]
  assert(!planEventPotions({ offers: [potion], choices: ['take'], recipients: [''], replacements: [null], actorId: 'v', holders: ['m'],
    players: fullMate, free: freePotionSlots(fullMate, limit, 'v', ['m']) }).legal)
  // Two Potions passed to a teammate with one slot: the second is blocked, taken or not.
  const oneSlot = [viewer, seat('m', ['a'])]
  const twice = (choices) => planEventPotions({ offers: [potion, potion], choices, recipients: ['m', 'm'], replacements: [null, null],
    actorId: 'v', holders: ['v', 'v'], players: oneSlot, free: freePotionSlots(oneSlot, limit, 'v', ['v', 'v']) })
  assertDeepEqual([twice(['take', '']).blocked, twice(['take', '']).legal], [[false, true], true])
  assertDeepEqual([twice(['take', 'take']).blocked, twice(['take', 'take']).legal], [[false, true], false])
  assertDeepEqual(twice(['skip', '']).blocked, [false, false], 'a skipped Potion still used the teammate\'s slot')
  // The resolving player's only slot went to an earlier reveal and there is
  // nothing to discard: no swap can make room, so Take is blocked.
  const bare = [seat('v', [])]
  const earlier = { rewardItemKinds: ['potion'], rewardItemChoices: ['take'], potionRecipientIds: [''], potionReplacementIds: [''] }
  const stuck = planEventPotions({ offers: [potion], choices: ['take'], recipients: [''], replacements: [null], actorId: 'v', holders: ['v'],
    players: bare, free: freePotionSlots(bare, () => 1, 'v', ['v', 'v'], earlier) })
  assertDeepEqual([stuck.blocked, stuck.swaps, stuck.legal], [[true], [false], false])
  // Two overflows and one held Potion: the second has nothing left to give up.
  const oneHeld = [seat('v', ['fire_potion'])]
  const overflow = planEventPotions({ offers: [potion, potion], choices: ['take', 'take'], recipients: ['', ''], replacements: ['fire_potion', null],
    actorId: 'v', holders: ['v', 'v'], players: oneHeld, free: freePotionSlots(oneHeld, () => 1, 'v', ['v', 'v']) })
  assertDeepEqual([overflow.blocked, overflow.swaps, overflow.legal], [[false, true], [true, false], false])
  // No holder chosen yet is never legal, and a Sozu holder cannot keep it.
  assert(!plan('', ['take']).legal)
  const sozu = [seat('v', [], ['sozu'])]
  assert(!planEventPotions({ offers: [potion], choices: ['take'], recipients: [''], replacements: [null], actorId: 'v', holders: ['v'],
    players: sozu, free: freePotionSlots(sozu, limit, 'v', ['v']) }).legal)
  // Potions an earlier reveal already claimed use up the slots they will land
  // in; a replacement only frees one on the actor's own belt.
  const staged = { rewardItemKinds: ['potion', 'relic'], rewardItemChoices: ['take', 'take'], potionRecipientIds: [''], potionReplacementIds: [null] }
  const swapped = { ...staged, potionReplacementIds: ['x'] }
  assertEqual(freePotionSlots([viewer, mate], limit, 'v', ['m', 'm'], staged).get('m'), 1)
  assertEqual(freePotionSlots([viewer, mate], limit, 'v', ['m', 'm'], swapped).get('m'), 1, 'a stale replacement freed a teammate\'s slot')
  assertEqual(freePotionSlots([seat('v', ['a', 'b']), mate], limit, 'v', ['v', 'v'], swapped).get('v'), 0)
  assertDeepEqual(defaultLootChoices([potion, potion, { kind: 'relic', id: 'anchor' }], [mate, mate, mate],
    freePotionSlots([viewer, mate], limit, 'v', ['m', 'm', 'm', 'm'], staged)), ['take', '', 'take'])
  // Each-player gains deal one to every seat in turn, so each Potion checks its own seat.
  assertDeepEqual(defaultLootChoices([potion, potion], [viewer, mate], new Map([['v', 0], ['m', 2]])), ['', 'take'])
  assertDeepEqual(defaultLootChoices([potion], [undefined], new Map()), [''])
})

check('event loot names the seat that keeps each revealed item, in reveal order', () => {
  const living = ['v', 'm']
  const holders = (cardId, optionIds, rolls, targetId = '') => lootHolders({
    cardId, options: EVENT_DEFINITIONS[cardId].options, optionIds, rolls, actorId: 'v', targetId, livingIds: living,
  })
  // Lab's opening Potion is each player's own reveal; its 4–6 bonus goes to the chosen player.
  assertDeepEqual(holders('lab', ['resolve']), ['v'])
  assertDeepEqual(holders('lab', ['resolve'], [5], 'm'), ['m'])
  assertDeepEqual(holders('lab', ['resolve'], [2], 'm'), [])
  // Dead Adventurer's 5–6 Relic goes to the chosen player; nothing is revealed before the roll.
  assertDeepEqual(holders('dead_adventurer', ['search']), [])
  assertDeepEqual(holders('dead_adventurer', ['search'], [6], 'm'), ['m'])
  // A pre-roll gain is the actor's; the die's Curse is not an item.
  assertDeepEqual(holders('mausoleum', ['open_coffin']), ['v'])
  const partyPotions = { id: 'x', effects: [{ tag: 'gain-potion', target: 'each-player' }, { tag: 'gain-potion', count: 2 }] }
  assertDeepEqual(lootHolders({ cardId: 'x', options: [partyPotions], optionIds: ['x'], actorId: 'v', targetId: '', livingIds: living }), ['v', 'm', 'v', 'v'])
})

suite('board feedback helpers')

// Neither of these had a test, and both are pure functions with sharp edges.

check('dead enemies release their stage slots after the live dissolve', () => {
  const enemies = [
    { uid: 'boss-a', dead: false },
    { uid: 'summon-b', dead: true },
    { uid: 'summon-c', dead: true },
    { uid: 'summon-d', dead: false },
    { uid: 'summon-e', dead: false },
  ]
  assertDeepEqual(displayedEnemies(enemies, new Set(['summon-b', 'summon-c'])).map((enemy) => enemy.uid),
    ['boss-a', 'summon-b', 'summon-c', 'summon-d', 'summon-e'], 'fresh deaths stay through their dissolve')
  assertDeepEqual(displayedEnemies(enemies, new Set()).map((enemy) => enemy.uid),
    ['boss-a', 'summon-d', 'summon-e'], 'later summons reuse the released B/C positions')
})

check('the health bands fall where they are documented', () => {
  // Green above 60%, amber above 30%, red below — with the boundary itself
  // falling to the LOWER band, which is what the UI comment claims.
  assertEqual(healthBand(10, 10), 'healthy', 'full')
  assertEqual(healthBand(7, 10), 'healthy', 'just above 60%')
  assertEqual(healthBand(6, 10), 'hurt', '60% exactly is not healthy')
  assertEqual(healthBand(4, 10), 'hurt', 'above 30%')
  assertEqual(healthBand(3, 10), 'critical', '30% exactly is not merely hurt')
  assertEqual(healthBand(1, 10), 'critical', 'nearly gone')
  assertEqual(healthBand(0, 10), 'critical', 'gone')
  assertEqual(healthBand(0, 0), 'critical', 'and a zero maximum does not divide by zero')
})

check('pending card UI survives only its owner copy transition', () => {
  assertEqual(pendingUiSurvivesContext('copy', 'p1', 'p1'), true)
  assertEqual(pendingUiSurvivesContext('copy', 'p1', 'p2'), false)
  assertEqual(pendingUiSurvivesContext('copy', undefined, 'p1'), false)
  assertEqual(pendingUiSurvivesContext('player', 'p1', 'p1'), false)
})

check('hand motion identifies only newly visible cards and their real destination', () => {
  const card = (uid) => ({ uid, defId: 'strike_ironclad', upgraded: false })
  assertEqual(drawnCardUids([card('a'), card('b')], [card('b'), card('c'), card('d')]).join(','), 'c,d')
  const piles = { draw: [card('drawn')], discard: [card('spent')], exhaust: [card('burned')] }
  assertEqual(cardMotionDestination('drawn', piles), 'draw')
  assertEqual(cardMotionDestination('spent', piles), 'discard')
  assertEqual(cardMotionDestination('burned', piles), 'exhaust')
  assertEqual(cardMotionDestination('power', piles), 'stage')
  assertEqual(cardMotionDestination('anger', { draw: [], discard: [], exhaust: [] }, true), 'draw',
    'public draw-top rules survive online draw-pile redaction')
  assertEqual(cardMotionDestination('anger', { draw: [], discard: [], exhaust: [card('anger')] }, true), 'exhaust',
    'a forced exhaust is authoritative over the ordinary draw-top rule')
})

check('online opening deals require a live phase transition', () => {
  assertEqual(shouldAnimateOnlineOpeningHand('map', 'combat', true), true)
  assertEqual(shouldAnimateOnlineOpeningHand('map', 'combat', false), false,
    'a combat reached during reconnect must not replay its private opening hand')
  assertEqual(shouldAnimateOnlineOpeningHand(undefined, 'combat', true), false,
    'a restored first snapshot is a baseline')
  assertEqual(shouldAnimateOnlineOpeningHand('combat', 'combat', true), false)
})

check('uncommitted in-hand actions disarm their decorative flight', () => {
  assertEqual(shouldDisarmCardFlight(true, false), true)
  assertEqual(shouldDisarmCardFlight(true, true), false)
  assertEqual(shouldDisarmCardFlight(false, false), false, 'virtual copies never arm an in-hand flight')
})

// The Slime Boss splits into three slimes PER PLAYER, so the actor count is not
// bounded by the party — this is the case that used to push every seat off the
// board while the auto-scroll centred on enemies.
check('the stage shrinks only as far as it has to', () => {
  const rem = 16
  const fits = (actors) => (actors * STAGE_GAP_REM + STAGE_MARGIN_REM) * rem
  assertEqual(stageScaleFor(6, fits(6), rem), 1, 'a stage that already fits is never shrunk')
  assertEqual(stageScaleFor(6, fits(6) * 2, rem), 1, 'nor is one with room to spare blown up')
  assertEqual(stageScaleFor(0, 1280, rem), 1, 'an empty stage has nothing to scale')
  assertEqual(stageScaleFor(6, 0, rem), 1, 'an unmeasured board leaves the stage alone')

  // Half the room the stage wants, so it would halve — but the floor catches it.
  assertEqual(stageScaleFor(12, fits(12) / 2, rem), MIN_STAGE_SCALE, 'the stage never shrinks past the floor')
  assertEqual(stageScaleFor(12, fits(12) * 0.8, rem), 0.8, 'and shrinks exactly as much as it lacks above it')

  // Four players against a split Slime Boss: 4 seats, 12 slimes, the boss.
  const slimeSplit = stageScaleFor(17, 1280, rem)
  assert(slimeSplit >= MIN_STAGE_SCALE, `the floor holds: ${slimeSplit}`)
  assert(slimeSplit < 1, 'and seventeen actors on a 1280px board do need shrinking')
  const crowded = [12, 9, 6, 3].map(enemies => stageScaleFor(4 + enemies, 1440, rem, enemies))
  assert(crowded[0] * fits(16) <= 1440 + .1, 'the full Sentry crowd fits without pushing heroes off screen')
  assert(crowded[0] < MIN_STAGE_SCALE, 'extreme four-player crowds can fit below the ordinary floor')
  assert(crowded.every((scale, i) => i === 0 || scale > crowded[i - 1]), 'each cleared group restores scale')
  assertEqual(stageScaleFor(5, 1440, rem, 1), 1, 'one survivor restores the wanted size')
})

report('ui helpers')
