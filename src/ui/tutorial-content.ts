import type { CharacterId } from '../game/types.ts'

/**
 * The guided tutorial's script. Each chapter opens the first time its moment
 * arrives in a real Act I run and walks through a few steps, each optionally
 * pointing at a piece of the live UI. Chapters are checked in order, so the
 * character's own chapter follows the shared combat basics in the first fight.
 *
 * Every number here is the board game's, not the video game's: see
 * `docs/rules.md`, especially § 11.
 */
export type TutorialStep = {
  title: string
  body: string
  /** A CSS selector for the element to highlight; the first visible match wins. */
  target?: string
}

export type TutorialMoment = {
  phase: string
  /** The kind of map room the party is standing in, if any. */
  roomKind?: string
  /** The kind of non-combat room screen that is open, if any. */
  roomState?: string
  /** 1 for the run's first combat, 2 for the second, and so on; 0 outside combat. */
  combatNumber: number
  /** The combat's round, while one is under way. */
  turn: number
  /** The combat's phase: `start` while start-of-turn choices wait, `player` once cards can be played. */
  combatPhase?: string
}

export type TutorialChapter = {
  id: string
  when: (moment: TutorialMoment) => boolean
  steps: readonly TutorialStep[]
}

// Card-play chapters wait for the player phase, so a start-of-turn choice such
// as the Guardian's Mode is never hidden behind the coach.
const inCombat = (moment: TutorialMoment) =>
  moment.phase === 'combat' && moment.turn > 0 && moment.combatPhase === 'player'
const beforePlay = (moment: TutorialMoment) => moment.phase === 'combat' && moment.combatNumber === 1 &&
  (moment.turn === 0 || moment.combatPhase === 'start')

const WELCOME: TutorialChapter = {
  id: 'welcome',
  when: (moment) => moment.phase === 'neow',
  steps: [
    {
      title: 'Welcome to the Spire',
      body: 'This tutorial is a real Act I run with a guide. Climb the map, win your fights, and defeat the boss at the top. Nothing here affects your campaign, saved run or leaderboard.',
    },
    {
      title: 'Your health',
      body: 'Your HP always sits in the top bar. The board game uses small numbers: most heroes have about 9 HP and a Strike deals 1, so every point matters. At 0 HP the run is over.',
      target: '.pip--hp',
    },
    {
      title: 'Deck and relics',
      body: 'Open your deck here at any time. Relics you collect sit beside your gold; hover over or long-press any relic to read what it does.',
      target: '.deck-peek__open',
    },
    {
      title: "Neow's blessing",
      body: 'Every run starts with Neow. Reveal the card, take its red reward, then choose one of the blue rewards. Playing solo also gives you 2 gold and the Loaded Die relic.',
      target: '.neow-options, .neow-faces',
    },
  ],
}

const MAP: TutorialChapter = {
  id: 'map',
  when: (moment) => moment.phase === 'map',
  steps: [
    {
      title: 'The map',
      body: 'The party climbs from the bottom to the boss at the top. Each step you pick one of the rooms connected to where you stand. Rooms you can reach glow.',
      target: '.map__frame',
    },
    {
      title: 'Room types',
      body: 'Monsters are ordinary fights. Elites are harder but drop a relic. "?" rooms are events. Campfires let you heal or upgrade, merchants sell cards, relics and potions, and chests hold relics.',
      target: '.map__legend',
    },
    {
      title: 'Plan your route',
      body: 'The boss is face up, so you know what you are building toward. Look a few rooms ahead: take a campfire when HP is low, and fight an elite only when your deck can handle it.',
      target: '.map__frame',
    },
  ],
}

const COMBAT: TutorialChapter = {
  id: 'combat',
  when: (moment) => inCombat(moment) && moment.combatNumber === 1,
  steps: [
    {
      title: 'Your first fight',
      body: 'Bring every enemy to 0 HP to win. Enemies sit in rows: each attacks the player in its row, but you may attack any enemy.',
      target: '[data-enemy-id]',
    },
    {
      title: 'Enemy intent',
      body: 'The icon over each enemy shows what it will do on its turn. A number is the damage it will deal. Hover over or long-press an enemy to read its abilities.',
      target: '.enemy__intent',
    },
    {
      title: 'Your hand',
      body: 'You draw 5 cards each turn and there is no hand limit. Cards you have not played are discarded when your turn ends, unless they Retain.',
      target: '.hand',
    },
    {
      title: 'Energy',
      body: 'Every card costs Energy, shown in its top-left corner. Your Energy refills to 3 at the start of each turn, and unspent Energy does not carry over.',
      target: '.pip--energy',
    },
    {
      title: 'Playing a card',
      body: 'Click or tap a card, then click the enemy it should hit. You can also drag the card onto its target. Cards that do not need a target resolve right away.',
      target: '.hand',
    },
    {
      title: 'Block',
      body: 'Defend and similar cards give Block. Each point stops 1 damage this round, and you can hold at most 20. Block clears at the start of your next turn, and it never stops "lose HP" effects.',
      target: '.seat--viewer',
    },
    {
      title: 'The shared die',
      body: 'A board-game rule: one die is rolled every round. It chooses what some enemies do and triggers relics that match the roll. Your Loaded Die gives 1 Energy on a 6.',
      target: '.combat__die',
    },
    {
      title: 'Your piles',
      body: 'Draw pile, discard pile and exhaust pile. Click one to look inside. When the draw pile runs out, the discard pile is shuffled in. Exhausted cards are gone until the fight ends.',
      target: '.hand-area__stats .pile',
    },
    {
      title: 'End your turn',
      body: 'When you are done, end the turn. Enemies then act in order from the top row down, and bosses always act last. Check their intents before you end the turn.',
      target: '.combat__end-turn',
    },
  ],
}

const STATUS_EFFECTS: TutorialChapter = {
  id: 'status-effects',
  when: (moment) => inCombat(moment) && moment.combatNumber === 1 && moment.turn >= 2,
  steps: [
    {
      title: 'Tokens and caps',
      body: 'Vulnerable doubles the next hit and Weak lowers each hit by 1. Both lose one token after each attack, and both cap at 3. Strength adds 1 to every hit and caps at 8. Hover over any token to read it.',
      target: '.seat--viewer',
    },
  ],
}

const REWARD: TutorialChapter = {
  id: 'reward',
  when: (moment) => moment.phase === 'reward',
  steps: [
    {
      title: 'Rewards',
      body: 'After a fight, collect your rewards in any order and skip any you do not want. Gold is spent at merchants and in some events.',
      target: '.reward-screen',
    },
    {
      title: 'Choosing cards',
      body: 'A card reward shows 3 cards; add one or skip them all. A smaller deck draws your best cards more often, so take a card only when it improves your deck.',
      target: '.reward-screen',
    },
    {
      title: 'Potions',
      body: 'Potions are used once, and you can carry at most 3. Use them from the potion bar during a fight, and save them for the turns that matter.',
    },
  ],
}

const CAMPFIRE: TutorialChapter = {
  id: 'campfire',
  when: (moment) => moment.phase === 'room' && moment.roomKind === 'campfire' && !moment.roomState,
  steps: [
    {
      title: 'Campfire',
      body: 'Rest to heal 3 HP, or Smith to upgrade one card. Upgraded cards use the green text on the other side of the card. Rest when the next fights could kill you; otherwise upgrading makes your deck stronger for good.',
      target: '.campfire__choices, .campfire',
    },
  ],
}

const MERCHANT: TutorialChapter = {
  id: 'merchant',
  when: (moment) => moment.phase === 'room' && moment.roomState === 'merchant',
  steps: [
    {
      title: 'Merchant',
      body: 'Cards cost 2 gold for a common, 3 for an uncommon and 6 for a rare. Relics and potions show their price. For 3 gold you may remove one card from your deck, once per visit, which is often the best purchase.',
      target: '.merchant-shelf, .room-screen',
    },
  ],
}

const EVENT: TutorialChapter = {
  id: 'event',
  when: (moment) => moment.phase === 'room' && moment.roomState === 'event',
  steps: [
    {
      title: 'Events',
      body: 'A "?" room reveals an event card. Read every option first: some cost HP or add a Curse to your deck, and some are decided by a die roll. Near death, the safest option is usually best.',
      target: '.event-stage, .room-screen',
    },
  ],
}

const TREASURE: TutorialChapter = {
  id: 'treasure',
  when: (moment) => moment.phase === 'room' && moment.roomState === 'treasure',
  steps: [
    {
      title: 'Treasure',
      body: 'A chest gives you a relic. Relics last the whole run; read the new one so you can plan around it.',
    },
  ],
}

const ELITE: TutorialChapter = {
  id: 'elite',
  when: (moment) => inCombat(moment) && moment.roomKind === 'elite',
  steps: [
    {
      title: 'Elite fight',
      body: 'Elites hit harder and have more HP, but always drop a relic. Elites sit in the bottom row. Use your potions here if the fight turns bad.',
      target: '[data-enemy-id]',
    },
  ],
}

const BOSS: TutorialChapter = {
  id: 'boss',
  when: (moment) => inCombat(moment) && moment.roomKind === 'boss',
  steps: [
    {
      title: 'The boss',
      body: 'Win this fight to finish Act I and the tutorial. Bosses count as being in every row and always act last. Watch the intent every turn, and spend your potions now.',
      target: '[data-enemy-id]',
    },
  ],
}

type CharacterLessons = {
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
        target: '.seat--viewer',
      },
      {
        title: 'Bash and Vulnerable',
        body: 'Bash deals 2 damage and applies Vulnerable. The next hit on that enemy is doubled, bonuses first, and then one token is removed. Play Bash first, then your Strikes.',
        target: '.hand',
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
        target: '.hand-area__stats .pile-group',
      },
    ],
  },
  silent: {
    intro: [
      {
        title: 'Playing the Silent',
        body: 'Ring of the Snake draws 2 extra cards at the start of each fight. Your starter deck is bigger (12 cards), with Neutralize and Survivor added.',
        target: '.hand',
      },
      {
        title: 'Neutralize and Weak',
        body: 'Neutralize costs 0, deals 1 and applies Weak. A Weak enemy deals 1 less on each hit and loses one token after each attack. Aim it at the biggest attacker.',
        target: '.hand',
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
        target: '.combat__actions',
      },
    ],
  },
  defect: {
    intro: [
      {
        title: 'Playing the Defect',
        body: 'The Defect fights with Orbs. Cracked Core channels a Lightning Orb at the start of every fight.',
        target: '.orbs, .seat--viewer',
      },
      {
        title: 'Orbs',
        body: 'Lightning deals 1 damage at the end of your turn and 2 when Evoked. Frost gives 1 Block at the end of your turn and 1 when Evoked. Dark deals nothing each turn, but 3 plus 1 per Power you have when Evoked.',
        target: '.orbs, .seat--viewer',
      },
    ],
    advanced: [
      {
        title: 'Channel and Evoke',
        body: 'A board-game rule: Orbs never rotate. Channel puts an Orb into any empty slot. If every slot is full, you first Evoke the Orb of your choice. Zap channels Lightning, and Dual Cast Evokes one Orb twice.',
        target: '.orbs, .hand',
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
        target: '.seat--viewer',
      },
      {
        title: 'Calm and Wrath',
        body: 'Leaving Calm gives 2 Energy. In Wrath every hit deals 1 more, but ending your turn in Wrath costs you 1 damage (Block can stop it). A strong pattern: enter Calm, switch to Wrath for a big turn, and leave Wrath before you end it.',
        target: '.seat--viewer',
      },
    ],
    advanced: [
      {
        title: 'Miracles',
        body: 'Pure Water gives 1 Miracle each fight, and you can hold up to 5. Spend one at any time for 1 Energy with "Use Miracle". Spent right away on a card, it can take you past the 6-Energy cap.',
        target: '.combat__actions',
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
        target: '.slime-party, .seat--viewer',
      },
      {
        title: 'Command and Grow',
        body: 'Command makes a Slime act. What it does depends on its level, shown on the Slime. Grow raises a Slime\'s level. Lick Commands a Slime, and Slime Slap deals 2 damage and Grows one.',
        target: '.slime-party, .hand',
      },
    ],
    advanced: [
      {
        title: 'New Slimes',
        body: 'Slime cards from rewards join your party when you play them. Each has its own trigger: some act at the end of your turn, some when you Grow, and some when you spend 2 or more Energy on a card.',
        target: '.slime-party',
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
        target: '.guardian-mode-choice',
      },
    ],
    intro: [
      {
        title: 'Playing the Guardian',
        body: 'The Guardian enters Attack Mode at the start of every fight. You may shift Mode at the start of a turn and with certain cards.',
        target: '.seat--viewer',
      },
      {
        title: 'Attack and Defense Mode',
        body: 'Twin Slam deals 2 damage, plus 1 more in Attack Mode. Curl Up gives 2 Block and, in Defense Mode, a Vigor. Switch to Defense Mode when a big attack is coming.',
        target: '.hand',
      },
    ],
    advanced: [
      {
        title: 'Vigor',
        body: 'Spend Vigor from the top bar before a card. For the rest of the turn it adds to every hit in Attack Mode, or to every Block icon in Defense Mode. You share a supply of 4 Vigor tokens.',
        target: '.combat__actions',
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
        target: '.seat--viewer',
      },
      {
        title: 'Starter cards',
        body: 'Kindle gives Block and Advances. Sear costs 0 and deals 1, or 2 once Heat is at least 2. Raise Heat early so your attacks hit harder.',
        target: '.hand',
      },
    ],
    advanced: [
      {
        title: 'Soulburn',
        body: 'You gain 1 Soulburn at the start of every fight and can hold up to 6. Spending one with "Spend Soulburn" deals damage equal to your current Heat, so raise Heat first and spend it for the finishing blow.',
        target: '.combat__actions',
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
        body: 'Before the first turn of every fight, the Hermit draws 1 card and must Load a card into the Chamber. Tap a card in your hand to Load it. The fight starts once it is in place.',
        target: '.hand',
      },
    ],
    intro: [
      {
        title: 'Playing the Hermit',
        body: 'The Hermit has 8 HP and a Chamber with 2 slots. At the start of every fight you draw 1 extra card and must Load one card into the Chamber.',
        target: '.hermit-chamber-trigger',
      },
      {
        title: 'Load and Dead On',
        body: 'A Loaded card leaves your draw cycle until you play it from the Chamber, where its Dead On bonus fires. From the Chamber, Snapshot also gives Block equal to the damage it dealt. You still pay the card\'s cost.',
        target: '.hermit-chamber-trigger',
      },
    ],
    advanced: [
      {
        title: 'Covet',
        body: 'Covet costs 0, Retains, and Loads a card. Hold it until a card worth saving appears. Loading into a full Chamber discards the card already in that slot.',
        target: '.hermit-chamber-trigger, .hand',
      },
      {
        title: 'Rapid Fire',
        body: 'Rapid Fire plays the whole card an extra time: damage, Block, debuffs, and even Dead On when played from the Chamber. Load your Rapid Fire cards for the biggest turns.',
      },
    ],
  },
}

/** The ordered chapters for one hero's tutorial. */
export function tutorialChapters(character: CharacterId): TutorialChapter[] {
  const lessons = CHARACTER_LESSONS[character]
  return [
    WELCOME,
    MAP,
    ...lessons.setup ? [{
      id: `${character}-setup`,
      when: beforePlay,
      steps: lessons.setup,
    }] : [],
    COMBAT,
    {
      id: `${character}-intro`,
      when: (moment) => inCombat(moment) && moment.combatNumber === 1,
      steps: lessons.intro,
    },
    STATUS_EFFECTS,
    {
      id: `${character}-advanced`,
      when: (moment) => inCombat(moment) && moment.combatNumber >= 2,
      steps: lessons.advanced,
    },
    ELITE,
    BOSS,
    REWARD,
    CAMPFIRE,
    MERCHANT,
    EVENT,
    TREASURE,
  ]
}
