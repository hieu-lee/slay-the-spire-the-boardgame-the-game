// Slayer Pack combat mechanics: attached cards (Nightmare, Pressure Points),
// Ritual Dagger rewards, Metamorphosis power copies, Bandage Up HP reduction,
// card-play windows, discard-top recovery, and pending player choices.
//
// Cycle-free helper module below `effects.ts`: effects-layer mutations
// (discard, exhaust, enemy damage) are supplied as callbacks by callers.
import { combatIsOver, enemyLabel, findPlayer, livingEnemies } from './board.ts'
import { forgetRetain } from './pieces.ts'
import { activeCardPlayWindow, cardPlayWindowCardPlayable, persistentEffectOf } from './queries.ts'
import type { CombatState, PlayContext } from './types.ts'
import { CARDS, cardDef, faceOf } from '../cards.ts'
import type { Effect } from '../cards.ts'
import { addToDrawTop } from '../piles.ts'
import type { CardInstance, Enemy, Player } from '../types.ts'

export type DiscardCardsCallback = (state: CombatState, actor: Player, cards: CardInstance[]) => void
export type ExhaustCardsCallback = (
  state: CombatState,
  actor: Player,
  cards: CardInstance[],
  context?: PlayContext,
) => void
export type DamageEnemyCallback = (
  state: CombatState,
  enemy: Enemy,
  damage: number,
  source?: string,
  actor?: Player,
) => void

/**
 * Removes every Slayer card attached to a dying enemy. Nightmare+ reattaches:
 * with one other living enemy it moves there automatically (no choice owed);
 * with several the owner chooses (`pendingSlayerChoices`); with none the card
 * is discarded like the base face.
 */
export function detachSlayerCards(
  state: CombatState,
  enemy: Enemy,
  discardCards: DiscardCardsCallback,
): void {
  const attached = enemy.slayerAttachments ?? []
  enemy.slayerAttachments = undefined
  for (const entry of attached) {
    const owner = findPlayer(state, entry.playerId)
    if (!owner) continue
    const def = faceOf(cardDef(entry.card.defId), entry.card.upgraded)
    const hosts = livingEnemies(state).filter((candidate) => candidate.uid !== enemy.uid)
    if (def.attached?.onHostDeath === 'reattach' && hosts.length > 1) {
      state.pendingSlayerChoices = [...(state.pendingSlayerChoices ?? []),
        { id: allocateChoiceId(state), kind: 'reattach', playerId: owner.id, card: entry.card, fromUid: enemy.uid }]
      state.log = [...state.log, `${owner.name} chooses another enemy for ${def.name}`]
    } else if (def.attached?.onHostDeath === 'reattach' && hosts.length === 1) {
      attachSlayerCard(state, hosts[0]!, entry)
    } else {
      state.log = [...state.log, `${def.name} falls off ${enemyLabel(state.enemies, enemy)}`]
      discardCards(state, owner, [entry.card])
    }
  }
}

/**
 * A dead player can never answer, and their open choice would hold the whole
 * table (Last Stand, or a death in the Enemy Turn). Their Nightmare+ moves to
 * the first other living enemy (or is discarded); their Ritual Dagger+ reveal
 * goes to the bottom of their rare deck, leaving the deck as it was.
 */
export function resolveDeadOwnerSlayerChoicesWithDiscard(
  state: CombatState,
  discardCards: DiscardCardsCallback,
): void {
  const owed = state.pendingSlayerChoices
  if (!owed?.some((choice) => findPlayer(state, choice.playerId)?.dead !== false)) return
  state.pendingSlayerChoices = owed.filter((choice) => findPlayer(state, choice.playerId)?.dead === false)
  for (const choice of owed) {
    const owner = findPlayer(state, choice.playerId)
    if (!owner?.dead) continue
    if (choice.kind === 'reattach') {
      const host = livingEnemies(state).find((enemy) => enemy.uid !== choice.fromUid)
      if (host) attachSlayerCard(state, host, { card: choice.card, playerId: owner.id })
      else discardCards(state, owner, [choice.card])
    } else if (owner.rareRewards.length > 0) {
      const [top, ...rest] = owner.rareRewards
      owner.rareRewards = [...rest, top!]
      state.log = [...state.log, `${owner.name}'s revealed rare reward goes to the bottom of their rare deck`]
    }
  }
  if (state.pendingSlayerChoices.length === 0) delete state.pendingSlayerChoices
}

/**
 * Ritual Dagger's earned rewards, applied once the physical card has left play (or the
 * fight is over): the card and its deck copy are upgraded, or its owner privately sees
 * the top rare reward (`pendingSlayerChoices`), with the dagger already in its pile.
 */
export function grantSlayerKillRewards(state: CombatState): void {
  const earned = state.slayerKillRewards
  if (!earned) return
  const inPlay = state.pendingCardCopy && !combatIsOver(state) ? state.pendingCardCopy.card.uid : undefined
  state.slayerKillRewards = earned.filter((reward) => reward.cardUid === inPlay)
  for (const reward of earned) {
    const owner = findPlayer(state, reward.playerId)
    if (reward.cardUid === inPlay || !owner) continue
    if (reward.reward === 'upgrade') {
      const upgrade = (cards: CardInstance[]) =>
        cards.map((card) => card.uid === reward.cardUid ? { ...card, upgraded: true } : card)
      owner.deck = upgrade(owner.deck)
      owner.hand = upgrade(owner.hand)
      owner.draw = upgrade(owner.draw)
      owner.discard = upgrade(owner.discard)
      owner.exhaust = upgrade(owner.exhaust)
      state.log = [...state.log, `${owner.name} upgrades Ritual Dagger`]
    } else if (owner.rareRewards[0]) {
      state.pendingSlayerChoices = [...(state.pendingSlayerChoices ?? []),
        { id: allocateChoiceId(state), kind: 'ritualDagger', playerId: owner.id, cardUid: reward.cardUid,
          revealed: owner.rareRewards[0] }]
      state.log = [...state.log, `${owner.name} reveals the top card of their rare rewards`]
    } else {
      state.log = [...state.log, `${owner.name} has no rare reward left to reveal`]
    }
  }
  if (state.slayerKillRewards.length === 0) delete state.slayerKillRewards
}

/**
 * A host that leaves combat (Looter, Mugger) does not die, so nothing "when it dies"
 * happens: every card on it, a Nightmare+ included, goes to its owner's discard pile.
 */
export function shedSlayerCardsOnLeaveWithDiscard(
  state: CombatState,
  enemy: Enemy,
  discardCards: DiscardCardsCallback,
): void {
  const attached = enemy.slayerAttachments ?? []
  enemy.slayerAttachments = undefined
  for (const entry of attached) {
    const owner = findPlayer(state, entry.playerId)
    if (!owner) continue
    state.log = [...state.log, `${faceOf(cardDef(entry.card.defId), entry.card.upgraded).name} leaves with ${
      enemyLabel(state.enemies, enemy)} and is discarded`]
    discardCards(state, owner, [entry.card])
  }
}

export function attachSlayerCard(
  state: CombatState,
  host: Enemy,
  entry: NonNullable<Enemy['slayerAttachments']>[number],
): void {
  host.slayerAttachments = [...(host.slayerAttachments ?? []), entry]
  const owner = findPlayer(state, entry.playerId)
  state.log = [...state.log, `${owner?.name ?? 'A player'} attaches ${
    faceOf(cardDef(entry.card.defId), entry.card.upgraded).name} to ${enemyLabel(state.enemies, host)}`]
}

/** Which attached Slayer card sits on which enemy, captured when a play begins. */
export function slayerAttachmentKeys(state: CombatState): string[] {
  return state.enemies.flatMap((enemy) => (enemy.slayerAttachments ?? []).map((entry) => `${enemy.uid}/${entry.card.uid}`))
}

/**
 * Plain damage from the actor's attached cards whose condition this play met:
 * Nightmare for every host the Attack struck, Pressure Points for any Skill.
 */
export function resolveSlayerAttachedDamage(
  state: CombatState,
  actor: Player,
  when: 'attackAgainstHost' | 'skill',
  hosts: ReadonlySet<string> | null,
  damageEnemy: DamageEnemyCallback,
  excludeUid?: string,
  attachedAtStart?: readonly string[],
): void {
  const atStart = attachedAtStart ? new Set(attachedAtStart) : null
  // A dead or departed enemy is no host, even if an older save left a card on it.
  const reacting = state.enemies.flatMap((enemy) => enemy.dead || hosts && !hosts.has(enemy.uid) ? [] :
    (enemy.slayerAttachments ?? []).filter((entry) => entry.playerId === actor.id && entry.card.uid !== excludeUid &&
      faceOf(cardDef(entry.card.defId), entry.card.upgraded).attached?.damageWhen === when &&
      (!atStart || atStart.has(`${enemy.uid}/${entry.card.uid}`))).map((entry) => ({ enemy, entry })))
  for (const { enemy, entry } of reacting) {
    if (combatIsOver(state)) return
    // A host that died meanwhile has already shed its cards (`detachSlayerCards`),
    // so "still attached here" also rules out pinging a corpse.
    if (enemy.dead || !enemy.slayerAttachments?.some((held) => held.card.uid === entry.card.uid)) continue
    const def = faceOf(cardDef(entry.card.defId), entry.card.upgraded)
    damageEnemy(state, enemy, actor.damageDealtZeroThisTurn ? 0 : def.attached!.amount,
      `${actor.name}'s ${def.name}`, actor)
  }
}

/**
 * Bandage Up reduces an otherwise-real HP loss, then leaves play.
 */
export function bandageUp(
  state: CombatState,
  player: Player,
  amount: number,
  losable: number,
  exhaustCards: ExhaustCardsCallback,
): number {
  let remaining = amount
  let lost = losable
  const answered: { held: CardInstance; then: 'exhaust' | 'discard' }[] = []
  for (const held of player.powers) {
    if (lost <= 0) break
    const effect = persistentEffectOf(held, 'reduceHpLoss')
    if (!effect) continue
    remaining = Math.max(0, remaining - effect.amount)
    lost = Math.min(player.hp, remaining)
    answered.push({ held, then: effect.then })
    state.log = [...state.log, `${player.name}'s Bandage Up prevents ${effect.amount} HP loss`]
  }
  for (const { held, then } of answered) {
    if (!player.powers.includes(held)) continue
    if (then === 'exhaust') {
      player.powers = player.powers.filter((power) => power.uid !== held.uid)
      exhaustCards(state, player, [held])
      state.log = [...state.log, `${player.name} exhausts Bandage Up`]
    } else discardPowerFromPlay(state, player, held, exhaustCards)
  }
  return lost
}

/** Fasting: the per-icon bonus on the owner's own Attack and Skill cards. Shivs are not cards. */
export function cardIconBonus(actor: Player, context: PlayContext, source?: string): number {
  if (source === 'Shiv' || context.slimeCommand || context.guardianGemPowerDamage ||
    (context.sourceCardType !== 'attack' && context.sourceCardType !== 'skill')) return 0
  return actor.powers.reduce((sum, power) => sum + (persistentEffectOf(power, 'cardIconBonus')?.amount ?? 0), 0)
}

/** A Metamorphosis leaves play as the physical Metamorphosis card, never as the Power it copied. */
export function metamorphosisCard(card: CardInstance): CardInstance {
  if (!card.metamorphosis) return card
  return { uid: card.uid, defId: 'slayer_metamorphosis', upgraded: card.metamorphosis.upgraded }
}

/** "If the copied Power is Exhausted or discarded, this card is as well." Chains follow too. */
export function followCopiedPowers(
  state: CombatState,
  actor: Player,
  leftUids: ReadonlySet<string>,
  to: 'exhaust' | 'discard',
  exhaustCards: ExhaustCardsCallback,
  context?: PlayContext,
): void {
  const followers = actor.powers.filter((power) =>
    power.metamorphosis !== undefined && leftUids.has(power.metamorphosis.sourceUid))
  if (followers.length === 0) return
  actor.powers = actor.powers.filter((power) => !followers.includes(power))
  state.log = [...state.log, `${actor.name}'s Metamorphosis ${to === 'exhaust' ? 'exhausts' : 'is discarded'} with the Power it copied`]
  if (to === 'exhaust') exhaustCards(state, actor, followers, context)
  else for (const follower of followers) discardPowerFromPlay(state, actor, follower, exhaustCards, false)
}

/** A Power that discards itself leaves play for the discard pile; it is not discarded from hand. */
export function discardPowerFromPlay(
  state: CombatState,
  actor: Player,
  held: CardInstance,
  exhaustCards: ExhaustCardsCallback,
  removeFromPlay = true,
): void {
  if (removeFromPlay) actor.powers = actor.powers.filter((power) => power.uid !== held.uid)
  const card = metamorphosisCard(forgetRetain({ ...held, counter: undefined }))
  actor.discard = [...actor.discard, card]
  state.log = [...state.log, `${actor.name} discards ${cardDef(card.defId).name}`]
  followCopiedPowers(state, actor, new Set([held.uid]), 'discard', exhaustCards)
}

/**
 * Backstop for removal paths that predate Metamorphosis: a copy whose Power has
 * left play follows it, and no pile ever holds the copy's borrowed identity.
 */
export function sweepMetamorphoses(state: CombatState, exhaustCards: ExhaustCardsCallback): void {
  for (const player of state.players) {
    for (const pile of ['hand', 'draw', 'discard', 'exhaust'] as const) {
      if (player[pile].some((card) => card.metamorphosis)) player[pile] = player[pile].map(metamorphosisCard)
    }
    for (;;) {
      const inPlay = new Set(player.powers.map((power) => power.uid))
      const orphan = player.powers.find((power) => power.metamorphosis && !inPlay.has(power.metamorphosis.sourceUid))
      if (!orphan) break
      // Every Exhaust goes through `exhaustCards`, which already takes the copies along, so an
      // orphan here lost its Power to a direct discard (Charge Up, Prepare Crush).
      discardPowerFromPlay(state, player, orphan, exhaustCards)
    }
  }
}

/** Mirrors each player's live window onto their hand, so cost displays and checks read it. */
export function syncCardPlayWindowMarks(state: CombatState): void {
  for (const player of state.players) {
    const live = activeCardPlayWindow(state, player.id)
    for (const pile of ['hand', 'draw', 'discard', 'exhaust', 'powers', 'chamber'] as const) {
      const cards = player[pile] ?? []
      // Only an offered card that can be played gets the window's cost (and its glow).
      const costOf = (card: CardInstance) => pile === 'hand' && live?.cardUids.includes(card.uid) &&
        cardPlayWindowCardPlayable(state, player, card, live.cost) ? live.cost : undefined
      if (cards.every((card) => card.playWindowCost === costOf(card))) continue
      player[pile] = cards.map((card) => {
        const cost = costOf(card)
        if (card.playWindowCost === cost) return card
        const { playWindowCost: _stale, ...rest } = card
        return cost === undefined ? rest : { ...rest, playWindowCost: cost }
      })
    }
  }
}

/** Opens a card-play window over the offered cards that are still in the caster's hand. */
export function openCardPlayWindow(
  state: CombatState,
  actor: Player,
  context: PlayContext,
  offered: readonly string[],
  spec: Pick<Extract<Effect, { kind: 'openPlayWindow' }>, 'cost' | 'plays' | 'optional' | 'discardRest'>,
): void {
  const sourceCardId = context.sourceCardId ?? 'card'
  const name = CARDS[sourceCardId]?.name ?? 'A card'
  const cardUids = offered.filter((uid, index) => offered.indexOf(uid) === index &&
    actor.hand.some((card) => card.uid === uid))
  if (cardUids.length === 0 || spec.plays === 0) {
    state.log = [...state.log, `${name}: ${actor.name} has no card to play`]
    return
  }
  const windows = state.pendingCardPlayWindows ?? []
  state.pendingCardPlayWindows = [...windows, {
    id: `${context.sourceCardUid ?? sourceCardId}@${state.turn}:${actor.cardsPlayedThisTurn ?? 0}:${windows.length}`,
    playerId: actor.id,
    sourceCardId,
    cardUids,
    cost: spec.cost,
    plays: spec.plays,
    optional: spec.optional,
    ...(spec.discardRest ? { discardRest: true } : {}),
  }]
  // Counts stay out of the public log: an offer of "every Attack in hand" would size a private hand.
  state.log = [...state.log, `${name}: ${actor.name} ${spec.optional ? 'may' : 'must'} play ${spec.plays === 1
    ? 'one card' : spec.plays === null ? spec.optional ? 'any number of cards' : 'the offered cards' : `${spec.plays} cards`
  } for ${spec.cost} Energy${spec.plays === 1 ? '' : ' each'}`]
  syncCardPlayWindowMarks(state)
}

/** Closes a player's live window. Discovery discards the offered cards that were not played. */
export function closeCardPlayWindowWithDiscard(
  state: CombatState,
  player: Player,
  discardCards: DiscardCardsCallback,
): void {
  const windows = state.pendingCardPlayWindows ?? []
  const live = activeCardPlayWindow(state, player.id)
  if (!live) return
  state.pendingCardPlayWindows = windows.filter((candidate) => candidate !== live)
  if (state.pendingCardPlayWindows.length === 0) delete state.pendingCardPlayWindows
  syncCardPlayWindowMarks(state)
  const rest = live.discardRest ? player.hand.filter((card) => live.cardUids.includes(card.uid)) : []
  if (rest.length > 0) discardCards(state, player, rest)
}

/**
 * Drops offered cards that left hand, then closes each player's live window
 * once it has nothing left to do: its plays are used, no offered card remains,
 * or (when it must be played) no offered card can be played. Waits while a
 * card, copy, or trigger is still resolving, so a nested window stays on top.
 */
export function settleCardPlayWindows(state: CombatState, discardCards: DiscardCardsCallback): void {
  for (const player of state.players) {
    for (let guard = 0; guard < 64 && !combatIsOver(state); guard++) {
      const idle = state.phase === 'player' && !state.pendingCardCopy && !(state.pendingTriggers?.length) &&
        !state.startTurnProgress && !state.endTurnProgress
      const live = activeCardPlayWindow(state, player.id)
      if (!live) break
      const cardUids = live.cardUids.filter((uid) => player.hand.some((card) => card.uid === uid))
      const current = cardUids.length === live.cardUids.length ? live : { ...live, cardUids }
      if (current !== live) {
        state.pendingCardPlayWindows = state.pendingCardPlayWindows!.map((candidate) =>
          candidate === live ? current : candidate)
      }
      if (!player.dead && !idle) break
      // Nothing it offers can still be played and paid for (a window that must be
      // played costs 0, so only playability decides there). An optional window
      // closes too, so cards outside it are playable again without a "Done".
      const stuck = !player.hand.some((card) => cardUids.includes(card.uid) &&
        cardPlayWindowCardPlayable(state, player, card, current.cost)) ||
        current.optional && player.energy + player.miracles < current.cost
      if (!player.dead && current.plays !== 0 && cardUids.length > 0 && !stuck) break
      if (stuck && cardUids.length > 0 && !player.dead) {
        state.log = [...state.log, `${player.name} cannot play the rest of ${CARDS[current.sourceCardId]?.name ?? 'a card'}'s cards`]
      }
      closeCardPlayWindowWithDiscard(state, player, discardCards)
    }
  }
  syncCardPlayWindowMarks(state)
}

/**
 * Ends every open window as the Player Turn ends. A window that must be played
 * cannot get here while it can still play; Discovery's offered-but-unplayed
 * cards are still discarded by its own effect.
 */
export function closeAllCardPlayWindowsWithDiscard(
  state: CombatState,
  discardCards: DiscardCardsCallback,
): void {
  for (const player of state.players) {
    for (let guard = 0; guard < 64 && activeCardPlayWindow(state, player.id); guard++) {
      closeCardPlayWindowWithDiscard(state, player, discardCards)
    }
  }
}

/**
 * Takes up to `count` cards off the top of a face-up discard pile — the end of
 * the array — topmost first, and gives them to the same player's hand or puts
 * them on top of their draw pile. Fewer cards are taken when the pile is short.
 */
export function takeDiscardTop(
  player: Player,
  count: number,
  to: 'hand' | 'drawTop',
  mayRetain: boolean,
): CardInstance[] {
  const taken = player.discard.slice(Math.max(0, player.discard.length - count)).reverse()
  if (taken.length === 0) return []
  player.discard = player.discard.slice(0, player.discard.length - taken.length)
  const cleaned = taken.map((card) => mayRetain ? { ...forgetRetain(card), mayRetainThisTurn: true } : forgetRetain(card))
  if (to === 'hand') player.hand = [...player.hand, ...cleaned]
  else player.draw = addToDrawTop(player, cleaned).draw
  return cleaned
}

export function discardTopLine(player: Player, moved: readonly CardInstance[], to: 'hand' | 'drawTop'): string {
  const names = moved.map((card) => faceOf(cardDef(card.defId), card.upgraded).name).join(' and ')
  return to === 'hand'
    ? `${player.name} returns ${names} from their discard pile to their hand`
    : `${player.name} puts ${names} from their discard pile on top of their draw pile`
}

/** Parks a decision that only `player` may answer; see `resolvePendingPlayerChoice`. */
export function queuePlayerChoice(
  state: CombatState,
  player: Player,
  sourceLabel: string,
  choice: { kind: 'drawOrDiscard' } | { kind: 'returnDiscardTop'; upTo: number },
): void {
  const id = allocateChoiceId(state)
  state.pendingPlayerChoices = [...(state.pendingPlayerChoices ?? []),
    { id, playerId: player.id, sourceLabel, ...choice }]
}

/** The next public id for a card-given choice, shared by player and Slayer choices. */
export function allocateChoiceId(state: CombatState): number {
  // A loaded state may lack the counter or carry a stale one: never reuse a pending id.
  const counter = Number.isSafeInteger(state.nextPlayerChoiceId) ? state.nextPlayerChoiceId! : 0
  const id = Math.max(counter, ...[...(state.pendingPlayerChoices ?? []), ...(state.pendingSlayerChoices ?? [])]
    .map((entry) => (entry.id ?? -1) + 1))
  state.nextPlayerChoiceId = id + 1
  return id
}

export function lapseDeadOwnerPlayerChoices(state: CombatState): void {
  const owed = (state.pendingPlayerChoices ?? []).filter((choice) =>
    state.players.some((player) => player.id === choice.playerId && !player.dead))
  if (!state.pendingPlayerChoices || owed.length === state.pendingPlayerChoices.length) return
  for (const choice of state.pendingPlayerChoices.filter((pending) => !owed.includes(pending))) {
    state.log = [...state.log, `${choice.sourceLabel}: its chooser is gone; the choice lapses`]
  }
  if (owed.length > 0) state.pendingPlayerChoices = owed
  else delete state.pendingPlayerChoices
}

export function clearTerminalChoices(state: CombatState): void {
  state.pendingTriggers = []
  state.pendingPlunderSwitches = []
  state.pendingDieRelicChoices = []
  state.pendingHermitSetupLoads = []
  state.pendingHermitChamberPlays = []
  state.pendingHermitStrengthRewards = []
  delete state.pendingPlayerChoices
  // Slayer Pack: a Ritual Dagger+ reveal from the killing blow survives a
  // victory: its owner still decides before the combat folds into the run.
  const ritual = state.enemies.every((enemy) => enemy.dead)
    ? state.pendingSlayerChoices?.filter((choice) => choice.kind === 'ritualDagger') : undefined
  if (ritual?.length) state.pendingSlayerChoices = ritual
  else delete state.pendingSlayerChoices
  delete state.pendingDistilled
  delete state.pendingRelicScry
  if (state.pendingCardPlayWindows) {
    delete state.pendingCardPlayWindows
    syncCardPlayWindowMarks(state)
  }
  delete state.endTurnProgress
  delete state.pendingCardCopy
  delete state.startTurnProgress
}
