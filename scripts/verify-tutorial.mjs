import { CHARACTER_LESSONS } from '../src/ui/tutorial/lessons.ts'
import { BASE_CHARACTER_IDS, CHARACTER_IDS, DLC_CHARACTER_IDS, DOWNFALL_CHARACTER_IDS } from '../src/game/types.ts'
import { HERO_TUTORIALS, tutorialChapters } from '../src/ui/tutorial/index.ts'
import { onScript } from '../src/ui/tutorial/helpers.ts'
import { simulateTutorial } from './lib/tutorial-sim.mjs'
import { suite, check, assert, assertEqual, assertDeepEqual, report } from './lib/harness.mjs'

suite('tutorial content')

const HEROES = [...BASE_CHARACTER_IDS, ...DOWNFALL_CHARACTER_IDS, ...DLC_CHARACTER_IDS]
const sorted = (items) => [...items].sort()

check('every released hero has lessons and a scripted tutorial', () => {
  assertEqual(Object.keys(CHARACTER_LESSONS).sort().join(), [...CHARACTER_IDS].sort().join())
  assertEqual(Object.keys(HERO_TUTORIALS).sort().join(), [...HEROES].sort().join())
})

check('chapters have unique ids and complete steps that fit a phone coach', () => {
  for (const hero of CHARACTER_IDS) {
    const chapters = tutorialChapters(hero)
    assertEqual(new Set(chapters.map((chapter) => chapter.id)).size, chapters.length, `${hero} chapter ids`)
    for (const chapter of chapters) {
      assert(chapter.steps.length > 0, `${hero}/${chapter.id} has no steps`)
      for (const step of chapter.steps) {
        assert(step.title.trim() && step.body.trim(), `${hero}/${chapter.id} has an empty step`)
        assert(step.body.length <= 330, `${hero}/${chapter.id}/${step.title} is too long for a phone coach (${step.body.length})`)
        assert(!step.done || step.focus?.length, `${hero}/${chapter.id}/${step.title} is a task with nothing to press`)
        for (const spot of step.focus ?? []) assert(/^[\w\s.,#:()[\]="'>^*+-]+$/.test(spot.css), `${hero}/${chapter.id} has an odd selector: ${spot.css}`)
      }
    }
  }
})

for (const hero of HEROES) {
  const tutorial = HERO_TUTORIALS[hero]
  if (!tutorial) continue
  const { plan } = tutorial
  check(`${hero}: the scripted run deals exactly what its script describes`, () => {
    const { trace, run } = simulateTutorial(hero, plan)
    const [neow, red, blue, map] = trace
    assertEqual(neow.card, plan.neow.card, 'Neow card')
    assertEqual(neow.boss, plan.boss, 'boss')
    assertDeepEqual(red.cards, [...plan.neow.red], 'Neow Card Reward')
    if (plan.neow.potions) assertDeepEqual(blue.potions, [...plan.neow.potions], 'Neow potions')
    assert(plan.neow.red.includes(plan.neow.pick), 'Neow pick is offered')
    assertEqual(map.stage, 'map')
    const rooms = trace.filter((entry) => entry.stage === 'room')
    assertEqual(rooms.length, plan.route.length, 'the route reaches the boss')
    assertEqual(rooms.at(-1).kind, 'boss', 'the route ends at the boss')
    for (const entry of rooms) {
      const room = plan.rooms[entry.roomId]
      assert(room, `${entry.roomId} has no plan`)
      const where = `${hero} ${entry.roomId}`
      if (room.kind === 'fight') {
        assert(entry.enemies, `${where} is not a fight`)
        assertDeepEqual(entry.enemies.map((enemy) => enemy.defId), [...room.enemies], `${where} enemies`)
        assertDeepEqual(sorted(entry.hand), sorted(room.hand), `${where} opening hand`)
        if (room.cards) assertDeepEqual(entry.reward?.cards, [...room.cards], `${where} Card Reward`)
        if (room.pick) assert(room.cards?.includes(room.pick), `${where} pick is offered`)
      } else if (room.kind === 'event') {
        assertEqual(entry.event, room.event, `${where} event`)
        assert(entry.options.some((option) => option.id === room.option), `${where} option ${room.option}`)
        if (room.pick) assert(entry.offers?.some((cards) => cards.includes(room.pick)), `${where} offers ${room.pick}`)
        assertEqual(entry.end.phase, 'map', `${where} resolves back to the map`)
      } else if (room.kind === 'merchant') {
        assertEqual(entry.kind, 'merchant', `${where} kind`)
        for (const item of room.buy ?? []) {
          const stock = item.section === 'card' ? entry.shop.cards : item.section === 'potion' ? entry.shop.potions : entry.shop.relics
          assertEqual(stock[item.slot], item.id, `${where} sells ${item.id}`)
        }
      } else if (room.kind === 'treasure') {
        assertEqual(entry.relic, room.relic, `${where} relic`)
      } else assertEqual(entry.kind, room.kind, `${where} kind`)
    }
    assert(onScript(plan, run), 'the finished plan is still on script')
  })
}

check('a card the script takes from an event counts once it resolves, and skipping it leaves the script', () => {
  const { plan } = HERO_TUTORIALS.kratos
  const skipped = { ...plan.rooms, a1r1c1: { ...plan.rooms.a1r1c1, pick: null } }
  // Two rooms in, the run stands on the resolved event; three in, it has moved on.
  for (const length of [2, 3]) {
    const route = plan.route.slice(0, length)
    assert(onScript(plan, simulateTutorial('kratos', { ...plan, route }).run), `the scripted pick keeps the run on script after ${length} rooms`)
    assert(!onScript(plan, simulateTutorial('kratos', { ...plan, route, rooms: skipped }).run), `skipping the Library card is off script after ${length} rooms`)
  }
})

report('tutorial')
