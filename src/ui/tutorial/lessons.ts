import type { CharacterId } from '../../game/types.ts'
import { spot } from './helpers.ts'
import type { TutorialStep } from './types.ts'

// Each hero's own mechanics in general terms. The hero scripts teach them on
// the cards in hand; these are also the lessons for a run that has left its
// script. Every number is the board game's: see `docs/rules.md` § 11.

export type CharacterLessons = {
  /** Shown before cards can be played in the first fight, for heroes with an opening choice. */
  setup?: readonly TutorialStep[]
  intro: readonly TutorialStep[]
  advanced: readonly TutorialStep[]
}

/** Each hero's own mechanics: shown in the first fight, then deepened in the second. */
export const CHARACTER_LESSONS: Record<CharacterId, CharacterLessons> = {
  ironclad: {
    intro: [
      {
        title: 'Playing the Ironclad',
        body: 'The Ironclad has the most HP of any hero (10), and Burning Blood heals 1 HP after every fight. You can afford small hits early on.',
        focus: [spot('.seat--viewer')],
      },
      {
        title: 'Bash and Vulnerable',
        body: 'Bash deals 2 damage and applies Vulnerable. The next hit on that enemy is doubled, bonuses first, and then one token is removed. Play Bash first, then your Strikes.',
        focus: [spot('.hand')],
      },
    ],
    advanced: [
      {
        title: 'Strength',
        body: 'Strength adds 1 damage to every hit, so cards that hit several times gain the most from it. Ironclad cards build Strength over a fight. It caps at 8.',
      },
      {
        title: 'Exhaust',
        body: 'Many Ironclad cards Exhaust themselves or your other cards, and some reward you whenever a card is exhausted. Exhausting weak cards such as statuses keeps your draws strong.',
        focus: [spot('.hand-area__stats .pile-group')],
      },
    ],
  },
  silent: {
    intro: [
      {
        title: 'Playing the Silent',
        body: 'Ring of the Snake draws 2 extra cards at the start of each fight. Your starter deck is bigger (12 cards), with Neutralize and Survivor added.',
        focus: [spot('.hand')],
      },
      {
        title: 'Neutralize and Weak',
        body: 'Neutralize costs 0, deals 1 and applies Weak. A Weak enemy deals 1 less on each hit and loses one token after each attack. Aim it at the biggest attacker.',
        focus: [spot('.hand')],
      },
    ],
    advanced: [
      {
        title: 'Poison',
        body: 'At the end of your turn each poisoned enemy loses 1 HP per token. Poison ignores Block and never wears off until the enemy dies. All enemies together can hold at most 30.',
      },
      {
        title: 'Shivs',
        body: 'Shivs are tokens, not cards; you can hold up to 5. Spend one whenever you could play a card, using "Use Shiv" in the top bar, to deal 1 damage. Each Shiv is its own hit, so Strength and Vulnerable apply to every one.',
        focus: [spot('.combat__actions')],
      },
    ],
  },
  defect: {
    intro: [
      {
        title: 'Playing the Defect',
        body: 'The Defect fights with Orbs. Cracked Core channels a Lightning Orb at the start of every fight.',
        focus: [spot('.orbs, .seat--viewer')],
      },
      {
        title: 'Orbs',
        body: 'Lightning deals 1 damage at the end of your turn and 2 when Evoked. Frost gives 1 Block at the end of your turn and 1 when Evoked. Dark deals nothing each turn, but 3 plus 1 per Power you have when Evoked.',
        focus: [spot('.orbs, .seat--viewer')],
      },
    ],
    advanced: [
      {
        title: 'Channel and Evoke',
        body: 'A board-game rule: Orbs never rotate. Channel puts an Orb into any empty slot. If every slot is full, you first Evoke the Orb of your choice. Zap channels Lightning, and Dual Cast Evokes one Orb twice.',
        focus: [spot('.orbs, .hand')],
      },
      {
        title: 'Powers',
        body: 'Powers stay in play for the whole fight, and each one makes Dark Orbs stronger. There is no Focus in the board game; you grow stronger with more Orbs and Powers instead.',
      },
    ],
  },
  watcher: {
    intro: [
      {
        title: 'Playing the Watcher',
        body: 'The Watcher switches between Stances. She starts every fight in Neutral. Eruption enters Wrath, and Vigilance gives Block and enters Calm.',
        focus: [spot('.seat--viewer')],
      },
      {
        title: 'Calm and Wrath',
        body: 'Leaving Calm gives 2 Energy. In Wrath every hit deals 1 more, but ending your turn in Wrath costs you 1 damage (Block can stop it). A strong pattern: enter Calm, switch to Wrath for a big turn, and leave Wrath before you end it.',
        focus: [spot('.seat--viewer')],
      },
    ],
    advanced: [
      {
        title: 'Miracles',
        body: 'Pure Water gives 1 Miracle each fight, and you can hold up to 5. Spend one at any time for 1 Energy with "Use Miracle". Spent right away on a card, it can take you past the 6-Energy cap.',
        focus: [spot('.combat__actions')],
      },
      {
        title: 'Scry and Retain',
        body: 'Scry lets you look at the top cards of your draw pile and discard any of them. Retain cards stay in your hand at the end of the turn, which is ideal for saving a big card for your Wrath turn.',
      },
    ],
  },
  slime_boss: {
    intro: [
      {
        title: 'Playing Slime Boss',
        body: 'You command a party of Slimes. Bruiser Slime joins you at the start of every fight and is Commanded automatically at the end of each turn.',
        focus: [spot('.slime-party, .seat--viewer')],
      },
      {
        title: 'Command and Grow',
        body: 'Command makes a Slime act. What it does depends on its level, shown on the Slime. Grow raises a Slime\'s level. Lick Commands a Slime, and Slime Slap deals 2 damage and Grows one.',
        focus: [spot('.slime-party, .hand')],
      },
    ],
    advanced: [
      {
        title: 'New Slimes',
        body: 'Slime cards from rewards join your party when you play them. Each has its own trigger: some act at the end of your turn, some when you Grow, and some when you spend 2 or more Energy on a card.',
        focus: [spot('.slime-party')],
      },
      {
        title: 'Building the gang',
        body: 'Balance your deck between cards that Grow Slimes and cards that Command them. A few high-level Slimes Commanded often hit harder than many small ones.',
      },
    ],
  },
  guardian: {
    setup: [
      {
        title: 'Choose your Mode',
        body: 'At the start of a turn the Guardian may shift Mode. Attack Mode powers cards such as Twin Slam, and Defense Mode powers cards such as Curl Up. Pick the Mode that suits this hand and the enemy intents.',
        focus: [spot('.guardian-mode-choice')],
      },
    ],
    intro: [
      {
        title: 'Playing the Guardian',
        body: 'The Guardian enters Attack Mode at the start of every fight. You may shift Mode at the start of a turn and with certain cards.',
        focus: [spot('.seat--viewer')],
      },
      {
        title: 'Attack and Defense Mode',
        body: 'Twin Slam deals 2 damage, plus 1 more in Attack Mode. Curl Up gives 2 Block and, in Defense Mode, a Vigor. Switch to Defense Mode when a big attack is coming.',
        focus: [spot('.hand')],
      },
    ],
    advanced: [
      {
        title: 'Vigor',
        body: 'Spend Vigor from the top bar before a card. For the rest of the turn it adds to every hit in Attack Mode, or to every Block icon in Defense Mode. You share a supply of 4 Vigor tokens.',
        focus: [spot('.combat__actions')],
      },
      {
        title: 'Gems and Sockets',
        body: 'Socket cards get a Gem when you take them: choose one of two Gems, and its effect resolves together with the card. Pick Gems that fix what your deck is missing.',
      },
    ],
  },
  hexaghost: {
    intro: [
      {
        title: 'Playing Hexaghost',
        body: 'Hexaghost burns on a Heat track from 1 to 6, shown by the flames around it. Advance raises Heat by 1 and Retract lowers it by 1. Many cards grow stronger at higher Heat.',
        focus: [spot('.seat--viewer')],
      },
      {
        title: 'Starter cards',
        body: 'Kindle gives Block and Advances. Sear costs 0 and deals 1, or 2 once Heat is at least 2. Raise Heat early so your attacks hit harder.',
        focus: [spot('.hand')],
      },
    ],
    advanced: [
      {
        title: 'Soulburn',
        body: 'You gain 1 Soulburn at the start of every fight and can hold up to 6. Spending one with "Spend Soulburn" deals damage equal to your current Heat, so raise Heat first and spend it for the finishing blow.',
        focus: [spot('.combat__actions')],
      },
      {
        title: 'Burns and exhaust',
        body: 'Burn cards deal 1 damage at the end of your turn while they are in your hand, and that damage can use up your Block. Cards that Exhaust them keep you safe and power Hexaghost cards that count your exhaust pile.',
      },
    ],
  },
  hermit: {
    setup: [
      {
        title: 'Load your first card',
        body: 'At the start of every fight, after your 5-card draw, the Hermit draws 1 more card and must Load one card into the Chamber. Tap a card in your hand to Load it. The turn starts once it is in place.',
        focus: [spot('.hand')],
      },
    ],
    intro: [
      {
        title: 'Playing the Hermit',
        body: 'The Hermit has 9 HP and a Chamber with 2 slots. At the start of every fight you draw 1 extra card and must Load one card into the Chamber.',
        focus: [spot('.hermit-chamber-trigger')],
      },
      {
        title: 'Load and Dead On',
        body: 'A Loaded card leaves your draw cycle until you play it from the Chamber, where its Dead On bonus fires. From the Chamber, Snapshot also gives Block equal to the damage it dealt. You still pay the card\'s cost.',
        focus: [spot('.hermit-chamber-trigger')],
      },
    ],
    advanced: [
      {
        title: 'Covet',
        body: 'Covet costs 0, Retains, and Loads a card. Hold it until a card worth saving appears. Loading into a full Chamber discards the card already in that slot.',
        focus: [spot('.hermit-chamber-trigger, .hand')],
      },
      {
        title: 'Rapid Fire',
        body: 'Rapid Fire plays the whole card an extra time: damage, Block, debuffs, and even Dead On when played from the Chamber. Load your Rapid Fire cards for the biggest turns.',
      },
    ],
  },
}
