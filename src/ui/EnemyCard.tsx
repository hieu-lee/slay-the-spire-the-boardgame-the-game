import { abilityText, actionsForEnemy, enemyAbilities, enemyDef } from '../game/enemies.ts'
import type { EnemyAction } from '../game/enemies.ts'
import type { Enemy } from '../game/types.ts'
import { Icon, IconValue } from './Icon.tsx'
import type { IconName } from './Icon.tsx'
import { TokenRow } from './TokenRow.tsx'
import { healthBand, strikeClass } from './board-signals.ts'

type EnemyCardProps = {
  enemy: Enemy
  /** The finished display name, built by the engine so the log agrees. */
  label: string
  /** The round's shared die, which decides what a die-pattern enemy will do. */
  die: number
  targeted?: boolean
  /** Just took damage: flinch, so the hit is felt and not merely recorded. */
  struck?: boolean
  /** Which hit this is, so a second blow restarts the animation. */
  beat?: number
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

/** An enemy's telegraphed intent, in the game's own symbols. */
function intentParts(action: EnemyAction): IntentPart[] {
  switch (action.kind) {
    case 'attack': {
      // Repeated symbols, not a formula. Twin Strike prints two swords side by
      // side rather than "1x2", and the enemy cards do the same — the board
      // game's own notation, and more symbol than text besides.
      const times = action.times && action.times > 1 ? action.times : 1
      return Array.from({ length: times }, (_unused, index) => ({
        icon: 'attack' as const,
        value: action.amount,
        aoe: action.aoe,
        times: index === 0 && times > 1 ? times : undefined,
        echo: index > 0,
      }))
    }
    case 'attackSequence':
      return action.hits.map((hit) => ({ icon: 'attack', value: hit.amount, aoe: hit.aoe }))
    case 'block':
      return [{ icon: 'block', value: action.amount }]
    case 'gainStrength':
      return [{ icon: 'strength', value: action.amount, prefix: '+' }]
    case 'blockAllEnemies':
      return [{ icon: 'block', value: action.amount, label: 'Block to all enemies' }]
    case 'strengthenAllEnemies':
      return [{ icon: 'strength', value: action.amount, prefix: '+', label: 'Strength to all enemies' }]
    case 'healAllEnemies':
      return [{ icon: 'monster', value: action.amount, label: 'heal all enemies', visibleLabel: 'Heal' }]
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
    case 'leave':
      return [{ icon: 'monster', label: 'leaves combat', visibleLabel: 'Leaves' }]
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
function describeEnemy(enemy: Enemy, label: string, intent: IntentPart[], abilities: string[]): string {
  // The label is built by the engine and is the SAME string the log prints --
  // "Cultist (row 0, #2)" when two of them share a row. Two identically named
  // buttons would leave a screen-reader user unable to match log to board, and
  // rebuilding the name here is what let the two drift apart before.
  const parts = [label]
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

export function EnemyCard({
  enemy,
  label,
  die,
  targeted = false,
  struck = false,
  beat = 0,
  onClick,
}: EnemyCardProps) {
  const def = enemyDef(enemy.defId, enemy.ascension)
  const actions = actionsForEnemy(enemy, die)
  const intent = actions.flatMap(intentParts)
  if ((enemy.actsLast || def.actsLast) && !actions.some((action) => action.kind === 'actsLast')) {
    intent.push(...intentParts({ kind: 'actsLast' }))
  }
  const abilities = enemyAbilities(def)
  const spentAbility = abilities.some((ability) => ability.kind === 'curlUp') && enemy.abilityUsed
  const abilityLabels = abilities.map((ability) => {
    const text = ability.kind === 'confusion'
      ? `Confusion: the first card played this turn costs ${ability.byRoll[die] ?? '?'} Energy`
      : abilityText(ability)
    return `${text}${spentAbility && ability.kind === 'curlUp' ? ', spent' : ''}`
  })
  const hpFraction = enemy.maxHp === 0 ? 0 : enemy.hp / enemy.maxHp

  const className = [
    'enemy',
    enemy.dead ? 'enemy--dead' : '',
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
      disabled={enemy.dead}
      onClick={() => onClick?.(enemy)}
      aria-label={describeEnemy(enemy, label, intent, abilityLabels)}
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
          className={`enemy__ability${spentAbility ? ' enemy__ability--spent' : ''}`}
          title={abilityLabels.join('\n')}
        >
          {abilities.map((ability, index) => (
            <span key={`${ability.kind}-${index}`}>
              {spentAbility && ability.kind === 'curlUp'
                ? 'Curl Up · spent'
                : ability.kind === 'confusion'
                  ? `Confusion · first card costs ${ability.byRoll[die] ?? '?'}`
                  : abilityText(ability, true)}
            </span>
          ))}
        </span>
      ) : null}

      <span className="enemy__portrait">
        <img
          src={`/assets/enemies/${enemy.defId}.webp`}
          alt=""
          loading="lazy"
          onError={(event) => {
            // Not every enemy has art extracted yet; fall back to the panel
            // background rather than showing a broken image.
            event.currentTarget.style.display = 'none'
          }}
        />
        <span className="enemy__head">
          <Icon name={enemy.isBoss ? 'boss' : 'monster'} size={16} />
          <span className="enemy__name">{def.name}</span>
        </span>
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
