// Quick Start: skip the opening and deal the run a few rooms in.
//
// The table works through one unit at a time — a card reward, a rare card, a
// potion, a relic — so the sequence is resumable between units.
import { createEnemyDecks, rollActBoss } from './encounters.ts'
import { availableRewardSources } from './rewards.ts'
import { canUpgradeCard, hasModifier, hasPendingRelicAcquisition, nextRunUid } from './rules.ts'
import { merchantItemDecks } from './supplies.ts'
import type { CardRewardOffer, RewardSource, RunState } from './types.ts'
import { queueNewGuardianSockets } from './guardian-gems.ts'
import { gainGold, removeCard, transformCard, upgradeCard } from '../acquisition.ts'
import { isActIVUnlocked, isColorlessUnlocked } from '../campaign.ts'
import { cardIsCurse } from '../cards.ts'
import { buildEventDeck } from '../events.ts'
import { addBurningElite, generateMap } from '../map.ts'
import { QUICK_START_TABLE, currentQuickSetupStep } from '../meta.ts'
import type { QuickSetupState } from '../meta.ts'
import { createMerchant } from '../noncombat.ts'
import { bossRelicOfferSize } from '../relics.ts'
import { nextInt } from '../rng.ts'

export function finishQuickSetup(state: RunState): RunState {
  const setup = state.setup
  if (!setup) return state
  if (setup.kind === 'catch-up') return {
    ...state,
    phase: 'map',
    setup: null,
    roomState: null,
    log: [...state.log, `Catch Up for Act ${setup.targetAct} is complete.`],
  }
  const rng = { ...state.rng }
  const act = setup.targetAct
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
    setup: null,
    map,
    enemyDecks: createEnemyDecks(rng, act, state.ascension),
    actBossDefId: rollActBoss(rng, act, state.meta.ruleset),
    selfBossRerolled: false,
    eventDeck: act === 4 ? [] : buildEventDeck(rng, act, state.ascension, colorlessUnlocked, state.meta.ruleset),
    eventsVisited: 0,
    roomState: null,
    log: [...state.log, `Quick Start for Act ${act} is complete.`],
  }
}

function advanceSetupUnit(setup: QuickSetupState): QuickSetupState | null {
  const row = QUICK_START_TABLE[setup.targetAct][setup.rowIndex]
  if (!row) return null
  if (setup.die) {
    const effects = currentQuickSetupStep(setup)
    const nextEffect = { ...setup, die: { ...setup.die, effectIndex: setup.die.effectIndex + 1 } }
    if (effects && currentQuickSetupStep(nextEffect)) return nextEffect
    setup = { ...setup, die: null }
  }
  const playerSpecific = !['bossRelic', 'merchant'].includes(row.kind)
  const repeats = row.kind === 'gold' || row.kind === 'merchant' ? 1 : row.count
  if (playerSpecific && setup.playerIndex + 1 < setup.playerIds.length) {
    return { ...setup, playerIndex: setup.playerIndex + 1 }
  }
  if (setup.repeatIndex + 1 < repeats) {
    return { ...setup, repeatIndex: setup.repeatIndex + 1, playerIndex: 0 }
  }
  const next = { ...setup, rowIndex: setup.rowIndex + 1, repeatIndex: 0, playerIndex: 0, die: null }
  return QUICK_START_TABLE[setup.targetAct][next.rowIndex] ? next : null
}

function withAdvancedSetup(state: RunState): RunState {
  if (!state.setup) return state
  const setup = advanceSetupUnit(state.setup)
  return setup ? { ...state, setup } : finishQuickSetup(state)
}

function setupOffer(playerId: string, kind: 'cardReward' | 'rareReward' | 'potion' | 'relic', transformed = false, availableSources?: RewardSource[]): CardRewardOffer {
  const transformReward = kind === 'cardReward' && transformed
  return {
    playerId,
    cardReward: !transformReward && (kind === 'cardReward' || kind === 'rareReward'),
    transformReward,
    choices: kind === 'cardReward' || kind === 'rareReward' ? null : [],
    upgraded: false,
    cardSource: kind === 'rareReward' ? 'rare' : 'ordinary',
    prismatic: Boolean(availableSources),
    availableSources,
    potion: kind === 'potion' ? null : false,
    relic: kind === 'relic' ? null : false,
    bossRelics: false,
  }
}

/** Resolve one authoritative Quick Start / Catch Up step without revealing future rewards. */
export function advanceQuickSetup(state: RunState, cardUids: readonly string[] = []): RunState {
  const setup = state.setup
  const step = setup ? currentQuickSetupStep(setup) : null
  if (state.phase !== 'setup' || !setup || !step || hasPendingRelicAcquisition(state) ||
    new Set(cardUids).size !== cardUids.length) return state
  const playerId = setup.playerIds[setup.playerIndex]
  const player = state.players.find((candidate) => candidate.id === playerId && !candidate.dead)
  if (!player && !['bossRelic', 'merchant'].includes(step.kind)) return state

  if (step.kind === 'rollDie') {
    if (cardUids.length > 0 || setup.die) return state
    const rng = { ...state.rng }
    return { ...state, rng, setup: { ...setup, die: { value: (nextInt(rng, 6) + 1) as 1 | 2 | 3 | 4 | 5 | 6, effectIndex: 0 } } }
  }

  if (step.kind === 'cardReward' || step.kind === 'rareReward' || step.kind === 'potion' || step.kind === 'relic') {
    if (cardUids.length > 0 || !playerId) return state
    const next = withAdvancedSetup(state)
    return {
      ...next,
      phase: 'reward',
      rewardDestination: 'setup',
      rewards: [setupOffer(playerId, step.kind, hasModifier(state, 'transformed'),
        player?.relics.some((relic) => relic.defId === 'prismatic_shard') && !hasModifier(state, 'transformed') &&
          (step.kind === 'cardReward' || step.kind === 'rareReward')
          ? availableRewardSources(state, step.kind === 'rareReward') : undefined)],
    }
  }

  if (step.kind === 'bossRelic') {
    if (cardUids.length > 0) return state
    const choices = state.bossRelicDeck.slice(0, bossRelicOfferSize(setup.playerIds.length))
    const next = withAdvancedSetup({ ...state, bossRelicDeck: state.bossRelicDeck.slice(choices.length) })
    return {
      ...next,
      phase: 'reward',
      rewardDestination: 'setup',
      rewards: setup.playerIds.map((id) => ({
        playerId: id, cardReward: false, choices: [], upgraded: false,
        potion: false, relic: false, bossRelics: [...choices],
      })),
    }
  }

  if (step.kind === 'merchant') {
    if (cardUids.length > 0) return state
    const players = setup.kind === 'catch-up'
      ? state.players.filter((player) => setup.playerIds.includes(player.id)) : state.players
    const guardianGemDeck = [...(state.guardianGemDeck ?? [])]
    return { ...state, phase: 'room', guardianGemDeck,
      roomState: createMerchant(merchantItemDecks(state, state.itemDecks), players, guardianGemDeck,
        state.meta.ruleset) }
  }

  if (!player) return state
  let owner = player
  if (step.kind === 'gold') {
    if (cardUids.length > 0) return state
    owner = gainGold(owner, step.count)
  } else {
    const eligible = step.kind === 'upgrade' ? owner.deck.filter(canUpgradeCard)
      : step.kind === 'cardRemove' ? owner.deck.filter((card) => card.defId !== 'ascenders_bane')
        : owner.deck.filter((card) => !cardIsCurse(card.defId))
    const required = Math.min(1, eligible.length)
    if (cardUids.length !== required || cardUids.some((uid) => !eligible.some((card) => card.uid === uid))) return state
    const uid = cardUids[0]
    if (uid && step.kind === 'upgrade') owner = upgradeCard(owner, uid)
    else if (uid && step.kind === 'cardRemove') owner = removeCard(owner, uid)
    else if (uid) owner = transformCard(state.rng, owner, uid, `c${nextRunUid(state.players)}`)
  }
  return queueNewGuardianSockets(state,
    withAdvancedSetup({ ...state, players: state.players.map((candidate) => candidate.id === owner.id ? owner : candidate) }))
}
