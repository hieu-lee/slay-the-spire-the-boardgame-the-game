import type { Dispatch, RefObject, SetStateAction } from 'react'
import { relicIconPath } from '../../game/assets.ts'
import { enemyLabel, overflowShivCount } from '../../game/combat.ts'
import type { CombatState, RelicContext } from '../../game/combat.ts'
import { potionDef, relicDef } from '../../game/relics.ts'
import type { Enemy, Player } from '../../game/types.ts'
import { Card } from '../Card.tsx'
import { DieRelicChoiceList, dieRelicChoices } from '../DieRelicChoices.tsx'
import { PotionTooltipAnchor } from '../PotionIcon.tsx'
import { relicTooltipText } from '../RelicChip.tsx'

export type RelicActionsProps = {
  state: CombatState
  viewer: Player
  viewerId: string
  stanceChangedThisTurn: boolean | undefined
  enemyButtonOrder: readonly Enemy[]
  canUseRelicNow: (relicIndex: number) => boolean
  useRelic: (relicIndex: number, context?: RelicContext) => void
  relicCardUids: string[]
  setRelicCardUids: Dispatch<SetStateAction<string[]>>
  relicShivEnemyUids: string[]
  setRelicShivEnemyUids: Dispatch<SetStateAction<string[]>>
  relicActionPending: RefObject<boolean>
}

export function RelicActions({
  state,
  viewer,
  viewerId,
  stanceChangedThisTurn,
  enemyButtonOrder,
  canUseRelicNow,
  useRelic,
  relicCardUids,
  setRelicCardUids,
  relicShivEnemyUids,
  setRelicShivEnemyUids,
  relicActionPending,
}: RelicActionsProps) {
  return (
    <div className="relic-actions">
      <section aria-label="Relic abilities">
        {viewer.relics.flatMap((held, relicIndex) => {
          const def = relicDef(held.defId)
          const description = relicTooltipText(held.defId, state.die)
          const simpleAction = <PotionTooltipAnchor id={held.defId} key={`${held.defId}-${relicIndex}`}
            name={def.name} text={description} kindLabel="Relic" confirmLabel="use">
            <button type="button" aria-label={`Use ${def.name}${held.cubes !== undefined ? ` (${held.cubes})` : ''}: ${description}`}
              onClick={() => useRelic(relicIndex)}>
              <img className="item-icon-image" src={relicIconPath(held.defId)} alt="" />
            </button>
          </PotionTooltipAnchor>
          const heldId = held.defId.replace(/^downfall_/, '')
          const reroute = ['dollys_mirror', 'nilrys_codex', 'loaded_die'].includes(heldId)
          if (!canUseRelicNow(relicIndex)) return []
          if (held.defId === 'golden_eye') return [simpleAction]
          if (held.defId === 'gambling_chip') return [simpleAction]
          if (held.defId === 'fuel_canister') return [<details key={relicIndex}>
            <summary>{def.name}</summary><p className="room-item-text">{def.text}</p>
            <div className="campfire__deck">{viewer.hand.map((card) => <Card stanceChangedThisTurn={stanceChangedThisTurn} key={card.uid} card={card}
              selected={relicCardUids[0] === card.uid} onClick={() => setRelicCardUids([card.uid])} />)}</div>
            <button type="button" disabled={relicCardUids.length !== 1}
              onClick={() => useRelic(relicIndex, { cardUids: relicCardUids })}>Exhaust and gain Energy</button>
          </details>]
          if (held.defId === 'shot_glass') return [<details key={relicIndex}>
            <summary>{def.name}</summary><p className="room-item-text">{def.text}</p>
            {viewer.potions.map((potionId, index) => <button type="button" key={`${potionId}-${index}`}
              onClick={() => useRelic(relicIndex, { discardPotionId: potionId })}>
              Discard {potionDef(potionId).name}
            </button>)}
          </details>]
          if (held.defId === 'blue_candle' || held.defId === 'runic_pyramid') return [<details key={relicIndex}>
            <summary>{def.name}</summary><p className="room-item-text">{def.text}</p>
            {held.defId === 'runic_pyramid' ? <p className="room-item-text">Choose the cards to keep for your next turn.</p> : null}
            <div className="campfire__deck">{viewer.hand.map((card) => <Card stanceChangedThisTurn={stanceChangedThisTurn} key={card.uid} card={card}
              selected={relicCardUids.includes(card.uid)} onClick={() => setRelicCardUids((current) =>
                current.includes(card.uid) ? current.filter((uid) => uid !== card.uid) :
                  held.defId === 'blue_candle' && current.length >= 2 ? current : [...current, card.uid])} />)}</div>
            <button type="button" disabled={held.defId === 'runic_pyramid' && relicCardUids.length === 0}
              onClick={() => useRelic(relicIndex, { cardUids: relicCardUids })}>
              {held.defId === 'runic_pyramid' ? `Retain ${relicCardUids.length} card${relicCardUids.length === 1 ? '' : 's'}` : 'Activate'}
            </button>
            <button type="button" onClick={(event) => {
              if (relicActionPending.current) return
              setRelicCardUids([])
              const details = event.currentTarget.closest('details')
              if (details) {
                details.open = false
                details.querySelector('summary')?.focus()
              }
            }}>Cancel</button>
          </details>]
          if (held.defId === 'charons_ashes') return [<details key={relicIndex}><summary>{def.name}</summary><p className="room-item-text">{def.text}</p>
            <div className="campfire__deck">{viewer.hand.map((card) => <Card stanceChangedThisTurn={stanceChangedThisTurn} key={card.uid} card={card}
              selected={relicCardUids[0] === card.uid} onClick={() => setRelicCardUids([card.uid])} />)}</div>
            {enemyButtonOrder.map((enemy) => <button type="button" key={enemy.uid}
              disabled={relicCardUids.length !== 1}
              onClick={() => useRelic(relicIndex, { cardUids: relicCardUids, enemyUid: enemy.uid })}>
              Hit {enemyLabel(state.enemies, enemy)}
            </button>)}
          </details>]
          if (heldId === 'ninja_scroll') {
            const amount = def.effects.find((effect) => effect.kind === 'gainShiv')?.amount ?? 2
            const overflow = overflowShivCount(state, amount)
            if (overflow === 0) return [simpleAction]
            return [<details key={relicIndex}><summary>{def.name}</summary><p className="room-item-text">{def.text}</p>
              <p>Choose {overflow} immediate Shiv target{overflow === 1 ? '' : 's'}.</p>
              {enemyButtonOrder.map((enemy) => <button type="button" key={enemy.uid}
                onClick={() => setRelicShivEnemyUids((current) => current.length < overflow
                  ? [...current, enemy.uid] : current)}>
                {enemyLabel(state.enemies, enemy)}
              </button>)}
              <button type="button" disabled={relicShivEnemyUids.length !== overflow}
                onClick={() => useRelic(relicIndex, { shivEnemyUids: relicShivEnemyUids })}>
                Throw {relicShivEnemyUids.length}/{overflow}
              </button>
              {relicShivEnemyUids.length > 0 ? <button type="button"
                onClick={() => setRelicShivEnemyUids([])}>Clear</button> : null}
            </details>]
          }
          if (reroute) {
            const face = heldId === 'nilrys_codex' ? 2 : null
            return [<details key={relicIndex}><summary>{def.name}</summary><p className="room-item-text">{def.text}</p>
              <DieRelicChoiceList state={state}
                choices={dieRelicChoices(state, { skip: (owner, targetRelicIndex, faces) =>
                  face !== null && !faces.includes(face) ||
                  ['nilrys_codex', 'loaded_die'].includes(heldId) && owner.id === viewerId &&
                  targetRelicIndex === relicIndex })}
                onChoose={(choice) => useRelic(relicIndex, {
                  targetRelicPlayerId: choice.owner.id, targetRelicIndex: choice.relicIndex,
                  targetAbilityIndex: choice.abilityIndex, enemyUid: choice.enemy?.uid,
                  targetPlayerId: choice.targetPlayer?.id,
                })} />
            </details>]
          }
          return [simpleAction]
        })}
      </section>
    </div>
  )
}
