import { CHARACTER_LESSONS, tutorialChapters } from '../src/ui/tutorial-content.ts'
import { suite, check, assert, assertEqual, report } from './lib/harness.mjs'

suite('tutorial content')

const HEROES = ['ironclad', 'silent', 'defect', 'watcher', 'slime_boss', 'guardian', 'hexaghost', 'hermit']
const moment = (overrides) => ({ phase: 'map', combatNumber: 0, turn: 0, combatPhase: 'player', ...overrides })
const firstChapter = (character, overrides, seen = new Set()) =>
  tutorialChapters(character).find((chapter) => !seen.has(chapter.id) && chapter.when(moment(overrides)))?.id

check('every playable hero has its own lessons', () => {
  assertEqual(Object.keys(CHARACTER_LESSONS).sort().join(), [...HEROES].sort().join())
  for (const hero of HEROES) {
    const { intro, advanced } = CHARACTER_LESSONS[hero]
    assert(intro.length >= 2 && advanced.length >= 2, `${hero} needs two intro and two advanced steps`)
  }
})

check('chapters have unique ids and complete, parseable steps', () => {
  for (const hero of HEROES) {
    const chapters = tutorialChapters(hero)
    assertEqual(new Set(chapters.map((chapter) => chapter.id)).size, chapters.length, `${hero} chapter ids`)
    for (const chapter of chapters) {
      assert(chapter.steps.length > 0, `${hero}/${chapter.id} has no steps`)
      for (const step of chapter.steps) {
        assert(step.title.trim() && step.body.trim(), `${hero}/${chapter.id} has an empty step`)
        assert(step.body.length <= 330, `${hero}/${chapter.id}/${step.title} is too long for a phone coach`)
        if (step.target) assert(/^[\w\s.,#:()[\]="'>*-]+$/.test(step.target), `${hero}/${chapter.id} has an odd selector`)
      }
    }
  }
})

check('the first fight teaches the basics, then that hero', () => {
  for (const hero of HEROES) {
    const fight = { phase: 'combat', combatNumber: 1, turn: 1 }
    assertEqual(firstChapter(hero, fight), 'combat', `${hero} first chapter in combat`)
    assertEqual(firstChapter(hero, fight, new Set(['combat'])), `${hero}-intro`, `${hero} follows with its own chapter`)
    assertEqual(firstChapter(hero, { phase: 'combat', combatNumber: 2, turn: 1 }), `${hero}-advanced`,
      `${hero} deepens its lessons in the second fight`)
  }
})

check('opening choices get their own chapter before cards can be played', () => {
  assertEqual(firstChapter('hermit', { phase: 'combat', combatNumber: 1, turn: 0 }), 'hermit-setup')
  assertEqual(firstChapter('guardian', { phase: 'combat', combatNumber: 1, turn: 1, combatPhase: 'start' }), 'guardian-setup')
  assertEqual(firstChapter('silent', { phase: 'combat', combatNumber: 1, turn: 0 }), undefined)
  assertEqual(firstChapter('silent', { phase: 'combat', combatNumber: 1, turn: 1, combatPhase: 'start' }), undefined,
    'no card-play chapter covers a start-of-turn choice')
})

check('each room of the run opens its own chapter', () => {
  assertEqual(firstChapter('ironclad', { phase: 'neow' }), 'welcome')
  assertEqual(firstChapter('ironclad', { phase: 'map' }), 'map')
  assertEqual(firstChapter('ironclad', { phase: 'reward' }), 'reward')
  assertEqual(firstChapter('ironclad', { phase: 'room', roomKind: 'campfire' }), 'campfire')
  assertEqual(firstChapter('ironclad', { phase: 'room', roomState: 'merchant' }), 'merchant')
  assertEqual(firstChapter('ironclad', { phase: 'room', roomState: 'event' }), 'event')
  assertEqual(firstChapter('ironclad', { phase: 'room', roomState: 'treasure' }), 'treasure')
  const later = new Set(['ironclad-advanced'])
  assertEqual(firstChapter('ironclad', { phase: 'combat', combatNumber: 3, turn: 1, roomKind: 'elite' }, later), 'elite')
  assertEqual(firstChapter('ironclad', { phase: 'combat', combatNumber: 5, turn: 1, roomKind: 'boss' }, later), 'boss')
})

report('tutorial')
