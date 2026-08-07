import { actionsFor, enemyDef } from '../game/enemies.ts'
import type { EnemyAction } from '../game/enemies.ts'
import type { Enemy } from '../game/types.ts'
import { Icon, IconValue } from './Icon.tsx'
import type { IconName } from './Icon.tsx'
import { TokenRow } from './TokenRow.tsx'

type EnemyCardProps = {
  enemy: Enemy
  /** The round's shared die, which decides what a die-pattern enemy will do. */
  die: number
  targeted?: boolean
  onClick?: (enemy: Enemy) => void
}

type IntentPart = { icon: IconName; value?: number | string; prefix?: string; aoe?: boolean }

/** An enemy's telegraphed intent, in the game's own symbols. */
function intentParts(action: EnemyAction): IntentPart[] {
  switch (action.kind) {
    case 'attack': {
      const value = action.times && action.times > 1 ? `${action.amount}×${action.times}` : action.amount
      return [{ icon: 'attack', value, aoe: action.aoe }]
    }
    case 'block':
      return [{ icon: 'block', value: action.amount }]
    case 'gainStrength':
      return [{ icon: 'strength', value: action.amount, prefix: '+' }]
    case 'applyWeak':
      return [{ icon: 'weak', value: action.amount, aoe: action.aoe }]
    case 'applyVulnerable':
      return [{ icon: 'vulnerable', value: action.amount, aoe: action.aoe }]
    case 'idle':
      return []
  }
}

export function EnemyCard({ enemy, die, targeted = false, onClick }: EnemyCardProps) {
  const def = enemyDef(enemy.defId)
  const intent = actionsFor(def, die, enemy.actionIndex).flatMap(intentParts)
  const hpFraction = enemy.maxHp === 0 ? 0 : enemy.hp / enemy.maxHp

  const className = [
    'enemy',
    enemy.dead ? 'enemy--dead' : '',
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
      aria-label={`${def.name}, ${enemy.hp} of ${enemy.maxHp} hit points`}
    >
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

      <span className="enemy__intent">
        {intent.length === 0 ? (
          <span className="enemy__asleep">…</span>
        ) : (
          intent.map((part, i) => (
            <span className="intent" key={`${part.icon}-${i}`}>
              {part.aoe ? <Icon name="aoe" size={20} /> : null}
              <IconValue name={part.icon} value={part.value ?? ''} prefix={part.prefix} size={28} />
            </span>
          ))
        )}
      </span>

      <span className="bar" aria-hidden="true">
        <span className="bar__fill" style={{ width: `${Math.round(hpFraction * 100)}%` }} />
        <span className="bar__label">
          {enemy.hp}/{enemy.maxHp}
        </span>
      </span>

      <TokenRow
        block={enemy.block}
        strength={enemy.strength}
        vulnerable={enemy.vulnerable}
        weak={enemy.weak}
        poison={enemy.poison}
      />
    </button>
  )
}
