import { useState } from 'react'
import type { CSSProperties } from 'react'
import { assetPath, campfireScenePath } from '../game/assets.ts'
import { canUpgradeCard } from '../game/run.ts'
import type { CampfireDecision } from '../game/run.ts'
import type { Player } from '../game/types.ts'
import { CardPicker } from './CardPicker.tsx'
import { Icon } from './Icon.tsx'

type CampfireScreenProps = {
  players: Player[]
  onResolve: (choices: Record<string, CampfireDecision>) => void
  rubyAvailable?: boolean
  restAllowed?: boolean
}

type Decision = CampfireDecision

function choiceLabel(choice: Decision['choice']) {
  if (choice === 'ruby') return 'Get Ruby Key'
  return choice[0]!.toUpperCase() + choice.slice(1)
}

/**
 * Each player picks Rest or Smith independently (p.9). Nobody moves on until
 * every living player has decided, which mirrors the table: you all leave the
 * campfire together.
 */
export function CampfireScreen({ players, onResolve, rubyAvailable = false, restAllowed = true }: CampfireScreenProps) {
  const [decisions, setDecisions] = useState<Record<string, Decision>>({})
  const [confirmedIds, setConfirmedIds] = useState<Set<string>>(() => new Set())
  const [picker, setPicker] = useState<'remove' | 'transform' | 'upgrade' | null>(null)
  const living = players.filter((player) => !player.dead)
  const livingCharacters = living.map((seat) => seat.character)
  const [focusedId, setFocusedId] = useState(living[0]?.id ?? '')
  const player = living.find((candidate) => candidate.id === focusedId) ?? living[0]
  const focusedIndex = Math.max(0, living.findIndex((candidate) => candidate.id === player?.id))
  const decision = player ? decisions[player.id] : undefined
  const confirmed = player ? confirmedIds.has(player.id) : false
  const coffee = player?.relics.some((relic) => relic.defId === 'coffee_dripper') ?? false
  const hammer = player?.relics.some((relic) => relic.defId === 'fusion_hammer') ?? false
  const peacePipe = player?.relics.some((relic) => relic.defId === 'peace_pipe') ?? false
  const straightRazor = player?.relics.some((relic) => relic.defId === 'straight_razor') ?? false
  const restHeal = player ? 3 + (player.relics.some((relic) => relic.defId === 'regal_pillow') ? 3 : 0) : 3
  const upgradable = player?.deck.filter(canUpgradeCard) ?? []
  const restBlocked = coffee || !restAllowed
  const blocked = restBlocked && (hammer || upgradable.length === 0)
  const clearDecision = () => {
    if (!player) return
    setDecisions((current) => {
      const next = { ...current }
      delete next[player.id]
      return next
    })
    setConfirmedIds((current) => {
      const next = new Set(current)
      next.delete(player.id)
      return next
    })
  }
  const confirmDecision = (nextDecision: Decision) => {
    if (!player) return
    const next = { ...decisions, [player.id]: nextDecision }
    setPicker(null)
    if (living.every((seat) => next[seat.id] && (seat.id === player.id || confirmedIds.has(seat.id)))) {
      onResolve(next)
      return
    }
    setDecisions(next)
    setConfirmedIds((current) => new Set(current).add(player.id))
  }

  return (
    <section className="campfire" data-party-size={living.length}
      style={{ '--campfire-scene': `url("${new URL(campfireScenePath(livingCharacters), window.location.href).href}")` } as CSSProperties}>
      <div className="campfire__prompt">
        <h2><Icon name="burn" size={26} /> Campfire <small>Rest Site</small></h2>
        {player ? <div className="campfire__player" role="group" aria-label={`${player.name}, ${player.hp} of ${player.maxHp} HP`}>
          <div className="campfire__name-row">
            <span className="campfire__name">{player.name} · {player.hp}/{player.maxHp} HP</span>
            {living.length > 1 ? <span className="campfire__turn-nav">
              <button type="button" aria-label={`Previous campfire player: ${living[(focusedIndex - 1 + living.length) % living.length]!.name}`}
                onClick={() => setFocusedId(living[(focusedIndex - 1 + living.length) % living.length]!.id)}>‹</button>
              <button type="button" aria-label={`Next campfire player: ${living[(focusedIndex + 1) % living.length]!.name}`}
                onClick={() => setFocusedId(living[(focusedIndex + 1) % living.length]!.id)}>›</button>
            </span> : null}
          </div>
          <div className="campfire__choices">
                {confirmed && decision ? <p className="campfire__choice-status" role="status">
                  {player.name} chose to {choiceLabel(decision.choice)}.
                </p> : <>
                {blocked ? <button type="button"
                  className={decision?.choice === 'leave' ? 'is-chosen' : ''}
                  onClick={() => confirmDecision({ choice: 'leave' })}>
                  Leave <span className="muted">No campfire action available</span>
                </button> : null}
                <button
                  type="button"
                  className={decision?.choice === 'rest' ? 'is-chosen' : ''}
                  disabled={restBlocked}
                  onClick={() => {
                    const next: Decision = { choice: 'rest' }
                    if (peacePipe || straightRazor) {
                      setDecisions((current) => ({ ...current, [player.id]: next }))
                      setPicker(peacePipe ? 'remove' : 'transform')
                    } else confirmDecision(next)
                  }}
                >
                  <img src={assetPath('noncombat/campfire/rest.webp')} alt="" />
                  <strong>Rest</strong>
                  <span className="muted"> +{restHeal} HP{!restAllowed ? ' · blocked by Night Terrors' : coffee ? ' · blocked by Coffee Dripper' : ''}</span>
                </button>
                {rubyAvailable ? <button
                  type="button"
                  className={decision?.choice === 'ruby' ? 'is-chosen' : ''}
                  onClick={() => confirmDecision({ choice: 'ruby' })}
                >◆ Ruby Key <span className="muted">skip campfire</span></button> : null}
                <button
                  type="button"
                  className={decision?.choice === 'smith' ? 'is-chosen' : ''}
                  disabled={hammer || upgradable.length === 0}
                  onClick={() => {
                    setDecisions((current) => ({ ...current, [player.id]: { choice: 'smith' } }))
                    setPicker('upgrade')
                  }}
                >
                  <img src={assetPath('noncombat/campfire/smith.webp')} alt="" />
                  <strong>Smith</strong>
                  <span className="muted"> upgrade</span>
                </button>
                </>}
          </div>
        </div> : null}
      </div>

      {player && decision && picker ? <CardPicker
        cards={picker === 'upgrade' ? upgradable : player.deck.filter((card) => picker === 'remove'
          ? card.defId !== 'ascenders_bane' : card.defId !== 'ascenders_bane' && card.uid !== decision.removeCardUid)}
        verb={picker === 'upgrade' ? 'Upgrade' : picker === 'remove' ? 'Remove' : 'Transform'}
        selectedCardUids={[picker === 'upgrade' ? decision.cardUid : picker === 'remove' ? decision.removeCardUid : decision.transformCardUid]
          .filter((uid): uid is string => Boolean(uid))}
        onSelect={(uid) => setDecisions((current) => ({ ...current, [player.id]: picker === 'upgrade'
          ? { choice: 'smith', cardUid: decision.cardUid === uid ? undefined : uid }
          : { ...decision, [picker === 'remove' ? 'removeCardUid' : 'transformCardUid']:
            (picker === 'remove' ? decision.removeCardUid : decision.transformCardUid) === uid ? undefined : uid,
            ...(picker === 'remove' && decision.transformCardUid === uid ? { transformCardUid: undefined } : {}) } }))}
        onClear={() => setDecisions((current) => ({ ...current, [player.id]: picker === 'upgrade'
          ? { choice: 'smith' } : { ...decision, [picker === 'remove' ? 'removeCardUid' : 'transformCardUid']: undefined } }))}
        onBack={() => { setPicker(null); clearDecision() }}
        onConfirm={() => {
          if (picker === 'remove' && straightRazor) setPicker('transform')
          else confirmDecision(decision)
        }}
        selectionRequired={picker === 'upgrade'}
      /> : null}
    </section>
  )
}
