import type React from 'react'
import { cardDef, faceOf } from '../game/cards.ts'
import type { CardDef } from '../game/cards.ts'
import type { Amount, Condition, CountOf, Effect } from '../game/cards.ts'
import type { HandEndOfTurnEffect } from '../game/cards.ts'
import { cardImagePath } from '../game/assets.ts'
import { CardFace } from './CardFace.tsx'
import { Icon } from './Icon.tsx'
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
  /** Position in the fan, -1 (leftmost) to 1 (rightmost), 0 in the middle. */
  fan?: number
  onClick?: (card: CardInstance) => void
}

/** Show an optional publisher scan only after Chromium can decode its pixels. */
export function revealDecodedImage(image: HTMLImageElement) {
  void image.decode().then(
    () => { image.style.visibility = 'visible' },
    () => { image.style.visibility = 'hidden' },
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
  attacksPlayedThisTurn: 'other Attack played this turn',
  attackingEnemies: 'enemy intending to attack you',
  clawCubesGainedThisCombat: 'Claw cube gained this combat',
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
    parts.push(`1 per ${amount.targetTokens.map((token) => token === 'weak' ? 'Weak' : 'Poison').join(' and ')} on the target`)
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
    parts.push(`once per ${times.targetTokens.map((token) => token === 'weak' ? 'Weak' : 'Poison').join(' and ')} on the target`)
  }
  return parts.join(' plus ') || '0 times'
}

function effectText(effect: Effect): string {
  const condition = effect.when ? ` if ${conditionText(effect.when)}` : ''
  switch (effect.kind) {
    case 'hit': return typeof effect.amount !== 'number' && effect.amount.per === 'miracles' &&
      effect.amount.base === 0 && !effect.amount.bonus && !effect.amount.targetTokens
      ? `deal ${effect.amount.scale ?? 1} damage per ${COUNT_LABEL.miracles}${condition}`
      : `deal ${amountText(effect.amount, true)} damage${effect.times ? ` ${timesText(effect.times)}` : ''}${condition}`
    case 'hitChoices': return effect.targets === 1
      ? `deal ${amountText(effect.amount, true)} damage to one enemy${condition}`
      : effect.distinct
        ? `deal ${amountText(effect.amount, true)} damage to ${effect.targets} distinct enemies${condition}`
        : `deal ${effect.targets} separately targeted hits for ${amountText(effect.amount, true)} damage each${condition}`
    case 'damage': return `deal ${amountText(effect.amount)} damage${condition}`
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
    case 'gainStrength': return `gain ${effect.amount} Strength${condition}`
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
    case 'draw': return `draw ${amountText(effect.amount)} ${effect.amount === 1 ? 'card' : 'cards'}${condition}`
    case 'drawThenDiscard': return `draw ${effect.amount} card then discard 1 card`
    case 'drawToHandSize': return `draw until you have ${effect.size} cards in hand${condition}`
    case 'cycleHand': return 'discard your hand, then draw that many cards'
    case 'discardNonRetain': return 'discard every card without Retain'
    case 'preventDraw': return 'cannot draw more cards this turn'
    case 'preventCardPlay': return 'cannot play additional cards this turn'
    case 'discountNextCard': return 'your next card this turn costs 0'
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
    case 'gainEnergy': return `gain ${effect.amount} Energy${condition}`
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

export function cardRulesText(def: CardDef): string {
  return [
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
    ...(def.modes
      ? def.modes.map((mode) => `choose ${mode.effects.map(effectText).join(' and ')}`)
      : def.effects.map(effectText)),
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
}

export function cardPlayText(def: CardDef, cost = def.cost): string {
  return [def.unplayable ? 'unplayable' : `cost ${costLabel(def, cost)}`, cardRulesText(def)]
    .filter(Boolean).join(', ')
}

export function cardAccessibleName(def: CardDef, cost = def.cost): string {
  const [playability, ...rules] = cardPlayText(def, cost).split(', ')
  return [def.name, playability, def.type, ...rules].filter(Boolean).join(', ')
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
  fan = 0,
  onClick,
}: CardProps) {
  const def = faceOf(cardDef(card.defId), card.upgraded)
  const className = [
    'card',
    extraClassName ?? '',
    playable ? '' : 'card--unplayable',
    selected ? 'card--selected' : '',
    picked ? 'card--picked' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <button
      type="button"
      className={className}
      data-sfx={def.type === 'attack' ? 'attack' : def.type === 'power' ? 'magic' : 'card'}
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
      onClick={(event) => {
        if (!playable) {
          event.preventDefault()
          return
        }
        onClick?.(card)
      }}
      aria-label={cardAccessibleName(def, cost)}
      aria-pressed={selected || picked}
      title={def.name}
    >
      <img
        className="card__art"
        src={cardImagePath(def, card.upgraded)}
        alt=""
        loading="lazy"
        onLoad={(event) => revealDecodedImage(event.currentTarget)}
        onError={(event) => {
          // Not every card has a scan in the source set (Daze, for one). Fall
          // back to the card frame rather than showing a broken image.
          event.currentTarget.style.visibility = 'hidden'
        }}
      />
      <CardFace def={def} cost={cost} rules={cardRulesText(def)} />
      {def.target === 'row' ? (
        // The burst printed on Cleave and its like. Marked hidden because
        // `accessibleName` already says "affects a whole row" — announced here as
        // well, every such card would read its reach out twice.
        <span className="card__aoe" aria-hidden="true">
          <Icon name="aoe" size={18} />
        </span>
      ) : null}
    </button>
  )
}
