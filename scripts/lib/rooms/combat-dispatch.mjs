// Combat-phase player action validation and engine dispatch.

import {
  activatePotion,
  activatePower,
  activateRelic,
  advanceAct,
  cardDef,
  cardShivChoiceCount,
  chooseDistilledCard,
  choosePendingRelicReward,
  currentRoom,
  enemyTurn,
  enterRoom,
  faceOf,
  leaveRoom,
  playCard,
  playCardCopy,
  playHermitChamberCard,
  potionDef,
  rerollDownfallSelfBoss,
  resolveBossRelicReward,
  resolveCombat,
  resolveGoldReward,
  resolveHermitSetupLoad,
  resolveHermitStrengthReward,
  resolvePendingDieRelicChoice,
  resolvePendingPlayerChoice,
  resolvePendingRelic,
  resolvePlunderRowSwitch,
  resolvePotionReward,
  resolveRelicReward,
  resolveSlayerChoice,
  spendMiracle,
  spendShiv,
  spendSoulburn,
  spendVigor,
  startPendingBoss,
  startPlayerTurnWithChoices,
  switchBetweenCombatRow,
  tradePotion,
  usePotionOutsideCombat,
} from '../../../src/game/state.ts'
import { finishCardPlayWindow } from '../../../src/game/combat/play.ts'
import { fail, hermitDieRelicList, overflowChoices, slotList, targetList, uidList } from './shared.mjs'
import { playWithReservedRng } from './previews.mjs'

export function dispatch(run, seat, action, lockedPreview) {
  switch (action?.kind) {
    case 'playCard':
    case 'playCardCopy': {
      if (!run.combat) fail('No combat in progress')
      const copied = action.kind === 'playCardCopy'
      if (copied && action.copyId !== run.combat.pendingCardCopy?.id) return run
      // A seat may only play cards from its OWN hand. Without this check any
      // client could spend another player's energy and empty their hand.
      const player = run.combat.players.find((candidate) => candidate.id === seat.playerId)
      const card = copied && run.combat.pendingCardCopy?.playerId === seat.playerId
        ? run.combat.pendingCardCopy.card
        : player?.hand.find((held) => held.uid === action.cardUid)
      if (!card) fail(copied ? 'No original card is waiting for you' : 'That card is not in your hand')
      const def = faceOf(cardDef(card.defId), card.upgraded)
      const cardsOutsidePlay = player.hand.length - Number(!copied)
      const variableDiscard = def.effects.some((effect) => effect.kind === 'discardAny')
      const variableExhaust = def.effects.find((effect) => effect.kind === 'exhaustAny')
      const discardUids = variableDiscard ? action.discardUids : uidList(action.discardUids)
      if (action.discardUids !== undefined && (
        !Array.isArray(action.discardUids) ||
        (variableDiscard
          ? action.discardUids.length > cardsOutsidePlay || action.discardUids.some((uid) => typeof uid !== 'string')
          : discardUids.length !== action.discardUids.length)
      )) fail('Discard choices must be a valid list of card ids')
      const exhaustUids = uidList(action.exhaustUids) ?? []
      if (action.exhaustUids !== undefined && (
        !Array.isArray(action.exhaustUids) || exhaustUids.length !== action.exhaustUids.length ||
        (variableExhaust && action.exhaustUids.length > variableExhaust.amount)
      )) fail('Exhaust choices must be a valid list of card ids')
      if (variableExhaust && exhaustUids.length < Math.min(
        variableExhaust.minimum ?? 0,
        Math.max(0, cardsOutsidePlay),
      )) fail('Choose the minimum number of cards to Exhaust')
      const shivEffects = def.type === 'power' && def.trigger && def.resolvesOnPlay !== true ? [] : def.effects
      const mandatoryShivs = cardShivChoiceCount(def, player, action.mode)
      const { overflow, targets: shivEnemyUids } = overflowChoices(run.combat, shivEffects, {
        ...action, discardUids,
      }, mandatoryShivs)
      const enemyUids = uidList(action.enemyUids)
      const playerIds = uidList(action.playerIds)
      if (action.enemyUids !== undefined && (
        !Array.isArray(action.enemyUids) || enemyUids.length !== action.enemyUids.length
      )) fail('Enemy choices must be a list of ids')
      if (action.playerIds !== undefined && (
        !Array.isArray(action.playerIds) || playerIds.length !== action.playerIds.length
      )) fail('Player choices must be a list of ids')
      const scryDiscardUids = uidList(action.scryDiscardUids)
      if (action.scryDiscardUids !== undefined && (
        !Array.isArray(action.scryDiscardUids) || scryDiscardUids.length !== action.scryDiscardUids.length
      )) fail('Scry choices must be a list of card ids')
      const topdeckUids = uidList(action.topdeckUids)
      if (action.topdeckUids !== undefined && (
        !Array.isArray(action.topdeckUids) || topdeckUids.length !== action.topdeckUids.length
      )) fail('Topdeck choices must be a list of card ids')
      const searchDrawUids = uidList(action.searchDrawUids)
      if (action.searchDrawUids !== undefined && (
        !Array.isArray(action.searchDrawUids) || searchDrawUids.length !== action.searchDrawUids.length
      )) fail('Draw-pile choices must be a list of card ids')
      const recoverDiscardUid = action.recoverDiscardUid
      if (recoverDiscardUid !== undefined && typeof recoverDiscardUid !== 'string') {
        fail('Discard recovery must be a card id')
      }
      const recoverDiscardUids = uidList(action.recoverDiscardUids)
      if (action.recoverDiscardUids !== undefined && (
        !Array.isArray(action.recoverDiscardUids) || recoverDiscardUids.length !== action.recoverDiscardUids.length
      )) fail('Discard recovery must be a list of card ids')
      if (recoverDiscardUid !== undefined && action.recoverDiscardUids !== undefined) {
        fail('Discard recovery must use one choice format')
      }
      const recoverExhaustUid = action.recoverExhaustUid
      if (recoverExhaustUid !== undefined && typeof recoverExhaustUid !== 'string') {
        fail('Exhaust recovery must be a card id')
      }
      const recoverExhaustUids = uidList(action.recoverExhaustUids)
      if (action.recoverExhaustUids !== undefined && (
        !Array.isArray(action.recoverExhaustUids) || recoverExhaustUids.length !== action.recoverExhaustUids.length
      )) fail('Exhaust recovery must be a list of card ids')
      if (recoverExhaustUid !== undefined && action.recoverExhaustUids !== undefined) {
        fail('Exhaust recovery must use one choice format')
      }
      if (action.energySpent !== undefined && !Number.isInteger(action.energySpent)) {
        fail('X Energy must be a whole number')
      }
      if (action.corruptedShardMode !== undefined && action.corruptedShardMode !== 'attack' && action.corruptedShardMode !== 'defense') {
        fail('Corrupted Shard Mode must be attack or defense')
      }
      const loadUids = uidList(action.loadUids)
      const chamberUids = uidList(action.chamberUids)
      const hermitEnemyUids = uidList(action.hermitEnemyUids)
      const slimeUids = uidList(action.slimeUids)
      const slimeEnemyUids = uidList(action.slimeEnemyUids)
      const soulburnEnemyUids = uidList(action.soulburnEnemyUids)
      const hermitDieRelics = hermitDieRelicList(action.hermitDieRelics)
      if (action.hermitDieRelics !== undefined && hermitDieRelics?.length !== action.hermitDieRelics.length) {
        fail('Cheat choices must identify valid die-relic abilities')
      }
      for (const [label, original, sanitized] of [
        ['Load', action.loadUids, loadUids],
        ['Chamber', action.chamberUids, chamberUids],
        ['Hermit enemy', action.hermitEnemyUids, hermitEnemyUids],
        ['Slime', action.slimeUids, slimeUids],
        ['Slime enemy', action.slimeEnemyUids, slimeEnemyUids],
        ['Soulburn enemy', action.soulburnEnemyUids, soulburnEnemyUids],
      ]) if (original !== undefined && (!Array.isArray(original) || sanitized.length !== original.length)) {
        fail(`${label} choices must be a list of ids`)
      }
      for (const [label, value] of [
        ['Vigor spend', action.spendVigor],
        ['Guardian Block spend', action.guardianBlockSpend],
      ]) if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
        fail(`${label} must be a non-negative whole number`)
      }
      if (action.guardianModeShift !== undefined && typeof action.guardianModeShift !== 'boolean') {
        fail('Guardian Mode shift must be true or false')
      }
      if (action.guardianPowerCardUid !== undefined && typeof action.guardianPowerCardUid !== 'string') {
        fail('Power Beam must identify a Power card')
      }
      const context = {
        enemyUid: action.enemyUid ?? null,
        enemyUids,
        playerId: action.playerId ?? seat.playerId,
        energySpent: action.energySpent,
        playerIds,
        switchWithPlayerId: action.switchWithPlayerId ?? null,
        mode: action.mode,
        corruptedShardMode: action.corruptedShardMode,
        // Coerced, not trusted: these arrive as JSON from a socket, and a
        // string where a list belongs threw a raw TypeError out of `apply`
        // instead of being refused like any other bad message.
        discardUids,
        exhaustUids,
        spendMiracle: action.spendMiracle === true,
        shivEnemyUids,
        // Both of these are real choices the rules grant (p.16, p.24). Dropping
        // them here made a Scry unable to bin anything and an orb evoke always
        // fall back to the first filled slot.
        scryDiscardUids,
        scryToHandUid: typeof action.scryToHandUid === 'string' ? action.scryToHandUid : undefined,
        topdeckUids,
        searchDrawUids,
        recoverDiscardUid,
        recoverDiscardUids,
        recoverExhaustUid,
        recoverExhaustUids,
        loadUids,
        chamberUids,
        hermitEnemyUids,
        slimeUids,
        slimeEnemyUids,
        soulburnEnemyUids,
        hermitDieRelics,
        chooseLoadSelf: action.chooseLoadSelf === true,
        spendVigor: action.spendVigor,
        guardianModeShift: action.guardianModeShift === true,
        secondGuardianModeShift: action.secondGuardianModeShift === true,
        guardianBlockSpend: action.guardianBlockSpend,
        guardianPowerCardUid: action.guardianPowerCardUid,
        evokeSlots: slotList(action.evokeSlots),
        evokeEnemyUids: targetList(action.evokeEnemyUids),
        // Slayer Pack: Metamorphosis's chosen Power; the engine rejects anything else.
        metamorphosisPowerUid: typeof action.metamorphosisPowerUid === 'string' ? action.metamorphosisPowerUid : undefined,
      }
      const combat = playWithReservedRng(run.combat, lockedPreview, (state) => copied
        ? playCardCopy(state, seat.playerId, context)
        : playCard(state, seat.playerId, action.cardUid, context))
      if (combat === run.combat && overflow > 0 && shivEnemyUids.length > mandatoryShivs) {
        const withoutOverflowTargets = playWithReservedRng(run.combat, lockedPreview, (state) => copied
          ? playCardCopy(state, seat.playerId, {
            ...context, shivEnemyUids: shivEnemyUids.slice(0, mandatoryShivs),
          })
          : playCard(state, seat.playerId, action.cardUid, {
            ...context, shivEnemyUids: shivEnemyUids.slice(0, mandatoryShivs),
          }))
        if (withoutOverflowTargets !== run.combat) {
          fail('An earlier overflow Shiv defeated a later target; choose targets again')
        }
      }
      if (combat === run.combat && action.preflight === true) {
        fail('That card play is no longer legal; choose again')
      }
      return combat === run.combat ? run : { ...run, combat }
    }

    case 'playHermitChamberCard': {
      if (!run.combat || typeof action.cardUid !== 'string') fail('No matching Chamber card in combat')
      const player = run.combat.players.find((candidate) => candidate.id === seat.playerId)
      const card = player?.chamber.find((held) => held.uid === action.cardUid)
      if (!player) fail('That Chamber card is not yours')
      if (!card) {
        const pending = run.combat.pendingHermitChamberPlays?.[0]
        if (pending?.playerId !== seat.playerId || pending.cardUids[0] !== action.cardUid) {
          fail('That Chamber card is not yours')
        }
        const combat = playHermitChamberCard(run.combat, seat.playerId, action.cardUid)
        return combat === run.combat ? run : { ...run, combat }
      }
      const def = faceOf(cardDef(card.defId), card.upgraded)
      const variableDiscard = def.effects.some((effect) => effect.kind === 'discardAny')
      const variableExhaust = def.effects.find((effect) => effect.kind === 'exhaustAny')
      const discardUids = variableDiscard ? action.discardUids : uidList(action.discardUids)
      const exhaustUids = uidList(action.exhaustUids) ?? []
      if (action.discardUids !== undefined && (!Array.isArray(action.discardUids) ||
        (variableDiscard ? action.discardUids.length > player.hand.length : discardUids.length !== action.discardUids.length))) {
        fail('Discard choices must be a valid list of card ids')
      }
      if (action.exhaustUids !== undefined && (!Array.isArray(action.exhaustUids) ||
        exhaustUids.length !== action.exhaustUids.length ||
        (variableExhaust && action.exhaustUids.length > player.hand.length))) {
        fail('Exhaust choices must be a valid list of card ids')
      }
      if (variableExhaust && exhaustUids.length < Math.min(variableExhaust.minimum ?? 0, player.hand.length)) {
        fail('Choose the minimum number of cards to Exhaust')
      }
      const lists = Object.fromEntries([
        'enemyUids', 'playerIds', 'scryDiscardUids', 'topdeckUids', 'searchDrawUids',
        'recoverDiscardUids', 'recoverExhaustUids', 'loadUids', 'chamberUids', 'hermitEnemyUids', 'slimeUids',
        'slimeEnemyUids',
        'soulburnEnemyUids',
      ].map((key) => [key, uidList(action[key])]))
      for (const key of Object.keys(lists)) if (action[key] !== undefined &&
        (!Array.isArray(action[key]) || lists[key]?.length !== action[key].length)) {
        fail(`${key} must be a list of ids`)
      }
      if (action.recoverDiscardUid !== undefined && typeof action.recoverDiscardUid !== 'string') {
        fail('Discard recovery must be a card id')
      }
      if (action.recoverExhaustUid !== undefined && typeof action.recoverExhaustUid !== 'string') {
        fail('Exhaust recovery must be a card id')
      }
      if (action.recoverExhaustUid !== undefined && action.recoverExhaustUids !== undefined) {
        fail('Exhaust recovery must use one choice format')
      }
      if (action.recoverDiscardUid !== undefined && action.recoverDiscardUids !== undefined) {
        fail('Discard recovery must use one choice format')
      }
      if (action.energySpent !== undefined && !Number.isInteger(action.energySpent)) fail('X Energy must be a whole number')
      if (action.corruptedShardMode !== undefined && action.corruptedShardMode !== 'attack' &&
        action.corruptedShardMode !== 'defense') fail('Corrupted Shard Mode must be attack or defense')
      if (action.guardianPowerCardUid !== undefined && typeof action.guardianPowerCardUid !== 'string') {
        fail('Power Beam must identify a Power card')
      }
      for (const [label, value] of [
        ['Vigor spend', action.spendVigor], ['Guardian Block spend', action.guardianBlockSpend],
      ]) if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
        fail(`${label} must be a non-negative whole number`)
      }
      const hermitDieRelics = hermitDieRelicList(action.hermitDieRelics)
      if (action.hermitDieRelics !== undefined && hermitDieRelics?.length !== action.hermitDieRelics.length) {
        fail('Cheat choices must identify valid die-relic abilities')
      }
      const mandatoryShivs = cardShivChoiceCount(def, player, action.mode)
      const { targets: shivEnemyUids } = overflowChoices(run.combat, def.effects, {
        ...action, discardUids,
      }, mandatoryShivs)
      const combat = playWithReservedRng(run.combat, lockedPreview, (state) => playHermitChamberCard(
        state, seat.playerId, action.cardUid, {
        enemyUid: typeof action.enemyUid === 'string' ? action.enemyUid : null,
        enemyUids: lists.enemyUids,
        playerId: typeof action.playerId === 'string' ? action.playerId : seat.playerId,
        playerIds: lists.playerIds,
        energySpent: Number.isInteger(action.energySpent) ? action.energySpent : undefined,
        mode: Number.isInteger(action.mode) ? action.mode : undefined,
        switchWithPlayerId: typeof action.switchWithPlayerId === 'string' ? action.switchWithPlayerId : null,
        corruptedShardMode: action.corruptedShardMode,
        discardUids,
        exhaustUids,
        spendMiracle: action.spendMiracle === true,
        shivEnemyUids,
        scryDiscardUids: lists.scryDiscardUids,
        scryToHandUid: typeof action.scryToHandUid === 'string' ? action.scryToHandUid : undefined,
        topdeckUids: lists.topdeckUids,
        searchDrawUids: lists.searchDrawUids,
        recoverDiscardUid: action.recoverDiscardUid,
        recoverDiscardUids: lists.recoverDiscardUids,
        recoverExhaustUid: action.recoverExhaustUid,
        recoverExhaustUids: lists.recoverExhaustUids,
        loadUids: lists.loadUids,
        chamberUids: lists.chamberUids,
        hermitEnemyUids: lists.hermitEnemyUids,
        slimeUids: lists.slimeUids,
        slimeEnemyUids: lists.slimeEnemyUids,
        soulburnEnemyUids: lists.soulburnEnemyUids,
        hermitDieRelics,
        chooseLoadSelf: action.chooseLoadSelf === true,
        spendVigor: action.spendVigor,
        guardianModeShift: action.guardianModeShift === true,
        secondGuardianModeShift: action.secondGuardianModeShift === true,
        guardianBlockSpend: action.guardianBlockSpend,
        guardianPowerCardUid: action.guardianPowerCardUid,
        evokeSlots: slotList(action.evokeSlots),
        evokeEnemyUids: targetList(action.evokeEnemyUids),
        metamorphosisPowerUid: typeof action.metamorphosisPowerUid === 'string' ? action.metamorphosisPowerUid : undefined,
      }))
      if (combat === run.combat && action.preflight === true) fail('That Chamber play is no longer legal')
      return combat === run.combat ? run : { ...run, combat }
    }

    case 'resolveHermitSetupLoad': {
      if (!run.combat || typeof action.cardUid !== 'string') fail('No Hermit setup Load is pending')
      const combat = resolveHermitSetupLoad(run.combat, seat.playerId, action.cardUid,
        typeof action.enemyUid === 'string' ? action.enemyUid : null)
      if (combat === run.combat) fail('That Hermit setup Load is no longer legal')
      return { ...run, combat }
    }

    case 'resolveDieRelicChoice': {
      if (!run.combat) fail('No die Relic choice is pending')
      if (!Number.isInteger(action.choiceId)) fail('Die Relic choice id must be a whole number')
      if (action.enemyUid !== undefined && action.enemyUid !== null && typeof action.enemyUid !== 'string') {
        fail('Die Relic enemy must be a valid id')
      }
      const discardUids = uidList(action.discardUids)
      const exhaustUids = uidList(action.exhaustUids)
      for (const [label, original, sanitized] of [
        ['Discard', action.discardUids, discardUids], ['Exhaust', action.exhaustUids, exhaustUids],
      ]) if (original !== undefined && (!Array.isArray(original) || sanitized.length !== original.length)) {
        fail(`${label} choices must be a list of card ids`)
      }
      const combat = resolvePendingDieRelicChoice(run.combat, seat.playerId, {
        choiceId: action.choiceId, discardUids, exhaustUids, enemyUid: action.enemyUid ?? null,
      })
      if (combat === run.combat) fail('That die Relic choice is no longer legal')
      return { ...run, combat }
    }

    // Slayer Pack: Heel Hook's draw/discard and Magnetism's return answer.
    case 'resolvePlayerChoice': {
      if (!run.combat || !Number.isInteger(action.choiceId)) fail('No card choice is pending')
      // Only the answer's own fields (and the transport's envelope) may arrive.
      if (Object.keys(action).some((key) =>
        !['kind', 'choiceId', 'draw', 'discardUid', 'count', 'type', 'requestId', 'preflight'].includes(key))) {
        fail('A card choice answer carries only draw, discardUid or count')
      }
      if (action.draw !== undefined && typeof action.draw !== 'boolean') fail('Draw must be true or false')
      if (action.discardUid !== undefined && typeof action.discardUid !== 'string') fail('Discard must be a card id')
      if (action.count !== undefined && !Number.isSafeInteger(action.count)) fail('Count must be a whole number')
      const combat = resolvePendingPlayerChoice(run.combat, seat.playerId, {
        choiceId: action.choiceId, draw: action.draw, discardUid: action.discardUid, count: action.count,
      })
      if (combat === run.combat) fail('That card choice is no longer legal')
      return { ...run, combat }
    }

    case 'resolveHermitStrengthReward': {
      if (!run.combat || typeof action.playerId !== 'string') fail('No Hermit Strength reward is pending')
      const combat = resolveHermitStrengthReward(run.combat, seat.playerId, action.playerId)
      if (combat === run.combat) fail('That Hermit Strength reward is no longer legal')
      return { ...run, combat }
    }

    case 'resolveSlayerChoice': {
      if (!run.combat) fail('No Slayer Pack choice is pending')
      if (action.enemyUid !== undefined && action.enemyUid !== null && typeof action.enemyUid !== 'string') {
        fail('A Nightmare target must be an enemy id')
      }
      if (action.replace !== undefined && typeof action.replace !== 'boolean') fail('Replace must be true or false')
      // Each answer names its choice, so a repeated or stale one cannot resolve the owner's next. An id is
      // absent only for a choice saved before ids existed.
      if (action.choiceId !== undefined && !Number.isSafeInteger(action.choiceId)) fail('The choice id must be a whole number')
      const combat = resolveSlayerChoice(run.combat, seat.playerId, {
        ...(action.choiceId !== undefined ? { choiceId: action.choiceId } : {}),
        ...(action.enemyUid !== undefined ? { enemyUid: action.enemyUid } : {}),
        ...(action.replace !== undefined ? { replace: action.replace } : {}),
      })
      if (combat === run.combat) fail('That choice is no longer legal')
      return { ...run, combat }
    }

    case 'activatePower': {
      if (!run.combat) fail('No combat in progress')
      const loadUids = uidList(action.loadUids)
      const chamberUids = uidList(action.chamberUids)
      const hermitEnemyUids = uidList(action.hermitEnemyUids)
      const scryDiscardUids = uidList(action.scryDiscardUids)
      const exhaustUids = uidList(action.exhaustUids)
      for (const [label, original, sanitized] of [
        ['Load', action.loadUids, loadUids],
        ['Chamber', action.chamberUids, chamberUids],
        ['Hermit enemy', action.hermitEnemyUids, hermitEnemyUids],
        ['Scry', action.scryDiscardUids, scryDiscardUids],
        ['Exhaust', action.exhaustUids, exhaustUids],
      ]) if (original !== undefined && (!Array.isArray(original) || sanitized.length !== original.length)) {
        fail(`${label} choices must be a list of ids`)
      }
      const combat = activatePower(run.combat, seat.playerId, action.powerUid, {
        enemyUid: action.enemyUid ?? null,
        enemyRow: Number.isInteger(action.enemyRow) ? action.enemyRow : null,
        playerId: typeof action.playerId === 'string' ? action.playerId : null,
        exhaustUids,
        guardianModeShift: action.guardianModeShift === true,
        loadUids,
        chamberUids,
        hermitEnemyUids,
        scryDiscardUids,
        cardUid: typeof action.cardUid === 'string' ? action.cardUid : undefined,
        orbSlots: slotList(action.orbSlots),
      })
      if (combat === run.combat && action.preflight === true) {
        fail('That Power ability is no longer legal; choose again')
      }
      return combat === run.combat ? run : { ...run, combat }
    }
    case 'activateRelic': {
      if (!run.combat || !Number.isInteger(action.relicIndex)) fail('No matching Relic in combat')
      const player = run.combat.players.find((candidate) => candidate.id === seat.playerId)
      if (!player?.relics[action.relicIndex]) fail('That Relic is not yours')
      const combat = activateRelic(run.combat, seat.playerId, action.relicIndex, {
        enemyUid: action.enemyUid ?? null,
        targetPlayerId: typeof action.targetPlayerId === 'string' ? action.targetPlayerId : null,
        cardUids: Array.isArray(action.cardUids) ? action.cardUids : [],
        targetRelicPlayerId: action.targetRelicPlayerId,
        targetRelicIndex: action.targetRelicIndex,
        targetAbilityIndex: action.targetAbilityIndex,
        die: action.die,
        scryDiscardUids: Array.isArray(action.scryDiscardUids)
          ? action.scryDiscardUids.filter((uid) => typeof uid === 'string')
          : undefined,
        shivEnemyUids: Array.isArray(action.shivEnemyUids)
          ? action.shivEnemyUids.filter((uid) => typeof uid === 'string')
          : undefined,
        discardPotionId: typeof action.discardPotionId === 'string' ? action.discardPotionId : undefined,
      })
      if (combat === run.combat) fail('That Relic activation is not legal')
      return { ...run, combat }
    }
    case 'resolvePendingRelic': {
      if (!Number.isInteger(action.pendingRelicId)) fail('Pending Relic choice needs its acquisition id')
      const next = resolvePendingRelic(run, seat.playerId,
        Array.isArray(action.cardUids) ? action.cardUids : [],
        Array.isArray(action.rewardIndices) ? action.rewardIndices : [], action.pendingRelicId)
      if (next === run) fail('That Relic choice is not legal')
      return next
    }
    case 'choosePendingRelicReward': {
      if (!Number.isInteger(action.pendingRelicId)) fail('Pending Relic reward needs its acquisition id')
      const next = choosePendingRelicReward(
        run, seat.playerId, action.reward, action.choice, action.pendingRelicId,
      )
      if (next === run) fail('That Relic reward choice is not legal')
      return next
    }

    // The turn is shared, so any seat may advance it — at the table this is
    // one player asking "everyone done?" and nobody objecting.
    case 'startTurn': {
      if (!run.combat) fail('No combat in progress')
      const combat = startPlayerTurnWithChoices(run.combat)
      return combat === run.combat ? run : { ...run, combat }
    }
    case 'resolveEnemies': {
      if (!run.combat) fail('No combat in progress')
      const combat = enemyTurn(run.combat)
      return combat === run.combat ? run : { ...run, combat }
    }

    case 'resolveCombat':
      return resolveCombat(run)
    case 'spendMiracle': {
      if (!run.combat) fail('No combat in progress')
      const combat = spendMiracle(run.combat, seat.playerId)
      return combat === run.combat ? run : { ...run, combat }
    }
    // Slayer Pack: The owner ends a "play any number" card-play window.
    case 'finishCardPlayWindow': {
      if (!run.combat || typeof action.windowId !== 'string') fail('No card-play window is open')
      const combat = finishCardPlayWindow(run.combat, seat.playerId, action.windowId)
      if (combat === run.combat) fail('That card-play window cannot be finished now')
      return { ...run, combat }
    }
    case 'chooseDistilledCard': {
      if (!run.combat) fail('No combat in progress')
      const combat = chooseDistilledCard(run.combat, seat.playerId, action.cardUid)
      if (combat === run.combat) fail('That Distilled Chaos choice is not legal')
      return { ...run, combat }
    }
    case 'spendShiv': {
      if (!run.combat) fail('No combat in progress')
      const combat = spendShiv(run.combat, seat.playerId, action.enemyUid)
      if (combat === run.combat) fail('That Shiv target is no longer legal')
      return { ...run, combat }
    }
    case 'spendVigor': {
      if (!run.combat) fail('No combat in progress')
      const combat = spendVigor(run.combat, seat.playerId)
      if (combat === run.combat) fail('Vigor cannot be spent right now')
      return { ...run, combat }
    }
    case 'spendSoulburn': {
      if (!run.combat || typeof action.enemyUid !== 'string' ||
        (action.extraCrispyPowerUid !== undefined && typeof action.extraCrispyPowerUid !== 'string')) {
        fail('Soulburn needs a valid enemy and optional Extra Crispy Power')
      }
      const combat = spendSoulburn(run.combat, seat.playerId, action.enemyUid, action.extraCrispyPowerUid)
      if (combat === run.combat) fail('That Soulburn target is no longer legal')
      return { ...run, combat }
    }
    case 'resolvePlunderRowSwitch': {
      if (!run.combat || action.row !== null && !Number.isInteger(action.row)) {
        fail('Plunder row must be a row number or null')
      }
      const combat = resolvePlunderRowSwitch(run.combat, seat.playerId, action.row)
      if (combat === run.combat) fail('That Plunder row choice is no longer legal')
      return { ...run, combat }
    }
    case 'usePotion': {
      if (!run.combat) fail('No combat in progress')
      const player = run.combat.players.find((candidate) => candidate.id === seat.playerId)
      if (typeof action.potionId !== 'string' || !player?.potions.includes(action.potionId)) {
        fail('That potion is not yours')
      }
      const def = potionDef(action.potionId)
      const { overflow, targets: shivEnemyUids } = overflowChoices(run.combat, def.effects, action)
      const combat = activatePotion(
        run.combat,
        seat.playerId,
        action.potionId,
        {
          enemyUid: action.enemyUid ?? null,
          targetPlayerId: action.targetPlayerId ?? null,
          enemyRow: Number.isInteger(action.enemyRow) ? action.enemyRow : null,
          shivEnemyUids,
          recoverDiscardUid: typeof action.recoverDiscardUid === 'string' ? action.recoverDiscardUid : undefined,
          exhaustUids: Array.isArray(action.exhaustUids)
            ? action.exhaustUids.filter((uid) => typeof uid === 'string')
            : undefined,
          die: Number.isInteger(action.die) ? action.die : undefined,
          replacePotionId: typeof action.replacePotionId === 'string' ? action.replacePotionId : undefined,
          transformHandUid: typeof action.transformHandUid === 'string' ? action.transformHandUid : undefined,
          recoverExhaustUid: typeof action.recoverExhaustUid === 'string' ? action.recoverExhaustUid : undefined,
          targetRelicPlayerId: typeof action.targetRelicPlayerId === 'string' ? action.targetRelicPlayerId : undefined,
          targetRelicIndex: Number.isInteger(action.targetRelicIndex) ? action.targetRelicIndex : undefined,
          targetAbilityIndex: Number.isInteger(action.targetAbilityIndex) ? action.targetAbilityIndex : undefined,
        },
      )
      if (
        combat === run.combat &&
        overflow > 0 &&
        shivEnemyUids.length > 0 &&
        run.combat.phase === 'player' &&
        !player.dead
      ) {
        fail('An earlier overflow Shiv defeated a later target; choose targets again')
      }
      if (combat === run.combat && action.preflight === true) {
        fail('That potion use is no longer legal; choose again')
      }
      return combat === run.combat ? run : { ...run, combat }
    }
    case 'enterRoom':
      return enterRoom(run, action.roomId, action.useWingBoots === true ? seat.playerId : undefined)
    case 'leaveRoom':
      // A campfire's only exit is everyone having chosen (p.9). Otherwise one
      // misclick walks the party out and costs everybody their Rest.
      //
      // The phase matters as well as the room: `resolveCampfire` leaves the
      // map position pointing at the campfire it just left, and play is
      // simultaneous (p.12), so a seat acting on a slightly stale frame would
      // otherwise get a hard error for a room the party has already left.
      if (run.phase === 'room' && currentRoom(run.map)?.kind === 'campfire') {
        fail('Everyone must Rest or Smith before leaving the campfire')
      }
      return leaveRoom(run)
    case 'campfire':
      // Handled outside `dispatch`: it has to accumulate across messages, so it
      // needs the room and not just the run.
      return run
    case 'cardReward':
      return run
    case 'goldReward':
      if (action.gain !== undefined && typeof action.gain !== 'boolean') fail('Choose whether to take the Gold reward')
      return resolveGoldReward(run, seat.playerId, action.gain !== false)
    case 'potionReward': {
      if (run.phase !== 'reward') fail('The party is not choosing rewards')
      const offer = run.rewards.find((candidate) => candidate.playerId === seat.playerId)
      if (!offer || offer.potion === false) fail('This seat has no Potion reward')
      const decision = action.choice === 'skip' ? { kind: 'skip' }
        : action.choice === 'skipAll' ? { kind: 'skipAll' }
        : action.choice === 'gain' ? { kind: 'gain' }
          : action.choice === 'pass' ? { kind: 'pass', playerId: action.playerId }
            : action.choice === 'replace' ? { kind: 'replace', potionId: action.potionId }
              : null
      if (!decision) fail('Choose a legal Potion reward action')
      const next = resolvePotionReward(run, seat.playerId, decision)
      if (next === run) fail('That Potion reward choice is no longer legal')
      return next
    }
    case 'relicReward': {
      if (!['gain', 'skip'].includes(action.choice)) fail('Choose gain or skip for the Relic reward')
      const next = resolveRelicReward(run, seat.playerId, action.choice === 'gain')
      if (next === run) fail('That Relic reward choice is not legal')
      return next
    }
    case 'bossRelicReward': {
      if (action.choice !== 'gain' && action.choice !== 'skip') {
        fail('Choose gain or skip for the boss Relic reward')
      }
      if (action.choice === 'gain' && typeof action.relicId !== 'string') {
        fail('Choose a revealed boss Relic to gain')
      }
      if (action.choice === 'skip' && action.relicId !== undefined) {
        fail('A boss Relic skip cannot name a Relic')
      }
      const next = resolveBossRelicReward(run, seat.playerId,
        action.choice === 'gain' ? action.relicId : null)
      if (next === run) fail('That boss Relic choice is not legal')
      return next
    }
    case 'tradePotion': {
      const next = tradePotion(run, seat.playerId, action.playerId, action.potionId)
      if (next === run) fail('That Potion trade is not legal')
      return next
    }
    case 'usePotionOutsideCombat': {
      const next = usePotionOutsideCombat(run, seat.playerId, action.potionId,
        typeof action.replacePotionId === 'string' ? action.replacePotionId : undefined)
      if (next === run) fail('That Potion cannot be used now')
      return next
    }
    case 'advanceAct':
      return advanceAct(run)
    case 'switchBetweenCombatRow':
      return switchBetweenCombatRow(run, seat.playerId, action.row)
    case 'startPendingBoss':
      return startPendingBoss(run)
    case 'rerollDownfallSelfBoss': {
      const next = rerollDownfallSelfBoss(run)
      if (next === run) fail('That self-boss cannot be rerolled')
      return next
    }
    default:
      return fail(`Unknown action: ${action?.kind}`)
  }
}
