// Pure helpers behind the UI. These looked too small to test, and a mutation
// pass proved otherwise: forcing every die to show a 1, or filing every rare
// card under the wrong directory, both went unnoticed.
import { dieIcon, iconPath, ICON_LABELS } from '../src/ui/icons.ts'
import { cardArtPath, tierOf, cardImagePath, CARD_ART_ROOT, CARD_ASSET_ROOT } from '../src/game/assets.ts'
import { CARDS, faceOf } from '../src/game/cards.ts'
import { POTIONS } from '../src/game/relics.ts'
import { cardVfxRecipe, potionVfxRecipe, vfxAssetPath, vfxToneColor } from '../src/ui/combat-vfx.ts'
import { cardSfxRecipe, potionSfxRecipe } from '../src/ui/combat-sfx.ts'
import {
  MIN_STAGE_SCALE,
  STAGE_GAP_REM,
  STAGE_MARGIN_REM,
  cardMotionDestination,
  drawnCardUids,
  healthBand,
  pendingUiSurvivesContext,
  shouldAnimateOnlineOpeningHand,
  shouldDisarmCardFlight,
  stageScaleFor,
  strikeClass,
} from '../src/ui/board-signals.ts'
import { suite, check, assert, assertEqual, report } from './lib/harness.mjs'

suite('ui helpers')

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

check('every reachable card resolves a stable combat VFX recipe for every character', () => {
  const characters = ['ironclad', 'silent', 'defect', 'watcher']
  const assets = new Set(['ironclad-strike', 'ironclad-bash', 'lightning-channel', 'watcher-pray',
    'silent-poison', 'silent-shiv', 'guard-bloom', 'potion-burst', 'magic-burst'])
  const cards = Object.values(CARDS)
  assertEqual(cards.filter((card) => characters.includes(card.owner)).length, 251,
    'the complete character card pool is covered')
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
})

check('all physical potion IDs have explicit VFX recipes', () => {
  assertEqual(Object.keys(POTIONS).length, 21)
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
  const characters = ['ironclad', 'silent', 'defect', 'watcher']
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
  assert(signature(cardSfxRecipe('ironclad', 'bash')) !== signature(cardSfxRecipe('watcher', 'bash')),
    'the acting character colors a cross-character card')
  assertEqual(new Set([0, 1, 2].map((mode) => signature(cardSfxRecipe('watcher', 'wish', mode)))).size, 3,
    'all Wish choices have their own sound')
})

check('all physical potions have distinct audible cues', () => {
  const recipes = Object.keys(POTIONS).map(potionSfxRecipe)
  assertEqual(recipes.length, 21)
  assertEqual(new Set(recipes.map((recipe) => recipe.cue)).size, recipes.length, 'potion cue IDs are unique')
  assertEqual(new Set(recipes.map((recipe) => JSON.stringify(recipe.layers))).size, recipes.length,
    'the potion deck does not collapse to generic drink audio')
})


suite('board feedback helpers')

// Neither of these had a test, and both are pure functions with sharp edges.

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

check('the flinch alternates so a repeated hit re-animates', () => {
  // A CSS animation only restarts when the computed animation-name changes, so
  // consecutive hits must not produce the same class.
  assert(strikeClass('seat', 0) !== strikeClass('seat', 1), 'consecutive hits must differ')
  assertEqual(strikeClass('seat', 0), strikeClass('seat', 2), 'and then alternate back')
  assert(
    strikeClass('enemy', 1).startsWith('enemy--'),
    'the base name follows the element it is applied to',
  )
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
})

report('ui helpers')
