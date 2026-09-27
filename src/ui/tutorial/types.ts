import type { RunState } from '../../game/run.ts'
import type { CharacterId } from '../../game/types.ts'

/**
 * A piece of the live UI: the first visible element matching `css` whose text
 * contains `text`, or with `all`, the box around every visible match.
 */
export type Spot = { css: string; text?: string; all?: boolean }

export type TutorialStep = {
  title: string
  body: string
  /** What the step is about. It is ringed, and it is all the player can press during a task. */
  focus?: readonly Spot[]
  /**
   * Makes the step a task: the coach waits, with only `focus` accepting input,
   * until this holds, then moves on by itself.
   */
  done?: (run: RunState) => boolean
}

export type TutorialChapter = {
  id: string
  /** Chapters open in order, once each, the first time this holds. */
  when: (run: RunState) => boolean
  steps: readonly TutorialStep[]
}

export type FightPlan = {
  kind: 'fight'
  /** Enemy definitions in the fight, as dealt. */
  enemies: readonly string[]
  /** The opening hand, in any order. */
  hand: readonly string[]
  /** The Card Reward the fight offers, and the card the coach asks for. */
  cards?: readonly string[]
  pick?: string | null
}

export type RoomPlan =
  | FightPlan
  | { kind: 'event'; event: string; option: string; cards?: readonly string[]; pick?: string | null }
  | { kind: 'merchant'; buy?: readonly { section: 'card' | 'potion' | 'relic'; slot: number; id: string }[] }
  | { kind: 'treasure'; relic: string }
  | { kind: 'campfire' }

/**
 * The fixed run a hero's tutorial walks. The script's text is written against
 * it, and `verify-tutorial.mjs` replays it through the engine to prove every
 * card, enemy and room it names is really there.
 */
export type TutorialPlan = {
  seed: string
  neow: {
    card: string
    red: readonly string[]
    pick: string
    option: number
    potions?: readonly string[]
    /** Cards chosen for an upgrade, removal or transform the blue option asks for. */
    effectCards?: readonly string[]
  }
  /** Every room from the first fight to the boss. */
  route: readonly string[]
  rooms: Readonly<Record<string, RoomPlan>>
  boss: string
}

export type HeroTutorial = {
  character: CharacterId
  plan: TutorialPlan
  chapters: readonly TutorialChapter[]
}
