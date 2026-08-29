// Reading the board for the screen: what a card still needs before it can be
// played, what a seat is called, and how the log reads.
//
// No components here and no hooks, and no reaching for state that was not passed
// in. `revealViewerRow` is the one that touches the DOM, because scrolling the
// board to the seat you control is a measurement rather than a render.
import type { Pending } from './types.ts'
import { cardDef, faceOf } from '../../game/cards.ts'
import type { CardDef, Effect } from '../../game/cards.ts'
import {
  cardEnemyChoiceCount,
  cardIsPlayable,
  cardNeedsEnemy,
  cardPlayerChoiceCount,
  cardShivChoiceCount,
  amountOf,
  effectIsActive,
  effectiveCombatCardDef,
  guardianCardNeedsAlly,
  guardianGemForCard,
  overflowShivCount,
  playCost,
  reachedTimeWarpLimit,
  remainingRoundHpLoss,
} from '../../game/combat.ts'
import type { CombatState } from '../../game/combat.ts'
import { potionDef } from '../../game/relics.ts'
import type { CardInstance, Player } from '../../game/types.ts'
import { orbDisplayText } from '../TokenRow.tsx'

/** The engine's phase names are for the engine; players get words. */
export const PHASE_LABEL: Record<CombatState['phase'], string> = {
  player: 'Your turn',
  copy: 'Resolve original card',
  start: 'Start of turn',
  discard: 'Order discards',
  enemy: 'Enemies act',
  roundEnd: 'Round over',
  won: 'Victory',
  lost: 'Defeat',
}

function requirementsOf(
  def: CardDef,
  allies: number,
  viewer: Player,
  state: CombatState,
  energySpent?: number,
  cardInHand = true,
  sourceDeadOn = false,
  previewChoiceCount?: number,
  attachedGemId?: string,
  sourceCardUid?: string,
  energyCharged = energySpent,
): Omit<Pending, 'card' | 'cardInHand' | 'chamberPlay' | 'energySpent' | 'effectEnergy' | 'energyCharged' | 'picked' | 'enemyUid' | 'playerId' | 'switchPlayerId' | 'switchChoiceDone' | 'enemyUids' | 'playerIds' | 'shivEnemyUids' | 'evokeSlots' | 'evokeEnemyUids' | 'mode' | 'corruptedShardMode' | 'choiceCards' | 'choiceConfirmed' | 'slimeUids' | 'slimeChoiceConfirmed' | 'slimeEnemyUids' | 'chamberUids' | 'chamberChoiceConfirmed' | 'hermitEnemyUids' | 'hermitDieRelics' | 'hermitDieRelicChoiceConfirmed' | 'soulburnEnemyUids' | 'guardianPowerCardUid'> {
  const onPlayEffects = def.type === 'power' && def.resolvesOnPlay !== true ? [] : def.effects
  const selectableEffects = onPlayEffects.flatMap((effect) => effect.kind === 'deadOnEffects'
    ? sourceDeadOn ? effect.effects : []
    : [effect])
  // The same predicate the engine uses to decide whether to REFUSE the play.
  // Two copies of this list drifted apart once already: the UI would prompt for
  // an enemy and the engine would then throw the choice away. The viewer goes
  // in because a counted attack with nothing to count reaches nobody, and
  // asking where to point it is asking a question with no consequence.
  const cardTarget = cardNeedsEnemy(def, viewer, false, energySpent, false, attachedGemId, sourceCardUid,
    energyCharged)
  const shivsGained = cardShivsOnPlay(def)
  const overflowShivs = overflowShivCount(state, shivsGained)
  const spentShivs = cardShivChoiceCount(def, viewer)
  const enemyChoices = onPlayEffects.length > 0 ? cardEnemyChoiceCount(def, undefined, state, viewer) : 0
  const playerChoices = onPlayEffects.length > 0 ? cardPlayerChoiceCount(def) : 0
  const slimeCommands = selectableEffects.some((effect) => {
    const slime = effect as unknown as { kind: string; commandAfter?: boolean }
    return slime.kind === 'commandSlime' || slime.commandAfter === true
  })
  const needsEnemy = cardTarget || slimeCommands || spentShivs > 0 || overflowShivs > 0 || enemyChoices > 0
  // With one player on the board there is nobody to choose between, so asking
  // "who gets it" is a prompt with a single possible answer.
  const needsAlly = (def.supportTarget === 'anyPlayer' || guardianCardNeedsAlly(def, viewer, attachedGemId)) && allies > 1
  const needsSwitch = onPlayEffects.some((effect) => effect.kind === 'switchRows') && allies > 1
  const discard = selectableEffects.find((effect) => effect.kind === 'discard')
  const discardAny = selectableEffects.some((effect) => effect.kind === 'discardAny')
  const exhaust = selectableEffects.find((effect) => effect.kind === 'exhaustFromHand')
  const exhaustAny = selectableEffects.find((effect) => effect.kind === 'exhaustAny')
  const topdeck = selectableEffects.find((effect) => effect.kind === 'topdeck')
  const recover = selectableEffects.find((effect) => effect.kind === 'recoverDiscard')
  const recoverExhaust = selectableEffects.find((effect) => effect.kind === 'recoverExhaust' ||
    effect.kind === 'recoverExhaustToDraw' || effect.kind === 'recoverExhaustToDiscard')
  const search = selectableEffects.find((effect) =>
    effect.kind === 'searchDraw' || effect.kind === 'searchDrawAndPlayTwice' ||
    ['overexert', 'replicateSlime'].includes((effect as { kind: string }).kind))
  const scried = selectableEffects.find((effect): effect is Extract<Effect, { kind: 'scry' }> =>
    effect.kind === 'scry' && effectIsActive(effect, state, viewer))
  const scryToHand = selectableEffects.find((effect): effect is Extract<Effect, { kind: 'scryToHand' }> =>
    effect.kind === 'scryToHand' && effectIsActive(effect, state, viewer))
  const load = selectableEffects.find((effect) => effect.kind === 'load')
  const chamberSlots = viewer.chamberSlots + selectableEffects
    .filter((effect) => effect.kind === 'gainChamberSlot')
    .reduce((sum, effect) => sum + effect.amount, 0)
  const loadPool = previewChoiceCount ?? (load?.source === 'discard'
    ? viewer.discard.length
    : Math.max(0, viewer.hand.length - Number(cardInHand)))
  const loadAmount = load ? Math.min(load.amount, loadPool) : 0
  const choice = attachedGemId === 'guardian_jasper'
    ? { kind: 'exhaustAny' as const, amount: Math.min(def.id === 'guardian_bauble_burst' ? 6 : 3,
      Math.max(0, viewer.hand.length - Number(cardInHand))), minimum: 0 }
    : discard
    ? { kind: 'discard' as const, amount: discard.amount }
    : discardAny
      ? { kind: 'discardAny' as const, amount: Math.max(0, viewer.hand.length - Number(cardInHand)) }
    : exhaust
      ? { kind: 'exhaust' as const, amount: exhaust.amount }
    : exhaustAny
      ? { kind: 'exhaustAny' as const, amount: exhaustAny.amount, minimum: exhaustAny.minimum }
      : scryToHand
        ? { kind: 'scryToHand' as const, amount: scryToHand.amount }
      : scried
        ? { kind: 'scry' as const, amount: scried.amount }
        : topdeck
          ? { kind: 'topdeck' as const, amount: topdeck.amount }
        : recover && viewer.discard.length > 0
          ? { kind: 'recover' as const, amount: recover.amount }
        : recoverExhaust && viewer.exhaust.length > 0
          ? { kind: 'recoverExhaust' as const, amount: recoverExhaust.amount,
            minimum: recoverExhaust.kind === 'recoverExhaustToDraw' ? 0 : undefined }
        : search
          ? { kind: 'search' as const, amount: search.kind === 'searchDraw' ? search.amount : 1 }
        : load
          ? { kind: load.upTo ? 'loadAny' as const : 'load' as const, amount: loadAmount,
            minimum: load.upTo ? 0 : loadAmount }
        : null
  const slimeEffect = selectableEffects.find((effect) => ['growSlime', 'commandSlime', 'gainSlimeVigor', 'tapSlime']
    .includes(effect.kind)) as unknown as {
      kind: 'growSlime' | 'commandSlime' | 'gainSlimeVigor' | 'tapSlime'
      amount: import('../../game/cards.ts').Amount
      upToDifferent?: number
      all?: boolean
      same?: boolean
    } | undefined
  const slimeAmount = !slimeEffect || slimeEffect.kind === 'commandSlime' && slimeEffect.all ? 0
    : slimeEffect.kind === 'commandSlime' && slimeEffect.upToDifferent === 99
      ? Math.min(viewer.slimes?.length ?? 0, amountOf(slimeEffect.amount, state, viewer, undefined,
        { enemyUid: null, playerId: viewer.id, energySpent }))
      : Math.min(viewer.slimes?.length ?? 0, slimeEffect.upToDifferent ?? 1)
  const slimeUpTo = Boolean(slimeEffect?.upToDifferent && slimeEffect.upToDifferent !== 99)
  const dieRelic = selectableEffects.find((effect) => effect.kind === 'triggerDieRelic')
  const chamberEffect = selectableEffects.find((effect) =>
    effect.kind === 'playChamber' || effect.kind === 'discardChamber' || effect.kind === 'discountChamber')
  const chamberEligible = chamberEffect?.kind === 'discardChamber' && chamberEffect.curseOnly
    ? viewer.chamber.filter((card) => faceOf(cardDef(card.defId), card.upgraded).type === 'curse')
    : viewer.chamber
  const chamberRequested = chamberEffect?.kind === 'playChamber' && chamberEffect.amount === 'all'
    ? chamberEligible.length : Number(chamberEffect?.amount ?? 0)
  const chamberAmount = chamberEffect
    ? Math.min(chamberRequested, chamberEligible.length)
    : 0
  const loadSelf = selectableEffects.some((effect) => effect.kind === 'loadSelf')
  const chamberAfterBase = viewer.chamber.length -
    (chamberEffect?.kind === 'discardChamber' ? chamberAmount : 0)
  const openAfterBase = Math.max(0, chamberSlots - chamberAfterBase)
  const replacementMax = Math.max(0, loadAmount + Number(loadSelf) - openAfterBase)
  const totalChamberChoices = chamberAmount + replacementMax
  const soulburn = selectableEffects.find((effect) => effect.kind === 'useAllSoulburn')
  const soulburnGained = soulburn ? selectableEffects.slice(0, selectableEffects.indexOf(soulburn))
    .reduce((sum, effect) => sum + (effect.kind === 'gainSoulburn' && effectIsActive(effect, state, viewer)
      ? amountOf(effect.amount, state, viewer, undefined,
        { enemyUid: null, playerId: viewer.id, energySpent }) : 0), 0) : 0
  return {
    needsEnemy,
    needsAlly,
    needsSwitch,
    overflowShivs,
    spentShivs,
    enemyChoices,
    playerChoices,
    hitsRow: def.target === 'row',
    choice,
    slimeChoice: slimeAmount > 0 ? { amount: slimeAmount, minimum: slimeUpTo ? 0 : slimeAmount } : null,
    hermitDieRelicChoice: dieRelic?.kind === 'triggerDieRelic'
      ? { amount: dieRelic.amount, minimum: dieRelic.upTo ? 0 : dieRelic.amount } : null,
    chamberChoice: totalChamberChoices > 0 ? {
      kind: chamberEffect?.kind === 'playChamber' ? 'play' : chamberEffect?.kind === 'discardChamber' ? 'discard'
        : chamberEffect?.kind === 'discountChamber' ? 'discount' : 'replace',
      amount: totalChamberChoices,
      minimum: chamberEffect?.kind === 'discardChamber' && chamberEffect.optional ? 0 : chamberAmount,
      eligibleUids: (replacementMax > 0 ? viewer.chamber : chamberEligible).map((card) => card.uid),
      ...(replacementMax > 0 ? { baseAmount: chamberAmount, openAfterBase, loadSelf } : {}),
    } : null,
    chooseLoadSelf: selectableEffects.some((effect) => effect.kind === 'loadSelf' && effect.optional) ? null : false,
    spendVigor: viewer.guardianMode !== null && viewer.vigor > 0 &&
      (def.type === 'attack' || def.type === 'skill') ? null : 0,
    guardianModeShift: ['guardian_hack', 'guardian_gear_up', 'guardian_speed_boost'].includes(def.id) ? null : false,
    secondGuardianModeShift: def.id === 'guardian_bauble_burst' && attachedGemId === 'guardian_amethyst' ? null : false,
    guardianBlockSpend: def.id === 'guardian_body_crash' ? null : 0,
    soulburnChoices: soulburn ? Math.min(6, viewer.soulburn + soulburnGained) : 0,
  }
}

export function pendingFor(
  card: CardInstance,
  choiceCards: CardInstance[] | null,
  state: CombatState,
  viewer: Player,
  cardInHand = true,
  copiedEnergySpent?: number,
  sourceInActorHand = cardInHand,
): Pending {
  const def = effectiveCombatCardDef(faceOf(cardDef(card.defId), card.upgraded), viewer.guardianMode)
  const attachedGemId = guardianGemForCard(viewer, card)
  const shownCard = attachedGemId === card.attachedGemId ? card : { ...card, attachedGemId }
  const forced = state.startTurnProgress?.forcedCard?.playerId === viewer.id &&
    state.startTurnProgress.forcedCard.cardUid === card.uid
  const cost = forced ? 0 : playCost(def, viewer, card)
  const energySpent = copiedEnergySpent ?? (cost === 'X' ? null : 0)
  const effectEnergy = copiedEnergySpent ?? (def.cost === 'X' && cost !== 'X' ? cost : energySpent)
  const energyCharged = copiedEnergySpent === undefined
    ? (typeof cost === 'number' ? cost : null)
    : 0
  const requirements = requirementsOf(
    def, state.players.filter((player) => !player.dead).length, viewer, state, effectEnergy ?? undefined, sourceInActorHand,
    card.hermitDeadOn === true, choiceCards?.length, attachedGemId, card.uid,
    energyCharged ?? undefined,
  )
  return {
    card: shownCard,
    cardInHand,
    chamberPlay: false,
    energySpent,
    effectEnergy,
    energyCharged,
    ...requirements,
    guardianModeShift: requirements.guardianModeShift === null || attachedGemId === 'guardian_amethyst' ? null : false,
    enemyUid: null,
    playerId: null,
    switchPlayerId: null,
    switchChoiceDone: false,
    enemyUids: [],
    playerIds: state.players.filter((player) => !player.dead).length === 1
      ? Array(requirements.playerChoices).fill(viewer.id)
      : [],
    shivEnemyUids: [],
    evokeSlots: [],
    evokeEnemyUids: [],
    mode: null,
    corruptedShardMode: null,
    choiceCards: choiceCards ?? (requirements.choice?.kind === 'recover'
      ? viewer.discard
      : requirements.choice?.kind === 'recoverExhaust' ? viewer.exhaust
        : requirements.choice?.kind === 'load' || requirements.choice?.kind === 'loadAny'
          ? (def.effects.find((effect) => effect.kind === 'load')?.source === 'discard'
            ? viewer.discard : viewer.hand.filter((held) => held.uid !== card.uid))
          : null),
    choiceConfirmed: false,
    picked: [],
    slimeUids: [],
    slimeChoiceConfirmed: false,
    slimeEnemyUids: [],
    chamberUids: [],
    chamberChoiceConfirmed: false,
    hermitEnemyUids: [],
    hermitDieRelics: [],
    hermitDieRelicChoiceConfirmed: false,
    soulburnEnemyUids: [],
    guardianPowerCardUid: null,
    scryToHandUid: undefined,
  }
}

export function gainedShivs(effects: readonly Effect[], discarded = 0): number {
  return effects.reduce((sum, effect) => sum + (effect.kind === 'gainShiv'
    ? effect.amount
    : effect.kind === 'gainShivPerDiscard' ? discarded + effect.bonus : 0), 0)
}

export function cardShivsOnPlay(def: CardDef, discarded = 0): number {
  return def.type === 'power' && def.trigger && def.resolvesOnPlay !== true
    ? 0
    : gainedShivs(def.effects, discarded)
}

/** Rows are the board's spatial unit: one per player, enemies sit in them. */
export function rowsOf(state: CombatState): number[] {
  const rows = new Set<number>()
  for (const player of state.players) rows.add(player.row)
  for (const enemy of state.enemies) if (!enemy.isBoss) rows.add(enemy.row)
  return [...rows].sort((a, b) => b - a)
}

export function revealViewerRow(board: HTMLElement | null, row: HTMLElement | null) {
  if (!board || !row) return
  const boardBox = board.getBoundingClientRect()
  const rowBox = row.getBoundingClientRect()
  board.scrollTop += rowBox.top - boardBox.top - (board.clientHeight - rowBox.height) / 2
  const seats = [...row.querySelectorAll<HTMLElement>('.row__seat')]
  const partySeats = [...board.querySelectorAll<HTMLElement>('.row__seat')]
    .filter((seat) => seat.querySelector('.seat:not(.seat--empty)'))
  const enemies = [...row.querySelectorAll<HTMLElement>('.enemy')]
  const bosses = [...board.querySelectorAll<HTMLElement>('.board__bosses .enemy:not(.enemy--dead)')]
  let actors = [...seats, ...(enemies.length > 0 ? enemies : bosses)]
  const span = (items: HTMLElement[]): [number, number] => {
    const boxes = items.map((actor) => actor.getBoundingClientRect())
    return [Math.min(...boxes.map((box) => box.left)), Math.max(...boxes.map((box) => box.right))]
  }
  const gutter = 8
  if (actors.length > 0 && seats.length > 0) {
    const [left, right] = span(actors)
    if (right - left > board.clientWidth - gutter * 2) {
      if (partySeats.length > 0) {
        const [partyLeft, partyRight] = span(partySeats)
        actors = partyRight - partyLeft <= board.clientWidth - gutter * 2 ? partySeats : seats
      } else {
        actors = seats
      }
    }
  }
  if (actors.length > 0) {
    const [left, right] = span(actors)
    const target = board.scrollLeft + left - boardBox.left - (board.clientWidth - (right - left)) / 2
    board.scrollLeft = Math.max(0, Math.min(Math.max(0, board.scrollWidth - board.clientWidth), target))
  }
}

/**
 * The seat button's accessible name.
 *
 * An `aria-label` replaces the element's contents wholesale, so anything not
 * named here is invisible to a screen reader no matter how it is marked up —
 * which is how the tokens' own hidden labels ended up unreachable. Everything
 * shown on the seat has to be listed.
 */
export function describeSeat(player: Player): string {
  const parts = [`${player.name}, ${player.hp} of ${player.maxHp} hit points, row ${player.row + 1}`]
  const tokens: [string, number][] = [
    ['Block', player.block],
    ['Strength', player.strength],
    ['Vulnerable', player.vulnerable],
    ['Weak', player.weak],
    ['Shivs', player.shivs],
    ['Miracles', player.miracles],
    ['Claw cubes', player.clawCubesGainedThisCombat ?? 0],
  ]
  for (const [label, value] of tokens) if (value > 0) parts.push(`${label} ${value}`)
  if (player.strengthLossAtEndOfTurn > 0) {
    parts.push(`Strength loss at end of turn ${player.strengthLossAtEndOfTurn}`)
  }
  if (player.drawLocked) parts.push('cannot draw more cards this turn')
  if (player.cardPlayLocked) parts.push('cannot play additional cards this turn')
  if ((player.freeAttacksThisTurn ?? 0) > 0) parts.push('next Attack costs 0 this turn')
  if ((player.doubledAttacksThisTurn ?? 0) > 0) {
    parts.push(`Double Tap, next ${player.doubledAttacksThisTurn} Attack${player.doubledAttacksThisTurn === 1 ? '' : 's'} played twice`)
  }
  if ((player.tripledAttacksThisTurn ?? 0) > 0) {
    parts.push(`Blasphemy, next ${player.tripledAttacksThisTurn} Attack${player.tripledAttacksThisTurn === 1 ? '' : 's'} played three times`)
  }
  if ((player.doubledCardsThisTurn ?? 0) > 0) {
    parts.push(`Echo Form, next ${player.doubledCardsThisTurn} Attack or Skill card${
      player.doubledCardsThisTurn === 1 ? '' : 's'
    } played twice`)
  }
  if ((player.doubledSkillsThisTurn ?? 0) > 0) {
    parts.push(`Burst, next ${player.doubledSkillsThisTurn} Skill${player.doubledSkillsThisTurn === 1 ? '' : 's'} played twice`)
  }
  const hpLossRemaining = remainingRoundHpLoss(player)
  if (hpLossRemaining !== undefined) {
    parts.push(`${player.powers.some((power) => power.defId === 'wraith_form') ? 'Wraith Form' : 'Apparition'} protection, ${hpLossRemaining} hit point loss remaining this round`)
  }
  if (player.character === 'defect') {
    parts.push(`${player.orbs.filter(Boolean).length} of ${player.orbs.length} Orb slots occupied`)
  }
  for (const orb of player.orbs) if (orb) parts.push(`${orb} orb, ${orbDisplayText(player, orb)}`)
  if (player.potions.length > 0) parts.push(`potions ${potionDescription(player)}`)
  if (player.stance !== 'neutral') parts.push(`${player.stance} stance`)
  // Powers are deliberately NOT listed here. They render as a sibling list
  // outside this button, with their own labels — naming them here as well had
  // a screen reader announce every Power twice.
  if (player.dead) parts.push('defeated')
  return parts.join(', ')
}

function potionDescription(player: Player): string {
  return [...new Set(player.potions)].map((potionId) => {
    const count = player.potions.filter((held) => held === potionId).length
    const potion = potionDef(potionId)
    return `${potion.name}${count > 1 ? ` ×${count}` : ''}: ${potion.text}`
  }).join(', ')
}

/**
 * How far a card sits from the middle of the fan, from -1 to 1.
 *
 * A single card hangs straight; the spread narrows as the hand grows so a full
 * hand still fits the width it is given.
 */
export function fanOf(index: number, count: number): number {
  if (count < 2) return 0
  return (index - (count - 1) / 2) / ((count - 1) / 2)
}

export function canAfford(
  state: CombatState,
  player: Player,
  card: CardInstance,
  spendMiracle = false,
  drawCount = player.draw.length,
  sourceInHand = true,
): boolean {
  const def = effectiveCombatCardDef(faceOf(cardDef(card.defId), card.upgraded), player.guardianMode)
  if (!cardIsPlayable(def, state, player, drawCount, sourceInHand)) return false
  if (reachedTimeWarpLimit(state, player)) return false
  const cost = playCost(def, player, card)
  if (spendMiracle && (cost === 'X' || cost === 0)) return false
  if (def.cost === 'X' && cost !== 'X' && cost < (def.minimumX ?? 0)) return false
  return cost === 'X'
    ? player.energy >= (def.minimumX ?? 0)
    : cost <= player.energy + (spendMiracle ? 1 : 0)
}
