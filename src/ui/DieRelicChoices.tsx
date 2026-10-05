// The picker for "trigger a die Relic" effects (Dolly's Mirror, Nilry's Codex,
// Loaded Die, Destiny Draught, Cheat). Every ability times every legal target
// used to print as its own sentence-long button, so a deep relic bar buried the
// panel in near-identical rows. Here one row is one Relic ability; its targets
// are short chips under it, and a Relic with nothing to aim is a single button.
import { enemyLabel, livingEnemies, reachesEnemy } from '../game/combat.ts'
import type { CombatState } from '../game/combat.ts'
import { relicIconPath } from '../game/assets.ts'
import { chosenDieRelicAbilities, relicDef } from '../game/relics.ts'
import type { Enemy, Player } from '../game/types.ts'

export type DieRelicChoice = {
  owner: Player
  relicIndex: number
  abilityIndex: number
  defId: string
  faces: readonly number[]
  enemy?: Enemy
  targetPlayer?: Player
}

/** Every die Relic ability a living player holds, once per legal target. */
export function dieRelicChoices(
  state: CombatState,
  { skip, needsEnemyForAll = false }: {
    skip?: (owner: Player, relicIndex: number, faces: readonly number[]) => boolean
    /** Cheat's engine path wants an enemy even for an all-enemies ability; the other paths ignore it. */
    needsEnemyForAll?: boolean
  } = {},
): DieRelicChoice[] {
  return state.players.filter((owner) => !owner.dead).flatMap((owner) => owner.relics.flatMap((held, relicIndex) =>
    chosenDieRelicAbilities(relicDef(held.defId)).flatMap((ability, abilityIndex) => {
      if (ability.trigger.kind !== 'dieRelic') return []
      const faces = ability.trigger.faces
      if (skip?.(owner, relicIndex, faces)) return []
      const enemies = (needsEnemyForAll || (ability.target ?? 'enemy') !== 'allEnemies') &&
        ability.effects.some((effect) => reachesEnemy(effect, owner))
        ? livingEnemies(state) : [undefined]
      const players = ability.supportTarget === 'anyPlayer'
        ? state.players.filter((player) => !player.dead) : [undefined]
      return enemies.flatMap((enemy) => players.map((targetPlayer): DieRelicChoice =>
        ({ owner, relicIndex, abilityIndex, defId: held.defId, faces, enemy, targetPlayer })))
    })))
}

const targetText = (state: CombatState, choice: DieRelicChoice): string =>
  [choice.enemy ? enemyLabel(state.enemies, choice.enemy) : null, choice.targetPlayer?.name]
    .filter(Boolean).join(' → ')

export function DieRelicChoiceList({ state, choices, pressed, onChoose }: {
  state: CombatState
  choices: readonly DieRelicChoice[]
  pressed?: (choice: DieRelicChoice) => boolean
  onChoose: (choice: DieRelicChoice) => void
}) {
  const groups = new Map<string, DieRelicChoice[]>()
  for (const choice of choices) {
    const key = `${choice.owner.id}:${choice.relicIndex}:${choice.abilityIndex}`
    groups.set(key, [...groups.get(key) ?? [], choice])
  }
  if (choices.length === 0) return null
  const shared = state.players.length > 1
  return (
    <div className={shared ? 'die-relic-list die-relic-list--shared' : 'die-relic-list'}>
      {[...groups].map(([key, group]) => {
        const first = group[0]!
        const name = relicDef(first.defId).name
        const faces = first.faces.join('/')
        const heading = <>
          <img className="die-relic__icon" src={relicIconPath(first.defId)} alt="" />
          <span className="die-relic__name" title={name}>{name}</span>
          {shared ? <span className="die-relic__owner">{first.owner.name}</span> : null}
          <span className="die-relic__faces">die {faces}</span>
        </>
        const label = (choice: DieRelicChoice) => {
          const target = targetText(state, choice)
          return `${first.owner.name}: ${name} · die ${faces}${target ? ` → ${target}` : ''}`
        }
        if (group.length === 1 && !first.enemy && !first.targetPlayer) {
          return <button type="button" key={key} className="die-relic die-relic--single"
            aria-pressed={pressed?.(first)} onClick={() => onChoose(first)}>
            {heading}
          </button>
        }
        return (
          <div className="die-relic die-relic--group" key={key} role="group" aria-label={`${shared ? `${first.owner.name}: ` : ''}${name} · die ${faces}`}>
            <div className="die-relic__head">{heading}</div>
            <div className="die-relic__targets">
              {group.map((choice) => (
                <button type="button" key={`${choice.enemy?.uid ?? ''}:${choice.targetPlayer?.id ?? ''}`}
                  className="die-relic__target" aria-label={label(choice)}
                  aria-pressed={pressed?.(choice)} onClick={() => onChoose(choice)}>
                  {targetText(state, choice)}
                </button>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}
