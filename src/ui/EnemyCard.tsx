import { cardDef } from '../game/cards.ts'
import { cardImagePath, enemyImagePath } from '../game/assets.ts'
import { abilityText, actionsForEnemy, enemyAbilities, enemyDef } from '../game/enemies.ts'
import type { EnemyAction } from '../game/enemies.ts'
// Aliased: `hitDamage` is also this component's floating hit-VFX number.
import { attackerModsOfEnemy, hitDamage as swingDamage } from '../game/damage.ts'
import type { Enemy, Player } from '../game/types.ts'
import type { CSSProperties, ReactNode } from 'react'
import { Icon, IconValue } from './Icon.tsx'
import type { IconName } from './Icon.tsx'
import { TokenRow } from './TokenRow.tsx'
import { healthBand, strikeClass } from './board-signals.ts'
import { revealDecodedImage } from './Card.tsx'

type EnemyCardProps = {
  enemy: Enemy
  /** The finished display name, built by the engine so the log agrees. */
  label: string
  /** The round's shared die, which decides what a die-pattern enemy will do. */
  die: number
  targeted?: boolean
  disabled?: boolean
  /** Just took damage: flinch, so the hit is felt and not merely recorded. */
  struck?: boolean
  hitDamage?: number
  /** Which hit this is, so a second blow restarts the animation. */
  beat?: number
  /** Just crossed from alive to dead: play the one-shot defeat animation. */
  falling?: boolean
  /** Decorative, authoritative action effects aimed at this enemy. */
  vfx?: ReactNode
  stageIndex?: number
  /** Player whose row this enemy occupies; bosses affect the whole party. */
  rowLabel?: string
  /**
   * The player this enemy will swing at, so the intent can show the damage that
   * will land rather than the number printed on the enemy card. Their Vulnerable
   * and Power count both change it. An AoE hits every row, but the occupant of
   * this row is the reading that matters to whoever owns it.
   */
  defender?: Pick<Player, 'vulnerable' | 'powers'>
  onClick?: (enemy: Enemy) => void
}

type IntentPart = {
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
function intentParts(action: EnemyAction, swing: (printed: number) => number): IntentPart[] {
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
      return [{ icon: action.card === 'burn' ? 'burn' : 'monster', value: action.amount, label: `shuffle ${action.card} into every deck`, visibleLabel: action.card }]
    case 'actsLast':
      return [{ icon: 'monster', label: 'acts last', visibleLabel: 'Acts last' }]
    case 'idle':
      return []
  }
}

/**
 * The enemy button's accessible name.
 *
 * `aria-label` replaces the element's contents wholesale, so anything left out
 * is unreachable however it is marked up — the same trap `describeSeat` avoids
 * for players. The intent especially: it is the one thing choosing a target
 * depends on, and it was not being announced at all.
 */
function describeEnemy(
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

function displayedAbilityText(
  ability: ReturnType<typeof enemyAbilities>[number],
  enemy: Enemy,
  defId: string,
  die: number,
  compact: boolean,
): string {
  if (ability.kind === 'confusion') return compact
    ? `Confusion · first card costs ${ability.byRoll[die] ?? '?'}`
    : `Confusion: the first card played this turn costs ${ability.byRoll[die] ?? '?'} Energy`
  if (ability.kind === 'thorns') return compact
    ? `Thorns · ${enemy.abilityCubes ?? 0} cubes`
    : `Thorns: ${enemy.abilityCubes ?? 0} cubes; after an Attack, ${ability.damagePerCube} damage per cube`
  if (ability.kind === 'beatOfDeath') return compact
    ? `Beat of Death · ${enemy.abilityCubes ?? 0} cubes`
    : `Beat of Death: ${enemy.abilityCubes ?? 0} cubes; deals that much damage to every player at end of turn`
  if (ability.kind === 'immuneOnSlots') return ability.slots.includes(enemy.actionIndex)
    ? 'Cannot lose HP this turn'
    : compact ? 'HP immunity · inactive' : 'Cannot lose HP while the cube is on a marked action'
  if (ability.kind === 'invincible') return enemy.abilityUsed
    ? compact ? 'Invincible · removed' : 'Invincible: removed'
    : compact
      ? `Invincible · no Weak · floor ${ability.hpPerPlayer}/player`
      : `Invincible: cannot gain Weak or fall below ${ability.hpPerPlayer} HP per player`
  if (ability.kind === 'facing') {
    if (ability.effect === 'spear') return compact
      ? 'Facing · start: gain 2 Burn'
      : 'Facing: gain 2 Burn at the start of turn while facing Spire Spear'
    const penalty = enemy.actionIndex === 0 ? 'lose 1 Energy' : enemy.actionIndex === 1 ? 'cannot draw' : 'deal 0 damage'
    return compact ? `Facing · ${penalty}` : `Facing: ${penalty} this turn while facing Spire Shield`
  }
  if (ability.kind === 'rebirth') {
    if (defId === 'time_eater') {
      if (enemy.abilityUsed) return compact ? 'Haste · spent' : 'Haste: spent'
      return compact
        ? `Haste · ${ability.hpPerPlayer} HP/player · +1 Strength · clear Weak/Vulnerable · Poison remains`
        : `Haste: when first defeated, return with ${ability.hpPerPlayer} HP per player, gain 1 Strength, remove all Weak and Vulnerable; Poison remains`
    }
    if (defId === 'the_champ') return compact
      ? `Anger · Fury at ${ability.hpPerPlayer}/player`
      : `Anger: when first defeated, enter Fury with ${ability.hpPerPlayer} HP per player`
    if (defId === 'awakened_one_phase_1') return compact
      ? `Awaken · return at end of turn${(enemy.ascension ?? 0) >= 10 ? ' · Strength from largest Power count' : ''}`
      : `Awaken: return at end of turn in a second form${(enemy.ascension ?? 0) >= 10 ? ' and gain Strength equal to the largest number of Powers a player has in play' : ''}`
  }
  return abilityText(ability, compact)
}

export function EnemyCard({
  enemy,
  label,
  die,
  targeted = false,
  disabled = false,
  struck = false,
  hitDamage,
  beat = 0,
  falling = false,
  vfx,
  stageIndex = 0,
  rowLabel,
  defender,
  onClick,
}: EnemyCardProps) {
  const def = enemyDef(enemy.defId, enemy.ascension)
  const actions = actionsForEnemy(enemy, die)
  const abilities = enemyAbilities(def)
  // Curiosity adds the defender's Power count to every hit, so it belongs in the
  // preview for the same reason Strength and Weak do.
  const curiosity = abilities.some((ability) => ability.kind === 'curiosity')
  const mods = attackerModsOfEnemy(enemy)
  const swing = (printed: number) => swingDamage(
    printed + (curiosity ? defender?.powers.length ?? 0 : 0),
    mods,
    { vulnerable: defender?.vulnerable ?? 0 },
  )
  const intent = actions.flatMap((action) => intentParts(action, swing))
  if ((enemy.actsLast || def.actsLast) && !actions.some((action) => action.kind === 'actsLast')) {
    intent.push(...intentParts({ kind: 'actsLast' }, swing))
  }
  const abilityLabels = abilities.map((ability) => {
    const text = displayedAbilityText(ability, enemy, def.id, die, false)
    return `${text}${enemy.abilityUsed && ability.kind === 'curlUp' ? ', spent' : ''}`
  })
  const hpFraction = enemy.maxHp === 0 ? 0 : enemy.hp / enemy.maxHp

  const className = [
    'enemy',
    enemy.dead ? 'enemy--dead' : '',
    falling ? 'enemy--falling' : '',
    struck ? strikeClass('enemy', beat) : '',
    targeted ? 'enemy--targeted' : '',
    enemy.isBoss ? 'enemy--boss' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <button
      type="button"
      className={className}
      data-sfx="enemy"
      data-enemy-id={enemy.uid}
      data-row={enemy.row}
      style={{
        '--stage-index': stageIndex,
        ...(def.bossAct ? { backgroundImage: `linear-gradient(rgb(14 12 10 / 0.72), rgb(14 12 10 / 0.88)), url(/assets/backgrounds/boss-act-${def.bossAct}.webp)` } : {}),
      } as CSSProperties}
      disabled={enemy.dead || disabled}
      onClick={() => onClick?.(enemy)}
      aria-label={describeEnemy(enemy, label, intent, abilityLabels, rowLabel)}
    >
      {/* A corpse telegraphing an attack it will never make is worse than no
          intent at all — it is read as a threat while choosing a target.
          p.13: the dead are flipped over until the end of combat. */}
      <span className="enemy__intent">
        {enemy.dead ? (
          // Not the `monster` icon: that same glyph badges LIVING enemies two
          // lines above, so a corpse wearing it still reads as a threat.
          <span className="enemy__defeated" aria-hidden="true">
            ✕
          </span>
        ) : intent.length === 0 ? (
          <span className="enemy__asleep">…</span>
        ) : (
          intent.map((part, i) => (
            <span className="intent" key={`${part.icon}-${i}`}>
              {part.aoe ? <Icon name="aoe" size={20} /> : null}
              <IconValue name={part.icon} value={part.value ?? ''} prefix={part.prefix} size={28} />
              {part.visibleLabel ? <span className="intent__label">{part.visibleLabel}</span> : null}
            </span>
          ))
        )}
      </span>
      {abilities.length > 0 ? (
        <span
          className="enemy__ability"
          title={abilityLabels.join('\n')}
          onClick={(event) => event.stopPropagation()}
        >
          {abilities.map((ability, index) => {
            const spent = enemy.abilityUsed && (ability.kind === 'curlUp' ||
              (ability.kind === 'rebirth' && def.id === 'time_eater'))
            return (
              <span className={spent ? 'enemy__ability--spent' : undefined} key={`${ability.kind}-${index}`}>
                {spent && ability.kind === 'curlUp'
                  ? 'Curl Up · spent'
                  : displayedAbilityText(ability, enemy, def.id, die, true)}
              </span>
            )
          })}
        </span>
      ) : null}

      {enemy.corpseExplosion ? (
        <span className="enemy__attachment" title={`Corpse Explosion · ${enemy.corpseExplosion.damage} row damage on death`}>
          <img src={cardImagePath(cardDef(enemy.corpseExplosion.card.defId), enemy.corpseExplosion.card.upgraded)} alt=""
            onLoad={(event) => revealDecodedImage(event.currentTarget)}
            onError={(event) => { event.currentTarget.style.visibility = 'hidden' }} />
          <span>Corpse Explosion · {enemy.corpseExplosion.damage}</span>
        </span>
      ) : null}

      <span className="enemy__portrait">
        <img
          className="enemy__art--cutout"
          src={enemyImagePath(def)}
          alt=""
          loading="lazy"
          onError={(event) => {
            // Keep combat usable if a bundled image fails to load.
            event.currentTarget.style.display = 'none'
          }}
        />
        {vfx}
        {rowLabel ? (
          <span className="enemy__row" title={`Row ${enemy.row + 1} · ${rowLabel}`} aria-hidden="true">
            <span className="enemy__row-long">{rowLabel}</span>
            <span className="enemy__row-short">P{enemy.row + 1}</span>
          </span>
        ) : null}
        <span className="enemy__head">
          <Icon name={enemy.isBoss ? 'boss' : 'monster'} size={16} />
          <span className="enemy__name">{def.name}</span>
        </span>
        {struck ? <span className="hit-vfx" key={beat} aria-hidden="true"><strong>{hitDamage}</strong></span> : null}
      </span>

      <span className="bar" aria-hidden="true">
        <span
          className="bar__fill"
          data-health={healthBand(enemy.hp, enemy.maxHp)}
          style={{ width: `${Math.round(hpFraction * 100)}%` }}
        />
        <span className="bar__label">
          {enemy.hp}/{enemy.maxHp}
        </span>
      </span>

      {/* A defeated enemy is flipped over (p.13), and its tokens go with it —
          a corpse still announcing "Poison 3" reads as a live threat. */}
      {enemy.dead ? null : (
      <TokenRow
        block={enemy.block}
        strength={enemy.strength}
        vulnerable={enemy.vulnerable}
        weak={enemy.weak}
        poison={enemy.poison}
      />
      )}
    </button>
  )
}
