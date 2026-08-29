/** Official public-v1.47 Hermit data from the Contention Games TTS prototype. */
export const HERMIT_SHEET_GUIDS = {
  starter: '3a0392',
  starter_upgrades: 'dcdd4a',
  rewards: '6355da',
  reward_upgrades: '9a4007',
  rares: '2b8379',
  rare_upgrades: 'c16bb3',
} as const

export const HERMIT_BOARD_GUID = '63f2c4'
export const HERMIT_STARTING_CHAMBER_SLOTS = 2
export const HERMIT_CURSE_MERCHANT_COST = 3

export const HERMIT_BOARD = {
  hp: 8,
  maxHp: 8,
  hpTrackMin: 1,
  hpTrackMax: 9,
  energy: 3,
  maxEnergy: 6,
  block: 0,
  maxBlock: 10,
  chamberSlots: HERMIT_STARTING_CHAMBER_SLOTS,
  reminders: {
    load: 'Load: Store a card in the Chamber.',
    deadOn: 'Dead On: Gains a bonus effect in the Chamber.',
    rapidFire: 'Rapid Fire: This card plays an additional time.',
  },
} as const

/** The board prints the effect but neither prints nor encodes a relic name. */
export const HERMIT_STARTING_COMBAT_ABILITY = {
  name: null,
  sourceName: 'unknown / unlabeled in source',
  text: 'Start of combat: Draw 1 card. Load 1 card.',
  draw: 1,
  load: 1,
} as const

export const HERMIT_FAQ = {
  attackPotionHighCaliberPlays: 4,
  loadedEtherealExhaustsAtEndOfTurn: false,
  snapshotUsesPrintedDamage: true,
  fatalDesireUpgradesAfterAdd: true,
} as const

export type HermitDeck = 'starter' | 'rewards' | 'rares'
export type HermitRarity = 'starter' | 'common' | 'uncommon' | 'rare' | 'curse' | 'ticket'
export type HermitPrintedType = 'Attack' | 'Skill' | 'Power' | 'Curse' | 'Ticket'
export type HermitPrintedCost = `${number}` | 'X' | null

export type HermitSourceCard = {
  deck: HermitDeck
  rarity: HermitRarity
  name: string
  type: HermitPrintedType
  cost: { base: HermitPrintedCost; upgraded: HermitPrintedCost }
  sheet_indices: { base: readonly number[]; upgraded: readonly number[] }
  multiplicity: number
  base_text: string
  upgraded_text: string | null
}

export type HermitCardFace = {
  cost: HermitPrintedCost
  /** Exact normalized transcription; resource names stand for the printed icons. */
  text: string
  /** Live opcodes are registered separately in HERMIT_CARD_DEFS. */
  effects: readonly HermitEngineEffect[]
  deadOn: boolean
  inherentRapidFire: number
  mentionsRapidFire: boolean
  mentionsLoad: boolean
  curseLoadReaction: boolean
  unplayable: boolean
}

type HermitEngineEffect = { kind: string; [key: string]: unknown }
type HermitLiveCardDef = {
  id: string
  name: string
  owner: 'hermit'
  type: 'attack' | 'skill' | 'power' | 'curse'
  rarity: 'starter' | 'common' | 'uncommon' | 'rare' | 'curse' | 'special'
  cost: number | 'X'
  effects: readonly HermitEngineEffect[]
  target?: 'enemy' | 'row'
  supportTarget?: 'self' | 'anyPlayer'
  exhaust?: boolean
  retain?: boolean
  unplayable?: boolean
  trigger?: { kind: 'startOfTurn' | 'endOfTurn' | 'onHermitDeadOn' }
  oncePerTurn?: boolean
  activeAbility?: boolean
  persistent?: boolean
  resolvesOnPlay?: boolean
  printedText: string
  printedCost: number | 'X' | null
  multiplicity: number
  hermit: {
    sourceText: string
    deadOn?: boolean
    rapidFire?: number
    rapidFireBy?: 'curseInChamber' | 'curses' | 'otherCardsInHand'
    costReductionBy?: 'attacksInChamber' | 'starterCards' | 'attacksPlayed' | 'curses'
    costZeroWhenDeadOn?: boolean
  }
  upgrade?: Partial<HermitLiveCardDef>
}

export type HermitCardDef = Omit<HermitSourceCard, 'cost' | 'base_text' | 'upgraded_text'> & {
  id: string
  base: HermitCardFace
  upgraded: HermitCardFace | null
}

export const HERMIT_SOURCE_CARDS: readonly HermitSourceCard[] = [
  {"deck":"starter","rarity":"starter","name":"Covet","type":"Skill","cost":{"base":"0","upgraded":"0"},"sheet_indices":{"base":[0],"upgraded":[0]},"multiplicity":1,"base_text":"Retain. Load 1 card.","upgraded_text":"Retain. Load up to 2 cards."},
  {"deck":"starter","rarity":"starter","name":"Strike","type":"Attack","cost":{"base":"1","upgraded":"1"},"sheet_indices":{"base":[1,2,3,4,5],"upgraded":[1,2,3,4,5]},"multiplicity":5,"base_text":"1 damage.","upgraded_text":"2 damage."},
  {"deck":"starter","rarity":"starter","name":"Snapshot","type":"Attack","cost":{"base":"2","upgraded":"2"},"sheet_indices":{"base":[6],"upgraded":[6]},"multiplicity":1,"base_text":"2 damage. Dead On: Gain Block equal to the damage dealt.","upgraded_text":"3 damage. Dead On: Gain Block equal to the damage dealt."},
  {"deck":"starter","rarity":"starter","name":"Defend","type":"Skill","cost":{"base":"1","upgraded":"1"},"sheet_indices":{"base":[7,8,9,10],"upgraded":[7,8,9,10]},"multiplicity":4,"base_text":"1 Block.","upgraded_text":"2 Block to any player."},
  {"deck":"rewards","rarity":"uncommon","name":"Vantage","type":"Skill","cost":{"base":"1","upgraded":"1"},"sheet_indices":{"base":[0],"upgraded":[0]},"multiplicity":1,"base_text":"Load 1 card. Your next Attack this turn gains Rapid Fire. Exhaust.","upgraded_text":"Load 1 card. Your next Attack this turn gains Rapid Fire."},
  {"deck":"rewards","rarity":"uncommon","name":"Flash Powder","type":"Skill","cost":{"base":"2","upgraded":"2"},"sheet_indices":{"base":[1],"upgraded":[1]},"multiplicity":1,"base_text":"Gain 1 Block and apply 1 Weak. Rapid Fire.","upgraded_text":"Gain 2 Block and apply 1 Weak. Rapid Fire."},
  {"deck":"rewards","rarity":"uncommon","name":"Heroic Bravado","type":"Skill","cost":{"base":"3","upgraded":"2"},"sheet_indices":{"base":[2],"upgraded":[2]},"multiplicity":1,"base_text":"Gain 1 Strength. Costs 1 less for each Attack in your Chamber. Exhaust.","upgraded_text":"Gain 1 Strength. Costs 1 less for each Attack in your Chamber. Exhaust."},
  {"deck":"rewards","rarity":"common","name":"Pistol Whip","type":"Attack","cost":{"base":"1","upgraded":"1"},"sheet_indices":{"base":[3,4],"upgraded":[3,4]},"multiplicity":2,"base_text":"2 damage. Dead On: Gain 1 Energy and Load 1 card.","upgraded_text":"3 damage. Dead On: Gain 1 Energy and Load 1 card."},
  {"deck":"rewards","rarity":"common","name":"Misfire","type":"Attack","cost":{"base":"0","upgraded":"0"},"sheet_indices":{"base":[5,6],"upgraded":[5,6]},"multiplicity":2,"base_text":"1 row damage. +1 damage if you have a Curse in your Chamber.","upgraded_text":"2 row damage. +1 damage if you have a Curse in your Chamber."},
  {"deck":"rewards","rarity":"common","name":"Quickdraw","type":"Attack","cost":{"base":"1","upgraded":"1"},"sheet_indices":{"base":[7,8],"upgraded":[7,8]},"multiplicity":2,"base_text":"1 damage. Draw 1 card. Load 1 card.","upgraded_text":"1 damage. Draw 2 cards. Load 1 card."},
  {"deck":"rewards","rarity":"common","name":"Tracking Shots","type":"Attack","cost":{"base":"2","upgraded":"2"},"sheet_indices":{"base":[9,10],"upgraded":[9,10]},"multiplicity":2,"base_text":"3 damage. If this was played from your hand, you may Load it.","upgraded_text":"4 damage. If this was played from your hand, you may Load it."},
  {"deck":"rewards","rarity":"common","name":"High-Caliber","type":"Attack","cost":{"base":"2","upgraded":"2"},"sheet_indices":{"base":[11,12],"upgraded":[11,12]},"multiplicity":2,"base_text":"1 damage and 1 Block. Rapid Fire.","upgraded_text":"2 damage and 1 Block. Rapid Fire."},
  {"deck":"rewards","rarity":"common","name":"Headshot","type":"Attack","cost":{"base":"2","upgraded":"2"},"sheet_indices":{"base":[13,14],"upgraded":[13,14]},"multiplicity":2,"base_text":"Dead On: 5 damage.","upgraded_text":"Dead On: 7 damage."},
  {"deck":"rewards","rarity":"common","name":"Itchy Trigger","type":"Attack","cost":{"base":"1","upgraded":"1"},"sheet_indices":{"base":[15,16],"upgraded":[15,16]},"multiplicity":2,"base_text":"1 damage. Rapid Fire.","upgraded_text":"1 damage. Rapid Fire. Rapid Fire."},
  {"deck":"rewards","rarity":"common","name":"Fan the Hammer","type":"Attack","cost":{"base":"1","upgraded":"1"},"sheet_indices":{"base":[17,18],"upgraded":[17,18]},"multiplicity":2,"base_text":"2 damage. Play a card in your Chamber for 0 Energy. Exhaust.","upgraded_text":"4 damage. Play a card in your Chamber for 0 Energy. Exhaust."},
  {"deck":"rewards","rarity":"common","name":"Dive","type":"Skill","cost":{"base":"1","upgraded":"1"},"sheet_indices":{"base":[19,20],"upgraded":[19,20]},"multiplicity":2,"base_text":"Gain 2 Block. +1 Block if you have a Curse in your Chamber.","upgraded_text":"Gain 3 Block. +1 Block if you have a Curse in your Chamber."},
  {"deck":"rewards","rarity":"common","name":"Feint","type":"Skill","cost":{"base":"1","upgraded":"1"},"sheet_indices":{"base":[21,22],"upgraded":[21,22]},"multiplicity":2,"base_text":"Draw 2 cards. Load 1 card.","upgraded_text":"Draw 3 cards. Load 1 card."},
  {"deck":"rewards","rarity":"common","name":"Take Cover","type":"Skill","cost":{"base":"1","upgraded":"1"},"sheet_indices":{"base":[23,24],"upgraded":[23,24]},"multiplicity":2,"base_text":"Gain 1 Block. Gain 1 Strength. Lose that Strength at end of turn.","upgraded_text":"Gain 2 Block. Gain 1 Strength. Lose that Strength at end of turn."},
  {"deck":"rewards","rarity":"common","name":"Body Armor","type":"Skill","cost":{"base":"1","upgraded":"1"},"sheet_indices":{"base":[25,26],"upgraded":[25,26]},"multiplicity":2,"base_text":"Gain 2 Block. Dead On: Costs 0.","upgraded_text":"Gain 3 Block. Dead On: Costs 0."},
  {"deck":"rewards","rarity":"common","name":"Low Profile","type":"Skill","cost":{"base":"0","upgraded":"0"},"sheet_indices":{"base":[27,28],"upgraded":[27,28]},"multiplicity":2,"base_text":"Gain 1 Block. Load 1 card. Exhaust.","upgraded_text":"Gain 1 Block. Load 1 card."},
  {"deck":"rewards","rarity":"common","name":"Manifest","type":"Skill","cost":{"base":"2","upgraded":"2"},"sheet_indices":{"base":[29,30],"upgraded":[29,30]},"multiplicity":2,"base_text":"Gain 3 Block. Load 1 card.","upgraded_text":"Gain 4 Block. Load 1 card."},
  {"deck":"rewards","rarity":"curse","name":"Scorn","type":"Curse","cost":{"base":null,"upgraded":null},"sheet_indices":{"base":[31],"upgraded":[31]},"multiplicity":1,"base_text":"Unplayable. When Loaded, gain 3 Block.","upgraded_text":"Unplayable. When Loaded, gain 4 Block."},
  {"deck":"rewards","rarity":"curse","name":"Grudge","type":"Curse","cost":{"base":null,"upgraded":null},"sheet_indices":{"base":[32],"upgraded":[32]},"multiplicity":1,"base_text":"Unplayable. When Loaded, deal 2 damage. +2 damage for each Weak and Vulnerable on the target.","upgraded_text":"Unplayable. When Loaded, deal 3 damage. +3 damage for each Weak and Vulnerable on the target."},
  {"deck":"rewards","rarity":"curse","name":"Malice","type":"Curse","cost":{"base":null,"upgraded":null},"sheet_indices":{"base":[33],"upgraded":[33]},"multiplicity":1,"base_text":"Unplayable. When Loaded, deal 2 damage to a row.","upgraded_text":"Unplayable. When Loaded, deal 4 damage to a row."},
  {"deck":"rewards","rarity":"curse","name":"Undead","type":"Curse","cost":{"base":null,"upgraded":null},"sheet_indices":{"base":[34],"upgraded":[34]},"multiplicity":1,"base_text":"Unplayable. When Loaded, gain 1 Strength. Lose that Strength at end of turn.","upgraded_text":"Unplayable. When Loaded, gain 2 Strength. Lose that Strength at end of turn."},
  {"deck":"rewards","rarity":"curse","name":"Horror","type":"Curse","cost":{"base":null,"upgraded":null},"sheet_indices":{"base":[35],"upgraded":[35]},"multiplicity":1,"base_text":"Unplayable. When Loaded, apply 1 Weak and 1 Vulnerable to an enemy.","upgraded_text":"Unplayable. When Loaded, apply 2 Weak and 1 Vulnerable to an enemy."},
  {"deck":"rewards","rarity":"ticket","name":"Golden Ticket","type":"Ticket","cost":{"base":null,"upgraded":null},"sheet_indices":{"base":[36,37],"upgraded":[36,37]},"multiplicity":2,"base_text":"Golden Ticket can't be added to your deck. When you reveal Golden Ticket, reveal a card from your rare deck.","upgraded_text":null},
  {"deck":"rewards","rarity":"uncommon","name":"Fully Loaded","type":"Power","cost":{"base":"1","upgraded":"1"},"sheet_indices":{"base":[38],"upgraded":[38]},"multiplicity":1,"base_text":"Gain a Chamber slot. When played, Load 1 card.","upgraded_text":"Gain a Chamber slot. When played, Load any number of cards."},
  {"deck":"rewards","rarity":"uncommon","name":"Take Aim","type":"Power","cost":{"base":"2","upgraded":"1"},"sheet_indices":{"base":[39],"upgraded":[39]},"multiplicity":1,"base_text":"End of turn: Load 1 card.","upgraded_text":"End of turn: Load 1 card."},
  {"deck":"rewards","rarity":"uncommon","name":"Enervate","type":"Attack","cost":{"base":"X","upgraded":"X"},"sheet_indices":{"base":[40],"upgraded":[40]},"multiplicity":1,"base_text":"X damage. Rapid Fire.","upgraded_text":"X+1 damage. Rapid Fire."},
  {"deck":"rewards","rarity":"uncommon","name":"Wide Open","type":"Attack","cost":{"base":"1","upgraded":"1"},"sheet_indices":{"base":[41],"upgraded":[41]},"multiplicity":1,"base_text":"2 damage. Dead On: Apply 1 Vulnerable.","upgraded_text":"3 damage. Dead On: Apply 1 Vulnerable."},
  {"deck":"rewards","rarity":"uncommon","name":"Desperado","type":"Attack","cost":{"base":"1","upgraded":"1"},"sheet_indices":{"base":[42],"upgraded":[42]},"multiplicity":1,"base_text":"2 damage. This has Rapid Fire while you have a Curse in your Chamber.","upgraded_text":"3 damage. This has Rapid Fire while you have a Curse in your Chamber."},
  {"deck":"rewards","rarity":"uncommon","name":"Cursed Weapon","type":"Attack","cost":{"base":"2","upgraded":"2"},"sheet_indices":{"base":[43],"upgraded":[43]},"multiplicity":1,"base_text":"2 damage. +3 damage for each Curse in your hand and Chamber.","upgraded_text":"2 damage. +4 damage for each Curse in your hand and Chamber."},
  {"deck":"rewards","rarity":"uncommon","name":"Trick Shot","type":"Attack","cost":{"base":"1","upgraded":"1"},"sheet_indices":{"base":[44],"upgraded":[44]},"multiplicity":1,"base_text":"2 damage. Dead On: Draw cards equal to the damage dealt. Exhaust.","upgraded_text":"2 damage. Dead On: Draw cards equal to the damage dealt."},
  {"deck":"rewards","rarity":"uncommon","name":"Short Fuse","type":"Attack","cost":{"base":"3","upgraded":"3"},"sheet_indices":{"base":[45],"upgraded":[45]},"multiplicity":1,"base_text":"1 row damage. Rapid Fire. Costs 1 less for each starter Strike or Defend in your hand and Chamber.","upgraded_text":"2 row damage. Rapid Fire. Costs 1 less for each starter Strike or Defend in your hand and Chamber."},
  {"deck":"rewards","rarity":"uncommon","name":"Deadeye","type":"Attack","cost":{"base":"2","upgraded":"2"},"sheet_indices":{"base":[46],"upgraded":[46]},"multiplicity":1,"base_text":"2 damage. Dead On: Gain 1 Strength.","upgraded_text":"4 damage. Dead On: Gain 1 Strength."},
  {"deck":"rewards","rarity":"uncommon","name":"Brawl","type":"Attack","cost":{"base":"3","upgraded":"3"},"sheet_indices":{"base":[47],"upgraded":[47]},"multiplicity":1,"base_text":"3 damage and 1 Block. Costs 1 less for each Attack you played this turn.","upgraded_text":"4 damage and 2 Block. Costs 1 less for each Attack you played this turn."},
  {"deck":"rewards","rarity":"uncommon","name":"Overwhelming Power","type":"Power","cost":{"base":"1","upgraded":"0"},"sheet_indices":{"base":[48],"upgraded":[48]},"multiplicity":1,"base_text":"Once per turn: If you've played 2 or more Attacks this turn, draw 2 cards.","upgraded_text":"Once per turn: If you've played 2 or more Attacks this turn, draw 2 cards."},
  {"deck":"rewards","rarity":"uncommon","name":"Showdown","type":"Power","cost":{"base":"1","upgraded":"0"},"sheet_indices":{"base":[49],"upgraded":[49]},"multiplicity":1,"base_text":"Your Rapid Fire Attacks deal +1 damage on each hit.","upgraded_text":"Your Rapid Fire Attacks deal +1 damage on each hit."},
  {"deck":"rewards","rarity":"uncommon","name":"Determination","type":"Power","cost":{"base":"2","upgraded":"1"},"sheet_indices":{"base":[50],"upgraded":[50]},"multiplicity":1,"base_text":"Once per turn: When you Load a Curse, gain 1 Strength.","upgraded_text":"Once per turn: When you Load a Curse, gain 1 Strength."},
  {"deck":"rewards","rarity":"uncommon","name":"Maintenance","type":"Power","cost":{"base":"1","upgraded":"1"},"sheet_indices":{"base":[51],"upgraded":[51]},"multiplicity":1,"base_text":"Your starter Strikes cost 0.","upgraded_text":"Your starter Strikes cost 0 and deal +1 damage."},
  {"deck":"rewards","rarity":"uncommon","name":"Lone Wolf","type":"Power","cost":{"base":"1","upgraded":"1"},"sheet_indices":{"base":[52],"upgraded":[52]},"multiplicity":1,"base_text":"Whenever you Load a card with Dead On, gain 1 Block.","upgraded_text":"Whenever you Load a card with Dead On, gain 2 Block."},
  {"deck":"rewards","rarity":"uncommon","name":"Shadow Cloak","type":"Power","cost":{"base":"2","upgraded":"2"},"sheet_indices":{"base":[53],"upgraded":[53]},"multiplicity":1,"base_text":"Once per turn: Discard a Curse from your hand or Chamber to gain 2 Block.","upgraded_text":"Once per turn: Discard a Curse from your hand or Chamber to gain 3 Block."},
  {"deck":"rewards","rarity":"uncommon","name":"Called Shot","type":"Power","cost":{"base":"1","upgraded":"0"},"sheet_indices":{"base":[54],"upgraded":[54]},"multiplicity":1,"base_text":"Start of turn: Choose a card in your Chamber. It costs 0 this turn.","upgraded_text":"Start of turn: Choose a card in your Chamber. It costs 0 this turn."},
  {"deck":"rewards","rarity":"uncommon","name":"Black Wind","type":"Power","cost":{"base":"1","upgraded":"0"},"sheet_indices":{"base":[55],"upgraded":[55]},"multiplicity":1,"base_text":"Once per turn: Discard a card from your Chamber to Load 1 card.","upgraded_text":"Once per turn: Discard a card from your Chamber to Load 1 card."},
  {"deck":"rewards","rarity":"uncommon","name":"Ghostly Presence","type":"Skill","cost":{"base":"1","upgraded":"1"},"sheet_indices":{"base":[56],"upgraded":[56]},"multiplicity":1,"base_text":"Gain 2 Block. Discard a card from your Chamber. Load up to 2 cards.","upgraded_text":"Gain 3 Block. Discard a card from your Chamber. Load up to 2 cards."},
  {"deck":"rewards","rarity":"uncommon","name":"Specter","type":"Skill","cost":{"base":"1","upgraded":"1"},"sheet_indices":{"base":[57],"upgraded":[57]},"multiplicity":1,"base_text":"Gain 1 Block. Draw 1 card. This gains Rapid Fire for each Curse in your hand or Chamber.","upgraded_text":"Gain 2 Block. Draw 1 card. This gains Rapid Fire for each Curse in your hand or Chamber."},
  {"deck":"rewards","rarity":"uncommon","name":"Midnight","type":"Skill","cost":{"base":"2","upgraded":"2"},"sheet_indices":{"base":[58],"upgraded":[58]},"multiplicity":1,"base_text":"Apply 1 Vulnerable. Costs 1 less for each Attack in your Chamber. Exhaust.","upgraded_text":"Apply 1 Vulnerable. Costs 1 less for each Attack in your Chamber."},
  {"deck":"rewards","rarity":"uncommon","name":"Rummage","type":"Skill","cost":{"base":"1","upgraded":"1"},"sheet_indices":{"base":[59],"upgraded":[59]},"multiplicity":1,"base_text":"Load 1 card from your discard pile. Exhaust.","upgraded_text":"Load 1 card from your discard pile."},
  {"deck":"rewards","rarity":"uncommon","name":"Eye Of The Storm","type":"Skill","cost":{"base":"1","upgraded":"0"},"sheet_indices":{"base":[60],"upgraded":[60]},"multiplicity":1,"base_text":"Play every card in your Chamber for 0 Energy. Exhaust.","upgraded_text":"Play every card in your Chamber for 0 Energy. Exhaust."},
  {"deck":"rewards","rarity":"uncommon","name":"Virtue","type":"Skill","cost":{"base":"1","upgraded":"1"},"sheet_indices":{"base":[61],"upgraded":[61]},"multiplicity":1,"base_text":"Any player draws 3 cards.","upgraded_text":"Any player draws 4 cards."},
  {"deck":"rares","rarity":"curse","name":"Fatal Desire","type":"Curse","cost":{"base":null,"upgraded":null},"sheet_indices":{"base":[0],"upgraded":[0]},"multiplicity":1,"base_text":"Unplayable. When you add this card to your deck, gain 10 Gold.","upgraded_text":"Unplayable. When you remove this card from your deck, gain 10 Gold."},
  {"deck":"rares","rarity":"rare","name":"Cheat","type":"Attack","cost":{"base":"1","upgraded":"1"},"sheet_indices":{"base":[1],"upgraded":[1]},"multiplicity":1,"base_text":"2 damage. Dead On: Trigger a die relic. Its owner gets the effect.","upgraded_text":"2 damage. Dead On: Trigger up to two different die relics. The owners get the effects."},
  {"deck":"rares","rarity":"rare","name":"Magnum","type":"Attack","cost":{"base":"3","upgraded":"3"},"sheet_indices":{"base":[2],"upgraded":[2]},"multiplicity":1,"base_text":"2 damage. This gains Rapid Fire for each other card in your hand. Discard your hand.","upgraded_text":"3 damage. This gains Rapid Fire for each other card in your hand. Discard your hand."},
  {"deck":"rares","rarity":"rare","name":"Roundhouse Kick","type":"Attack","cost":{"base":"2","upgraded":"2"},"sheet_indices":{"base":[3],"upgraded":[3]},"multiplicity":1,"base_text":"3 row damage and apply 1 Vulnerable. Exhaust.","upgraded_text":"5 row damage and apply 1 Vulnerable. Exhaust."},
  {"deck":"rares","rarity":"rare","name":"Purgatory","type":"Attack","cost":{"base":"4","upgraded":"4"},"sheet_indices":{"base":[4],"upgraded":[4]},"multiplicity":1,"base_text":"7 row damage. Costs 1 less for each Curse in your hand or Chamber.","upgraded_text":"9 row damage. Costs 1 less for each Curse in your hand and Chamber."},
  {"deck":"rares","rarity":"rare","name":"Golden Bullet","type":"Attack","cost":{"base":"1","upgraded":"1"},"sheet_indices":{"base":[5],"upgraded":[5]},"multiplicity":1,"base_text":"2 damage. Dead On: If the target has Vulnerable, deal quadruple damage instead of double.","upgraded_text":"3 damage. Dead On: If the target has Vulnerable, deal quadruple damage instead of double."},
  {"deck":"rares","rarity":"rare","name":"Roulette","type":"Attack","cost":{"base":"1","upgraded":"1"},"sheet_indices":{"base":[6],"upgraded":[6]},"multiplicity":1,"base_text":"Die: 1 -> 1 damage; 2 -> 2 damage + 1 Vulnerable; 3 -> 2 damage + 2 Block; 4 -> 2 row damage; 5 -> 2 damage + 1 Weak; 6 -> 6 damage.","upgraded_text":"Die: 1 -> 1 damage; 2 -> 3 damage + 1 Vulnerable; 3 -> 3 damage + 3 Block; 4 -> 3 row damage; 5 -> 3 damage + 1 Weak; 6 -> 9 damage."},
  {"deck":"rares","rarity":"rare","name":"No Holds Barred","type":"Power","cost":{"base":"2","upgraded":"1"},"sheet_indices":{"base":[7],"upgraded":[7]},"multiplicity":1,"base_text":"Your Rapid Fire cards gain an additional Rapid Fire.","upgraded_text":"Your Rapid Fire cards gain an additional Rapid Fire."},
  {"deck":"rares","rarity":"rare","name":"Eternal Form","type":"Power","cost":{"base":"3","upgraded":"2"},"sheet_indices":{"base":[8],"upgraded":[8]},"multiplicity":1,"base_text":"Start of turn: Load 1 card. It costs 0 this turn.","upgraded_text":"Start of turn: Load 1 card. It costs 0 this turn."},
  {"deck":"rares","rarity":"rare","name":"High Noon","type":"Power","cost":{"base":"2","upgraded":"2"},"sheet_indices":{"base":[9],"upgraded":[9]},"multiplicity":1,"base_text":"Your starter Strikes gain Rapid Fire.","upgraded_text":"Your starter Strikes and Defends gain Rapid Fire."},
  {"deck":"rares","rarity":"rare","name":"Snipe","type":"Power","cost":{"base":"2","upgraded":"1"},"sheet_indices":{"base":[10],"upgraded":[10]},"multiplicity":1,"base_text":"Once per turn: Apply 1 Vulnerable if you have a Dead On Attack in your Chamber.","upgraded_text":"Once per turn: Apply 1 Vulnerable if you have a Dead On Attack in your Chamber."},
  {"deck":"rares","rarity":"rare","name":"Gestalt","type":"Skill","cost":{"base":"1","upgraded":"1"},"sheet_indices":{"base":[11],"upgraded":[11]},"multiplicity":1,"base_text":"Gain 2 Block. If this was played from your hand, you may Load it.","upgraded_text":"Gain 3 Block. If this was played from your hand, you may Load it."},
  {"deck":"rares","rarity":"rare","name":"Dead Or Alive","type":"Skill","cost":{"base":"2","upgraded":"2"},"sheet_indices":{"base":[12],"upgraded":[12]},"multiplicity":1,"base_text":"Apply 2 Vulnerable. Attach to the target. When it dies, give 1 Strength to any player and discard this card.","upgraded_text":"Apply 3 Vulnerable. Attach to the target. When it dies, give 1 Strength to any player and discard this card."},
  {"deck":"rares","rarity":"rare","name":"Coalescence","type":"Skill","cost":{"base":"0","upgraded":"0"},"sheet_indices":{"base":[13],"upgraded":[13]},"multiplicity":1,"base_text":"Draw 2 cards. Load up to 2 cards. Exhaust.","upgraded_text":"Draw 3 cards. Load up to 2 cards. Exhaust."},
  {"deck":"rares","rarity":"rare","name":"Smoking Barrel","type":"Power","cost":{"base":"1","upgraded":"1"},"sheet_indices":{"base":[14],"upgraded":[14]},"multiplicity":1,"base_text":"Start of turn: You may discard a card from your Chamber to draw 3 cards.","upgraded_text":"Start of turn: You may discard a card from your Chamber to draw 4 cards."},
  {"deck":"rares","rarity":"rare","name":"Combo","type":"Power","cost":{"base":"2","upgraded":"2"},"sheet_indices":{"base":[15],"upgraded":[15]},"multiplicity":1,"base_text":"Once per turn: When you activate Dead On, draw 2 cards then Load 1 card.","upgraded_text":"Once per turn: When you activate Dead On, draw 3 cards then Load 1 card."},
] as const

function cardId(name: string): string {
  return `hermit_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}`
}

function inherentRapidFire(text: string): number {
  return text.split('.').filter((clause) => clause.trim() === 'Rapid Fire').length
}

function face(card: HermitSourceCard, upgraded: boolean): HermitCardFace | null {
  const text = upgraded ? card.upgraded_text : card.base_text
  if (text === null) return null
  return {
    cost: upgraded ? card.cost.upgraded : card.cost.base,
    text,
    effects: [],
    deadOn: text.includes('Dead On:'),
    inherentRapidFire: inherentRapidFire(text),
    mentionsRapidFire: text.includes('Rapid Fire'),
    mentionsLoad: /\bLoad(?:ed)?\b/.test(text),
    curseLoadReaction: text.includes('When Loaded,'),
    unplayable: text.includes('Unplayable.'),
  }
}

export const HERMIT_CARDS: readonly HermitCardDef[] = HERMIT_SOURCE_CARDS.map((card) => ({
  ...card,
  id: cardId(card.name),
  base: face(card, false)!,
  upgraded: face(card, true),
}))

export const HERMIT_CARDS_BY_ID: Readonly<Record<string, HermitCardDef>> = Object.fromEntries(
  HERMIT_CARDS.map((card) => [card.id, card]),
)

const H = (kind: string, fields: Record<string, unknown> = {}): HermitEngineEffect => ({ kind, ...fields })
const hit = (amount: unknown): HermitEngineEffect => H('hit', { amount })
const rowHit = (amount: unknown): HermitEngineEffect => H('rowHit', { amount })
const block = (amount: unknown, toChosen = false): HermitEngineEffect => H('block', { amount, ...(toChosen ? { toChosen } : {}) })
const load = (amount: number, fields: Record<string, unknown> = {}): HermitEngineEffect => H('load', { amount, ...fields })
const deadOn = (...effects: HermitEngineEffect[]): HermitEngineEffect => H('deadOnEffects', { effects })

type HermitLiveSpec = Omit<HermitLiveCardDef,
  'id' | 'name' | 'owner' | 'printedText' | 'printedCost' | 'multiplicity' | 'hermit' | 'upgrade'> & {
    hermit?: Omit<HermitLiveCardDef['hermit'], 'sourceText'>
    upgrade?: Partial<Omit<HermitLiveCardDef, 'id' | 'name' | 'owner' | 'multiplicity' | 'hermit'>> & {
      hermit?: Omit<HermitLiveCardDef['hermit'], 'sourceText'>
    }
  }

const HERMIT_LIVE_SPECS: Readonly<Record<string, HermitLiveSpec>> = {
  hermit_covet: { type: 'skill', rarity: 'starter', cost: 0, retain: true, effects: [load(1)],
    upgrade: { effects: [load(2, { upTo: true })] } },
  hermit_strike: { type: 'attack', rarity: 'starter', cost: 1, effects: [hit(1)], upgrade: { effects: [hit(2)] } },
  hermit_snapshot: { type: 'attack', rarity: 'starter', cost: 2, effects: [hit(2), deadOn(H('deadOnPrintedBlock', { amount: 2 }))],
    hermit: { deadOn: true }, upgrade: { effects: [hit(3), deadOn(H('deadOnPrintedBlock', { amount: 3 }))] } },
  hermit_defend: { type: 'skill', rarity: 'starter', cost: 1, effects: [block(1)],
    upgrade: { effects: [block(2, true)], supportTarget: 'anyPlayer' } },

  hermit_vantage: { type: 'skill', rarity: 'uncommon', cost: 1, exhaust: true,
    effects: [load(1), H('grantNextAttackRapidFire')], upgrade: { exhaust: false } },
  hermit_flash_powder: { type: 'skill', rarity: 'uncommon', cost: 2,
    effects: [block(1), H('applyWeak', { amount: 1 })], hermit: { rapidFire: 1 },
    upgrade: { effects: [block(2), H('applyWeak', { amount: 1 })] } },
  hermit_heroic_bravado: { type: 'skill', rarity: 'uncommon', cost: 3, exhaust: true,
    effects: [H('gainStrength', { amount: 1 })], hermit: { costReductionBy: 'attacksInChamber' }, upgrade: { cost: 2 } },
  hermit_pistol_whip: { type: 'attack', rarity: 'common', cost: 1,
    effects: [hit(2), deadOn(H('gainEnergy', { amount: 1 }), load(1))], hermit: { deadOn: true },
    upgrade: { effects: [hit(3), deadOn(H('gainEnergy', { amount: 1 }), load(1))] } },
  hermit_misfire: { type: 'attack', rarity: 'common', cost: 0, target: 'row',
    effects: [rowHit({ base: 1, bonus: { plus: 1, when: { kind: 'hasCurseInChamber' } } })],
    upgrade: { effects: [rowHit({ base: 2, bonus: { plus: 1, when: { kind: 'hasCurseInChamber' } } })] } },
  hermit_quickdraw: { type: 'attack', rarity: 'common', cost: 1, effects: [hit(1), H('draw', { amount: 1 }), load(1)],
    upgrade: { effects: [hit(1), H('draw', { amount: 2 }), load(1)] } },
  hermit_tracking_shots: { type: 'attack', rarity: 'common', cost: 2,
    effects: [hit(3), H('loadSelf', { optional: true })], upgrade: { effects: [hit(4), H('loadSelf', { optional: true })] } },
  hermit_high_caliber: { type: 'attack', rarity: 'common', cost: 2, effects: [hit(1), block(1)], hermit: { rapidFire: 1 },
    upgrade: { effects: [hit(2), block(1)] } },
  hermit_headshot: { type: 'attack', rarity: 'common', cost: 2, effects: [deadOn(hit(5))], hermit: { deadOn: true },
    upgrade: { effects: [deadOn(hit(7))] } },
  hermit_itchy_trigger: { type: 'attack', rarity: 'common', cost: 1, effects: [hit(1)], hermit: { rapidFire: 1 },
    upgrade: { hermit: { rapidFire: 2 } } },
  hermit_fan_the_hammer: { type: 'attack', rarity: 'common', cost: 1, exhaust: true,
    effects: [hit(2), H('playChamber', { amount: 1, free: true })],
    upgrade: { effects: [hit(4), H('playChamber', { amount: 1, free: true })] } },
  hermit_dive: { type: 'skill', rarity: 'common', cost: 1,
    effects: [block({ base: 2, bonus: { plus: 1, when: { kind: 'hasCurseInChamber' } } })],
    upgrade: { effects: [block({ base: 3, bonus: { plus: 1, when: { kind: 'hasCurseInChamber' } } })] } },
  hermit_feint: { type: 'skill', rarity: 'common', cost: 1, effects: [H('draw', { amount: 2 }), load(1)],
    upgrade: { effects: [H('draw', { amount: 3 }), load(1)] } },
  hermit_take_cover: { type: 'skill', rarity: 'common', cost: 1,
    effects: [block(1), H('gainTemporaryStrength', { amount: 1, loseGainedOnly: true })],
    upgrade: { effects: [block(2), H('gainTemporaryStrength', { amount: 1, loseGainedOnly: true })] } },
  hermit_body_armor: { type: 'skill', rarity: 'common', cost: 1, effects: [block(2)], hermit: { deadOn: true, costZeroWhenDeadOn: true },
    upgrade: { effects: [block(3)] } },
  hermit_low_profile: { type: 'skill', rarity: 'common', cost: 0, exhaust: true, effects: [block(1), load(1)],
    upgrade: { exhaust: false } },
  hermit_manifest: { type: 'skill', rarity: 'common', cost: 2, effects: [block(3), load(1)],
    upgrade: { effects: [block(4), load(1)] } },
  hermit_scorn: { type: 'curse', rarity: 'curse', cost: 0, effects: [], unplayable: true },
  hermit_grudge: { type: 'curse', rarity: 'curse', cost: 0, effects: [], unplayable: true },
  hermit_malice: { type: 'curse', rarity: 'curse', cost: 0, effects: [], unplayable: true },
  hermit_undead: { type: 'curse', rarity: 'curse', cost: 0, effects: [], unplayable: true },
  hermit_horror: { type: 'curse', rarity: 'curse', cost: 0, effects: [], unplayable: true },
  hermit_golden_ticket: { type: 'curse', rarity: 'special', cost: 0, effects: [], unplayable: true },
  hermit_fully_loaded: { type: 'power', rarity: 'uncommon', cost: 1, resolvesOnPlay: true,
    effects: [H('gainChamberSlot', { amount: 1 }), load(1)],
    upgrade: { effects: [H('gainChamberSlot', { amount: 1 }), load(99, { upTo: true })] } },
  hermit_take_aim: { type: 'power', rarity: 'uncommon', cost: 2, trigger: { kind: 'endOfTurn' }, effects: [load(1)],
    upgrade: { cost: 1 } },
  hermit_enervate: { type: 'attack', rarity: 'uncommon', cost: 'X', effects: [hit({ base: 0, per: 'energySpent' })],
    hermit: { rapidFire: 1 }, upgrade: { effects: [hit({ base: 1, per: 'energySpent' })] } },
  hermit_wide_open: { type: 'attack', rarity: 'uncommon', cost: 1,
    effects: [hit(2), deadOn(H('applyVulnerable', { amount: 1 }))], hermit: { deadOn: true },
    upgrade: { effects: [hit(3), deadOn(H('applyVulnerable', { amount: 1 }))] } },
  hermit_desperado: { type: 'attack', rarity: 'uncommon', cost: 1, effects: [hit(2)], hermit: { rapidFireBy: 'curseInChamber' },
    upgrade: { effects: [hit(3)] } },
  hermit_cursed_weapon: { type: 'attack', rarity: 'uncommon', cost: 2,
    effects: [hit({ base: 2, per: 'cursesInHandAndChamber', scale: 3 })],
    upgrade: { effects: [hit({ base: 2, per: 'cursesInHandAndChamber', scale: 4 })] } },
  hermit_trick_shot: { type: 'attack', rarity: 'uncommon', cost: 1, exhaust: true,
    effects: [hit(2), deadOn(H('drawLastHitDamage'))], hermit: { deadOn: true }, upgrade: { exhaust: false } },
  hermit_short_fuse: { type: 'attack', rarity: 'uncommon', cost: 3, target: 'row', effects: [rowHit(1)],
    hermit: { rapidFire: 1, costReductionBy: 'starterCards' }, upgrade: { effects: [rowHit(2)] } },
  hermit_deadeye: { type: 'attack', rarity: 'uncommon', cost: 2,
    effects: [hit(2), deadOn(H('gainStrength', { amount: 1 }))], hermit: { deadOn: true },
    upgrade: { effects: [hit(4), deadOn(H('gainStrength', { amount: 1 }))] } },
  hermit_brawl: { type: 'attack', rarity: 'uncommon', cost: 3, effects: [hit(3), block(1)],
    hermit: { costReductionBy: 'attacksPlayed' }, upgrade: { effects: [hit(4), block(2)] } },
  hermit_overwhelming_power: { type: 'power', rarity: 'uncommon', cost: 1, effects: [], persistent: true,
    upgrade: { cost: 0 } },
  hermit_showdown: { type: 'power', rarity: 'uncommon', cost: 1, effects: [], persistent: true, upgrade: { cost: 0 } },
  hermit_determination: { type: 'power', rarity: 'uncommon', cost: 2, effects: [], persistent: true, upgrade: { cost: 1 } },
  hermit_maintenance: { type: 'power', rarity: 'uncommon', cost: 1, effects: [], persistent: true },
  hermit_lone_wolf: { type: 'power', rarity: 'uncommon', cost: 1, effects: [], persistent: true },
  hermit_shadow_cloak: { type: 'power', rarity: 'uncommon', cost: 2, activeAbility: true, oncePerTurn: true,
    effects: [H('discardChamber', { amount: 1, curseOnly: true }), block(2)],
    upgrade: { effects: [H('discardChamber', { amount: 1, curseOnly: true }), block(3)] } },
  hermit_called_shot: { type: 'power', rarity: 'uncommon', cost: 1, trigger: { kind: 'startOfTurn' },
    effects: [H('discountChamber', { amount: 1 })], upgrade: { cost: 0 } },
  hermit_black_wind: { type: 'power', rarity: 'uncommon', cost: 1, activeAbility: true, oncePerTurn: true,
    effects: [H('discardChamber', { amount: 1 }), load(1)], upgrade: { cost: 0 } },
  hermit_ghostly_presence: { type: 'skill', rarity: 'uncommon', cost: 1,
    effects: [block(2), H('discardChamber', { amount: 1 }), load(2, { upTo: true })],
    upgrade: { effects: [block(3), H('discardChamber', { amount: 1 }), load(2, { upTo: true })] } },
  hermit_specter: { type: 'skill', rarity: 'uncommon', cost: 1, effects: [block(1), H('draw', { amount: 1 })],
    hermit: { rapidFireBy: 'curses' }, upgrade: { effects: [block(2), H('draw', { amount: 1 })] } },
  hermit_midnight: { type: 'skill', rarity: 'uncommon', cost: 2, exhaust: true,
    effects: [H('applyVulnerable', { amount: 1 })], hermit: { costReductionBy: 'attacksInChamber' },
    upgrade: { exhaust: false } },
  hermit_rummage: { type: 'skill', rarity: 'uncommon', cost: 1, exhaust: true,
    effects: [load(1, { source: 'discard' })], upgrade: { exhaust: false } },
  hermit_eye_of_the_storm: { type: 'skill', rarity: 'uncommon', cost: 1, exhaust: true,
    effects: [H('playChamber', { amount: 'all', free: true })], upgrade: { cost: 0 } },
  hermit_virtue: { type: 'skill', rarity: 'uncommon', cost: 1, supportTarget: 'anyPlayer',
    effects: [H('draw', { amount: 3, toChosen: true })], upgrade: { effects: [H('draw', { amount: 4, toChosen: true })] } },

  hermit_fatal_desire: { type: 'curse', rarity: 'curse', cost: 0, effects: [], unplayable: true },
  hermit_cheat: { type: 'attack', rarity: 'rare', cost: 1, effects: [hit(2), deadOn(H('triggerDieRelic', { amount: 1 }))],
    hermit: { deadOn: true }, upgrade: { effects: [hit(2), deadOn(H('triggerDieRelic', { amount: 2, upTo: true }))] } },
  hermit_magnum: { type: 'attack', rarity: 'rare', cost: 3, effects: [hit(2), H('discardHand')],
    hermit: { rapidFireBy: 'otherCardsInHand' }, upgrade: { effects: [hit(3), H('discardHand')] } },
  hermit_roundhouse_kick: { type: 'attack', rarity: 'rare', cost: 2, target: 'row', exhaust: true,
    effects: [rowHit(3), H('applyVulnerable', { amount: 1 })],
    upgrade: { effects: [rowHit(5), H('applyVulnerable', { amount: 1 })] } },
  hermit_purgatory: { type: 'attack', rarity: 'rare', cost: 4, target: 'row', effects: [rowHit(7)],
    hermit: { costReductionBy: 'curses' }, upgrade: { effects: [rowHit(9)] } },
  hermit_golden_bullet: { type: 'attack', rarity: 'rare', cost: 1,
    effects: [H('goldenBullet', { amount: 2 })], hermit: { deadOn: true },
    upgrade: { effects: [H('goldenBullet', { amount: 3 })] } },
  hermit_roulette: { type: 'attack', rarity: 'rare', cost: 1, effects: [H('roulette', { byRoll: {
    1: [hit(1)], 2: [hit(2), H('applyVulnerable', { amount: 1 })], 3: [hit(2), block(2)],
    4: [rowHit(2)], 5: [hit(2), H('applyWeak', { amount: 1 })], 6: [hit(6)],
  } })], upgrade: { effects: [H('roulette', { byRoll: {
    1: [hit(1)], 2: [hit(3), H('applyVulnerable', { amount: 1 })], 3: [hit(3), block(3)],
    4: [rowHit(3)], 5: [hit(3), H('applyWeak', { amount: 1 })], 6: [hit(9)],
  } })] } },
  hermit_no_holds_barred: { type: 'power', rarity: 'rare', cost: 2, effects: [], persistent: true, upgrade: { cost: 1 } },
  hermit_eternal_form: { type: 'power', rarity: 'rare', cost: 3, trigger: { kind: 'startOfTurn' },
    effects: [load(1, { discount: true })], upgrade: { cost: 2 } },
  hermit_high_noon: { type: 'power', rarity: 'rare', cost: 2, effects: [], persistent: true },
  hermit_snipe: { type: 'power', rarity: 'rare', cost: 2, activeAbility: true, oncePerTurn: true,
    effects: [H('applyVulnerable', { amount: 1, when: { kind: 'hasDeadOnAttackInChamber' } })], upgrade: { cost: 1 } },
  hermit_gestalt: { type: 'skill', rarity: 'rare', cost: 1, effects: [block(2), H('loadSelf', { optional: true })],
    upgrade: { effects: [block(3), H('loadSelf', { optional: true })] } },
  hermit_dead_or_alive: { type: 'skill', rarity: 'rare', cost: 2,
    effects: [H('attachBounty', { vulnerable: 2 })], upgrade: { effects: [H('attachBounty', { vulnerable: 3 })] } },
  hermit_coalescence: { type: 'skill', rarity: 'rare', cost: 0, exhaust: true,
    effects: [H('draw', { amount: 2 }), load(2, { upTo: true })],
    upgrade: { effects: [H('draw', { amount: 3 }), load(2, { upTo: true })] } },
  hermit_smoking_barrel: { type: 'power', rarity: 'rare', cost: 1, trigger: { kind: 'startOfTurn' },
    effects: [H('discardChamber', { amount: 1, optional: true, then: [H('draw', { amount: 3 })] })],
    upgrade: { effects: [H('discardChamber', { amount: 1, optional: true, then: [H('draw', { amount: 4 })] })] } },
  hermit_combo: { type: 'power', rarity: 'rare', cost: 2, trigger: { kind: 'onHermitDeadOn' }, oncePerTurn: true,
    effects: [H('draw', { amount: 2 }), H('load', { amount: 1 })], persistent: true,
    upgrade: { effects: [H('draw', { amount: 3 }), H('load', { amount: 1 })] } },
}

function printedCost(cost: HermitPrintedCost): number | 'X' | null {
  return cost === null || cost === 'X' ? cost : Number(cost)
}

export const HERMIT_CARD_DEFS: Readonly<Record<string, HermitLiveCardDef>> = Object.fromEntries(
  HERMIT_SOURCE_CARDS.map((source) => {
    const id = cardId(source.name)
    const spec = HERMIT_LIVE_SPECS[id]
    if (!spec) throw new Error(`Missing live Hermit specification: ${id}`)
    const { upgrade: upgradeSpec, ...baseSpec } = spec
    const upgradedText = source.upgraded_text
    const definition: HermitLiveCardDef = {
      ...baseSpec,
      id,
      name: source.name,
      owner: 'hermit',
      printedText: source.base_text,
      printedCost: printedCost(source.cost.base),
      multiplicity: source.multiplicity,
      hermit: { sourceText: source.base_text, ...baseSpec.hermit },
      ...(upgradedText === null ? {} : {
        upgrade: {
          ...upgradeSpec,
          printedText: upgradedText,
          printedCost: printedCost(source.cost.upgraded),
          hermit: { sourceText: upgradedText, ...baseSpec.hermit, ...upgradeSpec?.hermit },
        },
      }),
    }
    return [id, definition]
  }),
)

export type HermitPhysicalCard = {
  id: string
  defId: string
  deck: HermitDeck
  sheetGuid: string
  sheetIndex: number
  upgradeSheetGuid: string
  upgradeSheetIndex: number
  upgradeAvailable: boolean
}

function sheetGuid(deck: HermitDeck, upgraded: boolean): string {
  if (deck === 'starter') return upgraded ? HERMIT_SHEET_GUIDS.starter_upgrades : HERMIT_SHEET_GUIDS.starter
  if (deck === 'rewards') return upgraded ? HERMIT_SHEET_GUIDS.reward_upgrades : HERMIT_SHEET_GUIDS.rewards
  return upgraded ? HERMIT_SHEET_GUIDS.rare_upgrades : HERMIT_SHEET_GUIDS.rares
}

export const HERMIT_PHYSICAL_CARDS: readonly HermitPhysicalCard[] = HERMIT_CARDS.flatMap((card) =>
  card.sheet_indices.base.map((sheetIndex, copy) => ({
    id: `${card.id}_${copy + 1}`,
    defId: card.id,
    deck: card.deck,
    sheetGuid: sheetGuid(card.deck, false),
    sheetIndex,
    upgradeSheetGuid: sheetGuid(card.deck, true),
    upgradeSheetIndex: card.sheet_indices.upgraded[copy]!,
    upgradeAvailable: card.upgraded !== null,
  })),
)

/** Def ids in sheet order, including one entry per physical copy. */
export const HERMIT_PHYSICAL_DECKS: Readonly<Record<HermitDeck, readonly string[]>> = {
  starter: HERMIT_PHYSICAL_CARDS.filter((card) => card.deck === 'starter').map((card) => card.defId),
  rewards: HERMIT_PHYSICAL_CARDS.filter((card) => card.deck === 'rewards').map((card) => card.defId),
  rares: HERMIT_PHYSICAL_CARDS.filter((card) => card.deck === 'rares').map((card) => card.defId),
}

export type HermitChamber<T> = {
  slots: readonly (T | null)[]
}

export type HermitCardZones<T> = {
  hand: readonly T[]
  chamber: HermitChamber<T>
  discard: readonly T[]
}

export function createHermitChamber<T>(slotCount = HERMIT_STARTING_CHAMBER_SLOTS): HermitChamber<T> {
  if (!Number.isSafeInteger(slotCount) || slotCount < 0) throw new RangeError('Chamber slot count must be a non-negative integer')
  return { slots: Array.from({ length: slotCount }, () => null) }
}

export function gainHermitChamberSlots<T>(chamber: HermitChamber<T>, amount = 1): HermitChamber<T> {
  if (!Number.isSafeInteger(amount) || amount < 0) throw new RangeError('Chamber slot gain must be a non-negative integer')
  return { slots: [...chamber.slots, ...Array.from({ length: amount }, () => null)] }
}

function removeAt<T>(items: readonly T[], index: number, zone: string): { item: T; rest: readonly T[] } {
  if (!Number.isSafeInteger(index) || index < 0 || index >= items.length) throw new RangeError(`Invalid ${zone} index`)
  return { item: items[index]!, rest: [...items.slice(0, index), ...items.slice(index + 1)] }
}

/** Load from hand or discard; an occupied destination is discarded first. */
export function loadHermitCard<T>(
  zones: HermitCardZones<T>,
  source: 'hand' | 'discard',
  sourceIndex: number,
  slotIndex: number,
): { zones: HermitCardZones<T>; loaded: T; displaced: T | null } {
  if (!Number.isSafeInteger(slotIndex) || slotIndex < 0 || slotIndex >= zones.chamber.slots.length) {
    throw new RangeError('Invalid Chamber slot index')
  }
  const removed = removeAt(zones[source], sourceIndex, source)
  const displaced = zones.chamber.slots[slotIndex] ?? null
  const slots = [...zones.chamber.slots]
  slots[slotIndex] = removed.item
  return {
    zones: {
      ...zones,
      [source]: removed.rest,
      chamber: { slots },
      discard: displaced === null ? (source === 'discard' ? removed.rest : zones.discard) : [
        ...(source === 'discard' ? removed.rest : zones.discard), displaced,
      ],
    },
    loaded: removed.item,
    displaced,
  }
}

export function discardHermitChamberCard<T>(
  zones: HermitCardZones<T>,
  slotIndex: number,
): { zones: HermitCardZones<T>; discarded: T } {
  if (!Number.isSafeInteger(slotIndex) || slotIndex < 0 || slotIndex >= zones.chamber.slots.length) {
    throw new RangeError('Invalid Chamber slot index')
  }
  const discarded = zones.chamber.slots[slotIndex]
  if (discarded == null) throw new Error('Cannot discard an empty Chamber slot')
  const slots = [...zones.chamber.slots]
  slots[slotIndex] = null
  return { zones: { ...zones, chamber: { slots }, discard: [...zones.discard, discarded] }, discarded }
}

export function playHermitChamberCard<T>(
  chamber: HermitChamber<T>,
  slotIndex: number,
): { chamber: HermitChamber<T>; card: T; deadOn: true } {
  if (!Number.isSafeInteger(slotIndex) || slotIndex < 0 || slotIndex >= chamber.slots.length) {
    throw new RangeError('Invalid Chamber slot index')
  }
  const card = chamber.slots[slotIndex]
  if (card == null) throw new Error('Cannot play an empty Chamber slot')
  const slots = [...chamber.slots]
  slots[slotIndex] = null
  return { chamber: { slots }, card, deadOn: true }
}

export type HermitPlayOrigin = 'hand' | 'chamber' | 'external-copy' | 'rapid-fire-copy'

/** Dead On is active for a Chamber play and every copy descended from it. */
export function isHermitDeadOn(origin: HermitPlayOrigin, copiedFromDeadOn = false): boolean {
  return origin === 'chamber' || copiedFromDeadOn
}

export type HermitRapidFirePlay = {
  origin: HermitPlayOrigin
  deadOn: boolean
  canTriggerRapidFire: boolean
  targetChosenIndependently: true
}

/**
 * Each original/external seed triggers every Rapid Fire instance exactly once.
 * Rapid Fire copies are terminal, while copies made by other effects are seeds.
 */
export function planHermitRapidFire(options: {
  rapidFireInstances: number
  externalCopies?: number
  playedFromChamber?: boolean
}): readonly HermitRapidFirePlay[] {
  const { rapidFireInstances, externalCopies = 0, playedFromChamber = false } = options
  for (const [name, amount] of [['Rapid Fire', rapidFireInstances], ['external copy', externalCopies]] as const) {
    if (!Number.isSafeInteger(amount) || amount < 0) throw new RangeError(`${name} count must be a non-negative integer`)
  }
  const deadOn = playedFromChamber
  const seeds: HermitRapidFirePlay[] = Array.from({ length: externalCopies + 1 }, (_, index) => ({
    origin: index === 0 ? (playedFromChamber ? 'chamber' : 'hand') : 'external-copy',
    deadOn,
    canTriggerRapidFire: true,
    targetChosenIndependently: true,
  }))
  return seeds.flatMap((seed) => [
    seed,
    ...Array.from({ length: rapidFireInstances }, (): HermitRapidFirePlay => ({
      origin: 'rapid-fire-copy',
      deadOn,
      canTriggerRapidFire: false,
      targetChosenIndependently: true,
    })),
  ])
}

/** FAQ: target Block and remaining HP do not reduce Snapshot's Dead On Block. */
export function snapshotDeadOnBlock(printedDamage: number): number {
  if (!Number.isSafeInteger(printedDamage) || printedDamage < 0) throw new RangeError('Printed damage must be a non-negative integer')
  return printedDamage
}

/** Ethereal and other held-at-end-of-turn effects inspect the hand, not Chamber. */
export function shouldHermitEtherealExhaust(zone: 'hand' | 'chamber'): boolean {
  return zone === 'hand'
}

export type HermitCurseLoadReaction =
  | { kind: 'block'; amount: number }
  | { kind: 'damage'; amount: number; target: 'enemy' | 'row' }
  | { kind: 'temporaryStrength'; amount: number }
  | { kind: 'statuses'; weak: number; vulnerable: number; target: 'enemy' }

/** Fatal Desire has add/remove text, not a Load reaction. */
export function hermitCurseLoadReaction(
  cardId: string,
  upgraded: boolean,
  targetStatuses: { weak: number; vulnerable: number } = { weak: 0, vulnerable: 0 },
): HermitCurseLoadReaction | null {
  const step = upgraded ? 1 : 0
  switch (cardId) {
    case 'hermit_scorn': return { kind: 'block', amount: 3 + step }
    case 'hermit_grudge': {
      const tokens = targetStatuses.weak + targetStatuses.vulnerable
      if (!Number.isSafeInteger(tokens) || targetStatuses.weak < 0 || targetStatuses.vulnerable < 0) {
        throw new RangeError('Target statuses must be non-negative integers')
      }
      const damage = 2 + step
      return { kind: 'damage', amount: damage + damage * tokens, target: 'enemy' }
    }
    case 'hermit_malice': return { kind: 'damage', amount: upgraded ? 4 : 2, target: 'row' }
    case 'hermit_undead': return { kind: 'temporaryStrength', amount: upgraded ? 2 : 1 }
    case 'hermit_horror': return { kind: 'statuses', weak: upgraded ? 2 : 1, vulnerable: 1, target: 'enemy' }
    case 'hermit_fatal_desire': return null
    default: throw new Error(`Not a Hermit Curse: ${cardId}`)
  }
}

/**
 * Fatal Desire+ is added before it is immediately upgraded, so adding either
 * face gains 10 Gold. Only the upgraded face rewards removal.
 */
export function fatalDesireGold(event: 'add' | 'remove', upgraded: boolean): number {
  return event === 'add' || upgraded ? 10 : 0
}

/** Draw one, then perform the board's mandatory Load choice. */
export function setupHermitCombat<T>(
  zones: HermitCardZones<T> & { draw: readonly T[] },
  loadHandIndex: number,
  chamberSlotIndex: number,
): HermitCardZones<T> & { draw: readonly T[] } {
  const drawn = zones.draw.slice(0, HERMIT_STARTING_COMBAT_ABILITY.draw)
  const afterDraw = {
    hand: [...zones.hand, ...drawn],
    chamber: zones.chamber,
    discard: zones.discard,
    draw: zones.draw.slice(drawn.length),
  }
  const loaded = loadHermitCard(afterDraw, 'hand', loadHandIndex, chamberSlotIndex).zones
  return { ...loaded, draw: afterDraw.draw }
}
