// Starting a run: the players, their decks, the map, the supplies, and the
// campaign progress a later act reads back.
//
// `beginCatchUp` is the same job for a seat that joined late — it has to arrive
// with everything a seat that started at the door would already have.
import { createEnemyDecks, rollActBoss } from './encounters.ts'
import { grantHeirlooms } from './rewards.ts'
import { MAX_HP, hasModifier, hasPendingRelicAcquisition, nextRunUid } from './rules.ts'
import { mirrorItemSupplies } from './supplies.ts'
import type { PartyMember, RunState } from './types.ts'
import { addCard, characterRewardDeck, createItemDecks } from '../acquisition.ts'
import { createCampaignProgress, createSpireKeys, isActIVUnlocked, isColorlessUnlocked } from '../campaign.ts'
import type { CampaignProgress } from '../campaign.ts'
import { STARTER_DECKS } from '../cards.ts'
import { buildEventDeck } from '../events.ts'
import { ACT_SHAPE, addBurningElite, generateMap } from '../map.ts'
import type { RoomKind } from '../map.ts'
import { normalizeModifierIds, rollDailyModifiers } from '../meta.ts'
import type { DailyModifierId, QuickSetupState, RunMetaOptions } from '../meta.ts'
import { dealNeow } from '../neow.ts'
import type { NeowState } from '../neow.ts'
import { STARTING_RELIC, createRelicDecks, createRelicInstance } from '../relics.ts'
import { createRng, shuffle } from '../rng.ts'
import type { RngState } from '../rng.ts'
import type { CardInstance, CharacterId, Player } from '../types.ts'

/**
 * Card instance ids, counted per RUN rather than per module.
 *
 * This counter is only used while one run is being built. Later card rewards
 * derive their next id from that run's own deck, so creating another room
 * cannot rewind an older run's ids.
 */
let instanceCounter = 0

/**
 * What each room is called out loud.
 *
 * Keyed by RoomKind so an eighth kind fails to compile rather than silently
 * falling through to its own raw id in the log. (MapScreen holds a separate,
 * shorter label for the map badge — deliberately different wording.)
 */
export const ROOM_LABEL: Record<RoomKind, string> = {
  encounter: 'encounter',
  elite: 'elite fight',
  boss: 'boss fight',
  campfire: 'campfire',
  treasure: 'treasure room',
  merchant: 'merchant',
  // Called an Event on the map badge and the room screen; one name for one
  // room, not three.
  event: 'event',
}

/**
 * "an encounter", "a boss fight" — the phrase a player actually reads.
 *
 * The article comes from the LABEL, not from the room kind: they agree today
 * only by coincidence, and an `event` renamed to "mystery room" would have
 * read "an mystery room".
 */
export function enteringRoom(kind: string): string {
  const label = ROOM_LABEL[kind as RoomKind] ?? kind
  return `${/^[aeiou]/i.test(label) ? 'an' : 'a'} ${label}`
}

/** Card instance ids only need to be unique within a run. */
function makeInstance(defId: string): CardInstance {
  instanceCounter += 1
  return { uid: `c${instanceCounter}`, defId, upgraded: false }
}

export function createPlayer(
  rng: RngState,
  id: string,
  name: string,
  character: CharacterId,
  row: number,
  addedCards: readonly string[] = [],
  campaignProgress: CampaignProgress = createCampaignProgress(),
  rewardDecks?: { cardRewards: string[]; rareRewards: string[] },
): Player {
  const deck = [...STARTER_DECKS[character], ...addedCards].map(makeInstance)
  const maxHp = MAX_HP[character]
  return {
    id,
    name,
    character,
    row,
    hp: maxHp,
    maxHp,
    block: 0,
    energy: 3,
    gold: 0,
    deck,
    draw: shuffle(rng, [...deck]),
    hand: [],
    discard: [],
    exhaust: [],
    powers: [],
    strength: 0,
    strengthLossAtEndOfTurn: 0,
    vulnerable: 0,
    weak: 0,
    drawLocked: false,
    lostHpThisCombat: false,
    hpLostThisRound: 0,
    hpLossLimitThisRound: undefined,
    freeCardsThisTurn: 0,
    freeAttacksThisTurn: 0,
    cardPlayLocked: false,
    doubledAttacksThisTurn: 0,
    tripledAttacksThisTurn: 0,
    doubledCardsThisTurn: 0,
    doubledSkillsThisTurn: 0,
    retainCardsThisTurn: 0,
    cardsPlayedThisTurn: 0,
    attacksPlayedThisTurn: 0,
    shivs: 0,
    shivDamageBonus: 0,
    cardBlockBonus: 0,
    hitPoison: 0,
    starterStrikeDamageBonus: 0,
    clawCubesGainedThisCombat: 0,
    starterDefendBlockBonus: 0,
    miracles: 0,
    stance: 'neutral',
    wrathAttackDamageBonus: 0,
    orbs: [null, null, null],
    orbEvokeBonus: 0,
    darkOrbEvokeBonus: 0,
    orbEndTurnBonus: 0,
    lightningEndTurnBonus: 0,
    relics: [{ defId: STARTING_RELIC[character] ?? 'burning_blood', spent: false }],
    potions: [],
    cardRewards: rewardDecks?.cardRewards ?? shuffle(rng, characterRewardDeck(character, false, campaignProgress)),
    rareRewards: rewardDecks?.rareRewards ?? shuffle(rng, characterRewardDeck(character, true, campaignProgress)),
    dead: false,
  }
}

export function createRun(
  seed: number,
  party: PartyMember[],
  ascension = 0,
  campaignProgress: CampaignProgress = createCampaignProgress(),
  chooseYourRelic = false,
  lastStand = false,
  metaOptions: RunMetaOptions = {},
): RunState {
  if (party.length < 1 || party.length > 4) throw new Error('a run requires 1 to 4 players')
  instanceCounter = 0
  const rng = createRng(seed)
  const mode = metaOptions.mode ?? 'standard'
  const modifierIds = mode === 'daily'
    ? rollDailyModifiers(rng).modifiers.map(({ id }) => id)
    : mode === 'custom' ? normalizeModifierIds(metaOptions.modifiers) : []
  const modifier = (id: DailyModifierId) => modifierIds.includes(id)
  let players = party.map((member, index) =>
    createPlayer(
      rng,
      member.id,
      member.name,
      member.character,
      index,
      ascension >= 5 ? ['ascenders_bane'] : [],
      campaignProgress,
    ),
  )
  if (ascension >= 2) {
    for (const player of players) {
      player.maxHp -= 1
      player.hp -= 1
    }
  }
  if (ascension >= 9) for (const player of players) player.hp -= 1

  const relicDecks = createRelicDecks(rng)
  const keys = createSpireKeys()
  const baseMap = generateMap(rng, 1, ACT_SHAPE, ascension)
  const map = isActIVUnlocked(campaignProgress) ? addBurningElite(rng, baseMap) : baseMap
  const actBossDefId = rollActBoss(rng, 1)
  const colorlessUnlocked = isColorlessUnlocked(campaignProgress)
  const itemDecks = createItemDecks(rng, colorlessUnlocked || modifier('all_star') || modifier('prismatic_shard'), campaignProgress, party.map((member) => member.character))
  itemDecks.relics = [...relicDecks.relicDeck]
  const dealt = dealNeow(rng, players.map((player) => player.id), colorlessUnlocked)
  const neow: NeowState = {
    deck: dealt.deck,
    players: Object.fromEntries(players.map((player) => {
      return [player.id, {
        cardId: dealt.dealt[player.id]!,
        redGoldPending: true,
        redRewardPending: true,
        redReward: null,
        blueOption: null,
        pendingEffect: null,
        rewardKind: null,
        reward: null,
        rewardQueue: [],
        done: false,
      }]
    })),
  }
  const nextRunNumber = (campaignProgress.nextRunNumber ?? 0) + 1
  const nextCampaignProgress = { ...campaignProgress, nextRunNumber }
  let nextUid = nextRunUid(players)
  if (modifier('all_star')) players = players.map((player) => {
    let owner = player
    for (const defId of itemDecks.colorless.splice(0, 5)) owner = addCard(owner, defId, `c${nextUid++}`)
    return owner
  })
  if (modifier('shiny')) players = players.map((player) => {
    let owner = { ...player, rareRewards: [...player.rareRewards] }
    for (const defId of owner.rareRewards.splice(0, 5)) owner = addCard(owner, defId, `c${nextUid++}`)
    return owner
  })
  if (modifier('cursed')) players = players.map((player) => {
    let owner = player
    for (const defId of itemDecks.curses.splice(0, 2)) owner = addCard(owner, defId, `c${nextUid++}`)
    return owner
  })
  if (modifier('prismatic_shard')) players = players.map((player) => ({
    ...player,
    relics: [...player.relics, createRelicInstance('prismatic_shard')],
  }))
  const quickStartAct = metaOptions.quickStartAct ?? 1
  if (quickStartAct === 4 && !isActIVUnlocked(campaignProgress)) throw new Error('Act IV Quick Start is not unlocked')
  const setup: QuickSetupState | null = quickStartAct > 1 ? {
    kind: 'quick-start',
    targetAct: quickStartAct as 2 | 3 | 4,
    playerIds: players.map((player) => player.id),
    // Neow is the first printed Quick Start row and is resolved by the normal screen.
    rowIndex: 1,
    repeatIndex: 0,
    playerIndex: 0,
    die: null,
  } : null
  let run: RunState = {
    rng,
    seed,
    ascension,
    act: 1,
    phase: 'neow',
    neow,
    map,
    enemyDecks: createEnemyDecks(rng, 1, ascension),
    players,
    combat: null,
    potionDeck: [...itemDecks.potions],
    relicDeck: [...itemDecks.relics],
    bossRelicDeck: relicDecks.bossRelicDeck,
    pendingBossDefId: null,
    actBossDefId,
    rewards: [],
    rewardDestination: null,
    itemDecks,
    eventDeck: buildEventDeck(rng, 1, ascension, colorlessUnlocked),
    eventsVisited: 0,
    roomState: null,
    eventCombat: null,
    courier: { usedBy: [], offer: null },
    chooseYourRelic: chooseYourRelic && party.length > 1,
    lastStand: lastStand && party.length > 1,
    meta: { mode, modifierIds },
    setup,
    campaignProgress: nextCampaignProgress,
    campaign: {
      runId: `campaign-${nextRunNumber}`,
      startedAtAct: quickStartAct,
      bossesDefeated: 0,
      joinedAfterBosses: {},
      highestBossActDefeated: 0,
      keys,
      finalized: false,
    },
    log: ['The party enters the Spire.'],
  }
  if (modifier('heirloom')) run = grantHeirlooms(run, players.map((player) => player.id))
  return run
}

/** Add physical characters only before the party enters an Act II–IV map (Quick Start p.22). */
export function beginCatchUp(state: RunState, members: readonly PartyMember[]): RunState {
  const adding = state.phase === 'neow' && state.setup?.kind === 'catch-up' && Boolean(state.neow)
  if ((!adding && (state.phase !== 'map' || state.map.position !== null)) || state.act < 2 || state.act > 4 ||
    members.length < 1 || state.players.length + members.length > 4 || hasPendingRelicAcquisition(state)) return state
  const ids = new Set(state.players.map((player) => player.id))
  const characters = new Set(state.players.map((player) => player.character))
  if (members.some((member) => ids.has(member.id) || characters.has(member.character)) ||
    new Set(members.map((member) => member.id)).size !== members.length ||
    new Set(members.map((member) => member.character)).size !== members.length) return state
  const rng = { ...state.rng }
  const itemDecks = structuredClone(state.itemDecks)
  instanceCounter = nextRunUid(state.players) - 1
  let newPlayers = members.map((member, index) => {
    const cardRewards = itemDecks.characterCards[member.character]
    const rareRewards = itemDecks.characterRares[member.character]
    const player = createPlayer(rng, member.id, member.name, member.character, state.players.length + index,
      state.ascension >= 5 ? ['ascenders_bane'] : [], state.campaignProgress,
      cardRewards && rareRewards ? { cardRewards, rareRewards } : undefined)
    if (state.ascension >= 2) { player.maxHp -= 1; player.hp -= 1 }
    if (state.ascension >= 9) player.hp -= 1
    delete itemDecks.characterCards[member.character]
    delete itemDecks.characterRares[member.character]
    return player
  })
  let catchUpUid = nextRunUid([...state.players, ...newPlayers])
  if (hasModifier(state, 'all_star')) newPlayers = newPlayers.map((player) => {
    let owner = player
    for (const defId of itemDecks.colorless.splice(0, 5)) owner = addCard(owner, defId, `c${catchUpUid++}`)
    return owner
  })
  if (hasModifier(state, 'shiny')) newPlayers = newPlayers.map((player) => {
    let owner = { ...player, rareRewards: [...player.rareRewards] }
    for (const defId of owner.rareRewards.splice(0, 5)) owner = addCard(owner, defId, `c${catchUpUid++}`)
    return owner
  })
  if (hasModifier(state, 'cursed')) newPlayers = newPlayers.map((player) => {
    let owner = player
    for (const defId of itemDecks.curses.splice(0, 2)) owner = addCard(owner, defId, `c${catchUpUid++}`)
    return owner
  })
  if (hasModifier(state, 'prismatic_shard')) newPlayers = newPlayers.map((player) => ({
    ...player, relics: [...player.relics, createRelicInstance('prismatic_shard')],
  }))
  const joinedAfterBosses = { ...state.campaign.joinedAfterBosses,
    ...Object.fromEntries(newPlayers.map((player) => [player.character, state.campaign.bossesDefeated])) }
  if (adding && state.neow && state.setup) {
    const deck = [...state.neow.deck]
    const progress = Object.fromEntries(newPlayers.map((player) => {
      const cardId = deck.shift()
      return [player.id, {
        cardId: cardId!, redGoldPending: true, redRewardPending: true,
        redReward: null, blueOption: null, pendingEffect: null, rewardKind: null,
        reward: null, rewardQueue: [], done: false,
      }]
    }))
    if (Object.values(progress).some((entry) => !entry.cardId)) return state
    let next = mirrorItemSupplies({
      ...state,
      rng,
      players: [...state.players, ...newPlayers],
      itemDecks,
      neow: { deck, players: { ...state.neow.players, ...progress } },
      setup: { ...state.setup, playerIds: [...state.setup.playerIds, ...newPlayers.map((player) => player.id)] },
      campaign: { ...state.campaign, joinedAfterBosses },
      log: [...state.log, `${newPlayers.map((player) => player.name).join(' and ')} join Catch Up.`],
    }, itemDecks)
    if (hasModifier(state, 'heirloom')) next = grantHeirlooms(next, newPlayers.map((player) => player.id))
    return next
  }
  const dealt = dealNeow(rng, newPlayers.map((player) => player.id), isColorlessUnlocked(state.campaignProgress))
  let next = mirrorItemSupplies({
    ...state,
    rng,
    phase: 'neow',
    players: [...state.players, ...newPlayers],
    itemDecks,
    neow: {
      deck: dealt.deck,
      players: Object.fromEntries(newPlayers.map((player) => [player.id, {
        cardId: dealt.dealt[player.id]!, redGoldPending: true, redRewardPending: true,
        redReward: null, blueOption: null, pendingEffect: null, rewardKind: null,
        reward: null, rewardQueue: [], done: false,
      }])),
    },
    setup: {
      kind: 'catch-up', targetAct: state.act as 2 | 3 | 4,
      playerIds: newPlayers.map((player) => player.id), rowIndex: 1, repeatIndex: 0, playerIndex: 0, die: null,
    },
    campaign: { ...state.campaign, joinedAfterBosses },
    log: [...state.log, `${newPlayers.map((player) => player.name).join(' and ')} catch up at the start of Act ${state.act}.`],
  }, itemDecks)
  if (hasModifier(state, 'heirloom')) next = grantHeirlooms(next, newPlayers.map((player) => player.id))
  return next
}
