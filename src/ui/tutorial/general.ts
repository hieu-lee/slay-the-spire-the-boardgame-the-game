import type { RunState } from '../../game/run.ts'
import type { CharacterId } from '../../game/types.ts'
import { at } from './helpers.ts'
import { CHARACTER_LESSONS } from './lessons.ts'
import type { TutorialChapter } from './types.ts'

// General lessons for a tutorial run that has left its script, which only
// happens when the player hid the tips and went their own way. They explain
// each part of the run the first time it comes up, without asking for moves.

const room = (run: RunState) => run.map.position ? run.map.rooms[run.map.position]?.kind : undefined
const fighting = (run: RunState) => run.phase === 'combat' && run.combat?.phase === 'player' && run.combat.turn > 0
const firstFight = (run: RunState) => fighting(run) && (run.combatsFinished ?? 0) === 0

const GENERAL: readonly TutorialChapter[] = [
  {
    id: 'general-map',
    when: (run) => run.phase === 'map',
    steps: [
      {
        title: 'The map',
        body: 'The party climbs from the bottom to the boss at the top. Each step you pick one of the rooms connected to where you stand. Rooms you can reach glow.',
      },
      {
        title: 'Room types',
        body: 'Monsters are ordinary fights. Elites are harder but drop a relic. "?" rooms are events. Campfires let you heal or upgrade, merchants sell cards, relics and potions, and chests hold relics.',
        focus: [at.legend],
      },
    ],
  },
  {
    id: 'general-combat',
    when: firstFight,
    steps: [
      {
        title: 'Fighting',
        body: 'Bring every enemy to 0 HP to win. The icon over each enemy is its intent: a number is the damage it will deal. Hover over or long-press an enemy to read its abilities.',
        focus: [at.enemies],
      },
      {
        title: 'Cards and Energy',
        body: 'You draw 5 cards each turn. Every card costs Energy, shown in its top-left corner, and your Energy refills to 3 each turn. Tap a card, then its target, or drag it onto the target.',
        focus: [at.hand],
      },
      {
        title: 'Block and the die',
        body: 'Block stops 1 damage per point until your next turn, up to 20. One shared die is rolled every round: it picks what some enemies do and triggers relics such as your Loaded Die.',
        focus: [at.die],
      },
    ],
  },
  {
    id: 'general-reward',
    when: (run) => run.phase === 'reward',
    steps: [{
      title: 'Rewards',
      body: 'Collect rewards in any order and skip any you do not want. A card reward shows 3 cards; a smaller deck draws your best cards more often, so take a card only when it improves your deck.',
    }],
  },
  {
    id: 'general-campfire',
    when: (run) => run.phase === 'room' && room(run) === 'campfire' && !run.roomState,
    steps: [{
      title: 'Campfire',
      body: 'Rest to heal 3 HP, or Smith to upgrade one card. Rest when the next fights could kill you; otherwise upgrading makes your deck stronger for good.',
      focus: [at.campfire],
    }],
  },
  {
    id: 'general-merchant',
    when: (run) => run.phase === 'room' && run.roomState?.kind === 'merchant',
    steps: [{
      title: 'Merchant',
      body: 'Cards cost 2 gold for a common, 3 for an uncommon and 6 for a rare. For 3 gold you may remove one card from your deck, once per visit, which is often the best purchase.',
    }],
  },
  {
    id: 'general-event',
    when: (run) => run.phase === 'room' && run.roomState?.kind === 'event',
    steps: [{
      title: 'Events',
      body: 'Read every option first: some cost HP or add a Curse to your deck, and some are decided by a die roll. Near death, the safest option is usually best.',
      focus: [at.event],
    }],
  },
  {
    id: 'general-treasure',
    when: (run) => run.phase === 'room' && run.roomState?.kind === 'treasure',
    steps: [{
      title: 'Treasure',
      body: 'A chest gives you a relic. Relics last the whole run; read the new one so you can plan around it.',
    }],
  },
  {
    id: 'general-elite',
    when: (run) => fighting(run) && room(run) === 'elite',
    steps: [{
      title: 'Elite fight',
      body: 'Elites hit harder and have more HP, but always drop a relic. Use your potions here if the fight turns bad.',
      focus: [at.enemies],
    }],
  },
  {
    id: 'general-boss',
    when: (run) => fighting(run) && room(run) === 'boss',
    steps: [{
      title: 'The boss',
      body: 'Win this fight to finish Act I and the tutorial. Bosses count as being in every row and always act last. Watch the intent every turn, and spend your potions now.',
      focus: [at.enemies],
    }],
  },
]

/** The general lessons for one hero, shown only while `offScript` holds. */
export function generalChapters(character: CharacterId, offScript: (run: RunState) => boolean): TutorialChapter[] {
  const lessons = CHARACTER_LESSONS[character]
  const chapters: TutorialChapter[] = [
    ...GENERAL.slice(0, 2),
    ...(lessons ? [
      { id: 'general-hero', when: firstFight, steps: lessons.intro },
      { id: 'general-hero-advanced', when: (run: RunState) => fighting(run) && (run.combatsFinished ?? 0) > 0, steps: lessons.advanced },
    ] : []),
    ...GENERAL.slice(2),
  ]
  return chapters.map((chapter) => ({ ...chapter, when: (run: RunState) => offScript(run) && chapter.when(run) }))
}

