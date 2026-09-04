import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { assetPath, campfireScenePath } from '../game/assets.ts'
import { canUpgradeCard } from '../game/run.ts'
import type { ActionOutcome, PublicSeat, VisiblePlayer } from '../multiplayer/useRoomSession.ts'
import type { CampfireDecision } from '../game/run.ts'
import { CardPicker } from './CardPicker.tsx'
import { Icon } from './Icon.tsx'

type Decision = CampfireDecision

function choiceLabel(choice: Decision['choice']) {
  if (choice === 'ruby') return 'Get Ruby Key'
  return choice[0]!.toUpperCase() + choice.slice(1)
}

type Props = {
  player: VisiblePlayer
  saved?: Decision
  decided: string[]
  seats: PublicSeat[]
  onAction: (action: object) => Promise<ActionOutcome>
  rubyAvailable?: boolean
  restAllowed?: boolean
}

export function OnlineCampfireScreen({ player, saved, decided, seats, onAction, rubyAvailable = false, restAllowed = true }: Props) {
  const [decision, setDecision] = useState<Decision | null>(saved ?? null)
  const [picker, setPicker] = useState<'remove' | 'transform' | 'upgrade' | null>(null)
  const [actionPending, setActionPending] = useState(false)
  const actionPendingRef = useRef(false)
  const deck = player.deck ?? []
  const upgradable = deck.filter(canUpgradeCard)
  const coffee = player.relics.some((relic) => relic.defId === 'coffee_dripper')
  const hammer = player.relics.some((relic) => relic.defId === 'fusion_hammer')
  const peacePipe = player.relics.some((relic) => relic.defId === 'peace_pipe')
  const straightRazor = player.relics.some((relic) => relic.defId === 'straight_razor')
  const restHeal = 3 + (player.relics.some((relic) => relic.defId === 'regal_pillow') ? 3 : 0)
  const alive = seats.some((seat) => seat.playerId === player.id)
  const seatCharacters = seats.map((seat) => seat.character)
  const locked = decided.includes(player.id)
  const confirmDecision = (next: Decision) => {
    if (locked || actionPendingRef.current) return
    actionPendingRef.current = true
    setDecision(next)
    setPicker(null)
    setActionPending(true)
    void onAction({ kind: 'campfire', choices: { [player.id]: next } }).then((outcome) => {
      const acknowledged = outcome.snapshot !== undefined && (outcome.snapshot.campfireDecided.includes(player.id) ||
        outcome.snapshot.run !== null && outcome.snapshot.run.phase !== 'room')
      if (!acknowledged && outcome.status !== 'accepted') {
        actionPendingRef.current = false
        setActionPending(false)
      }
    }, () => {
      actionPendingRef.current = false
      setActionPending(false)
    })
  }

  useEffect(() => {
    if (saved) {
      setDecision(saved)
    }
    if (locked) {
      actionPendingRef.current = false
      setActionPending(false)
    }
  }, [locked, saved?.cardUid, saved?.choice, saved?.removeCardUid, saved?.transformCardUid])

  return (
    <section className="campfire" data-party-size={seats.length}
      style={{ '--campfire-scene': `url("${new URL(campfireScenePath(seatCharacters), window.location.href).href}")` } as CSSProperties}>
      <div className="campfire__prompt">
      <h2><Icon name="burn" size={26} /> Campfire <small>Rest Site</small></h2>
      {alive ? <div className="campfire__player">
        <span className="campfire__name">{player.name} · {player.hp}/{player.maxHp}</span>
        <div className="campfire__choices">
          {(locked || actionPending) && decision ? <p className="campfire__choice-status" role="status">
            {player.name} chose to {choiceLabel(decision.choice)}.
          </p> : <>
          {(coffee || !restAllowed) && (hammer || upgradable.length === 0) ? <button type="button" className={decision?.choice === 'leave' ? 'is-chosen' : ''}
            onClick={() => confirmDecision({ choice: 'leave' })}>
            Leave <span className="muted">No campfire action available</span>
          </button> : null}
          <button type="button" disabled={coffee || !restAllowed} className={decision?.choice === 'rest' ? 'is-chosen' : ''} onClick={() => {
            const next: Decision = { choice: 'rest' }
            if (peacePipe || straightRazor) {
              setDecision(next)
              setPicker(peacePipe ? 'remove' : 'transform')
            } else confirmDecision(next)
          }}>
            <img src={assetPath('noncombat/campfire/rest.webp')} alt="" /><strong>Rest</strong><span className="muted">+{restHeal} HP{!restAllowed ? ' · blocked by Night Terrors' : ''}</span>
          </button>
          <button type="button" disabled={hammer || upgradable.length === 0} className={decision?.choice === 'smith' ? 'is-chosen' : ''} onClick={() => {
            setDecision({ choice: 'smith' }); setPicker('upgrade')
          }}>
            <img src={assetPath('noncombat/campfire/smith.webp')} alt="" /><strong>Smith</strong><span className="muted">upgrade</span>
          </button>
          {rubyAvailable ? <button type="button" className={decision?.choice === 'ruby' ? 'is-chosen' : ''} onClick={() => confirmDecision({ choice: 'ruby' })}>
            ◆ Ruby Key <span className="muted">skip campfire</span>
          </button> : null}
          </>}
        </div>
      </div> : <p className="campfire__spectator" role="status">Your climb has ended. You are watching the surviving party choose.</p>}
      </div>
      {alive && !locked && !actionPending && decision && picker ? <CardPicker
        cards={picker === 'upgrade' ? upgradable : deck.filter((card) => picker === 'remove'
          ? card.defId !== 'ascenders_bane' : card.defId !== 'ascenders_bane' && card.uid !== decision.removeCardUid)}
        verb={picker === 'upgrade' ? 'Upgrade' : picker === 'remove' ? 'Remove' : 'Transform'}
        selectedCardUids={[picker === 'upgrade' ? decision.cardUid : picker === 'remove' ? decision.removeCardUid : decision.transformCardUid]
          .filter((uid): uid is string => Boolean(uid))}
        onSelect={(uid) => setDecision((current) => current && (picker === 'upgrade'
          ? { choice: 'smith', cardUid: current.cardUid === uid ? undefined : uid }
          : { ...current, [picker === 'remove' ? 'removeCardUid' : 'transformCardUid']:
            (picker === 'remove' ? current.removeCardUid : current.transformCardUid) === uid ? undefined : uid,
            ...(picker === 'remove' && current.transformCardUid === uid ? { transformCardUid: undefined } : {}) }))}
        onClear={() => setDecision((current) => current && (picker === 'upgrade'
          ? { choice: 'smith' } : { ...current, [picker === 'remove' ? 'removeCardUid' : 'transformCardUid']: undefined }))}
        onBack={() => { setPicker(null); setDecision(saved ?? null) }}
        onConfirm={() => {
          if (picker === 'remove' && straightRazor) setPicker('transform')
          else confirmDecision(decision)
        }}
        selectionRequired={picker === 'upgrade'}
      /> : null}
    </section>
  )
}
