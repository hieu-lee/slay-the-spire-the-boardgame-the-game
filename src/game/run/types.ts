// The shapes a run is described in: the state itself, the offers it puts in
// front of a player, and the decisions it is waiting on.
//
// Types only, so every other module can name a shape without importing
// behaviour.
import type { ItemDecks } from '../acquisition.ts'
import type { CampaignProgress, SpireKeys } from '../campaign.ts'
import type { CombatState } from '../combat.ts'
import type { EventRoomState } from '../event-room.ts'
import type { EventCard, EventEffect } from '../events.ts'
import type { SpireMap } from '../map.ts'
import type { QuickSetupState, RunMetaState } from '../meta.ts'
import type { NeowState } from '../neow.ts'
import type { CourierOffer, MerchantState, RelicRewardState } from '../noncombat.ts'
import type { RngState } from '../rng.ts'
import type { CharacterId, Enemy, Player } from '../types.ts'

export type RunPhase =
  | 'neow'
  /** Choosing where to go next. */
  | 'map'
  | 'combat'
  | 'reward'
  | 'betweenCombat'
  /** A non-combat room the party is resolving. */
  | 'room'
  /** Official Quick Start / Catch Up setup sequence (p.22). */
  | 'setup'
  | 'victory'
  | 'defeat'

export type RunState = {
  rng: RngState
  seed: number
  /** Ascension 0 is the base game; 1-13 add the modifiers in docs/rules.md. */
  ascension: number
  act: number
  phase: RunPhase
  neow: NeowState | null
  map: SpireMap
  enemyDecks: EnemyDecks
  players: Player[]
  combat: CombatState | null
  /** Face-down shared physical deck. Its order is server-only. */
  potionDeck: string[]
  relicDeck: string[]
  bossRelicDeck: string[]
  /** Ascension 13's second distinct Act III boss, fought after the first. */
  pendingBossDefId: string | null
  /**
   * This act's boss, rolled with the map and public to the whole party — it is
   * what the map names at the top so a deck can be built toward it.
   */
  actBossDefId: string | null
  /** Downfall's optional own-boss reroll can be spent at most once per Act. */
  selfBossRerolled?: boolean
  /** Guardian's face-down 24-card transparent Gem supply. */
  guardianGemDeck: string[]
  /** Socket cards already gained but still waiting for their revealed Gem choice. */
  pendingGuardianSockets: PendingGuardianSocket[]
  rewards: CardRewardOffer[]
  rewardDestination: 'map' | 'combat' | 'betweenCombat' | 'setup' | 'victory' | null
  itemDecks: ItemDecks
  eventDeck: EventCard[]
  eventsVisited: number
  roomState: MerchantState | RelicRewardState | EventRoomState | null
  eventCombat: { kind: 'encounter' | 'elite' | 'boss'; mindBloom: boolean; bossDefId?: string; relicReward?: boolean } | null
  courier: { usedBy: string[]; offer: CourierOffer | null }
  chooseYourRelic: boolean
  /** Optional p.23 Boss-fight continuation rule. */
  lastStand: boolean
  meta: RunMetaState
  setup: QuickSetupState | null
  campaignProgress: CampaignProgress
  campaign: {
    runId: string
    startedAtAct: 1 | 2 | 3 | 4
    bossesDefeated: number
    /** Boss count already defeated before each character joined through Catch Up. */
    joinedAfterBosses: Partial<Record<CharacterId, number>>
    highestBossActDefeated: 0 | 1 | 2 | 3 | 4
    keys: SpireKeys
    finalized: boolean
  }
  log: string[]
}

export type CardRewardOffer = {
  playerId: string
  /** False when this encounter printed no card reward or it has been settled. */
  cardReward: boolean
  choices: string[] | null
  upgraded: boolean
  /** Indices drawn from the rare stack by Golden Tickets. Public once revealed. */
  rareChoiceIndices?: number[]
  /** Exact physical cards exposed by this reveal. */
  cardsDrawn?: string[]
  raresDrawn?: string[]
  /** Revealed cards temporarily removed while another reward consumes later cards. */
  drawsReserved?: boolean
  /** Setup Rare rewards draw directly from the rare stack. */
  cardSource?: 'ordinary' | 'rare'
  prismatic?: boolean
  availableSources?: Array<CharacterId | 'colorless'>
  prismaticSources?: Array<CharacterId | 'colorless'>
  prismaticDraws?: Array<{ source: CharacterId | 'colorless'; cardId: string; rareId?: string }>
  /** Daily/Custom Transformed replaces this normal Card Reward. */
  transformReward?: boolean
  /** False = none/settled, null = unrevealed, string = reserved face-up card. */
  potion: false | null | string
  /** Additional independent Potion rewards, resolved in physical source order. */
  potionQueue?: Array<null | string>
  /** Ordinary relic reward: face down, face up, or settled. */
  relic?: false | null | string
  /** Shared boss choices remain public until this player picks or skips. */
  bossRelics?: false | string[]
  /** Public Gems revealed alongside this Guardian draft. */
  guardianGems?: string[]
}

export type PendingGuardianSocket = {
  playerId: string
  cardUid: string
  gemIds: string[]
  source: 'draft' | 'merchant' | 'gain'
}

export type PotionRewardDecision =
  | { kind: 'gain' }
  | { kind: 'skip' }
  | { kind: 'pass'; playerId: string }
  | { kind: 'replace'; potionId: string }

export type PendingRelicPreview = {
  relicId: string
  rewardChoices?: string[][]
  rewardUpgraded?: boolean[]
  guardianGemGroups?: string[][]
}

export type EncounterCard = {
  defId: string
  goldReward: number
  cardReward: Enemy['cardReward']
  potionReward?: boolean
  relicReward?: boolean
  summons?: string[]
  randomSummons?: { group: string; count: number; soloCount?: number }
  summonsPerPlayer?: string[]
  randomSummonsPerPlayer?: { group: string; count: number }
  minAscension?: number
  maxAscension?: number
}

export type EnemyDecks = {
  act: number
  first: EncounterCard[]
  encounter: EncounterCard[]
  elite: EncounterCard[]
}

export type PartyMember = { id: string; name: string; character: CharacterId }

export type RewardSource = CharacterId | 'colorless'

export type CardRewardEffect = EventEffect & { tag: 'card-reward' | 'rare-reward' }

export type CampfireChoice = 'rest' | 'smith' | 'leave' | 'ruby'

export type CampfireDecision = { choice: CampfireChoice; cardUid?: string; removeCardUid?: string; transformCardUid?: string }
