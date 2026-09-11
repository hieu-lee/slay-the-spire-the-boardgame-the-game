import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { assetPath } from '../game/assets.ts'
import type { RelicRewardState } from '../game/noncombat.ts'
import type { Player } from '../game/types.ts'
import { useReducedEffects } from './combat-screen/hooks.ts'
import { ItemImage } from './ItemImage.tsx'

type TreasurePlayer = Pick<Player, "id" | "gold" | "relics" | "character">

type Bounds = { left: number; top: number; width: number; height: number }
type Scene = { stage: Bounds; chest: Bounds }

type Claim = { key: string; id: string; seat: number; character: string; x: number; y: number }
const colors = ['#dc8060', '#82b998', '#7abde0', '#bd98df']
export const treasurePlayerColor = (seat: number) => colors[seat % colors.length]
export const treasureHandPath = (character: string, grip = false) => assetPath(`noncombat/treasure/${grip ? 'grip' : 'hand'}-${character}.webp`)

/** Lives in the game shell so the last confirmed pickup survives leaving the room. */
export function TreasureEffects({ room, players, runId, resolved }: {
  room: RelicRewardState | null
  players: TreasurePlayer[]
  runId: string
  resolved: boolean
}) {
  const reduced = useReducedEffects()
  const previous = useRef<{ room: RelicRewardState | null; players: TreasurePlayer[]; runId: string; points: Map<string, { x: number; y: number }>; scene: Scene | null } | null>(null)
  const [claims, setClaims] = useState<Claim[]>([])
  const [departure, setDeparture] = useState<Scene | null>(null)
  useLayoutEffect(() => {
    const old = previous.current
    if (old?.room && old.runId === runId && !reduced) {
      const reward = old.room
      const additions: Claim[] = []
      // Only newly confirmed decisions animate. A reconnect starts with a fresh baseline.
      for (const [seat, playerId] of reward.playerIds.entries()) {
        if (reward.decisions[playerId] !== undefined) continue
        const player = players.find((candidate) => candidate.id === playerId)
        const before = old.players.find((candidate) => candidate.id === playerId)
        if (!player || !before) continue
        let choice = room?.decisions[playerId]
        if (!room && resolved) {
          const gained = (id: string | null | undefined) => id && (id === 'old_coin'
            ? player.gold > before.gold
            : player.relics.filter((relic) => relic.defId === id).length > before.relics.filter((relic) => relic.defId === id).length)
          choice = reward.sharedOffers
            ? reward.sharedOffers.findIndex((id, index) => !Object.values(reward.decisions).includes(index) && gained(id))
            : gained(reward.offers[playerId]) ? 'take' : undefined
        }
        const slot = typeof choice === 'number' ? String(choice) : playerId
        const id = typeof choice === 'number' ? reward.sharedOffers?.[choice] : choice === 'take' ? reward.offers[playerId] : null
        const point = old.points.get(slot)
        if (id && point) additions.push({ key: `${playerId}-${slot}`, id, seat, character: player.character, ...point })
      }
      if (additions.length) {
        setClaims((current) => [...current, ...additions])
        if (!room) setDeparture(old.scene)
      }
    }
    if ((old && old.runId !== runId) || reduced) { setClaims([]); setDeparture(null) }
    if (room) setDeparture(null)
    if (!room) {
      previous.current = { room, players, runId, points: new Map(), scene: null }
      return
    }
    const current = { room, players, runId, points: new Map<string, { x: number; y: number }>(), scene: null as Scene | null }
    const measure = () => {
      document.querySelectorAll<HTMLElement>('[data-treasure-slot]').forEach((element) => {
        const rect = element.getBoundingClientRect()
        current.points.set(element.dataset.treasureSlot!, { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 })
      })
      const stage = document.querySelector('.treasure-stage')?.getBoundingClientRect()
      const chest = document.querySelector('.treasure-chest')?.getBoundingClientRect()
      const bounds = (rect: DOMRect): Bounds => ({ left: rect.left, top: rect.top, width: rect.width, height: rect.height })
      if (stage && chest) current.scene = { stage: bounds(stage), chest: bounds(chest) }
    }
    measure()
    previous.current = current
    const observer = new MutationObserver(measure)
    const stage = document.querySelector('.treasure-stage')
    if (stage) observer.observe(stage, { childList: true, subtree: true })
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure, true) }
  }, [room, players, runId, resolved, reduced])
  useLayoutEffect(() => {
    if (!claims.length) return
    const timer = window.setTimeout(() => setClaims([]), 1500)
    return () => window.clearTimeout(timer)
  }, [claims])
  if (!claims.length) return null
  return createPortal(<div className="sts-scope treasure-claims" aria-hidden="true">
    {departure ? <div className="treasure-departure" style={departure.stage}>
      <img src={assetPath('noncombat/treasure/background.webp')} alt="" style={departure.chest} />
      <img src={assetPath('noncombat/treasure/chest-open.webp')} alt="" style={departure.chest} />
    </div> : null}
    {claims.map((claim) => <div className="treasure-claim-source" key={`source-${claim.key}`} style={{ left: claim.x, top: claim.y }}><ItemImage kind="relic" id={claim.id} /></div>)}
    {claims.map((claim) => <div key={claim.key} className={`treasure-claim treasure-claim--${claim.seat % 4}`}
      style={{ left: claim.x, top: claim.y }}
      onAnimationEnd={(event) => { if (event.target === event.currentTarget) setClaims((current) => current.filter((item) => item.key !== claim.key)) }}>
      <img className="treasure-claim__hand treasure-claim__hand--reach" src={treasureHandPath(claim.character)} alt="" />
      <img className="treasure-claim__hand treasure-claim__hand--grip" src={treasureHandPath(claim.character, true)} alt="" />
      <div className="treasure-claim__relic"><ItemImage kind="relic" id={claim.id} /></div>
    </div>)}
  </div>, document.body)
}
