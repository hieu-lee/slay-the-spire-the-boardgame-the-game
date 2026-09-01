import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import { campfireCharacterImagePath, campfireScenePath, campfireUsesCharacterCutouts } from '../game/assets.ts'
import { canUpgradeCard } from '../game/run.ts'
import type { PublicSeat, VisiblePlayer } from '../multiplayer/useRoomSession.ts'
import type { CampfireDecision } from '../game/run.ts'
import { Card } from './Card.tsx'
import { Icon } from './Icon.tsx'

type Decision = CampfireDecision

type Props = {
  player: VisiblePlayer
  saved?: Decision
  decided: string[]
  seats: PublicSeat[]
  onAction: (action: object) => void
  rubyAvailable?: boolean
  restAllowed?: boolean
}

export function OnlineCampfireScreen({ player, saved, decided, seats, onAction, rubyAvailable = false, restAllowed = true }: Props) {
  const [decision, setDecision] = useState<Decision | null>(saved ?? null)
  const deck = player.deck ?? []
  const upgradable = deck.filter(canUpgradeCard)
  const coffee = player.relics.some((relic) => relic.defId === 'coffee_dripper')
  const hammer = player.relics.some((relic) => relic.defId === 'fusion_hammer')
  const peacePipe = player.relics.some((relic) => relic.defId === 'peace_pipe')
  const straightRazor = player.relics.some((relic) => relic.defId === 'straight_razor')
  const restHeal = 3 + (player.relics.some((relic) => relic.defId === 'regal_pillow') ? 3 : 0)
  const ready = decision?.choice === 'rest' || decision?.choice === 'leave' || decision?.choice === 'ruby' || decision?.cardUid !== undefined
  const alive = seats.some((seat) => seat.playerId === player.id)
  const seatCharacters = seats.map((seat) => seat.character)
  const characterCutouts = campfireUsesCharacterCutouts(seatCharacters)

  useEffect(() => {
    if (saved) setDecision(saved)
  }, [saved?.cardUid, saved?.choice, saved?.removeCardUid, saved?.transformCardUid])

  return (
    <section className="campfire" data-party-size={seats.length} data-character-cutouts={characterCutouts || undefined}
      style={{ '--campfire-scene': `url("${new URL(campfireScenePath(seatCharacters), window.location.href).href}")` } as CSSProperties}>
      {characterCutouts ? <div className="campfire__party" aria-hidden="true"
        style={{ '--campfire-party-size': seats.length } as CSSProperties}>
        {seats.map((seat) => <img key={seat.playerId} src={campfireCharacterImagePath(seat.character)} alt="" />)}
      </div> : null}
      <div className="campfire__prompt">
      <h2><Icon name="burn" size={26} /> Campfire <small>Rest Site</small></h2>
      {alive ? <div className="campfire__player">
        <span className="campfire__name">{player.name} · {player.hp}/{player.maxHp}</span>
        <div className="campfire__choices">
          {(coffee || !restAllowed) && (hammer || upgradable.length === 0) ? <button type="button" className={decision?.choice === 'leave' ? 'is-chosen' : ''}
            onClick={() => setDecision({ choice: 'leave' })}>
            Leave <span className="muted">No campfire action available</span>
          </button> : null}
          <button type="button" disabled={coffee || !restAllowed} className={decision?.choice === 'rest' ? 'is-chosen' : ''} onClick={() => setDecision({ choice: 'rest' })}>
            <img src="/assets/noncombat/campfire/rest.webp" alt="" /><strong>Rest</strong><span className="muted">+{restHeal} HP{!restAllowed ? ' · blocked by Night Terrors' : ''}</span>
          </button>
          <button type="button" disabled={hammer || upgradable.length === 0} className={decision?.choice === 'smith' ? 'is-chosen' : ''} onClick={() => setDecision({ choice: 'smith' })}>
            <img src="/assets/noncombat/campfire/smith.webp" alt="" /><strong>Smith</strong><span className="muted">upgrade</span>
          </button>
          {rubyAvailable ? <button type="button" className={decision?.choice === 'ruby' ? 'is-chosen' : ''} onClick={() => setDecision({ choice: 'ruby' })}>
            ◆ Ruby Key <span className="muted">skip campfire</span>
          </button> : null}
        </div>
        {decision?.choice === 'rest' && peacePipe ? <div className="campfire__deck campfire__deck--remove">
          {deck.filter((card) => card.defId !== 'ascenders_bane').map((card) => <Card key={card.uid} card={card} selected={card.uid === decision.removeCardUid}
            onClick={() => setDecision({
              ...decision,
              removeCardUid: decision.removeCardUid === card.uid ? undefined : card.uid,
              transformCardUid: decision.removeCardUid !== card.uid && decision.transformCardUid === card.uid
                ? undefined : decision.transformCardUid,
            })} />)}
        </div> : null}
        {decision?.choice === 'rest' && straightRazor ? <div className="campfire__deck campfire__deck--transform">
          {deck.filter((card) => card.defId !== 'ascenders_bane' && card.uid !== decision.removeCardUid).map((card) =>
            <Card key={card.uid} card={card} selected={card.uid === decision.transformCardUid}
              onClick={() => setDecision({ ...decision,
                transformCardUid: decision.transformCardUid === card.uid ? undefined : card.uid })} />)}
        </div> : null}
        {decision?.choice === 'smith' ? (
          <div className="campfire__deck campfire__deck--smith">
            {upgradable.map((card) => (
              <Card key={card.uid} card={card} selected={card.uid === decision.cardUid} onClick={() => setDecision({ choice: 'smith', cardUid: card.uid })} />
            ))}
          </div>
        ) : null}
      </div> : <p className="campfire__spectator" role="status">Your climb has ended. You are watching the surviving party choose.</p>}
      </div>
      {alive ? <button
        type="button"
        className="campfire__leave"
        disabled={!ready}
        onClick={() => onAction({ kind: 'campfire', choices: { [player.id]: decision } })}
      >
        {decided.includes(player.id) ? 'Update choice' : 'Lock in choice'}
      </button> : null}
    </section>
  )
}
