import * as runEngine from '../../src/game/run.ts'
import * as combatEngine from '../../src/game/combat.ts'
import { cardDef, faceOf } from '../../src/game/cards.ts'
import { actionsForEnemy, enemyDef } from '../../src/game/enemies.ts'
import { relicDef, potionDef } from '../../src/game/relics.ts'
import { GUARDIAN_CARDS_BY_ID } from '../../src/game/downfall/guardian.ts'

export const POLICY_VERSION = 'ai-v1'
const id = 'p1'
const perPlayer = new Set(['chooseNeow', 'resolveNeowGold', 'revealNeowReward', 'resolveNeowReward', 'resolveNeowEffect',
  'chooseEvent', 'skipEvent', 'resolveGoldReward', 'resolvePotionReward', 'resolveRelicReward', 'resolveBossRelicReward',
  'chooseRelicReward', 'resolvePendingRelic', 'choosePendingRelicReward', 'resolveGuardianSocket',
  'resolveTransformReward', 'removeAtCurrentMerchant', 'revealCourier', 'decideCourier', 'usePotionOutsideCombat'])
const runOps = new Set([...perPlayer, 'enterRoom', 'leaveRoom', 'advanceAct', 'finishRun', 'startPendingBoss', 'rerollDownfallSelfBoss',
  'resolveCombat', 'revealCardReward', 'revealRewardItems', 'finishRewardsIfComplete', 'purchaseAtMerchant', 'finishMerchant',
  'resolveCardRewards', 'resolveCampfire'])
const combatOps = new Set(['playCard', 'playCardCopy', 'playHermitChamberCard', 'activatePower', 'activateRelic', 'activatePotion',
  'spendMiracle', 'spendShiv', 'spendVigor', 'spendSoulburn', 'resolvePlunderRowSwitch', 'chooseDistilledCard',
  'resolveHermitSetupLoad', 'resolveHermitStrengthReward', 'defaultPendingDieRelicChoice', 'resolvePendingDieRelicChoice',
  'resolvePendingTrigger', 'resolveStartPlayerTurn', 'orderStartTurnScries', 'resolveStartTurnScry', 'resolveStartTurnDiscard',
  'startPlayerTurnWithChoices', 'endPlayerTurn', 'beginEndPlayerTurn', 'beginEndTurnResolution', 'resolveEndTurnAbility', 'enemyTurn',
  'resolveDeterministicForcedCard'])
const globalCombatOps = new Set(['resolveStartPlayerTurn', 'orderStartTurnScries', 'startPlayerTurnWithChoices', 'endPlayerTurn',
  'beginEndPlayerTurn', 'beginEndTurnResolution', 'resolveEndTurnAbility', 'enemyTurn', 'resolveDeterministicForcedCard'])
const playFields = new Set('enemyUid enemyRow playerId slimeUids slimeEnemyUids loadUids chamberUids hermitEnemyUids hermitDieRelics energySpent spendVigor guardianModeShift secondGuardianModeShift corruptedShardMode guardianBlockSpend guardianPowerCardUid enemyUids soulburnEnemyUids playerIds switchWithPlayerId mode discardUids exhaustUids topdeckUids recoverDiscardUid recoverDiscardUids recoverExhaustUid recoverExhaustUids searchDrawUids spendMiracle holdRage shivEnemyUids scryDiscardUids scryToHandUid evokeSlots evokeEnemyUids chooseLoadSelf'.split(' '))
function publicChoices(context) {
  if (!context || typeof context !== 'object' || Array.isArray(context) || Object.keys(context).some((key) => !playFields.has(key))) throw new Error('Use only printed PlayContext choices')
  return context
}
const alias = { play: 'playCard', copy: 'playCardCopy', chamber: 'playHermitChamberCard', power: 'activatePower',
  relic: 'activateRelic', potion: 'activatePotion', room: 'enterRoom', neow: 'chooseNeow', event: 'chooseEvent',
  end: 'beginEndTurnResolution', reward: 'resolveCardRewards', campfire: 'resolveCampfire' }

export function decodeAction(input) {
  if (!Array.isArray(input) || typeof input[0] !== 'string') throw new Error('Action must be [operation, ...arguments]')
  const [op, ...values] = input
  const name = op === 'end' && values.length ? 'beginEndPlayerTurn' : alias[op] ?? op
  const args = structuredClone(values)
  if (name === 'resolvePendingTrigger') for (const index of [1, 2, 3, 4]) if (args[index] === null) args[index] = undefined
  if (name === 'beginEndTurnResolution' && args.length) throw new Error('Use end with an order; beginEndTurnResolution accepts no arguments')
  if (name === 'enterRoom' && args[1] === true) args[1] = id
  const scope = runOps.has(name) ? 'run' : combatOps.has(name) ? 'combat' : null
  if (!scope) throw new Error(`Unsupported operation ${op}`)
  if (name === 'playCard' || name === 'playHermitChamberCard') {
    const context = typeof args[1] === 'string' ? { enemyUid: args[1] } : args[1] ?? {}
    args[1] = { enemyUid: null, playerId: id, ...publicChoices(context) }
  }
  if (name === 'playCardCopy') args[0] = { enemyUid: null, playerId: id, ...publicChoices(args[0] ?? {}) }
  if (name === 'resolveCardRewards') args[0] = { [id]: args[0] }
  if (name === 'resolveCampfire') {
    if (!['rest', 'smith', 'leave', 'ruby'].includes(args[0]?.choice)) throw new Error('Choose a legal campfire action')
    args[0] = { [id]: args[0] }
  }
  if (name === 'revealCardReward' || perPlayer.has(name) || scope === 'combat' && !globalCombatOps.has(name)) args.unshift(id)
  return { scope, name, args }
}
export function applyAction(run, choice) {
  if (run.courier.offer && choice.name !== 'decideCourier') throw new Error('Resolve the Courier offer before other actions')
  if (choice.name === 'finishRun' && run.phase === 'victory' && !runEngine.victoryIsTerminal(run, run.campaignProgress)) throw new Error('Continue to the next Act; this playtest ends only at terminal victory or defeat')
  if (choice.name === 'endPlayerTurn' && run.combat?.phase !== 'discard') throw new Error('Use end to preserve end-turn target choices')
  if (['beginEndPlayerTurn', 'beginEndTurnResolution'].includes(choice.name)) {
    const abilities = combatEngine.endTurnAbilities(run.combat)
    if (abilities.length > 1 && !abilities.some((ability) => ability.orbChoice) && !choice.args.length) throw new Error('Choose an explicit end order from prompts.endAbilities')
    if (abilities.some((ability) => ability.orbChoice) && choice.args.length) throw new Error('Use end, then resolveEndTurnAbility for engine-ordered Loop choices')
  }
  const args = structuredClone(choice.args)
  if (choice.name === 'resolvePendingTrigger') for (const index of [2, 3, 4, 5]) if (args[index] === null) args[index] = undefined
  if (choice.scope === 'run') return runEngine[choice.name](run, ...args)
  const prepared = run.roomState?.kind === 'event' ? run.roomState.preparedCombat : null
  if (run.phase !== 'combat' && !prepared) throw new Error('No active combat')
  if (prepared && !['resolveHermitSetupLoad', 'orderStartTurnScries', 'resolveStartTurnScry'].includes(choice.name)) throw new Error('Finish the prepared event opening choices')
  if (prepared && choice.name === 'resolveHermitSetupLoad') args[3] = true
  const before = prepared ?? run.combat
  const combat = combatEngine[choice.name](before, ...args)
  return combat === before ? run : prepared ? { ...run, roomState: { ...run.roomState, preparedCombat: combat } } : { ...run, combat }
}
const action = (input) => decodeAction(input)

// Forced transitions only. No optional reward, card, route, target, order, or skip is chosen here.
export function automaticAction(run, reveal) {
  if (reveal || run.courier.offer || run.phase !== 'combat' && runEngine.hasPendingRelicAcquisition(run)) return null
  if (run.phase === 'defeat' || run.phase === 'victory' && runEngine.victoryIsTerminal(run, run.campaignProgress)) {
    return run.campaign.finalized ? null : action(['finishRun'])
  }
  if (run.phase === 'reward') {
    const offer = run.rewards[0]
    if (!offer) return action(['finishRewardsIfComplete'])
    if (offer?.potion === null || offer?.relic === null) return action(['revealRewardItems'])
    if (offer?.cardReward && !offer.choices && !offer.transformReward && !offer.prismatic) return action(['revealCardReward'])
    if (offer && !offer.gold && offer.potion === false && !offer.relic && !offer.bossRelics && !offer.cardReward && !offer.transformReward) return action(['finishRewardsIfComplete'])
  }
  if (run.phase === 'neow') {
    const progress = run.neow.players[id]
    if (!progress.redGoldPending && !runEngine.neowPreview(run, id).prismatic &&
      (progress.redRewardPending && !progress.redReward || progress.rewardKind && !progress.reward)) return action(['revealNeowReward'])
  }
  if (run.phase === 'room' && !run.roomState && run.map.rooms[run.map.position]?.kind !== 'campfire') return action(['leaveRoom'])
  if (run.phase !== 'combat') return null
  const combat = run.combat
  if (combat.startTurnProgress?.forcedCard && combatEngine.resolveDeterministicForcedCard(combat) !== combat) return action(['resolveDeterministicForcedCard'])
  if (['won', 'lost'].includes(combat.phase) && !run.courier.offer) return action(['resolveCombat'])
  if (combat.phase === 'enemy') return action(['enemyTurn'])
  if (combat.phase === 'roundEnd') return action(['startPlayerTurnWithChoices'])
  if (combat.phase === 'discard' && !combatEngine.discardNeedsChoice(combat.players[0]) && !combatEngine.discardTopNeedsChoice(combat.players[0])) return action(['endPlayerTurn'])
  if (combat.phase === 'start' && !combatEngine.startTurnNeedsChoice(combat) && !combat.startTurnProgress?.forcedCard
    && !combat.startTurnProgress?.beforeDraw && !combat.startTurnProgress?.discard && !combat.pendingTriggers.length
    && !combat.pendingHermitSetupLoads?.length && !combat.pendingDieRelicChoices?.length) {
    return action(['resolveStartPlayerTurn', combatEngine.defaultStartTurnChoices(combat)])
  }
  return null
}
const compactCard = ({ uid, defId, upgraded, attachedGemId, ...instance }) => {
  const metadata = prune(instance)
  return [uid, defId + (upgraded ? '+' : ''), ...(Object.keys(metadata).length ? [attachedGemId ?? null, metadata] : attachedGemId ? [attachedGemId] : [])]
}
function publicPlayer(player) {
  const { draw, deck, cardRewards, rareRewards, damageStats: _stats, ...visible } = player
  return { ...visible, drawCount: draw.length, deckCount: deck.length,
    hand: player.hand.map(compactCard), discard: player.discard.map(compactCard), exhaust: player.exhaust.map(compactCard),
    powers: player.powers.map(compactCard), chamber: player.chamber?.map(compactCard) ?? [] }
}
const prune = (object) => Object.fromEntries(Object.entries(object).filter(([key, value]) =>
  value !== undefined && value !== null && value !== false && (value !== 0 || ['nextCardCost', 'enemyNextCardCost', 'hpLossLimitThisRound'].includes(key)) && (!Array.isArray(value) || value.length) &&
  (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length)))

export function snapshot(session, detail = false) {
  const { run, record, reveal } = session
  if (!run) return { worker: session.worker, revision: session.revision, done: true }
  const combat = run.phase === 'combat' ? run.combat : run.roomState?.preparedCombat ?? null
  const player = combat?.players[0] ?? run.players[0]
  const result = { worker: session.worker, revision: session.revision, run: record.index + 1, seed: record.seed,
    act: run.act, boss: run.actBossDefId, phase: run.phase, floor: run.floorsCleared ?? 0,
    player: { ...prune(publicPlayer(player)), hp: player.hp, maxHp: player.maxHp, energy: player.energy, block: player.block, gold: player.gold }, ...(combat ? { turn: combat.turn, die: combat.die, combatPhase: combat.phase,
      enemies: combat.enemies.filter((enemy) => !enemy.dead).map((enemy) => ({ ...enemy, intent: actionsForEnemy(enemy, combat.die) })) } : {}) }
  // Private draw order and physical reward supplies never leave the owning engine.
  const prompts = {}
  if (run.courier?.offer) prompts.courier = run.courier.offer
  if (run.pendingGuardianSockets?.length) prompts.socket = run.pendingGuardianSockets
  const pendingRelic = player.relics.find((relic) => relic.pending)
  if (pendingRelic && run.phase !== 'combat') prompts.relic = { ...runEngine.pendingRelicPreview(run, id), eligibleCards: runEngine.pendingRelicEligibleCards(player, pendingRelic.defId).map(compactCard) }
  if (run.phase === 'map') {
    const map = runEngine.visibleMap(run)
    const routes = (rooms) => rooms.map((room) => { const { id, kind, exits, hidden } = map.rooms[room.id]; return { id, kind, exits, ...(hidden ? { hidden } : {}) } })
    prompts.routes = routes(runEngine.roomChoices(run))
    const wings = runEngine.wingBootChoices(run, id)
    if (wings.length) prompts.wingRoutes = routes(wings)
  }
  if (run.phase === 'neow') {
    const { card, ...progress } = runEngine.neowPreview(run, id)
    prompts.neow = { options: card.options, ...progress }
  }
  if (run.phase === 'reward') prompts.rewards = run.rewards
  if (run.phase === 'room') {
    if (run.roomState?.kind === 'event') {
      const room = run.roomState
      prompts.event = { card: room.card, pendingDecision: room.pendingDecisions?.[id], rolls: room.dieRolls?.[id],
        rewards: room.rewardOffers?.[id], items: room.itemOffers?.[id], gems: room.guardianGemOffers?.[id],
        availableRewardSources: room.availableRewardSources, revealedCards: room.revealedCards?.[id],
        revealedCardDefs: room.revealedCardDefs?.[id], revealedRelic: room.revealedRelics?.[id], labChoice: room.labChoices?.[id] }
    } else prompts.room = run.roomState ?? { kind: run.map.rooms[run.map.position]?.kind }
  }
  if (combat) {
    result.turnState = prune({ discardedThisTurn: combat.discardedThisTurn, stanceChangedThisTurn: combat.stanceChangedThisTurn,
      powerTriggersUsedThisTurn: combat.powerTriggersUsedThisTurn, partyAttackDiscount: combat.partyAttackDiscount,
      initialEnemyCount: combat.initialEnemyCount, potionLimit: combat.potionLimit,
      playedCardsThisTurn: combat.playedCardsThisTurn.map((play) => ({ ...play, card: compactCard(play.card) })) })
    const forced = combat.startTurnProgress?.forcedCard
    Object.assign(prompts, prune({
      trigger: combatEngine.pendingTriggerAbility(combat), endAbility: combatEngine.endTurnResolutionAbility(combat),
      endAbilities: combatEngine.endTurnAbilities(combat),
      startAbilities: combat.phase === 'start' ? combatEngine.startTurnAbilities(combat) : [],
      scry: combatEngine.startTurnScryPreview(combat), scries: combatEngine.startTurnScryAbilities(combat),
      discard: combatEngine.startTurnDiscardPreview(combat),
      forced: forced && { cardUid: forced.cardUid, source: forced.sourceLabel ?? forced.sourceCardId },
      copy: combat.pendingCardCopy && { card: compactCard(combat.pendingCardCopy.card), sources: combat.pendingCardCopy.sourceNames },
      distilled: !forced ? combat.pendingDistilled?.cards.map(compactCard) : undefined,
      load: combat.pendingHermitSetupLoads, chamberPlays: combat.pendingHermitChamberPlays,
      strengthRewards: combat.pendingHermitStrengthRewards, dieRelics: combat.pendingDieRelicChoices,
      plunder: combat.pendingPlunderSwitches, relicScry: combat.pendingRelicScry && { relicIndex: combat.pendingRelicScry.relicIndex, cards: combat.pendingRelicScry.cards.map(compactCard) },
    }))
  }
  if (reveal) prompts.reveal = { cardUid: reveal.cardUid, kind: reveal.preview.kind, cards: reveal.preview.cards.map(compactCard) }
  result.prompts = prompts
  const cards = [...player.hand, ...player.powers, ...(reveal?.preview.cards ?? [])]
  cards.push(...(combat?.playedCardsThisTurn ?? []).map((play) => play.card))
  const offers = [run.neow?.players[id]?.redReward, run.neow?.players[id]?.reward, ...run.rewards].filter(Boolean)
  for (const offer of offers) if (!offer.kind || ['card', 'rare', 'colorless'].includes(offer.kind)) {
    for (const defId of offer.choices ?? []) cards.push({ defId, upgraded: offer.upgraded ?? false })
  }
  for (const group of run.roomState?.rewardOffers?.[id] ?? []) for (const defId of group) cards.push({ defId, upgraded: false })
  if (run.phase === 'room' || run.neow?.players[id]?.pendingEffect) { result.deck = player.deck.map(compactCard); cards.push(...player.deck) }
  for (const defId of run.roomState?.cards?.[id]?.choices ?? []) cards.push({ defId, upgraded: false })
  for (const defId of run.roomState?.colorless ?? []) if (defId) cards.push({ defId, upgraded: false })
  for (const group of prompts.relic?.rewardChoices ?? []) for (const defId of group) cards.push({ defId, upgraded: false })
  for (const slime of player.slimes ?? []) if (slime.card) cards.push(slime.card)
  const relics = new Set(player.relics.map((held) => held.defId))
  const potions = new Set(player.potions)
  for (const offer of offers) {
    if (typeof offer.relic === 'string') relics.add(offer.relic)
    if (typeof offer.potion === 'string') potions.add(offer.potion)
    for (const defId of offer.bossRelics || []) relics.add(defId)
    if (offer.kind === 'relic') for (const defId of offer.choices) relics.add(defId)
    if (offer.kind === 'potion') for (const defId of offer.choices) potions.add(defId)
  }
  for (const defId of [...(run.roomState?.relics ?? []), ...Object.values(run.roomState?.offers ?? {}), ...(run.roomState?.sharedOffers ?? [])]) if (defId) relics.add(defId)
  for (const defId of run.roomState?.potions ?? []) if (defId) potions.add(defId)
  for (const offer of run.roomState?.itemOffers?.[id] ?? []) (offer.kind === 'relic' ? relics : potions).add(offer.id)
  if (run.courier?.offer) (run.courier.offer.kind === 'relic' ? relics : potions).add(run.courier.offer.id)
  result.relicText = Object.fromEntries([...relics].map((defId) => [defId, relicDef(defId)]))
  result.potionText = Object.fromEntries([...potions].map((defId) => [defId, potionDef(defId)]))
  const gems = new Set([...(run.pendingGuardianSockets ?? []).flatMap((pending) => pending.gemIds), ...cards.map((card) => card.attachedGemId).filter(Boolean),
    ...offers.flatMap((offer) => offer.guardianGems ?? []), ...Object.values(run.roomState?.guardianGems ?? {}).flat(), ...(run.roomState?.guardianGemOffers?.[id] ?? []).flat()])
  result.gemText = Object.fromEntries([...gems].map((defId) => [defId, GUARDIAN_CARDS_BY_ID[defId]?.base.text]))
  result.enemyText = Object.fromEntries((combat?.enemies ?? []).filter((enemy) => !enemy.dead).map((enemy) => [enemy.defId, enemyDef(enemy.defId, enemy.ascension)]))
  if (detail) cards.push(...player.deck, ...player.discard, ...player.exhaust, ...(player.chamber ?? []))
  result.cardText = Object.fromEntries([...new Map(cards.map((card) => [card.defId + (card.upgraded ? '+' : ''), card])).entries()].map(([key, card]) => {
    const def = faceOf(cardDef(card.defId), card.upgraded)
    const { upgrade: _upgrade, publisherScan: _scan, id: _id, ...printed } = def
    return [key, printed]
  }))
  if (detail) { result.deck = player.deck.map(compactCard); result.map = runEngine.visibleMap(run); result.log = run.log.slice(-12); result.combatLog = combat?.log.slice(-12) }
  return result
}

export function sourceFor(run, choice) {
  const player = run.combat?.players[0]
  const cards = ['playCard', 'playHermitChamberCard', 'resolveDeterministicForcedCard'].includes(choice.name) ? [...(player?.hand ?? []), ...(player?.chamber ?? [])]
    : choice.name === 'activatePower' ? player?.powers ?? [] : []
  const card = choice.name === 'playCardCopy' ? run.combat?.pendingCardCopy?.card
    : cards.find((held) => held.uid === (choice.name === 'resolveDeterministicForcedCard' ? run.combat?.startTurnProgress?.forcedCard?.cardUid : choice.args[1]))
  return card ? card.defId + (card.upgraded ? '+' : '') : undefined
}
export function requiresReveal(run, choice) {
  if (run.phase !== 'combat') return false
  const previews = { playCard: 'previewCardChoice', playCardCopy: 'previewCardCopyChoice', playHermitChamberCard: 'previewHermitChamberCardChoice', activatePower: 'previewPowerChoice' }
  return previews[choice.name] && Boolean(combatEngine[previews[choice.name]](run.combat, id, choice.args[1]))
}
export function revealCard(run, cardUid, kind = 'card') {
  if (run.phase !== 'combat') throw new Error('Reveals require combat')
  if (run.courier.offer) throw new Error('Resolve the Courier offer before private reveals')
  const previews = { card: 'previewCardChoice', copy: 'previewCardCopyChoice', chamber: 'previewHermitChamberCardChoice', power: 'previewPowerChoice' }
  const preview = combatEngine[previews[kind]](run.combat, id, cardUid)
  if (!preview) throw new Error('Card has no legal reveal')
  return { cardUid: kind === 'copy' ? run.combat.pendingCardCopy.card.uid : cardUid, kind, preview }
}
export function boundary(before, after) {
  if (before.phase !== after.phase || before.act !== after.act || before.map.position !== after.map.position) return 'phase'
  if (JSON.stringify(before.courier.offer) !== JSON.stringify(after.courier.offer)
    || JSON.stringify(before.pendingGuardianSockets) !== JSON.stringify(after.pendingGuardianSockets)
    || after.phase !== 'combat' && runEngine.hasPendingRelicAcquisition(after)) return 'prompt'
  const a = before.combat, b = after.combat
  if (before.rng.calls !== after.rng.calls || a?.rng.calls !== b?.rng.calls) return 'randomness'
  if (!a || !b) return 'decision'
  if (a.phase !== b.phase || a.turn !== b.turn || a.combatId !== b.combatId) return 'turn_or_prompt'
  const pendingKeys = ['pendingTriggers', 'pendingCardCopy', 'pendingHermitSetupLoads', 'pendingHermitChamberPlays',
    'pendingHermitStrengthRewards', 'pendingDieRelicChoices', 'pendingDistilled', 'pendingRelicScry', 'pendingPlunderSwitches', 'startTurnProgress', 'endTurnProgress']
  if (pendingKeys.some((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]))) return 'prompt'
  const prior = new Map(a.players[0].hand.map((card) => [card.uid, card.defId + (card.upgraded ? '+' : '')]))
  if (b.players[0].hand.some((card) => prior.get(card.uid) !== card.defId + (card.upgraded ? '+' : '')) || b.players[0].draw.length !== a.players[0].draw.length
    || b.potionDeck.length < a.potionDeck.length || a.potionDeck.some((defId, index) => b.potionDeck[index] !== defId)
    || a.players[0].cardRewards.length !== b.players[0].cardRewards.length
    || a.players[0].rareRewards.length !== b.players[0].rareRewards.length
    || b.log.slice(a.log.length).some((line) => /\bdraws?\b|\bscr(?:y|ies)\b/i.test(line))) return 'draw_or_reveal'
  if (a.enemies.some((enemy) => !enemy.dead && b.enemies.find((target) => target.uid === enemy.uid)?.dead)) return 'target_died'
  return null
}
