import type { GuardianMode } from '../types.ts'
import type { Effect } from '../cards.ts'
import type { Trigger } from '../triggers.ts'

type GuardianLiveCardDef = {
  id: string
  name: string
  owner: 'guardian'
  type: 'attack' | 'skill' | 'power'
  rarity: 'starter' | 'common' | 'uncommon' | 'rare' | 'special'
  cost: number | 'X'
  effects: Effect[]
  exhaust?: boolean
  ethereal?: boolean
  retain?: boolean
  minimumX?: number
  guardianVariableType?: boolean
  guardian?: { printedType: string; socket: boolean; grantsSocket: boolean; sourceText: string }
  unplayable?: boolean
  trigger?: Trigger
  resolvesOnPlay?: boolean
  activeAbility?: boolean
  oncePerTurn?: boolean
  persistent?: boolean
  upgrade?: Partial<GuardianLiveCardDef>
}

/** Official public-v1.47 Guardian sheets from the Contention Games TTS prototype. */
export const GUARDIAN_SHEET_GUIDS = {
  starter: '4da11c',
  starter_upgrades: 'a6e9ad',
  rewards: 'db37c0',
  reward_upgrades: '0b9dcc',
  rares: '1641bf',
  rare_upgrades: 'cdb9a0',
  gems: '9f2743',
} as const

export const GUARDIAN_SOURCE = 'Official Contention Games Downfall Tabletop Simulator save'
export const GUARDIAN_SOURCE_SAVE = 'tmp/downfall-reference/downfall-workshop.json'
export const GUARDIAN_VERIFICATION = 'Every entry was checked against its high-resolution crop in tmp/downfall-reference/manifests/guardian-crops. Upgrade sheets are transparent overlays; upgraded_text reconstructs the visible base plus overlay. Bracketed tokens transcribe printed symbols rather than importing PC-mod terminology.'
export const GUARDIAN_VIGOR_CAP = 4
export const GUARDIAN_STARTING_MODE: GuardianMode = 'attack'
export const GUARDIAN_GEM_RULES = {
  shuffleBetweenActs: true,
  draftRevealCount: 2,
  directGainRevealCount: 1,
  merchantSocketLimit: 2,
} as const

export type GuardianDeck = 'starter' | 'rewards' | 'rares' | 'gems'
export type GuardianRarity = 'starter' | 'reward' | 'ticket' | 'rare' | 'gem'
export type GuardianPrintedType = 'Attack' | 'Skill' | 'Power' | 'Gem Attack' | 'Gem Skill' | 'Gem Power' | '???' | 'Ticket' | 'Gem'
export type GuardianPrintedCost = `${number}` | 'X' | null
export type GuardianIcon = '[damage]' | '[block]' | '[vigor]' | '[energy]' | '[mode-shift]' | '[debuff]' | '[weak]' | '[aoe]' | '[hp]' | '[remove]'

export const GUARDIAN_ICON_LEGEND: Readonly<Record<GuardianIcon, string>> = {
  '[damage]': 'red sword damage symbol',
  '[block]': 'blue shield block symbol',
  '[vigor]': 'orange flame symbol',
  '[energy]': 'blue energy-pip symbol',
  '[mode-shift]': 'pink spiral symbol',
  '[debuff]': 'broken pink heart symbol',
  '[weak]': 'crossed pale-green weapons symbol',
  '[aoe]': 'red burst symbol',
  '[hp]': 'heart symbol',
  '[remove]': 'red crossed/removal symbol',
}

export type GuardianSourceCard = {
  deck: GuardianDeck
  rarity: GuardianRarity
  name: string
  type: GuardianPrintedType
  cost: { base: GuardianPrintedCost; upgraded: GuardianPrintedCost }
  sheet_indices: { base: readonly number[]; upgraded: readonly number[] }
  multiplicity: number
  base_text: string
  upgraded_text: string | null
  /** Kept verbatim from the visual audit. Null means the crop was unambiguous. */
  ocr_uncertainty: string | null
}

export type GuardianVigorReference =
  | 'none'
  | 'gain'
  | 'gain-and-spend'
  | 'spend-attached'
  | 'spent-this-turn'
  | 'spent-zone'
  | 'modifier'

export type GuardianCardFace = {
  cost: GuardianPrintedCost
  /** Exact reconstructed printed effect; bracketed words are source icons. */
  text: string
  /** Executable engine opcode; source text remains separately auditable. */
  effects: readonly Effect[]
  iconCounts: Readonly<Partial<Record<GuardianIcon, number>>>
  /** Modes mentioned by a conditional, variable type, or other printed rule. */
  modeEffects: readonly GuardianMode[]
  vigorReference: GuardianVigorReference
}

export type GuardianCardDef = Omit<GuardianSourceCard, 'cost' | 'base_text' | 'upgraded_text'> & {
  id: string
  base: GuardianCardFace
  upgraded: GuardianCardFace | null
  /** This physical reward card receives a transparent Gem when gained. */
  socket: boolean
  /** The card changes other cards so they can receive Gems. */
  grantsSocket: boolean
}

export const GUARDIAN_SOURCE_CARDS: readonly GuardianSourceCard[] = [
  {"deck":"starter","rarity":"starter","name":"Curl Up","type":"Skill","cost":{"base":"2","upgraded":"2"},"sheet_indices":{"base":[0],"upgraded":[0]},"multiplicity":1,"base_text":"2 [block]. Defense Mode: [vigor].","upgraded_text":"3 [block] to any player. Defense Mode: [vigor].","ocr_uncertainty":null},
  {"deck":"starter","rarity":"starter","name":"Defend","type":"Skill","cost":{"base":"1","upgraded":"1"},"sheet_indices":{"base":[1,2,3,4],"upgraded":[1,2,3,4]},"multiplicity":4,"base_text":"1 [block].","upgraded_text":"2 [block] to any player.","ocr_uncertainty":null},
  {"deck":"starter","rarity":"starter","name":"Strike","type":"Attack","cost":{"base":"1","upgraded":"1"},"sheet_indices":{"base":[5,6,7,8],"upgraded":[5,6,7,8]},"multiplicity":4,"base_text":"1 [damage].","upgraded_text":"2 [damage].","ocr_uncertainty":null},
  {"deck":"starter","rarity":"starter","name":"Twin Slam","type":"Attack","cost":{"base":"2","upgraded":"2"},"sheet_indices":{"base":[9],"upgraded":[9]},"multiplicity":1,"base_text":"2 [damage]. Attack Mode: 1 [damage].","upgraded_text":"2 [damage]. Attack Mode: 3 [damage].","ocr_uncertainty":null},
  {"deck":"rewards","rarity":"reward","name":"Orb Support","type":"Attack","cost":{"base":"2","upgraded":"2"},"sheet_indices":{"base":[0],"upgraded":[0]},"multiplicity":1,"base_text":"Attack Mode: 3 [damage], 1 [block]. Defense Mode: 1 [damage], 3 [block].","upgraded_text":"Attack Mode: 4 [damage], 1 [block]. Defense Mode: 1 [damage], 4 [block].","ocr_uncertainty":null},
  {"deck":"rewards","rarity":"reward","name":"Resilient Plate","type":"Skill","cost":{"base":"2","upgraded":"2"},"sheet_indices":{"base":[1],"upgraded":[1]},"multiplicity":1,"base_text":"3 [block]. Defense Mode: X [block]. X is the number of Powers you have in play.","upgraded_text":"4 [block]. Defense Mode: X [block]. X is the number of Powers you have in play.","ocr_uncertainty":null},
  {"deck":"rewards","rarity":"reward","name":"Overload","type":"Skill","cost":{"base":"1","upgraded":"1"},"sheet_indices":{"base":[2],"upgraded":[2]},"multiplicity":1,"base_text":"Draw 4 cards.","upgraded_text":"Draw 5 cards.","ocr_uncertainty":null},
  {"deck":"rewards","rarity":"reward","name":"Prismatic Barrier","type":"Gem Skill","cost":{"base":"1","upgraded":"1"},"sheet_indices":{"base":[3],"upgraded":[3]},"multiplicity":1,"base_text":"1 [block] to any player. All [damage], [block], [debuff] on this card have [aoe]. Socket.","upgraded_text":"2 [block] to any player. All [damage], [block], [debuff] on this card have [aoe]. Socket.","ocr_uncertainty":"The three icon tokens and burst token were verified visually; semantic aliases are descriptive."},
  {"deck":"rewards","rarity":"reward","name":"Prismatic Spray","type":"Gem Attack","cost":{"base":"1","upgraded":"1"},"sheet_indices":{"base":[4],"upgraded":[4]},"multiplicity":1,"base_text":"[aoe] 1 [damage]. All [damage], [block], [debuff] on this card have [aoe]. Socket.","upgraded_text":"[aoe] 2 [damage]. All [damage], [block], [debuff] on this card have [aoe]. Socket.","ocr_uncertainty":"The three icon tokens were verified visually; semantic aliases are descriptive."},
  {"deck":"rewards","rarity":"reward","name":"Tune Up","type":"Skill","cost":{"base":"2","upgraded":"2"},"sheet_indices":{"base":[5],"upgraded":[5]},"multiplicity":1,"base_text":"2 [block]. Attack Mode: The next Attack you play this turn costs 0.","upgraded_text":"3 [block]. Attack Mode: The next Attack you play this turn costs 0.","ocr_uncertainty":null},
  {"deck":"rewards","rarity":"reward","name":"Stasis Field","type":"Skill","cost":{"base":"3","upgraded":"3"},"sheet_indices":{"base":[6],"upgraded":[6]},"multiplicity":1,"base_text":"1 [block], 1 [block], 1 [block]. Each [block] can target a different player. Exhaust.","upgraded_text":"1 [block], 1 [block], 1 [block], 1 [block]. Each [block] can target a different player. Exhaust.","ocr_uncertainty":null},
  {"deck":"rewards","rarity":"reward","name":"Strike for Strike","type":"Attack","cost":{"base":"1","upgraded":"1"},"sheet_indices":{"base":[7],"upgraded":[7]},"multiplicity":1,"base_text":"1 [damage]. Attack Mode: Gain [block] equal to the damage dealt.","upgraded_text":"2 [damage]. Attack Mode: Gain [block] equal to the damage dealt.","ocr_uncertainty":null},
  {"deck":"rewards","rarity":"reward","name":"Sentry Beam","type":"Attack","cost":{"base":"2","upgraded":"2"},"sheet_indices":{"base":[8],"upgraded":[8]},"multiplicity":1,"base_text":"[aoe] 3 [damage]. Attack Mode: [vigor] [mode-shift].","upgraded_text":"[aoe] 4 [damage]. Attack Mode: [vigor] [mode-shift].","ocr_uncertainty":"Attack Mode consists only of two printed icons."},
  {"deck":"rewards","rarity":"reward","name":"Disrupt","type":"Gem Skill","cost":{"base":"2","upgraded":"2"},"sheet_indices":{"base":[9],"upgraded":[9]},"multiplicity":1,"base_text":"1 [block]. [debuff]. Socket.","upgraded_text":"2 [block]. [debuff]. Socket.","ocr_uncertainty":"Middle line is a broken-heart icon with no printed prose."},
  {"deck":"rewards","rarity":"reward","name":"Charge Core","type":"Skill","cost":{"base":"1","upgraded":"1"},"sheet_indices":{"base":[10,11],"upgraded":[10,11]},"multiplicity":2,"base_text":"[vigor]. Exhaust.","upgraded_text":"[vigor].","ocr_uncertainty":null},
  {"deck":"rewards","rarity":"reward","name":"Crystal Edge","type":"Gem Attack","cost":{"base":"1","upgraded":"1"},"sheet_indices":{"base":[12,13],"upgraded":[12,13]},"multiplicity":2,"base_text":"1 [damage]. Draw 1 card. Socket.","upgraded_text":"2 [damage]. Draw 1 card. Socket.","ocr_uncertainty":null},
  {"deck":"rewards","rarity":"reward","name":"Fierce Bash","type":"Gem Attack","cost":{"base":"3","upgraded":"3"},"sheet_indices":{"base":[14,15],"upgraded":[14,15]},"multiplicity":2,"base_text":"5 [damage]. Socket.","upgraded_text":"7 [damage]. Socket.","ocr_uncertainty":null},
  {"deck":"rewards","rarity":"reward","name":"Orb Slam","type":"Attack","cost":{"base":"1","upgraded":"1"},"sheet_indices":{"base":[16,17],"upgraded":[16,17]},"multiplicity":2,"base_text":"2 [damage]. Defense Mode: 1 [block].","upgraded_text":"3 [damage]. Defense Mode: 1 [block].","ocr_uncertainty":null},
  {"deck":"rewards","rarity":"reward","name":"Hack","type":"Skill","cost":{"base":"1","upgraded":"1"},"sheet_indices":{"base":[18,19],"upgraded":[18,19]},"multiplicity":2,"base_text":"Draw 2 cards. You may Mode Shift.","upgraded_text":"Draw 3 cards. You may Mode Shift.","ocr_uncertainty":null},
  {"deck":"rewards","rarity":"reward","name":"Poly Beam","type":"Attack","cost":{"base":"1","upgraded":"1"},"sheet_indices":{"base":[20,21],"upgraded":[20,21]},"multiplicity":2,"base_text":"2 [damage]. Attack Mode: Gain [energy].","upgraded_text":"3 [damage]. Attack Mode: Gain [energy].","ocr_uncertainty":null},
  {"deck":"rewards","rarity":"reward","name":"Priming Shot","type":"Attack","cost":{"base":"1","upgraded":"1"},"sheet_indices":{"base":[22,23],"upgraded":[22,23]},"multiplicity":2,"base_text":"2 [damage]. Attack Mode: [vigor]. Spend that [vigor] immediately.","upgraded_text":"3 [damage]. Attack Mode: [vigor]. Spend that [vigor] immediately.","ocr_uncertainty":null},
  {"deck":"rewards","rarity":"reward","name":"Gear Up","type":"Skill","cost":{"base":"0","upgraded":"0"},"sheet_indices":{"base":[24,25],"upgraded":[24,25]},"multiplicity":2,"base_text":"1 [block]. You may Mode Shift.","upgraded_text":"2 [block]. You may Mode Shift.","ocr_uncertainty":null},
  {"deck":"rewards","rarity":"reward","name":"Spheric Shield","type":"Skill","cost":{"base":"1","upgraded":"1"},"sheet_indices":{"base":[26,27],"upgraded":[26,27]},"multiplicity":2,"base_text":"1 [block]. Defense Mode: 1 [block] to any player.","upgraded_text":"2 [block]. Defense Mode: 1 [block] to any player.","ocr_uncertainty":null},
  {"deck":"rewards","rarity":"reward","name":"Suspension","type":"Gem Skill","cost":{"base":"1","upgraded":"1"},"sheet_indices":{"base":[28,29],"upgraded":[28,29]},"multiplicity":2,"base_text":"1 [block]. 1 [block] if you have another Gem in hand. Socket.","upgraded_text":"2 [block]. 1 [block] if you have another Gem in hand. Socket.","ocr_uncertainty":null},
  {"deck":"rewards","rarity":"reward","name":"Fortify","type":"Skill","cost":{"base":"1","upgraded":"1"},"sheet_indices":{"base":[30,31],"upgraded":[30,31]},"multiplicity":2,"base_text":"2 [block]. Attack Mode: Draw 2 cards.","upgraded_text":"3 [block]. Attack Mode: Draw 2 cards.","ocr_uncertainty":null},
  {"deck":"rewards","rarity":"reward","name":"Walker Claw","type":"Gem Attack","cost":{"base":"2","upgraded":"2"},"sheet_indices":{"base":[32,33],"upgraded":[32,33]},"multiplicity":2,"base_text":"1 [damage], 1 [damage]. Socket.","upgraded_text":"1 [damage], 1 [damage], 1 [damage]. Socket.","ocr_uncertainty":null},
  {"deck":"rewards","rarity":"reward","name":"Roll Attack","type":"Attack","cost":{"base":"1","upgraded":"1"},"sheet_indices":{"base":[34,35],"upgraded":[34,35]},"multiplicity":2,"base_text":"X [damage]. X is equal to your [block].","upgraded_text":"[aoe] X [damage]. X is equal to your [block].","ocr_uncertainty":null},
  {"deck":"rewards","rarity":"ticket","name":"Golden Ticket","type":"Ticket","cost":{"base":null,"upgraded":null},"sheet_indices":{"base":[36,37],"upgraded":[36,37]},"multiplicity":2,"base_text":"Golden Ticket can't be added to your deck. When you reveal Golden Ticket, reveal a card from your rare deck.","upgraded_text":null,"ocr_uncertainty":"The corresponding upgrade-sheet cells are Slay the Spire card backs, not upgraded Golden Tickets."},
  {"deck":"rewards","rarity":"reward","name":"Orbwalk","type":"Power","cost":{"base":"2","upgraded":"1"},"sheet_indices":{"base":[38],"upgraded":[38]},"multiplicity":1,"base_text":"Attack Mode: Your [vigor] give +2 damage instead of +1.","upgraded_text":"Attack Mode: Your [vigor] give +2 damage instead of +1.","ocr_uncertainty":null},
  {"deck":"rewards","rarity":"reward","name":"Guardian Whirl","type":"???","cost":{"base":"X","upgraded":"X"},"sheet_indices":{"base":[39],"upgraded":[39]},"multiplicity":1,"base_text":"Attack Mode: [aoe] X [damage]. This is an Attack. Defense Mode: X [block] to any player. This is a Skill.","upgraded_text":"Attack Mode: [aoe] X+1 [damage]. This is an Attack. Defense Mode: X+1 [block] to any player. This is a Skill.","ocr_uncertainty":"Printed type plaque is literally '???'."},
  {"deck":"rewards","rarity":"reward","name":"Vent Steam","type":"Skill","cost":{"base":"1","upgraded":"1"},"sheet_indices":{"base":[40],"upgraded":[40]},"multiplicity":1,"base_text":"Attack Mode: [debuff]. Defense Mode: [weak].","upgraded_text":"Attack Mode: [aoe] [debuff]. Defense Mode: [aoe] [weak].","ocr_uncertainty":"Effects are icon-only."},
  {"deck":"rewards","rarity":"reward","name":"Turbocharge","type":"Power","cost":{"base":"2","upgraded":"2"},"sheet_indices":{"base":[41],"upgraded":[41]},"multiplicity":1,"base_text":"End of turn: If you are in Attack Mode, [vigor]. Otherwise, [energy]. Exhaust this card.","upgraded_text":"End of turn: If you are in Attack Mode, [vigor]. Otherwise, [energy]. Exhaust this card.","ocr_uncertainty":null},
  {"deck":"rewards","rarity":"reward","name":"Speed Boost","type":"Attack","cost":{"base":"0","upgraded":"0"},"sheet_indices":{"base":[42],"upgraded":[42]},"multiplicity":1,"base_text":"Retain. 1 [damage]. You may Mode Shift.","upgraded_text":"Retain. 2 [damage]. You may Mode Shift.","ocr_uncertainty":null},
  {"deck":"rewards","rarity":"reward","name":"Charge Up","type":"Power","cost":{"base":"2","upgraded":"2"},"sheet_indices":{"base":[43],"upgraded":[43]},"multiplicity":1,"base_text":"Start of turn: [vigor] [vigor]. Discard this card.","upgraded_text":"Start of turn: [vigor] [vigor] [vigor]. Discard this card.","ocr_uncertainty":null},
  {"deck":"rewards","rarity":"reward","name":"Incinerate","type":"Attack","cost":{"base":"1","upgraded":"1"},"sheet_indices":{"base":[44],"upgraded":[44]},"multiplicity":1,"base_text":"1 [damage], 1 [damage]. Attack Mode: Draw 2 cards. Exhaust.","upgraded_text":"1 [damage], 1 [damage]. Attack Mode: Draw 4 cards. Exhaust.","ocr_uncertainty":null},
  {"deck":"rewards","rarity":"reward","name":"Crystallize","type":"Gem Power","cost":{"base":"1","upgraded":"0"},"sheet_indices":{"base":[45],"upgraded":[45]},"multiplicity":1,"base_text":"Your starter Strikes gain: Socket.","upgraded_text":"Your starter Strikes gain: Socket.","ocr_uncertainty":null},
  {"deck":"rewards","rarity":"reward","name":"Focus Beam","type":"Attack","cost":{"base":"1","upgraded":"1"},"sheet_indices":{"base":[46],"upgraded":[46]},"multiplicity":1,"base_text":"2 [damage]. If your [block] is 3 or more, [vigor].","upgraded_text":"3 [damage]. If your [block] is 3 or more, [vigor].","ocr_uncertainty":null},
  {"deck":"rewards","rarity":"reward","name":"Gem Cannon","type":"Attack","cost":{"base":"1","upgraded":"1"},"sheet_indices":{"base":[47],"upgraded":[47]},"multiplicity":1,"base_text":"2 [damage]. The next Gem card you play this turn costs 0.","upgraded_text":"2 [damage]. The next 2 Gem cards you play this turn cost 0.","ocr_uncertainty":null},
  {"deck":"rewards","rarity":"reward","name":"Harden","type":"Gem Skill","cost":{"base":"2","upgraded":"2"},"sheet_indices":{"base":[48],"upgraded":[48]},"multiplicity":1,"base_text":"3 [block] to any player. Socket.","upgraded_text":"4 [block] to any player. Socket.","ocr_uncertainty":null},
  {"deck":"rewards","rarity":"reward","name":"Multi Beam","type":"Gem Attack","cost":{"base":"X","upgraded":"X"},"sheet_indices":{"base":[49],"upgraded":[49]},"multiplicity":1,"base_text":"Deal 1 [damage] X times. X can't be 0. Socket.","upgraded_text":"Deal 1 [damage] X+1 times. X can't be 0. Socket.","ocr_uncertainty":null},
  {"deck":"rewards","rarity":"reward","name":"Stasis Beam","type":"Attack","cost":{"base":"1","upgraded":"1"},"sheet_indices":{"base":[50],"upgraded":[50]},"multiplicity":1,"base_text":"2 [damage]. +1 damage for each Power you have in play.","upgraded_text":"2 [damage]. +2 damage for each Power you have in play.","ocr_uncertainty":null},
  {"deck":"rewards","rarity":"reward","name":"Power Beam","type":"Attack","cost":{"base":"2","upgraded":"2"},"sheet_indices":{"base":[51],"upgraded":[51]},"multiplicity":1,"base_text":"3 [damage]. Defense Mode: Play a Power in your hand or discard pile for 0 Energy.","upgraded_text":"4 [damage]. Defense Mode: Play a Power in your hand or discard pile for 0 Energy.","ocr_uncertainty":null},
  {"deck":"rewards","rarity":"reward","name":"Laser Turret","type":"Power","cost":{"base":"1","upgraded":"1"},"sheet_indices":{"base":[52],"upgraded":[52]},"multiplicity":1,"base_text":"End of turn: Deal X damage. X is how many Powers you have in play.","upgraded_text":"End of turn: Deal X damage to any row. X is how many Powers you have in play.","ocr_uncertainty":null},
  {"deck":"rewards","rarity":"reward","name":"Future Plans","type":"Power","cost":{"base":"1","upgraded":"0"},"sheet_indices":{"base":[53],"upgraded":[53]},"multiplicity":1,"base_text":"Your cards with Attack Mode effects have Retain.","upgraded_text":"Your cards with Attack Mode effects have Retain.","ocr_uncertainty":null},
  {"deck":"rewards","rarity":"reward","name":"Preprogram","type":"Skill","cost":{"base":"1","upgraded":"1"},"sheet_indices":{"base":[54],"upgraded":[54]},"multiplicity":1,"base_text":"Draw 2 cards. [vigor] if you have spent any [vigor] this turn.","upgraded_text":"Draw 3 cards. [vigor] if you have spent any [vigor] this turn.","ocr_uncertainty":null},
  {"deck":"rewards","rarity":"reward","name":"Brilliant Scales","type":"Power","cost":{"base":"1","upgraded":"0"},"sheet_indices":{"base":[55],"upgraded":[55]},"multiplicity":1,"base_text":"Whenever you play a Gem, 1 [block].","upgraded_text":"Whenever you play a Gem, 1 [block].","ocr_uncertainty":null},
  {"deck":"rewards","rarity":"reward","name":"Repulsor","type":"Power","cost":{"base":"1","upgraded":"0"},"sheet_indices":{"base":[56],"upgraded":[56]},"multiplicity":1,"base_text":"When played, [mode-shift]. Start of turn: Gain [energy].","upgraded_text":"When played, [mode-shift]. Start of turn: Gain [energy].","ocr_uncertainty":null},
  {"deck":"rewards","rarity":"reward","name":"Ancient Construct","type":"Power","cost":{"base":"1","upgraded":"0"},"sheet_indices":{"base":[57],"upgraded":[57]},"multiplicity":1,"base_text":"End of turn: If your [block] is 4 or more, [vigor].","upgraded_text":"End of turn: If your [block] is 4 or more, [vigor].","ocr_uncertainty":null},
  {"deck":"rewards","rarity":"reward","name":"Shield Charger","type":"Power","cost":{"base":"1","upgraded":"1"},"sheet_indices":{"base":[58],"upgraded":[58]},"multiplicity":1,"base_text":"Start of turn: Keep up to 2 of your leftover [block] from last turn.","upgraded_text":"Start of turn: Keep up to 3 of your leftover [block] from last turn.","ocr_uncertainty":null},
  {"deck":"rewards","rarity":"reward","name":"Time Sifter","type":"Skill","cost":{"base":"0","upgraded":"0"},"sheet_indices":{"base":[59],"upgraded":[59]},"multiplicity":1,"base_text":"Lose all [vigor] in the \"Spent\" zone, then gain that much [vigor].","upgraded_text":"Retain. Lose all [vigor] in the \"Spent\" zone, then gain that much [vigor].","ocr_uncertainty":"The source prints the same orange-flame glyph on both sides of the conversion sentence."},
  {"deck":"rewards","rarity":"reward","name":"Scale Slash","type":"Attack","cost":{"base":"1","upgraded":"1"},"sheet_indices":{"base":[60],"upgraded":[60]},"multiplicity":1,"base_text":"1 [damage], 1 [damage]. Attack Mode: Put this card on top of your draw pile.","upgraded_text":"1 [damage], 1 [damage], 1 [damage]. Attack Mode: Put this card on top of your draw pile.","ocr_uncertainty":null},
  {"deck":"rewards","rarity":"reward","name":"Blitz","type":"Skill","cost":{"base":"0","upgraded":"0"},"sheet_indices":{"base":[61],"upgraded":[61]},"multiplicity":1,"base_text":"Draw 1 card. The next card you play this turn costs 1. Exhaust.","upgraded_text":"Draw 2 cards. The next card you play this turn costs 1. Exhaust.","ocr_uncertainty":null},
  {"deck":"rares","rarity":"rare","name":"Bauble Burst","type":"Gem Attack","cost":{"base":"2","upgraded":"2"},"sheet_indices":{"base":[0],"upgraded":[0]},"multiplicity":1,"base_text":"2 [damage]. Gain the attached Gem's effect an additional time. Socket.","upgraded_text":"4 [damage]. Gain the attached Gem's effect an additional time. Socket.","ocr_uncertainty":null},
  {"deck":"rares","rarity":"rare","name":"Body Crash","type":"Attack","cost":{"base":"1","upgraded":"0"},"sheet_indices":{"base":[1],"upgraded":[1]},"multiplicity":1,"base_text":"Pay X [block]. X × X [damage].","upgraded_text":"Pay X [block]. X × X [damage].","ocr_uncertainty":null},
  {"deck":"rares","rarity":"rare","name":"Spiker Protocol","type":"Power","cost":{"base":"2","upgraded":"2"},"sheet_indices":{"base":[2],"upgraded":[2]},"multiplicity":1,"base_text":"End of turn: Deal 3 damage to all enemies that intend to attack you.","upgraded_text":"End of turn: Deal 4 damage to all enemies that intend to attack you.","ocr_uncertainty":null},
  {"deck":"rares","rarity":"rare","name":"Evade","type":"Skill","cost":{"base":"1","upgraded":"1"},"sheet_indices":{"base":[3],"upgraded":[3]},"multiplicity":1,"base_text":"2 [block]. Defense Mode: Double your [block]. Exhaust.","upgraded_text":"3 [block]. Defense Mode: Double your [block]. Exhaust.","ocr_uncertainty":null},
  {"deck":"rares","rarity":"rare","name":"Giga Beam","type":"Attack","cost":{"base":"2","upgraded":"2"},"sheet_indices":{"base":[4],"upgraded":[4]},"multiplicity":1,"base_text":"Attack Mode: [aoe] 5 [damage]. You can't Mode Shift this combat. (Place a black cube over Defense Mode.)","upgraded_text":"Attack Mode: [aoe] 7 [damage]. You can't Mode Shift this combat. (Place a black cube over Defense Mode.)","ocr_uncertainty":null},
  {"deck":"rares","rarity":"rare","name":"Revenge Protocol","type":"Power","cost":{"base":"2","upgraded":"1"},"sheet_indices":{"base":[5],"upgraded":[5]},"multiplicity":1,"base_text":"Once per turn: If you're in Attack Mode, play an Attack for 0 Energy.","upgraded_text":"Once per turn: If you're in Attack Mode, play an Attack for 0 Energy.","ocr_uncertainty":null},
  {"deck":"rares","rarity":"rare","name":"Armored Protocol","type":"Power","cost":{"base":"3","upgraded":"3"},"sheet_indices":{"base":[6],"upgraded":[6]},"multiplicity":1,"base_text":"The next time you would lose HP, prevent it, gain [vigor] [vigor], and Exhaust this card.","upgraded_text":"The next time you would lose HP, prevent it, gain [vigor] [vigor] [vigor], and Exhaust this card.","ocr_uncertainty":null},
  {"deck":"rares","rarity":"rare","name":"Gem Finder","type":"Power","cost":{"base":"1","upgraded":"1"},"sheet_indices":{"base":[7],"upgraded":[7]},"multiplicity":1,"base_text":"Once per turn: Scry 3. Draw any Gems you reveal.","upgraded_text":"Once per turn: Scry 4. Draw any Gems you reveal.","ocr_uncertainty":null},
  {"deck":"rares","rarity":"rare","name":"Exploit Gems","type":"Gem Skill","cost":{"base":"0","upgraded":"0"},"sheet_indices":{"base":[8],"upgraded":[8]},"multiplicity":1,"base_text":"Gain [energy]. Exhaust. Socket.","upgraded_text":"Gain [energy] [energy]. Exhaust. Socket.","ocr_uncertainty":null},
  {"deck":"rares","rarity":"rare","name":"Stasis Engine","type":"Power","cost":{"base":"3","upgraded":"2"},"sheet_indices":{"base":[9],"upgraded":[9]},"multiplicity":1,"base_text":"End of turn: You may Retain a card. It costs 0 next turn.","upgraded_text":"End of turn: You may Retain a card. It costs 0 next turn.","ocr_uncertainty":null},
  {"deck":"rares","rarity":"rare","name":"Construction Form","type":"Power","cost":{"base":"3","upgraded":"2"},"sheet_indices":{"base":[10],"upgraded":[10]},"multiplicity":1,"base_text":"Ethereal. Your other Powers cost 0. Whenever you play another Power, 1 [block].","upgraded_text":"Ethereal. Your other Powers cost 0. Whenever you play another Power, 1 [block].","ocr_uncertainty":null},
  {"deck":"rares","rarity":"rare","name":"Floating Orbs","type":"Gem Power","cost":{"base":"2","upgraded":"1"},"sheet_indices":{"base":[11],"upgraded":[11]},"multiplicity":1,"base_text":"Once per turn: Socket.","upgraded_text":"Once per turn: Socket.","ocr_uncertainty":"There is intentionally no printed effect between the colon and the Socket box on either crop."},
  {"deck":"rares","rarity":"rare","name":"Time Capacitor","type":"Skill","cost":{"base":"1","upgraded":"1"},"sheet_indices":{"base":[12],"upgraded":[12]},"multiplicity":1,"base_text":"Gain [vigor] equal to the number of Powers you have in play. Exhaust.","upgraded_text":"Gain [vigor] equal to the number of Powers you have in play.","ocr_uncertainty":null},
  {"deck":"rares","rarity":"rare","name":"DESTROY","type":"Attack","cost":{"base":"3","upgraded":"3"},"sheet_indices":{"base":[13],"upgraded":[13]},"multiplicity":1,"base_text":"Retain. 4 [damage]. +4 damage for each Gem card in your hand.","upgraded_text":"Retain. 5 [damage]. +5 damage for each Gem card in your hand.","ocr_uncertainty":null},
  {"deck":"rares","rarity":"rare","name":"Refracted Beam","type":"???","cost":{"base":"0","upgraded":"0"},"sheet_indices":{"base":[14],"upgraded":[14]},"multiplicity":1,"base_text":"Attack Mode: [aoe] 0 [damage], 0 [damage], 0 [damage]. This is an Attack. Defense Mode: [aoe] 0 [block], 0 [block], 0 [block]. This is a Skill.","upgraded_text":"Attack Mode: [aoe] 0 [damage], 0 [damage], 0 [damage], 0 [damage]. This is an Attack. Defense Mode: [aoe] 0 [block], 0 [block], 0 [block], 0 [block]. This is a Skill.","ocr_uncertainty":"Printed type plaque is literally '???'."},
  {"deck":"rares","rarity":"rare","name":"Forecasting","type":"Power","cost":{"base":"2","upgraded":"1"},"sheet_indices":{"base":[15],"upgraded":[15]},"multiplicity":1,"base_text":"End of turn: If you're in Defense Mode, draw 2 cards and Retain them.","upgraded_text":"End of turn: If you're in Defense Mode, draw 2 cards and Retain them.","ocr_uncertainty":null},
  {"deck":"gems","rarity":"gem","name":"Amethyst","type":"Gem","cost":{"base":null,"upgraded":null},"sheet_indices":{"base":[0,1],"upgraded":[]},"multiplicity":2,"base_text":"You may Mode Shift.","upgraded_text":null,"ocr_uncertainty":null},
  {"deck":"gems","rarity":"gem","name":"Emerald","type":"Gem","cost":{"base":null,"upgraded":null},"sheet_indices":{"base":[2,3],"upgraded":[]},"multiplicity":2,"base_text":"[weak].","upgraded_text":null,"ocr_uncertainty":"Effect is a crossed pale-green weapons icon only."},
  {"deck":"gems","rarity":"gem","name":"Garnet","type":"Gem","cost":{"base":null,"upgraded":null},"sheet_indices":{"base":[4,5],"upgraded":[]},"multiplicity":2,"base_text":"[debuff] [mode-shift].","upgraded_text":null,"ocr_uncertainty":"Effect consists of two icons only; aliases are descriptive."},
  {"deck":"gems","rarity":"gem","name":"Opal","type":"Gem","cost":{"base":null,"upgraded":null},"sheet_indices":{"base":[6,7],"upgraded":[]},"multiplicity":2,"base_text":"Defense Mode: Draw 2 cards.","upgraded_text":null,"ocr_uncertainty":null},
  {"deck":"gems","rarity":"gem","name":"Ruby","type":"Gem","cost":{"base":null,"upgraded":null},"sheet_indices":{"base":[8,9],"upgraded":[]},"multiplicity":2,"base_text":"1 [damage].","upgraded_text":null,"ocr_uncertainty":null},
  {"deck":"gems","rarity":"gem","name":"Sapphire","type":"Gem","cost":{"base":null,"upgraded":null},"sheet_indices":{"base":[10,11],"upgraded":[]},"multiplicity":2,"base_text":"1 [block].","upgraded_text":null,"ocr_uncertainty":null},
  {"deck":"gems","rarity":"gem","name":"Tourmaline","type":"Gem","cost":{"base":null,"upgraded":null},"sheet_indices":{"base":[12,13],"upgraded":[]},"multiplicity":2,"base_text":"Spend that [vigor] immediately.","upgraded_text":null,"ocr_uncertainty":null},
  {"deck":"gems","rarity":"gem","name":"Amber","type":"Gem","cost":{"base":null,"upgraded":null},"sheet_indices":{"base":[14,15],"upgraded":[]},"multiplicity":2,"base_text":"Attack Mode: Draw 2 cards.","upgraded_text":null,"ocr_uncertainty":null},
  {"deck":"gems","rarity":"gem","name":"Aquamarine","type":"Gem","cost":{"base":null,"upgraded":null},"sheet_indices":{"base":[16],"upgraded":[]},"multiplicity":1,"base_text":"You can't play additional cards this turn.","upgraded_text":null,"ocr_uncertainty":null},
  {"deck":"gems","rarity":"gem","name":"Bismuth","type":"Gem","cost":{"base":null,"upgraded":null},"sheet_indices":{"base":[17],"upgraded":[]},"multiplicity":1,"base_text":"Gain 1 [block] for each other Gem in your hand.","upgraded_text":null,"ocr_uncertainty":null},
  {"deck":"gems","rarity":"gem","name":"Morganite","type":"Gem","cost":{"base":null,"upgraded":null},"sheet_indices":{"base":[18,19],"upgraded":[]},"multiplicity":2,"base_text":"Gain [energy] if you haven't played any other cards this turn.","upgraded_text":null,"ocr_uncertainty":null},
  {"deck":"gems","rarity":"gem","name":"Jasper","type":"Gem","cost":{"base":null,"upgraded":null},"sheet_indices":{"base":[20],"upgraded":[]},"multiplicity":1,"base_text":"Exhaust up to 3 cards in your hand.","upgraded_text":null,"ocr_uncertainty":null},
  {"deck":"gems","rarity":"gem","name":"Onyx","type":"Gem","cost":{"base":null,"upgraded":null},"sheet_indices":{"base":[21],"upgraded":[]},"multiplicity":1,"base_text":"Remove [debuff] [weak] from any player. Retain.","upgraded_text":null,"ocr_uncertainty":"Both removable conditions are printed as icons."},
  {"deck":"gems","rarity":"gem","name":"Pearl","type":"Gem","cost":{"base":null,"upgraded":null},"sheet_indices":{"base":[22],"upgraded":[]},"multiplicity":1,"base_text":"The next Power you play this turn costs 0 Energy.","upgraded_text":null,"ocr_uncertainty":null},
  {"deck":"gems","rarity":"gem","name":"Peridot","type":"Gem","cost":{"base":null,"upgraded":null},"sheet_indices":{"base":[23],"upgraded":[]},"multiplicity":1,"base_text":"2 [damage] if you have another Gem in your hand.","upgraded_text":null,"ocr_uncertainty":null},
] as const

const ICONS = Object.keys(GUARDIAN_ICON_LEGEND) as GuardianIcon[]

function cardId(name: string): string {
  return `guardian_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}`
}

function iconCounts(text: string): Readonly<Partial<Record<GuardianIcon, number>>> {
  return Object.fromEntries(ICONS.flatMap((icon) => {
    const count = text.split(icon).length - 1
    return count ? [[icon, count]] : []
  }))
}

function modeEffects(text: string): readonly GuardianMode[] {
  return [
    ...(text.includes('Attack Mode') ? ['attack' as const] : []),
    ...(text.includes('Defense Mode') ? ['defense' as const] : []),
  ]
}

const VIGOR_REFERENCE_BY_NAME: Readonly<Record<string, Exclude<GuardianVigorReference, 'none'>>> = {
  'Curl Up': 'gain',
  'Sentry Beam': 'gain',
  'Charge Core': 'gain',
  'Priming Shot': 'gain-and-spend',
  Orbwalk: 'modifier',
  Turbocharge: 'gain',
  'Charge Up': 'gain',
  'Focus Beam': 'gain',
  Preprogram: 'spent-this-turn',
  'Ancient Construct': 'gain',
  'Time Sifter': 'spent-zone',
  'Armored Protocol': 'gain',
  'Time Capacitor': 'gain',
  Tourmaline: 'spend-attached',
}

function face(card: GuardianSourceCard, upgraded: boolean): GuardianCardFace | null {
  const text = upgraded ? card.upgraded_text : card.base_text
  if (text === null) return null
  return {
    cost: upgraded ? card.cost.upgraded : card.cost.base,
    text,
    effects: card.type === 'Gem'
      ? [{ kind: 'sequence', effects: [], guardianGemId: cardId(card.name) }]
      : [{ kind: 'sequence', effects: [], guardianAction: 'card' }],
    iconCounts: iconCounts(text),
    modeEffects: modeEffects(text),
    vigorReference: VIGOR_REFERENCE_BY_NAME[card.name] ?? 'none',
  }
}

export const GUARDIAN_CARDS: readonly GuardianCardDef[] = GUARDIAN_SOURCE_CARDS.map((card) => ({
  ...card,
  id: cardId(card.name),
  base: face(card, false)!,
  upgraded: face(card, true),
  socket: card.type.startsWith('Gem '),
  grantsSocket: card.name === 'Crystallize',
}))

export const GUARDIAN_CARDS_BY_ID: Readonly<Record<string, GuardianCardDef>> = Object.fromEntries(
  GUARDIAN_CARDS.map((card) => [card.id, card]),
)

function engineType(type: GuardianPrintedType): GuardianLiveCardDef['type'] {
  if (type === 'Skill' || type === 'Gem Skill') return 'skill'
  if (type === 'Power' || type === 'Gem Power') return 'power'
  return 'attack'
}

function engineRarity(card: GuardianSourceCard): GuardianLiveCardDef['rarity'] {
  if (card.rarity === 'starter') return 'starter'
  if (card.rarity === 'rare') return 'rare'
  if (card.rarity === 'reward') return card.multiplicity === 2 ? 'common' : 'uncommon'
  return 'special'
}

function engineCost(cost: GuardianPrintedCost): GuardianLiveCardDef['cost'] {
  return cost === 'X' ? 'X' : Number(cost ?? 0)
}

function engineFace(card: GuardianSourceCard, upgraded: boolean): Partial<GuardianLiveCardDef> {
  const text = upgraded ? card.upgraded_text : card.base_text
  const cost = upgraded ? card.cost.upgraded : card.cost.base
  return {
    cost: engineCost(cost),
    effects: card.type === 'Gem'
      ? [{ kind: 'sequence', effects: [], guardianGemId: cardId(card.name) }]
      : [{ kind: 'sequence', effects: [], guardianAction: 'card' }],
    exhaust: text?.includes('Exhaust') === true,
    ethereal: text?.includes('Ethereal') === true,
    retain: text?.includes('Retain') === true,
    minimumX: card.name === 'Multi Beam' ? 1 : undefined,
    guardian: {
      printedType: card.type,
      socket: card.type.startsWith('Gem '),
      grantsSocket: card.name === 'Crystallize',
      sourceText: text ?? card.base_text,
    },
  }
}

function powerBehavior(name: string): Partial<GuardianLiveCardDef> {
  switch (name) {
    case 'Turbocharge': case 'Laser Turret': case 'Ancient Construct': case 'Spiker Protocol': case 'Forecasting': case 'Stasis Engine':
      return { trigger: { kind: 'endOfTurn' } }
    case 'Charge Up':
      return { trigger: { kind: 'startOfTurn' } }
    case 'Repulsor':
      return { trigger: { kind: 'startOfTurn' }, resolvesOnPlay: true }
    case 'Brilliant Scales':
      return { persistent: true }
    case 'Gem Finder': case 'Floating Orbs': case 'Revenge Protocol':
      return { activeAbility: true, oncePerTurn: true }
    case 'Crystallize':
      return { persistent: true, resolvesOnPlay: true }
    case 'Construction Form':
      return { persistent: true, trigger: { kind: 'onPlayCard', cardType: 'power' } }
    case 'Orbwalk': case 'Future Plans': case 'Shield Charger': case 'Armored Protocol':
      return { persistent: true }
    default: return {}
  }
}

/** Live engine definitions. Gems and the Golden Ticket are data-bearing, unplayable overlays. */
export const GUARDIAN_CARD_DEFS: Readonly<Record<string, GuardianLiveCardDef>> = Object.fromEntries(
  GUARDIAN_SOURCE_CARDS.map((source) => {
    const id = cardId(source.name)
    const base = engineFace(source, false)
    const upgraded = source.upgraded_text === null ? undefined : engineFace(source, true)
    const def: GuardianLiveCardDef = {
      id,
      name: source.name,
      owner: 'guardian',
      type: engineType(source.type),
      rarity: engineRarity(source),
      cost: base.cost!,
      effects: base.effects!,
      exhaust: base.exhaust,
      ethereal: base.ethereal,
      retain: base.retain,
      minimumX: base.minimumX,
      guardianVariableType: source.type === '???',
      guardian: base.guardian,
      unplayable: source.type === 'Gem' || source.type === 'Ticket',
      ...powerBehavior(source.name),
      ...(upgraded ? { upgrade: upgraded } : {}),
    }
    return [id, def]
  }),
)

export type GuardianPhysicalCard = {
  id: string
  defId: string
  deck: GuardianDeck
  sheetGuid: string
  sheetIndex: number
  upgradeSheetGuid: string | null
  upgradeSheetIndex: number | null
  upgradeAvailable: boolean
}

function sheetGuid(deck: GuardianDeck, upgraded: boolean): string | null {
  if (deck === 'gems') return upgraded ? null : GUARDIAN_SHEET_GUIDS.gems
  if (deck === 'starter') return upgraded ? GUARDIAN_SHEET_GUIDS.starter_upgrades : GUARDIAN_SHEET_GUIDS.starter
  if (deck === 'rewards') return upgraded ? GUARDIAN_SHEET_GUIDS.reward_upgrades : GUARDIAN_SHEET_GUIDS.rewards
  return upgraded ? GUARDIAN_SHEET_GUIDS.rare_upgrades : GUARDIAN_SHEET_GUIDS.rares
}

export const GUARDIAN_PHYSICAL_CARDS: readonly GuardianPhysicalCard[] = GUARDIAN_CARDS.flatMap((card) =>
  card.sheet_indices.base.map((sheetIndex, copy) => ({
    id: `${card.id}_${copy + 1}`,
    defId: card.id,
    deck: card.deck,
    sheetGuid: sheetGuid(card.deck, false)!,
    sheetIndex,
    upgradeSheetGuid: sheetGuid(card.deck, true),
    upgradeSheetIndex: card.sheet_indices.upgraded[copy] ?? null,
    upgradeAvailable: card.upgraded !== null,
  })),
)

/** Def ids in physical deck order, including one entry per printed copy. */
export const GUARDIAN_PHYSICAL_DECKS: Readonly<Record<GuardianDeck, readonly string[]>> = {
  starter: GUARDIAN_PHYSICAL_CARDS.filter((card) => card.deck === 'starter').map((card) => card.defId),
  rewards: GUARDIAN_PHYSICAL_CARDS.filter((card) => card.deck === 'rewards').map((card) => card.defId),
  rares: GUARDIAN_PHYSICAL_CARDS.filter((card) => card.deck === 'rares').map((card) => card.defId),
  gems: GUARDIAN_PHYSICAL_CARDS.filter((card) => card.deck === 'gems').map((card) => card.defId),
}

export type GuardianResolvedCardType = 'attack' | 'skill' | 'power' | 'ticket' | 'gem' | null

/** `???` cards are neither Attacks nor Skills outside combat. */
export function resolveGuardianCardType(type: GuardianPrintedType, mode?: GuardianMode): GuardianResolvedCardType {
  if (type === '???') return mode === 'attack' ? 'attack' : mode === 'defense' ? 'skill' : null
  if (type === 'Attack' || type === 'Gem Attack') return 'attack'
  if (type === 'Skill' || type === 'Gem Skill') return 'skill'
  if (type === 'Power' || type === 'Gem Power') return 'power'
  return type === 'Ticket' ? 'ticket' : 'gem'
}

export type GuardianVigorState = { available: number; spent: number }

function assertVigorAmount(amount: number): void {
  if (!Number.isSafeInteger(amount) || amount < 0) throw new RangeError('Vigor amount must be a non-negative integer')
}

/** Gain is capped by all four physical tokens, including tokens in the Spent zone. */
export function gainGuardianVigor(state: GuardianVigorState, amount: number): GuardianVigorState {
  assertVigorAmount(amount)
  const room = Math.max(0, GUARDIAN_VIGOR_CAP - state.available - state.spent)
  return { ...state, available: state.available + Math.min(amount, room) }
}

/** Spending is optional player timing; callers invoke this whenever a card could be played. */
export function spendGuardianVigor(state: GuardianVigorState, amount: number): GuardianVigorState {
  assertVigorAmount(amount)
  if (amount > state.available) throw new RangeError('Cannot spend more Vigor than is available')
  return { available: state.available - amount, spent: state.spent + amount }
}

export function clearSpentGuardianVigor(state: GuardianVigorState): GuardianVigorState {
  return { available: state.available, spent: 0 }
}

/** Time Sifter moves every spent token back without creating a fifth token. */
export function reclaimSpentGuardianVigor(state: GuardianVigorState): GuardianVigorState {
  return { available: Math.min(GUARDIAN_VIGOR_CAP, state.available + state.spent), spent: 0 }
}

export function shiftGuardianMode(mode: GuardianMode): GuardianMode {
  return mode === 'attack' ? 'defense' : 'attack'
}

export type GuardianModeBonuses = { damagePerHit: number; blockPerIcon: number }

/**
 * Apply the result once to every printed hit or Block icon. Gem Attacks/Skills
 * qualify; Gem Powers do not. Orbwalk changes only Attack Mode's multiplier.
 */
export function guardianModeBonuses(
  mode: GuardianMode,
  spentVigor: number,
  printedType: GuardianPrintedType,
  orbwalk = false,
): GuardianModeBonuses {
  assertVigorAmount(spentVigor)
  const type = resolveGuardianCardType(printedType, mode)
  const qualifies = type === 'attack' || type === 'skill'
  return {
    damagePerHit: qualifies && mode === 'attack' ? spentVigor * (orbwalk ? 2 : 1) : 0,
    blockPerIcon: qualifies && mode === 'defense' ? spentVigor : 0,
  }
}

export function guardianDamagePerHitBonus(
  mode: GuardianMode,
  spentVigor: number,
  printedType: GuardianPrintedType,
  orbwalk = false,
): number {
  return guardianModeBonuses(mode, spentVigor, printedType, orbwalk).damagePerHit
}

export function guardianBlockPerIconBonus(
  mode: GuardianMode,
  spentVigor: number,
  printedType: GuardianPrintedType,
): number {
  return guardianModeBonuses(mode, spentVigor, printedType).blockPerIcon
}

export type GuardianSocketInstance = {
  uid: string
  defId: string
  upgraded: boolean
  attachedGemId?: string
}

export function attachGuardianGem<T extends GuardianSocketInstance>(
  instance: T,
  definition: Pick<GuardianCardDef, 'socket'>,
  gemId: string,
): T & { attachedGemId: string } {
  if (!definition.socket) throw new Error('Only a card with Socket can receive a Gem')
  if (instance.attachedGemId) throw new Error('This card already has an attached Gem')
  return { ...instance, attachedGemId: gemId }
}

export type GuardianGemReveal<T> = { revealed: readonly T[]; deck: readonly T[] }

/** The first element is the top of the face-down Gem deck. */
export function revealGuardianGems<T>(deck: readonly T[], count: number): GuardianGemReveal<T> {
  if (!Number.isSafeInteger(count) || count < 0) throw new RangeError('Reveal count must be a non-negative integer')
  return { revealed: deck.slice(0, count), deck: deck.slice(count) }
}

/** Reward/merchant reveals expose exactly two Gems if at least one revealed card has Socket. */
export function revealGuardianDraftGems<T>(
  revealedCards: readonly Pick<GuardianCardDef, 'socket'>[],
  gemDeck: readonly T[],
): GuardianGemReveal<T> {
  return revealGuardianGems(gemDeck, revealedCards.some((card) => card.socket) ? GUARDIAN_GEM_RULES.draftRevealCount : 0)
}

/** Transform/random gains reveal one Gem for each Socket card gained. */
export function revealGuardianGainedCardGem<T>(
  gainedCard: Pick<GuardianCardDef, 'socket'>,
  gemDeck: readonly T[],
): GuardianGemReveal<T> {
  return revealGuardianGems(gemDeck, gainedCard.socket ? GUARDIAN_GEM_RULES.directGainRevealCount : 0)
}

/** Put every unpicked revealed Gem on the bottom, preserving reveal order. */
export function settleGuardianGemChoice<T extends { id: string }>(
  deck: readonly T[],
  revealed: readonly T[],
  pickedId: string | null,
): readonly T[] {
  if (pickedId !== null && !revealed.some((gem) => gem.id === pickedId)) throw new Error('Picked Gem was not revealed')
  return [...deck, ...revealed.filter((gem) => gem.id !== pickedId)]
}

/** The rulebook limits Socket purchases at one Merchant to two. */
export function mayBuyGuardianSocketCard(socketCardsBought: number): boolean {
  return Number.isSafeInteger(socketCardsBought)
    && socketCardsBought >= 0
    && socketCardsBought < GUARDIAN_GEM_RULES.merchantSocketLimit
}
