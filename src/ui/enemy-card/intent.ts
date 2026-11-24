import { cardDef, faceOf } from '../../game/cards.ts'
import { abilityText, enemyAbilities } from '../../game/enemies.ts'
import type { EnemyAction } from '../../game/enemies.ts'
import type { Enemy } from '../../game/types.ts'
import type { IconName } from '../Icon.tsx'
import type { bossHeavyAttackFor } from '../combat-vfx.ts'

export type IntentPart = {
  icon: IconName
  value?: number | string
  prefix?: string
  aoe?: boolean
  /**
   * How many times this attack lands, when it is more than once.
   *
   * The symbol is REPEATED on screen, matching the printed card. Spoken, that
   * became "attack, attack, attack" with nothing to say it is one attack of
   * three — so only the first part carries the count, and only it is spoken.
   */
  times?: number
  /** Silent to a screen reader: a later copy of a repeated symbol. */
  echo?: boolean
  label?: string
  visibleLabel?: string
}

/**
 * An enemy's telegraphed intent, in the game's own symbols.
 *
 * `swing` turns a PRINTED attack number into the damage it will actually deal.
 * Without it the intent showed the number off the enemy card and the blow landed
 * for something else entirely: a Weakened enemy printing 1 deals 0 (Weak is a
 * flat -1 and nothing clamps a hit up to 1), and the board still promised 1.
 * Reading "will this kill me" off the board is the whole point of an intent.
 */
export function intentParts(action: EnemyAction, swing: (printed: number) => number): IntentPart[] {
  switch (action.kind) {
    case 'attack': {
      // Repeated symbols, not a formula. Twin Strike prints two swords side by
      // side rather than "1x2", and the enemy cards do the same — the board
      // game's own notation, and more symbol than text besides.
      const times = action.times && action.times > 1 ? action.times : 1
      return Array.from({ length: times }, (_unused, index) => ({
        icon: 'attack' as const,
        value: swing(action.amount),
        aoe: action.aoe,
        times: index === 0 && times > 1 ? times : undefined,
        echo: index > 0,
      }))
    }
    case 'attackSequence':
      return action.hits.map((hit) => ({ icon: 'attack', value: swing(hit.amount), aoe: hit.aoe }))
    case 'block':
      return [{ icon: 'block', value: action.perPlayer ? `${action.amount}/player` : action.amount }]
    case 'gainStrength':
      return [{ icon: 'strength', value: action.amount, prefix: '+' }]
    case 'blockAllEnemies':
      return [{ icon: 'block', value: action.amount, label: 'Block to all enemies' }]
    case 'strengthenAllEnemies':
      return [{ icon: 'strength', value: action.amount, prefix: '+', label: 'Strength to all enemies' }]
    case 'healAllEnemies':
      return [{ icon: 'monster', value: action.amount, label: 'heal all enemies', visibleLabel: 'Heal' }]
    case 'healSelf':
      return [{ icon: 'monster', value: action.amount, label: 'heals itself', visibleLabel: 'Heal' }]
    case 'blockNamed':
      return [{ icon: 'block', value: action.amount, label: `Block to ${action.defId.replaceAll('_', ' ')}` }]
    case 'clearSelfDebuffs':
      return [{ icon: 'monster', label: 'removes Weak and Vulnerable', visibleLabel: 'Cleanse' }]
    case 'reviveAll':
      return [{ icon: 'monster', label: `revives all dead ${action.group}s`, visibleLabel: 'Revive' }]
    case 'applyWeak':
      return [{ icon: 'weak', value: action.amount, aoe: action.aoe }]
    case 'applyVulnerable':
      return [{ icon: 'vulnerable', value: action.amount, aoe: action.aoe }]
    case 'daze':
      return [{ icon: 'daze', value: action.amount, aoe: action.aoe }]
    case 'status':
      return [{
        icon: action.card === 'burn' ? 'burn' : 'monster',
        value: action.amount,
        aoe: action.aoe,
        label: action.card,
        visibleLabel: action.card === 'slimed' ? 'Slimed' : undefined,
      }]
    case 'loseGold':
      return [{ icon: 'gold', value: action.amount, prefix: '-', label: 'gold' }]
    case 'summon':
      return [{ icon: 'monster', value: action.defIds.length, label: 'summons', visibleLabel: 'Summon' }]
    case 'summonUntil':
      return [{ icon: 'monster', value: action.perPlayer, label: 'summons per player', visibleLabel: 'Summon per player' }]
    case 'shuffleCurse':
      return [{ icon: 'monster', value: action.amount, aoe: action.aoe, label: 'Curses shuffled into each deck', visibleLabel: 'Curse' }]
    case 'reviveMatching':
      return [{ icon: 'monster', label: 'revives defeated summons', visibleLabel: 'Revive' }]
    case 'doubleNamedHp':
      return [{ icon: 'monster', label: `doubles ${action.defId.replaceAll('_', ' ')} HP`, visibleLabel: 'Double HP' }]
    case 'healMatching':
      return [{ icon: 'monster', value: action.amount, label: 'heals matching summons', visibleLabel: 'Heal' }]
    case 'gainSelfVulnerable':
      return [{ icon: 'vulnerable', value: action.amount, label: 'Vulnerable to self' }]
    case 'leave':
      return [{ icon: 'monster', label: 'leaves combat', visibleLabel: 'Leaves' }]
    case 'die':
      return [{ icon: 'monster', label: 'dies', visibleLabel: 'Dies' }]
    case 'addAbilityCube':
      return [{ icon: 'monster', value: action.amount, label: 'ability cube', visibleLabel: 'Cube' }]
    case 'transform':
      return [{ icon: 'monster', label: `enters ${action.defId.replaceAll('_', ' ')}`, visibleLabel: 'Mode' }]
    case 'guardianModeShift':
      return [{ icon: 'attack', value: swing(action.amount), label: 'if Block remains; otherwise enters Defensive Mode' }]
    case 'removeInvincible':
      return [{ icon: 'monster', label: 'removes Invincible', visibleLabel: 'Invincible off' }]
    case 'shuffleStatus':
      return [{ icon: action.card === 'burn' ? 'burn' : 'monster', value: action.amount, label: `shuffle ${action.card} into every draw pile`, visibleLabel: action.card }]
    case 'actsLast':
      return [{ icon: 'monster', label: 'acts last', visibleLabel: 'Acts last' }]
    case 'idle':
      return []
  }
}

export function withTargets(heavy: ReturnType<typeof bossHeavyAttackFor>, targets: readonly string[]) {
  return heavy && { ...heavy, targets }
}

/**
 * The enemy button's accessible name.
 *
 * `aria-label` replaces the element's contents wholesale, so anything left out
 * is unreachable however it is marked up — the same trap `describeSeat` avoids
 * for players. The intent especially: it is the one thing choosing a target
 * depends on, and it was not being announced at all.
 */
export function describeEnemy(
  enemy: Enemy,
  label: string,
  intent: IntentPart[],
  abilities: string[],
  rowLabel?: string,
): string {
  // The label is built by the engine and is the SAME string the log prints --
  // "Cultist (row 1, #2)" when two of them share a row. Two identically named
  // buttons would leave a screen-reader user unable to match log to board, and
  // rebuilding the name here is what let the two drift apart before.
  const parts = [label]
  if (rowLabel) parts.push(`facing ${rowLabel}`)
  if (enemy.dead) {
    parts.push('defeated')
    return parts.join(', ')
  }
  parts.push(`${enemy.hp} of ${enemy.maxHp} hit points`)

  const said = intent
    .filter((part) => !part.echo)
    .map((part) => {
      const value = part.value === undefined || part.value === '' ? '' : `${part.value} `
      const repeat = part.times ? `, ${part.times} times` : ''
      return `${part.aoe ? 'all rows, ' : ''}to ${part.prefix === '-' ? 'lose' : 'apply'} ${value}${part.label ?? part.icon}${repeat}`
    })
    .join(', ')
  // "intends to apply 1 Vulnerable" rather than "vulnerable 1": the tokens the
  // enemy CARRIES are announced below in the same shape, and case alone is not
  // something a screen reader conveys.
  parts.push(said ? `intends ${said}` : 'no intent')
  parts.push(...abilities)
  if (enemy.corpseExplosion) {
    parts.push(`Corpse Explosion attached, ${enemy.corpseExplosion.damage} row damage when defeated`)
  }
  for (const entry of enemy.slayerAttachments ?? []) {
    parts.push(`${faceOf(cardDef(entry.card.defId), entry.card.upgraded).name} attached`)
  }

  const tokens: [string, number][] = [
    ['Block', enemy.block],
    ['Strength', enemy.strength],
    ['Vulnerable', enemy.vulnerable],
    ['Weak', enemy.weak],
    ['Poison', enemy.poison],
  ]
  for (const [token, value] of tokens) if (value > 0) parts.push(`has ${token} ${value}`)
  return parts.join(', ')
}

export function displayedAbilityText(
  ability: ReturnType<typeof enemyAbilities>[number],
  enemy: Enemy,
  defId: string,
  die: number,
): string {
  if (ability.kind === 'confusion') return `Confusion: the first card played this turn costs ${ability.byRoll[die] ?? '?'} Energy`
  if (ability.kind === 'immuneOnSlots') return ability.slots.includes(enemy.actionIndex)
    ? 'HP immunity: cannot lose HP this turn'
    : 'HP immunity: inactive; cannot lose HP while the cube is on a marked action'
  if (ability.kind === 'invincible') return enemy.abilityUsed
    ? 'Invincible: removed'
    : `Invincible: cannot gain Weak or fall below ${ability.hpPerPlayer} HP per player`
  if (ability.kind === 'facing') {
    if (ability.effect === 'spear') return 'Facing: gain 2 Burn at the start of turn while facing Spire Spear'
    const penalty = enemy.actionIndex === 0 ? 'lose 1 Energy' : enemy.actionIndex === 1 ? 'cannot draw' : 'deal 0 damage'
    return `Facing: ${penalty} this turn while facing Spire Shield`
  }
  if (ability.kind === 'rebirth') {
    if (defId === 'time_eater') return enemy.abilityUsed ? 'Haste: spent'
      : `Haste: when first defeated, return with ${ability.hpPerPlayer} HP per player, gain 1 Strength, remove all Weak and Vulnerable; Poison remains`
    if (defId === 'the_champ') return `Anger: when first defeated, enter Fury with ${ability.hpPerPlayer} HP per player`
    if (defId === 'awakened_one_phase_1') return `Awaken: return at end of turn in a second form${(enemy.ascension ?? 0) >= 10 ? ' and gain Strength equal to the largest number of Powers a player has in play' : ''}`
  }
  return abilityText(ability, false, enemy)
}

export function enemyAbilityTips(dead: boolean, abilityLabels: readonly string[]): { name: string; text: string }[] {
  const tips: { name: string; text: string }[] = []
  if (!dead) for (const label of abilityLabels) {
    const separator = label.indexOf(':')
    const name = separator < 0 ? 'Special effects' : label.slice(0, separator)
    const text = separator < 0 ? label : label.slice(separator + 1).trim()
    const existing = tips.find((tip) => tip.name === name)
    if (existing) existing.text += `; ${text}`
    else tips.push({ name, text })
  }
  return tips
}
