import type React from 'react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { cardDef, faceOf } from '../game/cards.ts'
import type { CardDef } from '../game/cards.ts'
import type { Amount, Condition, CountOf, Effect, EnemyTokenKind } from '../game/cards.ts'
import type { HandEndOfTurnEffect } from '../game/cards.ts'
import { cardThumbPath } from '../game/assets.ts'
import { CardFace, cardTypeLabel } from './CardFace.tsx'
import { Icon, StatusIcon } from './Icon.tsx'
import type { IconName, StatusIconName } from './icons.ts'
import type { CardInstance } from '../game/types.ts'
import type { Trigger } from '../game/triggers.ts'

type CardProps = {
  card: CardInstance
  className?: string
  style?: React.CSSProperties
  /** Current cost after board-state reductions. */
  cost?: number | 'X'
  playable?: boolean
  /** Staged for play, waiting on a target or a choice. */
  selected?: boolean
  /** Chosen as the subject of another card's discard or exhaust effect. */
  picked?: boolean
  /** The attached Gem came from a Gem Power such as Crystallize. */
  gemPowerDamage?: boolean
  /** Position in the fan, -1 (leftmost) to 1 (rightmost), 0 in the middle. */
  fan?: number
  /** Removes an otherwise-real card button from sequential keyboard navigation. */
  tabIndex?: number
  onClick?: (card: CardInstance) => void
  onPointerDown?: React.PointerEventHandler<HTMLButtonElement>
  onPointerMove?: React.PointerEventHandler<HTMLButtonElement>
  onPointerUp?: React.PointerEventHandler<HTMLButtonElement>
  onPointerCancel?: React.PointerEventHandler<HTMLButtonElement>
  onLostPointerCapture?: React.PointerEventHandler<HTMLButtonElement>
}

/** Show an optional publisher scan only after Chromium can decode its pixels. */
export function revealDecodedImage(image: HTMLImageElement, options?: {
  isCurrent?: () => boolean
  onDecodeError?: () => void
}) {
  void image.decode().then(
    () => {
      if (options?.isCurrent && !options.isCurrent()) return
      image.style.visibility = 'visible'
    },
    () => {
      if (options?.isCurrent && !options.isCurrent()) return
      image.style.visibility = 'hidden'
      options?.onDecodeError?.()
    },
  )
}

/**
 * What a screen reader announces for the card.
 *
 * The optional publisher face is an image and the native face is deliberately
 * terse. This string carries the exact play clauses for assistive technology.
 */
const COUNT_LABEL: Record<CountOf, string> = {
  orbs: 'charged orb',
  frostOrbs: 'Frost Orb',
  lightningOrbs: 'Lightning Orb',
  orbTypes: 'different orb type',
  block: 'Block',
  strength: 'Strength',
  miracles: 'Miracle held',
  cardsInHand: 'other card in hand',
  retainCardsInHand: 'other card with Retain in hand',
  cardsInExhaust: 'card in your Exhaust pile',
  energySpent: 'Energy spent on this card',
  strikesInHand: 'other card in hand containing Strike',
  skillsInHand: 'Skill in hand',
  attacksInHand: 'Attack in hand',
  otherAttacksInHand: 'other Attack in hand',
  attacksPlayedThisTurn: 'other Attack played this turn',
  attacksInExhaust: 'Attack in your Exhaust pile',
  attackingEnemies: 'enemy intending to attack you',
  clawCubesGainedThisCombat: 'Claw cube gained this combat',
  heat: 'Heat',
  attacksInChamber: 'Attack in your Chamber',
  cursesInHandAndChamber: 'Curse in your hand or Chamber',
  starterCardsInHandAndChamber: 'starter Strike or Defend in your hand or Chamber',
  otherCardsInHand: 'other card in your hand',
}

const TARGET_TOKEN_LABEL: Record<EnemyTokenKind, string> = {
  strength: 'Strength',
  vulnerable: 'Vulnerable',
  weak: 'Weak',
  poison: 'Poison',
}

function targetTokenText(tokens: readonly EnemyTokenKind[]): string {
  const labels = tokens.map((token) => TARGET_TOKEN_LABEL[token])
  if (labels.length < 2) return labels[0] ?? ''
  return `${labels.slice(0, -1).join(', ')}${labels.length > 2 ? ',' : ''} and ${labels.at(-1)}`
}

function conditionText(condition: Condition): string {
  switch (condition.kind) {
    case 'hasShiv': return 'you have a Shiv'
    case 'targetPoisoned': return 'the target has Poison'
    case 'discardTopCosts': return `your discard top costs ${condition.cost}`
    case 'dieShows': return `the die shows ${condition.faces.join(' or ')}`
    case 'inStance': return `you are in ${condition.stance}`
    case 'notInStance': return `you are not in ${condition.stance}`
    case 'discardedThisTurn': return 'you discarded this turn'
    case 'stanceChangedThisTurn': return 'you changed stance this turn'
    case 'targetFullHp': return 'the target is at full hit points'
    case 'firstTurnOfCombat': return 'it is the first turn of combat'
    case 'firstCardPlayedThisTurn': return 'this is the first card you played this turn'
    case 'hasNoAttacksInHand': return 'you have no Attacks in hand'
    case 'allCardsInHandAreAttacks': return 'every card in your hand is an Attack'
    case 'onlyAttackInHand': return 'this is the only Attack in your hand'
    case 'goldAtLeast': return `you have ${condition.amount} or more gold`
    case 'orbsAtLeast': return `you have ${condition.amount} or more Orbs`
    case 'drawPileEmpty': return 'your draw pile is empty'
    case 'handEmpty': return 'your hand is empty'
    case 'drewSkill': return 'the card just drawn is a Skill'
    case 'retainedLastTurn': return 'this card was Retained last turn'
    case 'heatAtLeast': return `you have at least ${condition.amount} Heat`
    case 'heatBelow': return `you have less than ${condition.amount} Heat`
    case 'cardsInExhaustAtLeast': return `you have at least ${condition.amount} cards in your Exhaust pile`
    case 'soulburnUsedThisTurn': return 'you used Soulburn this turn'
    case 'hasCurseInChamber': return 'you have a Curse in your Chamber'
    case 'hasDeadOnAttackInChamber': return 'you have a Dead On Attack in your Chamber'
    case 'hpAtMost': return `you have ${condition.amount} or fewer hit points`
  }
}

function amountText(amount: Amount, hit = false): string {
  if (typeof amount === 'number') return String(amount)
  if (amount.per === 'energySpent' && !amount.bonus && !amount.targetTokens) {
    const scale = amount.scale ?? 1
    const variable = scale === 1 ? 'X' : `${scale}X`
    return amount.base ? `${variable}+${amount.base}` : variable
  }
  const parts: string[] = []
  if (amount.base || (!amount.bonus && !amount.per)) parts.push(String(amount.base))
  if (amount.bonus) parts.push(`${amount.bonus.plus} if ${conditionText(amount.bonus.when)}`)
  if (amount.per) {
    // Hit arithmetic already adds Strength once. A hit's counted Strength is
    // therefore the printed total multiplier, not only the stored extra scale.
    const scale = (amount.scale ?? 1) + (hit && amount.per === 'strength' ? 1 : 0)
    parts.push(`${scale} per ${COUNT_LABEL[amount.per]}`)
  }
  if (amount.targetTokens) {
    parts.push(`1 per ${targetTokenText(amount.targetTokens)} on the target`)
  }
  return parts.join(' plus ')
}

function timesText(times: Amount): string {
  if (typeof times === 'number') return times === 1 ? 'once' : `${times} times`
  const parts: string[] = []
  const count = (amount: number) => amount === 1 ? 'once' : `${amount} times`
  if (times.base) parts.push(count(times.base))
  if (times.bonus) parts.push(`${count(times.bonus.plus)} if ${conditionText(times.bonus.when)}`)
  if (times.per) parts.push(`${count(times.scale ?? 1)} per ${COUNT_LABEL[times.per]}`)
  if (times.targetTokens) {
    parts.push(`once per ${targetTokenText(times.targetTokens)} on the target`)
  }
  return parts.join(' plus ') || '0 times'
}

function effectText(effect: Effect): string {
  if ((effect as { kind: string }).kind === 'gainSlimeVigor') {
    const slimeEffect = effect as unknown as {
      amount: number; temporary?: boolean; commandAfter?: boolean
    }
    return `gain ${slimeEffect.amount} Strength${slimeEffect.commandAfter ? ', then Command it' : ''}` +
      `${slimeEffect.temporary ? `, lose that ${slimeEffect.amount} Strength at end of turn` : ''}`
  }
  const condition = effect.when ? ` if ${conditionText(effect.when)}` : ''
  switch (effect.kind) {
    case 'sequence': return `${effect.effects.map(effectText).join(', then ')}${condition}`
    case 'branch': return `if ${conditionText(effect.condition)}, ${effect.effects.map(effectText).join(', then ')}; otherwise, ${effect.otherwise.map(effectText).join(', then ')}${condition}`
    case 'hit': return typeof effect.amount !== 'number' && effect.amount.per === 'miracles' &&
      effect.amount.base === 0 && !effect.amount.bonus && !effect.amount.targetTokens
      ? `deal ${effect.amount.scale ?? 1} damage per ${COUNT_LABEL.miracles}${condition}`
      : `deal ${amountText(effect.amount, true)} damage${effect.times ? ` ${timesText(effect.times)}` : ''}${condition}`
    case 'rowHit': return `deal ${amountText(effect.amount, true)} damage to a row and any boss${effect.times ? ` ${timesText(effect.times)}` : ''}${condition}`
    case 'hitChoices': return effect.targets === 1
      ? `deal ${amountText(effect.amount, true)} damage to one enemy${condition}`
      : effect.distinct
        ? `deal ${amountText(effect.amount, true)} damage to ${effect.targets} distinct enemies${condition}`
        : `deal ${effect.targets} separately targeted hits for ${amountText(effect.amount, true)} damage each${condition}`
    case 'damage': return `deal ${amountText(effect.amount)} damage${condition}`
    case 'advance': return `Advance${effect.times ? ` ${timesText(effect.times)}` : ''}${condition}`
    case 'retract': return `Retract${effect.times ? ` ${timesText(effect.times)}` : ''}${condition}`
    case 'gainSoulburn': return `gain ${amountText(effect.amount)} Soulburn${condition}`
    case 'nextSoulburnDamageBonus': return `your next Soulburn deals +${effect.amount} damage${condition}`
    case 'useAllSoulburn': return `use all Soulburn on ${effect.target === 'row' ? 'a row and any boss' : 'one enemy'}${effect.regain ? ', then regain that Soulburn' : ''}${condition}`
    case 'spendEnergy': return `spend ${effect.amount} Energy${condition}`
    case 'exhaustNextCard': return `exhaust the next card you play${condition}`
    case 'damagePerAttackIntent': return `deal ${effect.amount} damage to each enemy attacking you per Attack icon in its intent${condition}`
    case 'loseHp': return `lose ${effect.amount} hit points${condition}`
    case 'loseOwnHp': return `lose ${effect.amount} hit points${condition}`
    case 'block': return typeof effect.amount !== 'number' && effect.amount.base === 0 &&
      effect.amount.per === 'block' && effect.amount.scale === undefined && effect.amount.bonus === undefined
      ? `double your Block, maximum Block 20${condition}`
      : `gain ${amountText(effect.amount)} Block${condition}`
    case 'blockChoices': return `assign ${effect.targets} separate ${amountText(effect.amount)} Block icons to any players${condition}`
    case 'applyVulnerable': return `apply ${effect.amount} Vulnerable${condition}`
    case 'applyWeak': return `apply ${amountText(effect.amount)} Weak${condition}`
    case 'weakChoices': return `assign ${effect.targets} separate ${effect.amount} Weak tokens to enemies${condition}`
    case 'vulnerableChoices': return `assign ${effect.targets} separate ${effect.amount} Vulnerable tokens to enemies${condition}`
    case 'gainStrength': return `gain ${amountText(effect.amount)} Strength${condition}`
    case 'doubleStrength': return `double your Strength, maximum Strength 8${condition}`
    case 'gainTemporaryStrength': return effect.loseGainedOnly
      ? `gain ${amountText(effect.amount)} Strength, lose that Strength at end of turn${condition}`
      : `gain ${amountText(effect.amount)} Strength, lose ${amountText(effect.amount)} Strength at end of turn${condition}`
    case 'poison': return `apply ${amountText(effect.amount)} Poison${condition}`
    case 'poisonChoices': return `assign ${effect.targets} separate ${effect.amount} Poison tokens to enemies${condition}`
    case 'multiplyPoison': return `multiply the target's Poison by ${effect.factor}${condition}`
    case 'attachCorpseExplosion': return `attach this card to the target; when it dies, deal ${effect.damage} damage to its row and discard this card${condition}`
    case 'copyLastPlayed': return 'play a copy of the last Attack or Skill played by any player this turn with cost equal to X'
    case 'copyLastAllyAttack': return "play a copy of the last Attack another player played this turn"
    case 'copyLastAttack': return `play a copy of the last Attack you played this turn${condition}`
    case 'draw': return `draw ${amountText(effect.amount)} ${effect.amount === 1 ? 'card' : 'cards'}${condition}`
    case 'drawThenDiscard': return `draw ${effect.amount} card then discard 1 card`
    case 'drawToHandSize': return `draw until you have ${effect.size} cards in hand${condition}`
    case 'cycleHand': return 'discard your hand, then draw that many cards'
    case 'discardNonRetain': return 'discard every card without Retain'
    case 'preventDraw': return 'cannot draw more cards this turn'
    case 'preventCardPlay': return 'cannot play additional cards this turn'
    case 'discountNextCard': return 'your next card this turn costs 0'
    case 'setNextCardCost': return `your next card this turn costs ${effect.amount}`
    case 'discountNextAttack': return 'your next Attack this turn costs 0'
    case 'discountHand': return 'cards currently in your hand cost 0 this turn'
    case 'discountRetainedCards': return `cards Retained last turn cost ${effect.amount} less this turn`
    case 'doubleNextAttack': return 'your next Attack this turn is played twice, with separate targets and modifiers'
    case 'tripleNextAttack': return 'your next Attack this turn is played three times, with separate targets and modifiers'
    case 'doubleNextAttackOrSkill': return 'your next Attack or Skill this turn is played twice, with separate choices and modifiers'
    case 'doubleNextSkill': return 'your next Skill this turn is played twice, with separate choices and modifiers; Burst cannot be copied or played twice'
    case 'retainAtEndOfTurn': return `may retain ${effect.amount} card${effect.amount === 1 ? '' : 's'} this turn`
    case 'limitRoundHpLoss': return `cannot lose more than ${effect.amount} hit points this round`
    case 'preventHpLoss': return effect.uses === 1
      ? 'prevent the next time you would lose hit points, then exhaust this Power'
      : `prevent the next ${effect.uses} times you would lose hit points, then exhaust this Power`
    case 'upgradeStarterCards': return `starter Strikes deal +${effect.amount} damage and starter Defends gain +${effect.amount} Block`
    case 'empowerStarterStrikes': return `put ${amountText(effect.amount)} cubes on this Power; starter Strikes deal +1 damage per cube`
    case 'countdownDamage': return `place a cube; at ${effect.cubes} cubes deal ${effect.damage} damage to every enemy, then exhaust this Power`
    case 'countdownExhaust': return `place a cube; at ${effect.cubes} cubes exhaust this Power`
    case 'switchRows': return 'may switch rows with another player'
    case 'gainEnergy': return `gain ${amountText(effect.amount)} Energy${condition}`
    case 'gainEnergyPerDiscard': return `gain 1 Energy per card discarded${effect.bonus ? ` plus ${effect.bonus}` : ''}${condition}`
    case 'gainShiv': return `gain ${effect.amount} Shivs${condition}`
    case 'gainShivPerDiscard': return `gain 1 Shiv per card discarded${effect.bonus ? ` plus ${effect.bonus}` : ''}${condition}`
    case 'useAllShivs': return `use all Shivs now; each deals +${effect.bonus} damage as a separate attack${condition}`
    case 'gainMiracle': return `gain ${amountText(effect.amount)} ${effect.amount === 1 ? 'Miracle' : 'Miracles'}${condition}`
    case 'enterStance': return `enter ${effect.stance}${condition}`
    case 'channel': return `channel ${amountText(effect.amount)} ${effect.orb} ${effect.amount === 1 ? 'orb' : 'orbs'}${condition}`
    case 'evoke': return `evoke one Orb ${typeof effect.times !== 'number' && effect.times.per === 'energySpent'
      ? `X${effect.times.base ? `+${effect.times.base}` : ''}`
      : amountText(effect.times)} times${condition}`
    case 'channelDieOrb': return `channel Lightning on die 1 or 2, Frost on 3 or 4, Dark on 5 or 6${condition}`
    case 'recurseOrb': return `evoke an Orb, then channel that Orb${condition}`
    case 'fission': return effect.evoke
      ? `evoke every Orb; gain 1 Energy and draw 1 card for each${condition}`
      : `remove every Orb; gain 1 Energy and draw 1 card for each${condition}`
    case 'scry': return `scry ${effect.amount}${condition}`
    case 'topdeck': return `put ${effect.amount} card from your hand on top of your draw pile${condition}`
    case 'recoverDiscard': {
      const cards = effect.amount === 1 ? 'a card' : `${effect.amount} cards`
      const destination = effect.toHand ? 'into your hand' : 'on top of your draw pile'
      return `put ${cards} from your discard pile ${destination}${effect.retain
        ? ` and Retain ${effect.amount === 1 ? 'it' : 'them'}`
        : ''}`
    }
    case 'recoverExhaust': return 'put a card from your Exhaust pile into your hand'
    case 'recoverExhaustToDraw': return `put up to ${effect.amount} card${effect.amount === 1 ? '' : 's'} from your Exhaust pile on top of your draw pile${condition}`
    case 'recoverExhaustToDiscard': return `put ${effect.amount} card${effect.amount === 1 ? '' : 's'} from your Exhaust pile on top of your discard pile${condition}`
    case 'scryToHand': return `scry ${effect.amount}, then you may put one revealed ${effect.cardType} into your hand${condition}`
    case 'searchDraw': return `search your draw pile for ${effect.amount} card${effect.amount === 1 ? '' : 's'}, put ${effect.amount === 1 ? 'it' : 'them'} in your hand, then shuffle`
    case 'searchDrawAndPlayTwice': return 'search your draw pile for an Attack or Skill, play it twice for 0 Energy, then exhaust it'
    case 'drawAndPlayFree': return effect.exhaustNonPower
      ? `draw 1 card, then immediately play it for 0 Energy; exhaust it unless it is a Power${condition}`
      : `draw 1 card, then immediately play it for 0 Energy; if it cannot be played, discard it${condition}`
    case 'addDaze': return `put ${effect.amount} Daze on your ${effect.pile} pile${condition}`
    case 'recoverDiscardTopCosts': return `return a ${effect.cost}-cost discard top to hand${condition}`
    case 'recoverAllDiscardCosts': return `return all ${effect.cost}-cost cards from your discard pile to hand${condition}`
    case 'heal': return `heal ${effect.amount}${condition}`
    case 'clearDebuffs': return `remove all Weak and Vulnerable${condition}`
    case 'clearTargetBlock': return `remove all Block from the target${condition}`
    case 'removeAllOrbs': return `remove all of your Orbs${condition}`
    case 'gainOrbSlots': return `gain ${effect.amount} Orb slots${condition}`
    case 'gainOrbEvokeBonus': return `Orb Evoke effects get +${effect.amount}${condition}`
    case 'gainDarkOrbEvokeBonus': return `Dark Orb Evoke effects get +${effect.amount}${condition}`
    case 'gainOrbEndTurnBonus': return `Orb end-of-turn effects get +${effect.amount}${condition}`
    case 'gainLightningEndTurnBonus': return `Lightning Orb end-of-turn effects get +${effect.amount}${condition}`
    case 'lightningTargetsRow': return `Lightning damages every enemy in a chosen row, plus the boss${condition}`
    case 'triggerOrbEndTurn': return `trigger 1 Orb's end-of-turn ability ${effect.amount === 1 ? 'once' : `${effect.amount} times`}${condition}`
    case 'gainWrathAttackDamageBonus': return `Attacks deal +${effect.amount} damage while in Wrath${condition}`
    case 'gainShivDamageBonus': return `Shivs deal +${effect.amount} damage${condition}`
    case 'gainCardBlockBonus': return `each Block on your Attacks and Skills gets +${effect.amount}${condition}`
    case 'gainHitPoison': return `each hit also applies ${effect.amount} Poison${condition}`
    case 'gainClawCube': return `gain ${effect.amount} Claw cube${condition}`
    case 'doubleEnergy': return `double your Energy, up to ${effect.max}${condition}`
    case 'gainEnergyIfTargetDead': return `gain ${effect.amount} energy if the target dies${condition}`
    case 'gainStrengthIfTargetDead': return `gain ${effect.amount} Strength if the target dies${condition}`
    case 'execute': return `set the target's hit points to 0 if it has ${effect.hpAtMost} or fewer${condition}`
    case 'gainBlockFromLastHit': return `gain Block equal to the preceding hit's unblocked damage${condition}`
    case 'discard': return `discard ${effect.amount} cards${condition}`
    case 'discardAny': return `discard any number of cards${condition}`
    case 'exhaustFromHand': return `exhaust ${effect.amount} card${effect.amount === 1 ? '' : 's'} from hand${condition}`
    case 'gainEnergyFromExhaust': return `gain Energy equal to its cost; X doubles Energy${condition}`
    case 'exhaustAny': return `exhaust ${effect.minimum ? `${effect.minimum}-${effect.amount}` : `up to ${effect.amount}`} cards from hand${condition}`
    case 'exhaustHand': return `exhaust all${effect.except ? ` non-${effect.except.charAt(0).toUpperCase()}${effect.except.slice(1)}` : ''} cards in hand${condition}`
    case 'exhaustDrawPile': return `exhaust your draw pile${condition}`
    case 'gainBlockPerExhaust': return `gain ${effect.amount} Block per card exhausted${condition}`
    case 'hitPerExhaust': return `deal ${effect.amount} as a separate hit per card exhausted${condition}`
    case 'exhaustDrawTop': return `exhaust the top ${effect.amount} cards of your draw pile${condition}`
    case 'preventDebuffs': return 'cannot gain Weak or Vulnerable'
    case 'preventBlock': return 'cannot gain Block'
    case 'optionalPreventRoundHpLoss': return 'at end of turn, may exhaust this Power to prevent all hit point loss this round'
    case 'load': return `Load ${effect.upTo ? 'up to ' : ''}${effect.amount} card${effect.amount === 1 ? '' : 's'}${condition}`
    case 'loadSelf': return `${effect.optional ? 'may ' : ''}Load this card${condition}`
    case 'playChamber': return `play ${effect.amount === 'all' ? 'every card' : `${effect.amount} card`} in your Chamber${effect.free ? ' for 0 Energy' : ''}${condition}`
    case 'gainChamberSlot': return `gain ${effect.amount} Chamber slot${effect.amount === 1 ? '' : 's'}${condition}`
    case 'discardChamber': return `${effect.optional ? 'may ' : ''}discard ${effect.amount} ${effect.curseOnly ? 'Curse ' : ''}from your Chamber${effect.then?.length ? `, then ${effect.then.map(effectText).join(', ')}` : ''}${condition}`
    case 'discountChamber': return `choose ${effect.amount} Chamber card to cost 0 this turn${condition}`
    case 'deadOnEffects': return `Dead On: ${effect.effects.map(effectText).join(', then ')}`
    case 'deadOnPrintedBlock': return `gain ${effect.amount} Block from printed damage`
    case 'drawLastHitDamage': return 'draw cards equal to the damage dealt'
    case 'grantNextAttackRapidFire': return 'the next Attack you play gains Rapid Fire'
    case 'discardHand': return 'discard your hand'
    case 'triggerDieRelic': return `trigger ${effect.amount} die relic${effect.amount === 1 ? '' : 's'}`
    case 'goldenBullet': return `deal ${effect.amount} damage; Dead On quadruples Vulnerable damage`
    case 'roulette': return 'resolve the row matching the shared die'
    case 'attachBounty': return `apply ${effect.vulnerable} Vulnerable and attach this card as a bounty`
  }
}

function triggerText(trigger: Trigger): string {
  switch (trigger.kind) {
    case 'startOfCombat': return 'at the start of combat'
    case 'beforeDraw': return 'at the start of your turn, before you draw'
    case 'startOfTurn': return 'at the start of your turn'
    case 'endOfTurn': return 'at the end of your turn'
    case 'endOfCombat': return 'at the end of combat'
    case 'dieRelic': return `when the die shows ${trigger.faces.join(' or ')}`
    case 'onPlayCard': return trigger.cardType
      ? `after you play a ${trigger.cardType} card`
      : 'after you play a card'
    case 'onDiscard': return 'whenever a card effect makes you discard one or more cards'
    case 'onExhaust': return 'whenever you exhaust a card'
    case 'onDraw': return trigger.cardType || trigger.cardTypes
      ? `whenever you draw a ${trigger.cardType ?? trigger.cardTypes!.join(' or ')} card`
      : 'whenever you draw a card'
    case 'onEnterStance': return trigger.stance
      ? `whenever you enter ${trigger.stance}`
      : 'whenever you switch Stances'
    case 'onAdvance': return 'whenever you Advance'
    case 'onRetract': return 'whenever you Retract'
    case 'onUseSoulburn': return 'whenever you use Soulburn'
    case 'onHermitDeadOn': return 'after you activate Dead On'
    case 'onScry': return 'whenever you scry'
    case 'onGainBlock': return 'whenever you gain Block'
    case 'onApplyPoison': return 'when you put Poison on an enemy'
    case 'onPutEnemyToken': return 'whenever you put a token on an enemy'
    case 'onShuffle': return 'whenever you shuffle your draw pile'
  }
}

function handEndOfTurnText(effect: HandEndOfTurnEffect): string {
  const when = 'handSizeAtMost' in effect && effect.handSizeAtMost !== undefined
    ? ` if you have ${effect.handSizeAtMost} or fewer cards in hand`
    : ''
  switch (effect.kind) {
    case 'damage': return `at end of turn, take ${effect.amount} damage${when}`
    case 'loseHp': return `at end of turn, lose ${effect.amount} hit points${when}`
    case 'gainWeak': return `at end of turn, gain ${effect.amount} Weak${when}`
    case 'loseBlock': return `at end of turn, lose ${effect.amount} Block${when}`
  }
}

const CARD_KEYWORD_TIPS = [
  ['Ethereal', /\bethereal\b/i, 'If this card is in your hand at end of turn, Exhaust it.'],
  ['Exhaust', /__exhaust__/, 'An Exhausted card is removed for this combat and returns to its deck afterward.'],
  ['Retain', /\bretain(?:ed)?\b/i, 'A retained card stays in its owner’s hand at end of turn.'],
  ['Scry', /\bscry\b/i, 'Look at the top cards of your draw pile. Discard any, then return the rest on top in the same order.'],
  ['All in a row', /\baffects a whole row\b|__row__/i, 'Affects all enemies in one row and always also the boss.', 'aoe'],
  ['All Enemies', /\baffects every enemy\b|__all_enemies__/i, 'Affects every row and the boss.'],
  ['Area effect', /\[aoe\]/i, 'Applies the marked effect to its whole group: damage or debuffs affect one enemy row and the boss; Block affects every player.', 'aoe'],
  ['Unplayable', /\bunplayable\b/i, 'This card cannot be played.'],
  ['Hit', /__hit__/i, 'Damage modified by Strength, Weak, and Vulnerable.', 'attack'],
  ['Slime Hit', /__slime_hit__/, 'Only this Slime’s Strength modifies these hits; enemy Vulnerable and Slime Boss Attack modifiers do not.', 'attack'],
  ['Status', /\bstatus\b/i, 'A temporary card that leaves your deck after combat.'],
  ['Vulnerable', /\bvulnerable\b|\[debuff\]/i, 'Each hit against this target is doubled, then removes 1 Vulnerable.', 'vulnerable'],
  ['Weak', /\bweak\b|__weak__/i, 'Each hit this character deals gets −1 damage, then removes 1 Weak.', 'weak'],
  ['Strength', /\bstrength\b|__strength__/i, 'Adds 1 damage to every hit for each Strength. Maximum 8.', 'strength'],
  ['Poison', /\bpoison(?:ed)?\b|__poison__/i, 'At end of turn, the enemy loses 1 HP per Poison. Block does not stop it.', 'poison'],
  ['Block', /\bblock(?:ed|ing)?\b|__block__/i, 'Prevents 1 damage per Block. Player Block is capped at 20.', 'block'],
  ['Daze', /\bdaze\b/i, 'A Daze is Ethereal and Unplayable.', 'daze'],
  ['Burn', /\bburn\b/i, 'If Burn remains in your hand at end of turn, take its damage.', 'burn'],
  ['Shiv', /\bshivs?\b/i, 'Spend a Shiv to deal 1 damage as a separate hit. Shivs are not cards.', 'shiv'],
  ['Miracle', /\bmiracles?\b/i, 'Spend a Miracle at any time to gain 1 Energy.', 'miracle'],
  ['Neutral', /\bneutral\b/i, 'The Watcher’s default Stance. Entering Neutral ends Calm or Wrath; leaving it grants no extra effect.'],
  ['Calm', /\bcalm\b/i, 'Leaving Calm grants 2 Energy.'],
  ['Wrath', /\bwrath\b/i, 'Hits deal +1 damage; ending your turn in Wrath deals 1 damage to you.'],
  ['Lightning', /\blightning\b/i, 'Deals 1 damage at end of turn and 2 damage when Evoked.'],
  ['Frost', /\bfrost\b/i, 'Grants 1 Block at end of turn and 1 Block when Evoked.'],
  ['Dark', /\bdark\b/i, 'When Evoked, deals 3 damage plus 1 per Power you have in play.'],
  ['Orb', /\borbs?\b|__orb__/i, 'Channel into an open slot; if every slot is full, Evoke an Orb first.', undefined, 'orb'],
  ['Power', /\bpowers?\b/i, 'A played Power stays face-up until Exhausted or combat ends.', undefined, 'power'],
  ['Energy', /\benergy\b/i, 'Spend Energy to play cards. Unspent Energy is normally lost at end of turn.', 'energy'],
  ['Grow', /\bgrow\b/i, 'Choose a Slime and increase its level by 1, up to its maximum.'],
  ['Command', /\bcommand\b/i, 'Choose a Slime and activate the ability at its current level.'],
  ['Slime', /\bslimes?\b|__slime__/i, 'A played Slime stays in your Powers area for combat. Its level determines its Command ability.'],
  ['Heat', /\bheat\b/i, 'Hexaghost starts at 1 Heat and can have 1–6. Some cards gain bonuses at a Heat threshold.'],
  ['Advance', /\badvance\b/i, 'Gain 1 Heat. At Heat 6, this still counts as an Advance.'],
  ['Retract', /\bretract\b/i, 'Lose 1 Heat. At Heat 1, this still counts as a Retract.'],
  ['Soulburn', /\bsoulburns?\b/i, 'Spend whenever you could play a card to deal damage equal to your Heat. Soulburns are not cards. Maximum 6.'],
  ['Guardian Modes', /\b(?:Attack|Defense) Mode\b/i, 'Card effects may change by Mode; being in a Mode has no passive effect by itself.'],
  ['Mode Shift', /\bmode shift\b|\[mode-shift\]/i, 'Switch between Attack Mode and Defense Mode.'],
  ['Vigor', /\bvigor\b|\[vigor\]/i, 'Spend whenever you could play a card. Each spent Vigor adds +1 per hit in Attack Mode or +1 per Block icon in Defense Mode on your Attacks and Skills this turn. Maximum 4.'],
  ['Gem', /\bgems?\b|__guardian_gem__/i, 'A transparent Gem permanently augments the Guardian card it is attached to.'],
  ['Socket', /\bsocket\b/i, 'When you add this card to your deck, reveal and attach a Guardian Gem to it.'],
  ['Chamber', /\bchamber\b/i, 'Stores cards outside your hand. They stay between turns and can be played normally.'],
  ['Load', /\bload(?:ed|ing)?\b/i, 'Store a card in the Chamber. If that slot is occupied, discard its current card first.'],
  ['Dead On', /\bdead on\b/i, 'Gain the listed bonus when this card is played from the Chamber.'],
  ['Rapid Fire', /\brapid fire\b/i, 'Play the card one additional time per Rapid Fire. Each copy may choose a different target and cannot trigger Rapid Fire again.'],
] as const

export function slimeCommandText(def: CardDef, level: number): string {
  const effects = def.slimeLevels?.[level]
  if (!effects) return ''
  const allEnemies = def.slimeTarget === 'allEnemies' ||
    def.id === 'slime_boss_evolution_slime' && level >= 3
  return `level ${level} Command${allEnemies ? ' against every enemy' : ''}: ` +
    effects.map(effectText).join(', then ')
}

export function cardRulesText(def: CardDef): string {
  const printed = def.printedText ?? def.guardian?.sourceText
  const slimeRules = Object.keys(def.slimeLevels ?? {})
    .map(Number).sort((left, right) => left - right)
    .map((level) => slimeCommandText(def, level)).join('; ')
  if (printed) {
    return [printed, slimeRules].filter(Boolean).join(', ')
  }
  const rules = [
    // A row always takes the boss too, wherever the boss stands (p.15). Saying
    // only "a whole row" tells a player picking a distant row that the boss is
    // safe from it, which is the opposite of the rule.
    def.target === 'row' ? 'affects a whole row and any boss' : '',
    def.target === 'allEnemies' ? 'affects every enemy' : '',
    def.supportTarget === 'anyPlayer' ? 'support effect may target any player' : '',
    def.supportTarget === 'allPlayers' ? 'support effect applies to all players' : '',
    def.powerCostReduction
      ? `costs ${def.powerCostReduction} less for each Power you have in play`
      : '',
    def.costAfterHpLoss !== undefined
      ? `costs ${def.costAfterHpLoss} after you lose hit points this combat`
      : '',
    def.minimumX ? `must spend at least ${def.minimumX} Energy` : '',
    def.corruptSkills ? 'your Skills cost 0 and Exhaust when played' : '',
    def.retainBlock ? 'at start of turn, keep your leftover Block from last turn, maximum Block 20' : '',
    def.playCondition ? `can only be played if ${conditionText(def.playCondition)}` : '',
    def.trigger ? triggerText(def.trigger) : '',
    def.activeAbility ? 'activate once per turn during your turn' : '',
    def.oncePerTurn && !def.activeAbility ? 'once per turn' : '',
    slimeRules,
    ...(def.modes
      ? def.modes.map((mode) => `choose ${mode.effects.map(effectText).join(' and ')}`)
      : def.effects.map(effectText)),
    ...(def.additionalTriggers ?? []).map(({ trigger, effects }) =>
      `${triggerText(trigger)}, ${effects.map(effectText).join(', then ')}`),
    ...(def.persistentEffects ?? []).map(effectText),
    ...(def.handEndOfTurn ?? []).map(handEndOfTurnText),
    ...(def.discardReaction?.effects ?? []).map((effect) =>
      `when discarded by a card effect, ${effectText(effect)}`),
    def.discardReaction?.exhaust ? 'exhausts after its discard effect' : '',
    ...(def.exhaustReaction?.effects ?? []).map((effect) =>
      `when this card is exhausted, ${effectText(effect)}`),
    def.scryPlayBonus !== undefined
      ? `when discarded by Scry, play this card instead with +${def.scryPlayBonus} damage`
      : '',
    def.toDrawTop ? 'returns to the top of your draw pile when played' : '',
    def.retain ? 'retain' : '',
    def.exhaust ? 'exhausts when played' : '',
    def.ethereal ? 'ethereal, exhausts at end of turn if still in hand' : '',
  ]
    .filter(Boolean)
    .join(', ')
  return rules
}

export function cardPlayText(def: CardDef, cost = def.cost): string {
  return [def.unplayable ? 'unplayable' : `cost ${costLabel(def, cost)}`, cardRulesText(def)]
    .filter(Boolean).join(', ')
}

export function cardRuleDescription(def: CardDef): string {
  const tokens: Readonly<Record<string, string>> = {
    damage: 'damage', block: 'Block', copy: 'copy', vigor: 'Vigor', energy: 'Energy', strength: 'Strength',
    'mode-shift': 'Mode Shift', debuff: 'Vulnerable', weak: 'Weak', aoe: 'area effect', hp: 'HP', remove: 'remove',
    vulnerable: 'Vulnerable',
  }
  return cardRulesText(def).replace(/\[([a-z-]+)\]/gi, (token, name: string) => tokens[name.toLowerCase()] ?? token)
}

export function cardAccessibleName(def: CardDef, cost = def.cost): string {
  const [playability] = cardPlayText(def, cost).split(', ')
  return [def.name, playability, cardTypeLabel(def), cardRuleDescription(def)].filter(Boolean).join(', ')
}

function flattenEffects(effects: readonly Effect[]): Effect[] {
  return effects.flatMap((effect) => {
    const nested = effect.kind === 'sequence' || effect.kind === 'deadOnEffects' ? effect.effects
      : effect.kind === 'branch' ? [...effect.effects, ...effect.otherwise]
      : effect.kind === 'discardChamber' ? effect.then ?? []
      : effect.kind === 'roulette' ? Object.values(effect.byRoll).flat()
      : []
    return [effect, ...flattenEffects(nested)]
  })
}

export function cardKeywordTips(def: CardDef): readonly {
  name: string; text: string; icon?: IconName; statusIcon?: StatusIconName
}[] {
  const effects = flattenEffects([
    ...def.effects,
    ...(def.modes ?? []).flatMap((mode) => mode.effects),
    ...(def.persistentEffects ?? []),
    ...(def.discardReaction?.effects ?? []),
    ...(def.exhaustReaction?.effects ?? []),
    ...(def.additionalTriggers ?? []).flatMap((entry) => entry.effects),
  ])
  const slimeEffects = flattenEffects(Object.values(def.slimeLevels ?? {}).flat())
  const hasHit = (entries: readonly Effect[]) => entries.some((effect) =>
    effect.kind === 'hit' || effect.kind === 'hitChoices' ||
    effect.kind === 'rowHit' || effect.kind === 'hitPerExhaust' || effect.kind === 'gainHitPoison' ||
    effect.kind === 'goldenBullet')
  const hit = hasHit(effects)
  const slimeHit = hasHit(slimeEffects)
  const allEffects = [...effects, ...slimeEffects]
  const orb = allEffects.some((effect) => /Orb/.test(effect.kind) ||
    effect.kind === 'channel' || effect.kind === 'evoke' || effect.kind === 'fission')
  const vulnerable = allEffects.some((effect) => effect.kind === 'applyVulnerable' ||
    effect.kind === 'vulnerableChoices')
  const weak = allEffects.some((effect) => effect.kind === 'applyWeak' || effect.kind === 'weakChoices')
  const block = allEffects.some((effect) => effect.kind === 'block' || effect.kind === 'blockChoices')
  const poison = allEffects.some((effect) => effect.kind === 'poison' || effect.kind === 'poisonChoices' ||
    effect.kind === 'multiplyPoison' || effect.kind === 'gainHitPoison')
  const strength = allEffects.some((effect) => effect.kind === 'gainStrength' ||
    effect.kind === 'gainTemporaryStrength' || effect.kind === 'doubleStrength' ||
    (effect as { kind: string }).kind === 'gainSlimeVigor')
  const cardRules = cardRulesText(def)
  const keywordRules = cardRules.replace(
    /All \[damage\], \[block\], \[debuff\] on this card have (\[aoe\])\.?/gi,
    '$1',
  )
  const exhaust = /\bexhaust/i.test(cardRules.replace('ethereal, exhausts at end of turn if still in hand', ''))
  const guardianGem = def.guardian?.printedType.includes('Gem')
  const cardType = def.cardKind === 'slime' ? '__slime__' : def.type
  const hitType = `${hit || (def.owner === 'guardian' && /\[damage\]/i.test(keywordRules)) ? '__hit__' : ''} ` +
    `${slimeHit ? '__slime_hit__' : ''}`
  const target = def.slimeTarget ?? def.target
  const reachesRow = allEffects.some((effect) => effect.kind === 'rowHit' ||
    (effect.kind === 'useAllSoulburn' && effect.target === 'row')) || /\b(?:a|any) row\b/i.test(keywordRules)
  const reachesAllEnemies = target === 'allEnemies' || def.id === 'slime_boss_evolution_slime'
  const reach = target === 'row' || reachesRow ? '__row__' : reachesAllEnemies ? '__all_enemies__' : ''
  const rules = `${cardType} ${def.unplayable ? 'unplayable' : ''} ${def.id === 'daze' || def.id === 'burn' ? def.id : ''} ${hitType} ${reach} ${vulnerable ? 'vulnerable' : ''} ${weak ? '__weak__' : ''} ${block ? '__block__' : ''} ${poison ? '__poison__' : ''} ${strength ? '__strength__' : ''} ${orb ? '__orb__' : ''} ${exhaust ? '__exhaust__' : ''} ${guardianGem ? '__guardian_gem__' : ''} ${keywordRules}`
  return CARD_KEYWORD_TIPS
    .filter(([, pattern]) => pattern.test(rules))
    .map(([name, , text, icon, statusIcon]) => ({ name, text, icon, statusIcon }))
}

export function CardKeywordHelp({ def, additionalDef, gemPowerDamage, extraTips = [], children }: {
  def: CardDef
  additionalDef?: CardDef | null
  gemPowerDamage?: boolean
  extraTips?: readonly { name: string, text: string, icon?: IconName, statusIcon?: StatusIconName }[]
  children: (props: {
    ref?: (element: HTMLElement | null) => void
    'aria-describedby'?: string
    'data-keyword-help-id'?: string
  }) => React.ReactNode
}) {
  const attachedTips = additionalDef ? cardKeywordTips(additionalDef) : []
  const attachedGemPowerDamage = (gemPowerDamage ?? def.guardian?.printedType === 'Gem Power') &&
    attachedTips.some((tip) => tip.name === 'Hit')
  const additionalTips = additionalDef ? [
    { name: additionalDef.name, text: cardRuleDescription(additionalDef) },
    ...attachedTips.filter((tip) => tip.name !== 'Unplayable' && !(tip.name === 'Hit' && attachedGemPowerDamage)),
    ...(attachedGemPowerDamage ? [{
      name: 'Gem Power damage',
      text: 'Damage printed by a Gem on a Gem Power ignores Strength, Weak, Vulnerable, and Vigor.',
      icon: 'attack' as IconName,
    }] : []),
  ] : []
  const tips = [...cardKeywordTips(def), ...additionalTips, ...extraTips]
    .filter((tip, index, all) => all.findIndex((candidate) => candidate.name === tip.name) === index)
  const tooltipId = `card-keyword-help-${useId()}`
  const anchorRef = useRef<HTMLElement | null>(null)
  const [mounted, setMounted] = useState(false)
  const setAnchor = useCallback((element: HTMLElement | null) => {
    const previous = anchorRef.current as (HTMLElement & { mountKeywordHelp?: () => void }) | null
    if (previous) delete previous.mountKeywordHelp
    anchorRef.current = element
    if (element) (element as HTMLElement & { mountKeywordHelp?: () => void }).mountKeywordHelp = () => setMounted(true)
  }, [])
  useEffect(() => {
    if (mounted && tips.length > 0) anchorRef.current?.dispatchEvent(new Event('card-keyword-help-ready', { bubbles: true }))
  }, [additionalDef?.id, def.id, mounted, tips.length])
  const host = mounted && anchorRef.current ? anchorRef.current.closest('dialog') ?? document.body : null
  const props = tips.length > 0 ? {
    ref: setAnchor,
    'aria-describedby': `${tooltipId}-description`,
    'data-keyword-help-id': tooltipId,
  } : mounted ? { ref: setAnchor } : {}
  return <>
    {children(props)}
    {tips.length > 0 ? <span className="visually-hidden" id={`${tooltipId}-description`}>
      {tips.map((tip) => `${tip.name}: ${tip.text}`).join(' ')}
    </span> : null}
    {host && tips.length > 0 ? createPortal(
      <span className="card-keyword-tips" id={tooltipId} role="tooltip">
        {tips.map((tip) => (
          <span className="card-keyword-tip" key={tip.name}>
            <strong>{tip.icon ? <Icon name={tip.icon} size={18} />
              : tip.statusIcon ? <StatusIcon name={tip.statusIcon} size={18} /> : null}{tip.name}</strong>
            <span>{tip.text}</span>
          </span>
        ))}
      </span>,
      host,
    ) : null}
  </>
}

/** The energy cost badge, or nothing at all for an unplayable card (p.24). */
function costLabel(def: CardDef, cost = def.cost): string {
  if (def.unplayable) return '—'
  return cost === 'X' ? 'X' : String(cost)
}

export function Card({
  card,
  className: extraClassName,
  style,
  cost,
  playable = true,
  selected = false,
  picked = false,
  gemPowerDamage,
  fan = 0,
  tabIndex,
  onClick,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onLostPointerCapture,
}: CardProps) {
  const def = faceOf(cardDef(card.defId), card.upgraded)
  const attachedGem = card.attachedGemId ? faceOf(cardDef(card.attachedGemId), false) : null
  const scan = cardThumbPath(def, card.upgraded)
  const hasPublisherScan = def.publisherScan !== false
  const [scanUnavailable, setScanUnavailable] = useState(!hasPublisherScan)
  useEffect(() => setScanUnavailable(!hasPublisherScan), [hasPublisherScan, scan])
  const className = [
    'card',
    extraClassName ?? '',
    playable ? '' : 'card--unplayable',
    selected ? 'card--selected' : '',
    picked ? 'card--picked' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return <CardKeywordHelp def={def} additionalDef={attachedGem}
    gemPowerDamage={gemPowerDamage}>{(keywordHelpProps) => (
    <button
      {...keywordHelpProps}
      type="button"
      className={className}
      data-sfx="card"
      tabIndex={tabIndex}
      style={{
        ...style,
        // Tilt with distance from the middle, and drop the outer cards a
        // little so the row reads as an arc rather than a shelf.
        // The spread grows with the hand: a fixed angle made five cards look
        // merely crooked and only became a fan at eight or more.
        '--fan-angle': `${fan * 11}deg`,
        '--fan-lift': `${Math.abs(fan) * 14}px`,
      } as React.CSSProperties}
      aria-disabled={!playable}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onLostPointerCapture}
      onClick={(event) => {
        if (!playable) {
          event.preventDefault()
          return
        }
        onClick?.(card)
      }}
      aria-label={`${cardAccessibleName(def, cost)}${attachedGem
        ? `, socketed with ${attachedGem.name}: ${cardRuleDescription(attachedGem)}` : ''}`}
      aria-pressed={selected || picked}
      title={def.name}
    >
      {hasPublisherScan ? <img
        className="card__art"
        src={scan}
        alt=""
        draggable={false}
        loading="lazy"
        decoding="async"
        onLoad={(event) => {
          const image = event.currentTarget
          revealDecodedImage(image, {
            isCurrent: () => image.isConnected && image.getAttribute('src') === scan,
            onDecodeError: () => setScanUnavailable(true),
          })
        }}
        onError={(event) => {
          if (event.currentTarget.getAttribute('src') !== scan) return
          // Some source-set cards have no scan. Fall back to the card frame
          // rather than showing a broken image.
          event.currentTarget.style.visibility = 'hidden'
          setScanUnavailable(true)
        }}
      /> : null}
      <CardFace def={def} cost={cost} rules={cardRulesText(def)} illustration={scanUnavailable} />
      {attachedGem ? <img className="card__gem" src={cardThumbPath(attachedGem, false)} alt=""
        draggable={false} title={`${attachedGem.name}: ${cardRuleDescription(attachedGem)}`} /> : null}
      {def.target === 'row' ? (
        // The burst printed on Cleave and its like. Marked hidden because
        // `accessibleName` already says "affects a whole row" — announced here as
        // well, every such card would read its reach out twice.
        <span className="card__aoe" aria-hidden="true">
          <Icon name="aoe" size={18} />
        </span>
      ) : null}
    </button>
  )}</CardKeywordHelp>
}
