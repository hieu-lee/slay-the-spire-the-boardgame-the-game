import { potionDef, relicDef } from '../../game/relics.ts'
import type { RunState } from '../../game/run.ts'
import {
  at, cardName, cardRevealed, cardTaken, goldTaken, inReward, inRoomScreen, movedTo, neowProgress, onMapAt,
  potionName, potionTaken, roomLeft, spot,
} from './helpers.ts'
import type { Spot, TutorialChapter, TutorialStep } from './types.ts'

// Step and chapter builders shared by every hero script, so each script is
// mostly what that hero's run actually shows and why the coach picks what it
// picks.

export const say = (title: string, body: string, ...focus: Spot[]): TutorialStep =>
  ({ title, body, focus: focus.length ? focus : undefined })

export const task = (title: string, body: string, done: (run: RunState) => boolean, ...focus: Spot[]): TutorialStep =>
  ({ title, body, done, focus })

/** Screen-only tasks, such as opening the shop, finish when this element appears. */
export const shown = (css: string) => () => Boolean(document.querySelector(css))

export const potionText = (id: string) => `${potionName(id)}: ${potionDef(id).text}`
export const relicText = (id: string) => `${relicDef(id).name}: ${relicDef(id).text}`

// Neow.

const neow = (run: RunState) => neowProgress(run)
export const neowGoldTaken = (run: RunState) => run.phase !== 'neow' || !neow(run)?.redGoldPending
export const neowRedRevealed = (run: RunState) => run.phase !== 'neow' || !neow(run)?.redRewardPending || Boolean(neow(run)?.redReward)
export const neowRedTaken = (run: RunState) => run.phase !== 'neow' || !neow(run)?.redRewardPending
export const neowBlueChosen = (run: RunState) => run.phase !== 'neow' || neow(run)?.blueOption !== null
export const neowDone = (run: RunState) => run.phase !== 'neow'
/** A staged Neow reward (a Potion, Relic or Card Reward) waiting to be revealed has been. */
export const neowRewardRevealed = (count: number) => (run: RunState) => {
  const progress = neow(run)
  return run.phase !== 'neow' || !progress || Boolean(progress.reward) || progress.rewardQueue.length < count
}
/** At most `left` rewards from the blue option remain to be resolved. */
export const neowRewardsLeft = (left: number) => (run: RunState) => {
  const progress = neow(run)
  return run.phase !== 'neow' || !progress ||
    progress.rewardQueue.length + (progress.rewardKind || progress.reward ? 1 : 0) <= left
}

export const NEOW_GOLD = task('Take the Gold', 'Neow\'s red reward starts with 3 Gold. Gold buys cards, relics, potions and card removal from merchants. Take it.',
  neowGoldTaken, at.neowButton('Gain 3 Gold'))
export const NEOW_REVEAL = task('Reveal the Card Reward', 'The rest of the red reward is a Card Reward: 3 cards from your hero\'s reward deck. Reveal them.',
  neowRedRevealed, at.neowButton('Reveal Card Reward'))

/** Selects one card in an open card picker, then confirms it. */
export function pickerSteps(verb: string, defId: string, why: string, done: (run: RunState) => boolean): TutorialStep[] {
  return [
    task(`${verb} ${cardName(defId)}`, why, shown('.card-picker--previewing'), at.offeredCard(defId)),
    task('Confirm', `Confirm to ${verb.toLowerCase()} ${cardName(defId)}.`, done, at.pickerConfirm),
  ]
}

// The map.

/** One forced step along the route: a few words about the next room, then the move. */
export function moveChapter(from: string | null, to: string, title: string, body: string, extra: readonly TutorialStep[] = []): TutorialChapter {
  return {
    id: `move-${to}`,
    when: onMapAt(from),
    steps: [...extra, task(title, body, movedTo(to), at.room(to))],
  }
}

// Rewards after a fight.

export type RewardScript = {
  gold?: number
  potion?: { id: string; why: string }
  /** What the coach says about each offered card, in the order they are offered. */
  cards: readonly (readonly [defId: string, comment: string])[]
  pick: string | null
  pickWhy: string
  intro?: readonly TutorialStep[]
}

export function rewardChapter(roomId: string, script: RewardScript): TutorialChapter {
  const steps: TutorialStep[] = [...script.intro ?? []]
  if (script.gold) steps.push(task(`Take ${script.gold} Gold`, 'Rewards can be collected in any order, and any of them can be skipped. Gold is always worth taking.',
    goldTaken, at.loot(`${script.gold} Gold`)))
  if (script.potion) steps.push(task(`Take the ${potionName(script.potion.id)}`, `${potionText(script.potion.id)} ${script.potion.why}`,
    potionTaken, at.loot(potionName(script.potion.id))))
  steps.push(task('Open the Card Reward', 'Look at the cards before deciding. Adding a card is never forced.',
    cardRevealed, at.loot('Add a card')))
  for (const [defId, comment] of script.cards) steps.push(say(cardName(defId), comment, at.offeredCard(defId)))
  steps.push(script.pick
    ? task(`Take ${cardName(script.pick)}`, script.pickWhy, cardTaken, at.offeredCard(script.pick))
    : task('Skip these cards', script.pickWhy, cardTaken, spot('.reward-screen--card-choice .reward-screen__skip')))
  return { id: `reward-${roomId}`, when: inReward(roomId), steps }
}

// Rooms.

export function eventChapter(roomId: string, steps: readonly TutorialStep[]): TutorialChapter {
  return { id: `event-${roomId}`, when: inRoomScreen(roomId, 'event'), steps }
}

export function treasureChapter(roomId: string, relic: string, why: string): TutorialChapter {
  return {
    id: `treasure-${roomId}`,
    when: inRoomScreen(roomId, 'treasure'),
    steps: [
      task('Open the chest', 'Treasure rooms hold a relic. Relics stay with you for the whole run.',
        shown('.treasure-offers'), at.treasureOpen),
      task(`Take ${relicDef(relic).name}`, `${relicText(relic)} ${why}`, roomLeft, at.treasureRelic, at.treasureTake),
    ],
  }
}

export function merchantChapter(roomId: string, inside: readonly TutorialStep[], leave = true): TutorialChapter {
  return {
    id: `merchant-${roomId}`,
    when: inRoomScreen(roomId, 'merchant'),
    steps: [
      task('Visit the Merchant', 'Tap the Merchant to see the wares. Everything is paid for with Gold.',
        shown('.merchant-stage'), at.merchantEnter),
      ...inside,
      ...leave ? [
        task('Leave the shop', 'That is all for this visit.', shown('.merchant-arrival'), at.merchantLeave),
        task('Move on', 'Proceed to return to the map.', roomLeft, at.merchantProceed),
      ] : [],
    ],
  }
}
