// Moving through the spire: entering a room, resolving what happens in it, and
// leaving for the next one.
//
// This is the seam the run exists for. A fighting room builds a CombatState and
// hands it to the combat engine; when the engine reports a result, this is what
// folds it back into the run — rewards, campaign progress, the next act, or the
// end of the run.
import { buildEncounter, createEnemyDecks, readyForCombat, rollActBoss } from './encounters.ts'
import { availableRewardSources } from './rewards.ts'
import {
  applyDeadlyEvent,
  hasModifier,
  hasPendingRelicAcquisition,
  hasRelic,
  nextRunUid,
  victoryIsTerminal,
} from './rules.ts'
import { enteringRoom } from './setup.ts'
import { queueNewGuardianSockets } from './guardian-gems.ts'
import { merchantItemDecks, mirrorItemSupplies } from './supplies.ts'
import type { CardRewardOffer, RunPhase, RunState } from './types.ts'
import { healingCapFor, transformCard } from '../acquisition.ts'
import { canEnterActIV, finishCampaign, isActIVUnlocked, isColorlessUnlocked } from '../campaign.ts'
import type { CampaignProgress, SpireKeys } from '../campaign.ts'
import { CARDS, cardIsCurse } from '../cards.ts'
import { createCombat, preparePlayerTurnThroughDraw, startPlayerTurnWithChoices } from '../combat.ts'
import type { CombatState } from '../combat.ts'
import { enemyDef } from '../enemies.ts'
import { createEventRoom } from '../event-room.ts'
import { EVENT_DEFINITIONS, buildEventDeck } from '../events.ts'
import { addBurningElite, currentRoom, generateMap, isActComplete, moveTo } from '../map.ts'
import type { Room, SpireMap } from '../map.ts'
import type { DailyModifierId } from '../meta.ts'
import { createMerchant, createRelicReward } from '../noncombat.ts'
import { bossRelicOfferSize, relicDef } from '../relics.ts'
import { nextInt, shuffle } from '../rng.ts'
import type { RngState } from '../rng.ts'
import type { Player } from '../types.ts'
import { DOWNFALL_BOSSES, DOWNFALL_SELF_BOSS_REROLLS } from '../downfall/enemies.ts'

export function canRerollDownfallSelfBoss(state: RunState): boolean {
  const current = state.actBossDefId
  return state.meta.ruleset === 'downfall' && !state.selfBossRerolled && current !== null &&
    (state.phase === 'neow' || state.phase === 'map') && state.map.position === null &&
    state.players.some((player) => player.character in DOWNFALL_SELF_BOSS_REROLLS &&
      DOWNFALL_SELF_BOSS_REROLLS[player.character as keyof typeof DOWNFALL_SELF_BOSS_REROLLS]?.includes(current))
}

/** Spend the FAQ's optional reroll when the shown Downfall boss matches a hero. */
export function rerollDownfallSelfBoss(state: RunState): RunState {
  if (!canRerollDownfallSelfBoss(state)) return state
  const candidates = (DOWNFALL_BOSSES[state.act] ?? []).filter((id) => id !== state.actBossDefId)
  if (candidates.length === 0) return state
  const rng = { ...state.rng }
  const actBossDefId = candidates[nextInt(rng, candidates.length)]!
  return {
    ...state,
    rng,
    actBossDefId,
    selfBossRerolled: true,
    log: [...state.log, `The party rerolls its self-boss into ${enemyDef(actBossDefId).name}.`],
  }
}

/**
 * Moves the party into a room and starts whatever that room is. Returns the
 * SAME state reference when the move is illegal, matching the combat engine.
 */
export function enterRoom(state: RunState, roomId: string, wingBootsPlayerId?: string): RunState {
  if (state.phase !== 'map' || hasPendingRelicAcquisition(state)) return state
  let map = moveTo(state.map, roomId)
  let wingBootsUsed = false
  if (map === state.map && wingBootsPlayerId) {
    const owner = state.players.find((player) => player.id === wingBootsPlayerId && !player.dead)
    const boots = owner?.relics.find((relic) => relic.defId === 'wing_boots' && (relic.uses ?? 0) > 0)
    const current = state.map.position ? state.map.rooms[state.map.position] : undefined
    const target = state.map.rooms[roomId]
    if (boots && target && target.row === (current?.row ?? -1) + 1) {
      map = {
        ...state.map,
        position: roomId,
        rooms: { ...state.map.rooms, [roomId]: { ...target, visited: true } },
      }
      wingBootsUsed = true
    }
  }
  if (map === state.map) return state

  const room = currentRoom(map)
  if (!room) return state

  const rng = { ...state.rng }
  const enemyDecks = structuredClone(state.enemyDecks)
  const roomPlayers = state.players.map((player) => ({
    ...player,
    relics: player.relics.flatMap((relic) => {
      if (wingBootsUsed && player.id === wingBootsPlayerId && relic.defId === 'wing_boots') {
        return relic.uses === 1 ? [] : [{ ...relic, uses: relic.uses! - 1 }]
      }
      return relicDef(relic.defId).activation === 'oncePerRoom' ? [{ ...relic, spent: false }] : [relic]
    }),
  }))
  const next: RunState = {
    ...state,
    map,
    rng,
    enemyDecks,
    players: roomPlayers,
    log: [...state.log, `The party enters ${enteringRoom(room.kind)}.`],
  }

  if (room.kind === 'encounter' || room.kind === 'elite' || room.kind === 'boss') {
    let nextUid = Math.max(0, ...roomPlayers.flatMap((player) => player.deck.map((card) => Number(/^c(\d+)$/.exec(card.uid)?.[1] ?? 0))))
    const players = roomPlayers.map((player) => {
      const prepared = room.burning && !state.campaign.keys.emerald
        ? {
            ...player,
            deck: [...player.deck, { uid: `c${++nextUid}`, defId: 'burn', upgraded: false }, { uid: `c${++nextUid}`, defId: 'burn', upgraded: false }],
          }
        : player
      return readyForCombat(rng, prepared)
    })
    const first = state.act === 1 && state.map.position === null && room.id === state.map.rows[0]?.[0]
    const { enemies, summonSupply, nextBossDefId } = buildEncounter(
      rng, enemyDecks, state.act, players, room.kind, first, state.ascension,
      undefined, state.actBossDefId, state.meta.ruleset,
    )
    // Start the first Player Turn immediately: entering a room with no cards in
    // hand and nothing to do is not a state the game ever sits in.
    const combat = startPlayerTurnWithChoices(createCombat(
      rng, players, enemies, room.id, state.potionDeck, state.ascension >= 4 ? 2 : 3, summonSupply,
      state.lastStand, state.meta.ruleset,
    ))
    return {
      ...next,
      phase: 'combat',
      players,
      combat,
      pendingBossDefId: nextBossDefId ?? null,
      roomState: null,
      courier: { usedBy: [], offer: null },
    }
  }

  if (room.kind === 'merchant') {
    const itemDecks = structuredClone(state.itemDecks)
    itemDecks.potions = [...state.potionDeck]
    const guardianGemDeck = [...(state.guardianGemDeck ?? [])]
    const roomState = createMerchant(merchantItemDecks(state, itemDecks), roomPlayers, guardianGemDeck,
      state.meta.ruleset)
    return mirrorItemSupplies({ ...next, phase: 'room', roomState, guardianGemDeck }, itemDecks)
  }
  if (room.kind === 'treasure') {
    const itemDecks = structuredClone(state.itemDecks)
    return mirrorItemSupplies({ ...next, phase: 'room', roomState: createRelicReward('treasure', itemDecks, roomPlayers, state.chooseYourRelic) }, itemDecks)
  }

  if (room.kind === 'event') {
    const itemDecks = structuredClone(state.itemDecks)
    itemDecks.potions = [...state.potionDeck]
    const eventDeck = [...state.eventDeck]
    let card = eventDeck.shift()
    while (state.eventsVisited === 0 && (card?.firstEventRedraw || card?.id === 'encounter_redraw' || card?.id === 'merchant_redraw' || card?.id === 'dead_adventurer')) {
      eventDeck.push(card)
      card = eventDeck.shift()
    }
    if (!card) return { ...next, phase: 'map', eventDeck, log: [...next.log, 'The Event deck is empty.'] }
    const drawnCard = card
    eventDeck.push(drawnCard)
    if (state.eventsVisited > 0 && (card.id === 'encounter_redraw' || card.id === 'merchant_redraw')) {
      const ordinaryId = card.id === 'encounter_redraw' ? 'encounter' : 'merchant'
      const ordinary = EVENT_DEFINITIONS[ordinaryId]!
      card = { ...card, id: ordinary.id, name: ordinary.name, options: ordinary.options, scope: ordinary.scope }
    }
    if (hasModifier(state, 'transformed')) card = {
      ...card,
      options: card.options.map((option) => {
        const replaced = option.effects.some((effect) => effect.tag === 'card-reward' && effect.source !== 'rare')
        return replaced ? {
          ...option,
          description: `${option.description} Normal Card Rewards become Transform.`,
          effects: option.effects.map((effect) => effect.tag === 'card-reward' && effect.source !== 'rare'
            ? { tag: 'transform-card' as const, count: effect.count, target: effect.target }
            : effect),
        } : option
      }),
    }
    const roomState = createEventRoom(card)
    roomState.availableRewardSources = {
      card: availableRewardSources(state, false),
      rare: availableRewardSources(state, true),
    }
    if (card.id === 'forgotten_altar') roomState.revealedRelics = Object.fromEntries(state.players.filter((player) => !player.dead && player.relics.length > 0).map((player) => [player.id, player.relics[nextInt(rng, player.relics.length)]!.defId]))
    if (card.id === 'falling') {
      const revealed = roomPlayers.filter((player) => !player.dead).map((player) => [player, shuffle(rng, player.deck.filter((entry) => entry.defId !== 'ascenders_bane')).slice(0, 3)] as const)
      roomState.revealedCards = Object.fromEntries(revealed.map(([player, cards]) => [player.id, cards.map((entry) => entry.uid)]))
      roomState.revealedCardDefs = Object.fromEntries(revealed.map(([player, cards]) => [player.id, cards.map((entry) => entry.defId)]))
    }
    if (card.id === 'downfall_event_act3_mysterious_sphere') {
      const players = roomPlayers.map((player) => readyForCombat(rng, player))
      const encounter = buildEncounter(rng, enemyDecks, state.act, players, 'encounter', false, state.ascension, undefined, undefined, state.meta.ruleset)
      const prepared = createCombat(
        rng, players, encounter.enemies, room.id, state.potionDeck,
        state.ascension >= 4 ? 2 : 3, encounter.summonSupply, state.lastStand, state.meta.ruleset,
      )
      roomState.preparedCombat = prepared.pendingHermitSetupLoads?.length
        ? prepared : preparePlayerTurnThroughDraw(prepared)
    }
    return mirrorItemSupplies({
      ...next,
      phase: 'room',
      eventDeck,
      eventsVisited: state.eventsVisited + 1,
      roomState,
      players: roomPlayers.map((player) => hasRelic(player, 'ssserpent_head') && !hasRelic(player, 'ectoplasm')
        ? { ...player, gold: player.gold + 2 }
        : player),
    }, itemDecks)
  }
  return { ...next, phase: 'room', roomState: null }
}

/**
 * Folds a finished combat back into the run: survivors keep their HP and gold,
 * and the party either climbs on or the run ends.
 */
/** How many combat lines to carry into the run log when a fight ends. */
const COMBAT_EPITAPH = 6

function preparePendingBossCombat(
  state: RunState,
  players: Player[],
  rng: RngState,
): { rng: RngState; players: Player[]; combat: CombatState } {
  const prepared = players.map((player) => readyForCombat(rng, player))
  const { enemies, summonSupply } = buildEncounter(
    rng,
    state.enemyDecks,
    state.act,
    prepared,
    'boss',
    false,
    state.ascension,
    state.pendingBossDefId!,
    undefined,
    state.meta.ruleset,
  )
  return {
    rng,
    players: prepared,
    combat: startPlayerTurnWithChoices(createCombat(
      rng, prepared, enemies, undefined, state.potionDeck, state.ascension >= 4 ? 2 : 3, summonSupply,
      state.lastStand, state.meta.ruleset,
    )),
  }
}

export function resolveCombat(state: RunState): RunState {
  const combat = state.combat
  if (!combat || state.courier.offer || (combat.phase !== 'won' && combat.phase !== 'lost')) return state

  const epitaph = combat.log.filter((line) => !/^Turn \d+ begins/.test(line)).slice(-COMBAT_EPITAPH)
  const itemDecks = structuredClone(state.itemDecks)
  itemDecks.potions = [...combat.potionDeck]
  if (combat.phase === 'lost') {
    return {
      ...state,
      phase: 'defeat',
      players: combat.players.map((player) => ({
        ...player,
        deck: player.deck.filter((card) => CARDS[card.defId]?.owner !== 'status'),
      })),
      combat: null,
      potionDeck: combat.potionDeck,
      pendingBossDefId: null,
      itemDecks,
      eventCombat: null,
      rewards: [],
      rewardDestination: null,
      log: [...state.log, ...epitaph, 'The party has fallen.'],
    }
  }

  const room = currentRoom(state.map)
  const wasBoss = room?.kind === 'boss' && !state.eventCombat
  const wasBonusBoss = state.eventCombat?.mindBloom === true
  const wasElite = room?.kind === 'elite' || state.eventCombat?.kind === 'elite' || state.eventCombat?.mindBloom === true
  const printedBossRewards = wasBoss && state.act <= 2
  const lastStandActEnd = state.lastStand && combat.players.some((player) => player.dead) &&
    (wasBoss || state.eventCombat?.kind === 'boss')
  const sharedReward = wasElite || wasBoss || state.eventCombat?.kind === 'boss'
    ? combat.enemies.find((enemy) => enemy.uid === 'elite' || enemy.uid === 'boss-0') ??
      combat.enemies.find((enemy) => enemyDef(enemy.defId, enemy.ascension).elite || enemy.isBoss)
    : undefined
  let players = state.players.map((player) => {
    const after = combat.players.find((candidate) => candidate.id === player.id)
    if (!after) return player
    const source = sharedReward ?? combat.enemies.find((enemy) => enemy.row === after.row)
    const rewardGold = printedBossRewards ? state.ascension >= 10 ? 2 : 3 : source?.goldReward ?? 0
    const canGainGold = !hasRelic(after, 'ectoplasm')
    const goldenIdol = hasRelic(after, 'golden_idol') ? 1 : 0
    const meatHp = hasRelic(after, 'meat_on_the_bone') && after.hp < 4 ? 4 : after.hp
    const hp = Math.min(healingCapFor(after, state.meta.ruleset), meatHp)
    const transformed = new Map(after.deck.map((card) => [card.uid, card]))
    return {
      ...player,
      deck: player.deck.map((card) => {
        const replacement = transformed.get(card.uid)
        return replacement ? {
          uid: replacement.uid,
          defId: replacement.defId,
          upgraded: replacement.upgraded,
          ...(replacement.attachedGemId ? { attachedGemId: replacement.attachedGemId } : {}),
        } : card
      }).filter((card) => CARDS[card.defId]?.owner !== 'status'),
      hp,
      maxHp: after.maxHp,
      gold: after.gold + (canGainGold ? rewardGold + goldenIdol : 0),
      cardRewards: after.cardRewards,
      rareRewards: after.rareRewards,
      row: after.row,
      potions: after.potions,
      relics: after.relics,
      damageStats: after.damageStats,
      lootChests: after.lootChests,
      dead: after.dead,
    }
  })
  const modifier = (id: DailyModifierId) => hasModifier(state, id)
  const rng = { ...combat.rng }
  if (modifier('terminal')) players = players.map((player) => {
    if (player.dead) return player
    const hp = Math.max(0, player.hp - 1)
    return { ...player, hp, dead: hp === 0 }
  })
  let dailyUid = nextRunUid(players)
  if (modifier('insanity')) players = players.map((player) => {
    if (player.dead) return player
    const eligible = player.deck.filter((card) => !cardIsCurse(card.defId))
    const card = eligible[nextInt(rng, eligible.length)]
    return card ? transformCard(rng, player, card.uid, `c${dailyUid++}`) : player
  })
  const dailyLastStand = state.lastStand && combat.enemies.some((enemy) => enemy.isBoss) && players.some((player) => !player.dead)
  if (players.some((player) => player.dead) && !dailyLastStand) return mirrorItemSupplies({
    ...state,
    rng,
    phase: 'defeat',
    players,
    combat: null,
    pendingBossDefId: null,
    eventCombat: null,
    rewards: [],
    rewardDestination: null,
    pendingGuardianSockets: [],
    log: [...state.log, ...epitaph, 'The party falls to a Daily modifier.'],
  }, itemDecks)
  state = queueNewGuardianSockets(state, { ...state, players })
  players = state.players

  const betweenBosses = wasBoss && Boolean(state.pendingBossDefId) && !lastStandActEnd
  const finalBoss = wasBoss && state.act >= 4
  const destination = lastStandActEnd || wasBoss && !betweenBosses ? 'victory' : betweenBosses ? 'betweenCombat' : 'map'
  const bossChoices = printedBossRewards
    ? state.bossRelicDeck.slice(0, bossRelicOfferSize(players.filter((player) => !player.dead).length))
    : []
  const rewards = players.flatMap<CardRewardOffer>((player) => {
    if (player.dead) return []
    const whitePotion: false | null = hasRelic(player, 'white_beast_statue') ? null : false
    if (betweenBosses || finalBoss || wasBoss && !printedBossRewards) return whitePotion === false ? [] : [{
      playerId: player.id,
      cardReward: false,
      choices: null,
      upgraded: false,
      potion: whitePotion,
      relic: false as const,
      bossRelics: false as const,
    }]
    const source = sharedReward ?? combat.enemies.find((enemy) => enemy.row === player.row)
    const rareReward = printedBossRewards
    const printedCardReward = wasBonusBoss || printedBossRewards ? 'normal' : source?.cardReward
    const transformedReward = modifier('transformed') && printedCardReward === 'normal' && !rareReward
    const vintageReward = modifier('vintage') && printedCardReward === 'normal' && !wasElite && !wasBoss
    const prismatic = hasRelic(player, 'prismatic_shard')
    const rewardSources = prismatic ? availableRewardSources(state, rareReward) : undefined
    const cardReward = Boolean(printedCardReward && !transformedReward && !vintageReward &&
      (prismatic ? (rewardSources?.length ?? 0) >= 3 : (rareReward ? player.rareRewards : player.cardRewards).length > 0))
    const potionCount = Number(source?.potionReward === true) + Number(hasRelic(player, 'white_beast_statue'))
    const potion: false | null = potionCount > 0 ? null : false
    // Elite relics are resolved by the shared physical room reward below.
    const relic: false | null = (source?.relicReward === true && !wasElite && !printedBossRewards || vintageReward || state.eventCombat?.relicReward) ? null : false
    if (!cardReward && !transformedReward && potion === false && relic === false && !printedBossRewards) return []
    return [{
      playerId: player.id,
      cardReward,
      cardSource: rareReward ? 'rare' : 'ordinary',
      prismatic: cardReward && prismatic,
      availableSources: cardReward && prismatic ? rewardSources : undefined,
      transformReward: transformedReward,
      choices: null,
      upgraded: printedCardReward === 'upgraded',
      potion,
      potionQueue: potionCount > 1 ? Array(potionCount - 1).fill(null) : undefined,
      relic,
      bossRelics: printedBossRewards ? [...bossChoices] : false as const,
    }]
  })
  const roomState = wasElite ? createRelicReward('elite', itemDecks, players, state.chooseYourRelic) : null
  const campaign = {
    ...state.campaign,
    bossesDefeated: state.campaign.bossesDefeated + (wasBoss || wasBonusBoss ? 1 : 0),
    highestBossActDefeated: (wasBoss || lastStandActEnd ? Math.max(state.campaign.highestBossActDefeated, state.act) : state.campaign.highestBossActDefeated) as 0 | 1 | 2 | 3 | 4,
    keys: room?.burning && !state.campaign.keys.emerald
      ? { ...state.campaign.keys, emerald: true }
      : state.campaign.keys,
  }
  const next = mirrorItemSupplies({
    ...state,
    rng,
    phase: rewards.length > 0 ? 'reward' : roomState ? 'room' : destination,
    players,
    bossRelicDeck: printedBossRewards ? state.bossRelicDeck.slice(bossChoices.length) : state.bossRelicDeck,
    potionDeck: combat.potionDeck,
    combat: null,
    pendingBossDefId: betweenBosses ? state.pendingBossDefId : null,
    rewards,
    roomState,
    eventCombat: null,
    campaign,
    rewardDestination: rewards.length > 0 || roomState ? destination : null,
    log: [...state.log, betweenBosses
      ? 'The party regroups before the second Act III boss.'
      : wasBoss && state.act >= 4
      ? 'The Spire is conquered.'
      : wasBoss ? 'The Act is won.' : 'The enemies fall.'],
  }, itemDecks)
  return state.eventCombat ? applyDeadlyEvent(state, next) : next
}

/** End an active fight as a party defeat without resolving any pending combat choice. */
export function giveUpFight(state: RunState): RunState {
  if (state.phase !== 'combat' || !state.combat || state.combat.phase === 'won' || state.combat.phase === 'lost') return state
  return resolveCombat({
    ...state,
    courier: { ...state.courier, offer: null },
    combat: {
      ...state.combat,
      phase: 'lost',
      players: state.combat.players.map((player) => ({ ...player, hp: 0, dead: true })),
      log: [...state.combat.log, 'The party gives up.'],
    },
  })
}

export function canGiveUpRun(state: {
  phase: RunPhase
  act: number
  lastStand: boolean
  players: readonly { dead: boolean }[]
  campaign: { finalized: boolean; keys: SpireKeys }
  combat: Pick<CombatState, 'phase'> | null
}, campaignProgress: Pick<CampaignProgress, 'actIV'>): boolean {
  if (state.phase === 'defeat' || victoryIsTerminal(state, campaignProgress)) return false
  return state.phase !== 'combat' || Boolean(state.combat && state.combat.phase !== 'won' && state.combat.phase !== 'lost')
}

/** End an active run from any screen. Combat surrender keeps its existing fold-back path. */
export function giveUpRun(state: RunState): RunState {
  if (!canGiveUpRun(state, state.campaignProgress)) return state
  const surrendered: RunState = state.phase === 'combat' ? giveUpFight(state) : {
    ...state,
    phase: 'defeat',
    neow: null,
    players: state.players.map((player) => ({ ...player, hp: 0, dead: true })),
    combat: null,
    pendingBossDefId: null,
    rewards: [],
    rewardDestination: null,
    roomState: null,
    eventCombat: null,
    courier: { ...state.courier, offer: null },
    setup: null,
    log: [...state.log, 'The party gives up.'],
  }
  return {
    ...surrendered,
    pendingGuardianSockets: [],
    players: surrendered.players.map((player) => ({
      ...player,
      relics: player.relics.filter((relic) => !relic.pending),
    })),
  }
}

/** Swap or move one player between combats (rulebook p.13). */
export function switchBetweenCombatRow(state: RunState, playerId: string, row: number): RunState {
  const canSwitch = state.phase === 'map' || state.phase === 'room' ||
    state.phase === 'betweenCombat' && Boolean(state.pendingBossDefId)
  if (!canSwitch ||
    !Number.isInteger(row) || row < 0 || row >= state.players.length) return state
  const player = state.players.find((candidate) => candidate.id === playerId)
  if (!player || player.dead || player.row === row) return state
  const other = state.players.find((candidate) => candidate.row === row)
  return {
    ...state,
    players: state.players.map((candidate) =>
      candidate.id === playerId ? { ...candidate, row }
        : other && candidate.id === other.id ? { ...candidate, row: player.row }
          : candidate),
    log: [...state.log, `${player.name} moves to row ${row + 1} before the next combat.`],
  }
}

/** Start the already-reserved second A13 boss without consuming client input. */
export function startPendingBoss(state: RunState): RunState {
  if (state.phase !== 'betweenCombat' || !state.pendingBossDefId || state.combat ||
    hasPendingRelicAcquisition(state)) return state
  const next = preparePendingBossCombat(state, state.players, { ...state.rng })
  return {
    ...state,
    ...next,
    phase: 'combat',
    pendingBossDefId: null,
    rewards: [],
    rewardDestination: null,
    log: [...state.log, 'The second boss approaches.'],
  }
}

/** Leaves only a room whose printed interaction is already resolved. */
export function leaveRoom(state: RunState): RunState {
  if (state.phase !== 'room') return state
  if (state.roomState) return state
  return { ...state, phase: 'map' }
}

/**
 * Starts the next Act: a fresh map, and every player healed to full (p.4).
 * Ascension 6 changes the heal to 4 HP rather than full.
 */
export function advanceAct(state: RunState): RunState {
  if (state.phase !== 'victory' || hasPendingRelicAcquisition(state) || state.campaign.finalized) return state
  if (state.lastStand && state.players.some((player) => player.dead)) return state
  if (!isActComplete(state.map)) return state
  if (state.act >= 4) return state

  const rng = { ...state.rng }
  const requestedAct = state.act + 1
  if (requestedAct > 4) return state
  if (requestedAct === 4 && !canEnterActIV(state.campaignProgress, state.campaign.keys, state.act)) return state
  const act = requestedAct
  const players = state.players.map((player) => ({
    ...player,
    hp: Math.min(healingCapFor(player, state.meta.ruleset), state.ascension >= 6 ? player.hp + 4 : player.maxHp),
    // Skipped common/uncommon rewards are shuffled back between Acts; rares
    // deliberately keep their order (setup p.4).
    cardRewards: shuffle(rng, [...player.cardRewards]),
  }))

  const colorlessUnlocked = isColorlessUnlocked(state.campaignProgress)
  const baseMap = generateMap(rng, act, state.ascension)
  const map = act === 4
    ? baseMap
    : !isActIVUnlocked(state.campaignProgress) || state.campaign.keys.emerald
      ? baseMap
      : addBurningElite(rng, baseMap)
  return {
    ...state,
    rng,
    act,
    phase: 'map',
    map,
    enemyDecks: createEnemyDecks(rng, act, state.ascension),
    players,
    combat: null,
    pendingBossDefId: null,
    actBossDefId: rollActBoss(rng, act, state.meta.ruleset),
    selfBossRerolled: false,
    guardianGemDeck: shuffle(rng, [...(state.guardianGemDeck ?? [])]),
    eventDeck: act === 4 ? [] : buildEventDeck(rng, act as 1 | 2 | 3, state.ascension, colorlessUnlocked, state.meta.ruleset),
    eventsVisited: 0,
    roomState: null,
    eventCombat: null,
    log: [...state.log, `Act ${act} begins.`],
  }
}

/** Finalizes a completed/lost physical game exactly once and awards its marks. */
export function finishRun(state: RunState): RunState {
  if ((state.phase !== 'victory' && state.phase !== 'defeat') || state.campaign.finalized ||
    hasPendingRelicAcquisition(state)) return state
  const campaignProgress = finishCampaign(state.campaignProgress, {
    runId: state.campaign.runId,
    characters: state.players.map((player) => player.character),
    bossesDefeated: state.campaign.bossesDefeated,
    joinedAfterBosses: state.campaign.joinedAfterBosses,
    startedAtAct: state.campaign.startedAtAct,
    highestBossActDefeated: state.campaign.highestBossActDefeated,
    ascensionPlayed: state.ascension,
  })
  return { ...state, campaignProgress, campaign: { ...state.campaign, finalized: true } }
}

/** Rooms the party may move to right now, or none if it is not their choice. */
export function roomChoices(state: RunState): Room[] {
  if (state.phase !== 'map' || hasPendingRelicAcquisition(state)) return []
  const map = state.map
  if (map.position === null) {
    const first = map.rows[0]?.[0]
    const room = first ? map.rooms[first] : undefined
    return room ? [room] : []
  }
  const current = map.rooms[map.position]
  if (!current) return []
  return current.exits.map((id) => map.rooms[id]).filter((room): room is Room => room !== undefined)
}

/** Redacts unvisited map tokens for Uncertain Future without leaking their room kind. */
export function visibleMap(state: RunState): SpireMap {
  if (!hasModifier(state, 'uncertain_future')) return state.map
  const hasTokenMetadata = Object.values(state.map.rooms).some((room) => room.tokenBack)
  return {
    ...state.map,
    rooms: Object.fromEntries(Object.entries(state.map.rooms).map(([id, room]) => [id,
      room.visited || (hasTokenMetadata && !room.tokenBack)
      ? { ...room }
      : { ...room, kind: 'encounter' as const, burning: undefined, hidden: true }])),
  }
}

/** Unconnected rooms exactly one row above that Wing Boots may reach. */
export function wingBootChoices(state: RunState, playerId: string): Room[] {
  if (state.phase !== 'map' || state.map.position === null || hasPendingRelicAcquisition(state)) return []
  const player = state.players.find((candidate) => candidate.id === playerId && !candidate.dead)
  if (!player?.relics.some((relic) => relic.defId === 'wing_boots' && (relic.uses ?? 0) > 0)) return []
  const current = state.map.rooms[state.map.position]
  if (!current) return []
  const normal = new Set(current.exits)
  return (state.map.rows[current.row + 1] ?? [])
    .filter((id) => !normal.has(id))
    .map((id) => state.map.rooms[id])
    .filter((room): room is Room => room !== undefined)
}
