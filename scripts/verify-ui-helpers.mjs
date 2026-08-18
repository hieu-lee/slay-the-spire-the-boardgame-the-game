// Pure helpers behind the UI. These looked too small to test, and a mutation
// pass proved otherwise: forcing every die to show a 1, or filing every rare
// card under the wrong directory, both went unnoticed.
import { dieIcon, iconPath, ICON_LABELS } from '../src/ui/icons.ts'
import { cardArtPath, tierOf, cardImagePath, CARD_ART_ROOT, CARD_ASSET_ROOT } from '../src/game/assets.ts'
import { CARDS, faceOf } from '../src/game/cards.ts'
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
