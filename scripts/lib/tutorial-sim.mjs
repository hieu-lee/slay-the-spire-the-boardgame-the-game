// Plays a tutorial plan headlessly through the real engine, the way the coach
// forces it in the browser, and reports what each stage actually shows.
//
// Fights are not played out: they are declared won, which is enough because the
// tutorial enters every room on its own seed (see src/ui/tutorial/run.ts), so
// nothing a fight does changes what a later room deals.
import { createTutorialRun, enterTutorialRoom } from '../../src/ui/tutorial/run.ts'
import {
  chooseEvent, chooseNeow, chooseRelicReward, finishMerchant, leaveRoom, purchaseAtMerchant, removeAtCurrentMerchant,
  resolveCampfire, resolveCardRewards, resolveCombat, resolveGoldReward, resolveNeowEffect, resolveNeowGold,
  resolveNeowReward, resolvePotionReward, resolveRelicReward, revealCardReward, revealNeowReward,
} from '../../src/game/run.ts'
import { neowCard } from '../../src/game/neow.ts'
import { merchantPurchaseCost } from '../../src/game/noncombat.ts'

const idsOf = (cards) => cards.map((card) => card.defId)
const uidsFor = (deck, defIds) => {
  const left = [...deck]
  return defIds.map((defId) => {
    const index = left.findIndex((card) => card.defId === defId && !card.upgraded)
    if (index < 0) throw new Error(`no ${defId} in the deck`)
    return left.splice(index, 1)[0].uid
  })
}

/**
 * @param plan the hero's TutorialPlan
 * @returns {{ trace: object[], run: object }} one entry per stage, with what the player sees
 */
export function simulateTutorial(character, plan) {
  const trace = []
  const player = () => run.players[0]
  let run = createTutorialRun(character, 'Player', plan.seed)
  const neow = run.neow.players.p1
  const card = neowCard(neow.cardId)
  trace.push({ stage: 'neow', card: neow.cardId, options: card.options.map((option) => option.label), boss: run.actBossDefId })
  run = resolveNeowGold(run, 'p1', true)
  run = revealNeowReward(run, 'p1')
  const red = run.neow.players.p1.redReward.choices
  trace.push({ stage: 'neow-red', cards: [...red] })
  run = resolveNeowReward(run, 'p1', plan.neow.pick === null ? null : red.indexOf(plan.neow.pick))
  run = chooseNeow(run, 'p1', plan.neow.option)
  const blue = { stage: 'neow-blue', option: card.options[plan.neow.option]?.label, potions: [], relics: [], cards: [] }
  for (let guard = 0; guard < 20 && run.phase === 'neow'; guard += 1) {
    const progress = run.neow.players.p1
    if (progress.rewardKind && !progress.reward) run = revealNeowReward(run, 'p1')
    else if (progress.reward?.kind === 'potion') {
      blue.potions.push(progress.reward.choices[0])
      run = resolveNeowReward(run, 'p1', { kind: 'gain' })
    } else if (progress.reward?.kind === 'relic') {
      blue.relics.push(...progress.reward.choices)
      run = resolveNeowReward(run, 'p1', 0)
    } else if (progress.reward) {
      blue.cards.push([...progress.reward.choices])
      const pick = plan.neow.blueCards?.[blue.cards.length - 1] ?? null
      run = resolveNeowReward(run, 'p1', pick === null ? null : progress.reward.choices.indexOf(pick))
    } else if (progress.pendingEffect) {
      const chosen = plan.neow.effectCards ?? []
      run = resolveNeowEffect(run, 'p1', true, chosen.length ? { cardUids: uidsFor(player().deck, chosen) } : {})
    } else break
  }
  trace.push(blue)
  if (run.phase !== 'map') throw Object.assign(new Error(`Neow did not finish: ${run.phase}`), { trace })
  trace.push({ stage: 'map', rows: run.map.rows.map((row) => row.map((id) => ({ id, kind: run.map.rooms[id].kind, exits: run.map.rooms[id].exits }))) })

  for (const roomId of plan.route) {
    const room = run.map.rooms[roomId]
    const before = run
    run = enterTutorialRoom(run, roomId, plan.seed)
    if (run === before) throw Object.assign(new Error(`cannot move to ${roomId} from ${before.map.position} (${before.phase})`), { trace })
    const roomPlan = plan.rooms[roomId] ?? {}
    const entry = { stage: 'room', roomId, kind: room.kind, hp: player().hp, gold: player().gold }
    trace.push(entry)
    if (run.phase === 'combat') {
      const combat = run.combat
      entry.enemies = combat.enemies.map((enemy) => ({ uid: enemy.uid, defId: enemy.defId, hp: enemy.hp, row: enemy.row }))
      entry.hand = idsOf(combat.players[0].hand)
      entry.draw = idsOf(combat.players[0].draw)
      entry.die = combat.die
      entry.combatPhase = combat.phase
      entry.turn = combat.turn
      run = resolveCombat({ ...run, combat: { ...combat, phase: 'won', enemies: combat.enemies.map((enemy) => ({ ...enemy, hp: 0 })) } })
      if (run.phase === 'reward') {
        const offer = run.rewards[0]
        entry.reward = { gold: offer.gold, potion: offer.potion, relic: offer.relic }
        if (offer.gold) run = resolveGoldReward(run, 'p1', true)
        if (typeof offer.potion === 'string') run = resolvePotionReward(run, 'p1', roomPlan.potion ??
          (player().potions.length < 3 ? { kind: 'gain' } : { kind: 'skip' }))
        if (typeof offer.relic === 'string') run = resolveRelicReward(run, 'p1', true)
        if (offer.cardReward) {
          run = revealCardReward(run, 'p1')
          const choices = run.rewards[0].choices
          entry.reward.cards = [...choices]
          const pick = roomPlan.pick ?? null
          run = resolveCardRewards(run, { p1: pick === null ? null : choices.indexOf(pick) })
        }
      }
      if (run.phase === 'room' && run.roomState?.kind === 'elite') {
        entry.relic = run.roomState.sharedOffers?.[0] ?? run.roomState.offers.p1
        run = chooseRelicReward(run, 'p1', run.roomState.sharedOffers ? 0 : 'take')
      }
      if (run.phase === 'victory') break
    } else if (run.roomState?.kind === 'event') {
      entry.event = run.roomState.card.id
      entry.options = run.roomState.card.options.map((option) => ({ id: option.id, text: option.description ?? option.label }))
      if (roomPlan.option) run = chooseEvent(run, 'p1', { optionIds: [roomPlan.option],
        ...roomPlan.cards ? { cardUids: uidsFor(player().deck, roomPlan.cards) } : {}, ...roomPlan.decision })
      for (let guard = 0; guard < 3 && run.roomState?.kind === 'event' && run.roomState.pendingDecisions?.p1; guard += 1) {
        const room = run.roomState
        const offers = room.rewardOffers?.p1
        const items = room.itemOffers?.p1
        if (offers) entry.offers = offers
        if (items) entry.items = items
        run = chooseEvent(run, 'p1', { ...room.pendingDecisions.p1,
          ...offers ? { rewardIndexes: offers.map((cards) => roomPlan.pick ? cards.indexOf(roomPlan.pick) : -1) } : {},
          ...items ? { rewardItemChoices: items.map(() => 'take') } : {} })
      }
      entry.after = { phase: run.phase, room: run.roomState?.kind ?? null, hp: player().hp, gold: player().gold }
    } else if (run.roomState?.kind === 'merchant') {
      const shop = run.roomState
      entry.shop = { relics: shop.relics, potions: shop.potions, cards: shop.cards.p1?.choices, colorless: shop.colorless }
      if (roomPlan.remove) run = removeAtCurrentMerchant(run, 'p1', uidsFor(player().deck, [roomPlan.remove])[0], { p1: 3 })
      for (const item of roomPlan.buy ?? []) {
        const purchase = { buyerId: 'p1', payments: {}, ...item }
        const cost = merchantPurchaseCost(run.roomState, purchase)
        const bought = purchaseAtMerchant(run, { ...purchase, payments: { p1: cost } })
        if (bought === run) throw Object.assign(new Error(`cannot buy ${JSON.stringify(item)} for ${cost} with ${player().gold} gold`), { trace })
        run = bought
      }
      run = finishMerchant(run)
    } else if (run.roomState?.kind === 'treasure') {
      entry.relic = run.roomState.sharedOffers?.[0] ?? run.roomState.offers.p1
      run = chooseRelicReward(run, 'p1', run.roomState.sharedOffers ? 0 : 'take')
    } else if (room.kind === 'campfire') {
      run = resolveCampfire(run, { p1: roomPlan.smith
        ? { choice: 'smith', cardUid: uidsFor(player().deck, [roomPlan.smith])[0] } : { choice: 'rest' } })
    }
    if (run.phase === 'room' && !run.roomState) run = leaveRoom(run)
    entry.deck = idsOf(player().deck)
    entry.potions = [...player().potions]
    entry.relics = player().relics.map((relic) => relic.defId)
    entry.end = { phase: run.phase, hp: player().hp, gold: player().gold }
  }
  return { trace, run }
}
