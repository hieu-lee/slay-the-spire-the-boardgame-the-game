// Card preview RNG reservation, validity checks, legacy migration, and Slime
// Boss preview choice validation.

import {
  cardDef,
  faceOf,
  nextFloat,
  previewCardChoice,
  previewCardCopyChoice,
  previewHermitChamberCardChoice,
  previewPowerChoice,
  resolveEnemyTargets,
  slimeCommandEnemyChoiceCount,
} from '../../../src/game/state.ts'
import { fail, fastClone, uidList } from './shared.mjs'

export function previewSlimeChoices(combat, action, def, player, effectEnergy, charged, playedCard) {
  const slimeUids = uidList(action.slimeUids) ?? []
  const slimeEnemyUids = uidList(action.slimeEnemyUids) ?? []
  if (action.slimeUids !== undefined && (!Array.isArray(action.slimeUids) ||
    slimeUids.length !== action.slimeUids.length) ||
    action.slimeEnemyUids !== undefined && (!Array.isArray(action.slimeEnemyUids) ||
      slimeEnemyUids.length !== action.slimeEnemyUids.length)) {
    fail('Slime preview choices must be lists of ids')
  }
  const count = def && player
    ? slimeCommandEnemyChoiceCount(def, combat, player, slimeUids, effectEnergy, charged,
      playedCard)
    : 0
  if (slimeEnemyUids.length !== count || slimeEnemyUids.some((uid) =>
    !combat.enemies.some((enemy) => enemy.uid === uid && !enemy.dead))) {
    fail('Choose every Slime Command target before revealing this card')
  }
  return { slimeUids, slimeEnemyUids }
}

export function reservePreviewRng(room, preview, locked) {
  const { reservedRng, ...visible } = preview
  if (locked?.rngBefore && locked.rngAfter) {
    return { ...visible, kind: locked.kind, cards: locked.cards,
      rngBefore: locked.rngBefore, rngAfter: locked.rngAfter }
  }
  if (locked?.retargetEnemy || locked?.retargetSlime) {
    return { ...visible, kind: locked.kind, cards: locked.cards }
  }
  const rngBefore = room.run.combat.rng
  if (!reservedRng || reservedRng.calls === rngBefore.calls) return visible
  room.run = { ...room.run, combat: { ...room.run.combat, rng: { ...reservedRng } } }
  return { ...visible, rngBefore: { ...rngBefore }, rngAfter: { ...reservedRng } }
}

export const previewState = (combat, preview) => preview?.rngBefore
  ? { ...combat, rng: { ...preview.rngBefore } }
  : combat

export function playWithReservedRng(combat, preview, play) {
  if (!preview?.rngBefore || !preview.rngAfter) return play(combat)
  const reserved = { ...preview.rngBefore }
  const replayValues = []
  for (let calls = preview.rngAfter.calls - preview.rngBefore.calls; calls > 0; calls -= 1) {
    replayValues.push(nextFloat(reserved))
  }
  const replay = { ...combat, rng: { ...combat.rng, replayValues } }
  const resolved = play(replay)
  if (resolved === replay) return combat
  const { replayValues: _replayValues, ...rng } = resolved.rng
  return { ...resolved, rng }
}

/** Reserve shuffle results already exposed by card previews saved before async play. */
export function migrateLegacyCardPreviews(room) {
  const combat = room.run?.combat
  if (!combat || !room.cardPreviews) return
  const rngBefore = { ...combat.rng }
  let rngAfter = rngBefore
  room.cardPreviews = Object.fromEntries(Object.entries(room.cardPreviews).map(([playerId, locked]) => {
    if (locked.rngBefore && locked.rngAfter) return [playerId, locked]
    const available = { ...combatForPreview(combat, playerId), rng: { ...rngBefore } }
    const revealed = locked.copy === true
      ? previewCardCopyChoice(available, playerId)
      : locked.chamber === true
        ? previewHermitChamberCardChoice(available, playerId, locked.cardUid)
        : previewCardChoice(available, playerId, locked.cardUid)
    const matches = revealed?.kind === locked.kind && revealed.cards.length === locked.cards.length &&
      revealed.cards.every((card, index) => card.uid === locked.cards[index]?.uid)
    if (!matches || !revealed.reservedRng || revealed.reservedRng.calls === rngBefore.calls) {
      return [playerId, locked]
    }
    if (revealed.reservedRng.calls > rngAfter.calls) rngAfter = { ...revealed.reservedRng }
    return [playerId, { ...locked, rngBefore: { ...rngBefore }, rngAfter: { ...revealed.reservedRng } }]
  }))
  if (rngAfter !== rngBefore) room.run = { ...room.run, combat: { ...combat, rng: rngAfter } }
}

export function visibleCardPreview(preview) {
  const {
    rngBefore: _rngBefore, rngAfter: _rngAfter,
    retargetEnemy: _retargetEnemy, retargetSlime: _retargetSlime,
    slimeEnemyCount: _slimeEnemyCount, ...visible
  } = preview
  return fastClone(visible)
}

function combatForPreview(combat, playerId, suspendedWork) {
  const currentCopy = combat?.pendingCardCopy?.playerId === playerId ? combat.pendingCardCopy : undefined
  const copy = currentCopy ?? suspendedWork?.copies?.find((pending) => pending.playerId === playerId)
  const currentForced = combat?.startTurnProgress?.forcedCard
  const forcedCard = currentForced?.playerId === playerId ? currentForced
    : suspendedWork?.forcedCards?.find((pending) => pending.playerId === playerId)
  const chamberPlays = [
    ...(combat?.pendingHermitChamberPlays ?? []),
    ...(suspendedWork?.choices?.pendingHermitChamberPlays ?? []),
  ].filter((choice) => choice.playerId === playerId)
  return combat ? {
    ...combat,
    phase: copy ? 'copy' : combat.phase === 'copy' ? 'player' : combat.phase,
    pendingCardCopy: copy,
    pendingTriggers: [],
    pendingDistilled: undefined,
    pendingRelicScry: undefined,
    pendingPlunderSwitches: [],
    pendingDieRelicChoices: [],
    pendingHermitSetupLoads: [],
    pendingHermitChamberPlays: chamberPlays,
    pendingHermitStrengthRewards: [],
    pendingPlayerChoices: undefined,
    pendingSlayerChoices: undefined,
    startTurnProgress: forcedCard
      ? { ...combat.startTurnProgress, choices: combat.startTurnProgress?.choices ?? [], forcedCard }
      : combat.startTurnProgress?.forcedCard ? { ...combat.startTurnProgress, forcedCard: undefined }
      : combat.startTurnProgress,
  } : combat
}

export function cardPreviewStillValid(combat, playerId, preview, suspendedWork) {
  if (!combat) return false
  const available = combatForPreview(combat, playerId, suspendedWork)
  const player = combat.players.find((candidate) => candidate.id === playerId)
  const card = preview.copy === true
    ? (combat.pendingCardCopy?.playerId === playerId ? combat.pendingCardCopy.card
      : suspendedWork?.copies?.find((pending) => pending.playerId === playerId)?.card)
    : preview.chamber === true
      ? player?.chamber.find((held) => held.uid === preview.cardUid)
      : player?.hand.find((held) => held.uid === preview.cardUid)
  const def = card ? faceOf(cardDef(card.defId), card.upgraded) : undefined
  if (!def) return false
  const current = previewState(available, preview)
  const revealed = preview.copy === true
    ? previewCardCopyChoice(current, playerId)
    : preview.chamber === true
      ? previewHermitChamberCardChoice(current, playerId, preview.cardUid)
      : previewCardChoice(current, playerId, preview.cardUid)
  const rngValid = !preview.rngAfter || revealed?.reservedRng?.seed === preview.rngAfter.seed &&
    revealed.reservedRng.calls === preview.rngAfter.calls
  return rngValid && revealed?.kind === preview.kind && revealed.cards.length === preview.cards.length &&
    revealed.cards.every((revealedCard, index) => revealedCard.uid === preview.cards[index]?.uid)
}

export function clearInvalidPreviews(room, suspendedWork) {
  const combat = room.run?.combat
  const playerWindow = combat?.phase === 'player' ||
    combat?.phase === 'copy' && combat.pendingCardCopy?.resumePhase === 'player'
  if (room.cardPreviews) room.cardPreviews = Object.fromEntries(Object.entries(room.cardPreviews).flatMap(([playerId, preview]) => {
    const held = preview.copy === true
      ? (combat?.phase === 'copy' && combat.pendingCardCopy?.playerId === playerId &&
        combat.pendingCardCopy.card.uid === preview.cardUid || suspendedWork?.copies
        ?.some((pending) => pending.playerId === playerId && pending.card.uid === preview.cardUid))
      : preview.chamber === true
        ? playerWindow && combat.players.find((player) => player.id === playerId)?.chamber
          .some((card) => card.uid === preview.cardUid)
      : (combat?.phase === 'player' || combat?.phase === 'copy' || ((combat?.phase === 'start' || combat?.phase === 'discard') &&
        combat.startTurnProgress?.forcedCard?.playerId === playerId &&
        combat.startTurnProgress.forcedCard.cardUid === preview.cardUid)) && combat.players
        .find((candidate) => candidate.id === playerId)?.hand.some((card) => card.uid === preview.cardUid)
    if (!held) return []
    let currentPreview = preview
    if (!cardPreviewStillValid(combat, playerId, preview, suspendedWork)) {
      const available = combatForPreview(room.run?.combat, playerId, suspendedWork)
      const revealed = preview.copy === true
        ? previewCardCopyChoice(available, playerId)
        : preview.chamber === true
          ? previewHermitChamberCardChoice(available, playerId, preview.cardUid)
          : previewCardChoice(available, playerId, preview.cardUid)
      if (!revealed) return []
      const { rngBefore: _rngBefore, rngAfter: _rngAfter, ...committed } = preview
      currentPreview = { ...committed, ...reservePreviewRng(room, revealed) }
    }
    const player = combat.players.find((candidate) => candidate.id === playerId)
    const card = preview.copy === true
      ? combatForPreview(combat, playerId, suspendedWork).pendingCardCopy?.card
      : preview.chamber === true ? player?.chamber.find((candidate) => candidate.uid === preview.cardUid)
      : player?.hand.find((candidate) => candidate.uid === preview.cardUid)
    const def = card && faceOf(cardDef(card.defId), card.upgraded)
    const enemyValid = !currentPreview.enemyUid || def &&
      resolveEnemyTargets(combat, def.target ?? 'enemy', currentPreview.enemyUid).length > 0
    const slimeTargetsValid = (currentPreview.slimeEnemyUids ?? [])
      .every((uid) => combat.enemies.some((enemy) => enemy.uid === uid && !enemy.dead))
    return [[playerId, enemyValid && slimeTargetsValid ? currentPreview : {
      ...currentPreview,
      enemyUid: enemyValid ? currentPreview.enemyUid : null,
      slimeEnemyUids: slimeTargetsValid ? currentPreview.slimeEnemyUids : [],
      slimeEnemyCount: slimeTargetsValid ? currentPreview.slimeEnemyCount : currentPreview.slimeEnemyUids?.length ?? 0,
      retargetEnemy: !enemyValid,
      retargetSlime: !slimeTargetsValid,
    }]]
  }))
  if (room.powerPreviews) room.powerPreviews = Object.fromEntries(Object.entries(room.powerPreviews)
    .flatMap(([playerId, preview]) => {
      if (!combat || ['won', 'lost'].includes(combat.phase)) return []
      const current = previewPowerChoice(combatForPreview(combat, playerId, suspendedWork), playerId, preview.powerUid)
      return current ? [[playerId, { id: preview.id, powerUid: preview.powerUid, ...current }]] : []
    }))
}
