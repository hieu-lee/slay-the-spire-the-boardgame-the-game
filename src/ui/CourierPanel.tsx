import { useEffect, useId, useRef, useState } from 'react'
import { assetPath } from '../game/assets.ts'
import { potionLimit } from '../game/acquisition.ts'
import { courierCost, type CourierOffer } from '../game/noncombat.ts'
import { potionDef, relicDef } from '../game/relics.ts'
import { mandatoryChoicePending, type CombatState } from '../game/combat.ts'
import type { Player } from '../game/types.ts'
import { ItemImage } from './ItemImage.tsx'

const hasSozu = (player: Player) => player.relics.some((relic) => relic.defId === 'sozu')

export const courierReady = (player: Player | undefined, usedBy: string[]) =>
  Boolean(player && !player.dead && !usedBy.includes(player.id) && player.relics.some((relic) => relic.defId === 'the_courier'))

export const courierPeekPhase = (combat: CombatState) =>
  (combat.phase === 'player' || combat.phase === 'start' || combat.phase === 'discard') && !mandatoryChoicePending(combat) &&
  !combat.startTurnProgress?.forcedCard && !combat.pendingDistilled && !combat.pendingRelicScry

function Gold({ value }: { value: number }) {
  return <span className="courier__gold"><img src={assetPath('icons/gold.png')} alt="" />{value}</span>
}

/* The combat bar hosts the full plaque; horizontal phones hide it and use the
   header key instead, because the stage rises into the bar on short screens. */
export function CourierPeek({ players, viewerId, usedBy, onReveal, placement, active = true }: {
  players: Player[]
  viewerId: string
  usedBy: string[]
  onReveal: (kind: CourierOffer['kind']) => void
  placement: 'bar' | 'header'
  active?: boolean
}) {
  const [menuOpen, setOpen] = useState(false)
  const open = menuOpen && active
  const rulesId = useId()
  const root = useRef<HTMLDivElement>(null)
  const choicesId = useId()
  useEffect(() => {
    if (!active) setOpen(false)
  }, [active])
  useEffect(() => {
    if (!open) return
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    // Captured and consumed so the same Escape does not also open the pause menu.
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (!root.current?.getClientRects().length) return setOpen(false)
      event.preventDefault()
      if (root.current?.contains(document.activeElement)) root.current.querySelector<HTMLElement>('.courier__toggle')?.focus()
      setOpen(false)
    }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', escape, true)
    return () => {
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('keydown', escape, true)
    }
  }, [open])
  const reveal = (kind: CourierOffer['kind']) => {
    setOpen(false)
    onReveal(kind)
  }
  if (!courierReady(players.find((player) => player.id === viewerId), usedBy)) return null
  return <div ref={root} className={`courier courier--available courier--${placement}`} role="group" aria-label="The Courier" data-open={open || undefined}
    onBlur={(event) => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setOpen(false) }}>
    {placement === 'header' ? <>
      {/* aria-disabled rather than disabled: this key goes idle every enemy turn, and a
          disabled button would drop keyboard focus to the page each time. */}
      <button type="button" className="courier__toggle" aria-disabled={!active || undefined} aria-expanded={open} aria-controls={choicesId}
        aria-label="Courier choices" aria-describedby={rulesId} onClick={() => { if (active) setOpen((current) => !current) }}>
        <img src={assetPath('relic-icons/the_courier.png')} alt="" />
      </button>
    </> : <>
      <img className="courier__mascot" src={assetPath('relic-icons/the_courier.png')} alt="" />
      <strong>The Courier</strong>
    </>}
    <div id={choicesId} className="courier__peek">
      {placement === 'header' ? <p id={rulesId} className="courier__rules">{relicDef('the_courier').text}</p> : null}
      <button type="button" aria-label="Look at Relic" onClick={() => reveal('relic')}><img src={assetPath('icons/relic.png')} alt="" />Relic</button>
      <button type="button" aria-label="Look at Potion" onClick={() => reveal('potion')}><img src={assetPath('icons/potion.png')} alt="" />Potion</button>
    </div>
  </div>
}

export function CourierPanel({ players, viewerId, ascension, offer, pledge, online = false, onResolve }: {
  players: Player[]
  viewerId: string
  ascension: number
  offer: CourierOffer | null
  pledge?: { playerId: string; id: string; discardPotionId?: string; payments: Record<string, number> }
  online?: boolean
  onResolve: (decision: 'buy' | 'discard', payments?: Record<string, number>, discardPotionId?: string) => void
}) {
  const viewer = players.find((player) => player.id === viewerId) ?? players[0]!
  const owner = players.find((player) => player.id === offer?.playerId) ?? viewer
  const offerKey = offer ? `${offer.playerId}:${offer.kind}:${offer.id}` : ''
  const [choice, setChoice] = useState({ offerKey: '', potionId: '' })
  const discardPotionId = choice.offerKey === offerKey && owner.potions.includes(choice.potionId) ? choice.potionId : ''
  const panel = useRef<HTMLElement>(null)
  const textId = useId()
  const titleId = useId()
  const shell = useRef<HTMLElement | null>(null)
  useEffect(() => {
    const root = panel.current
    const active = document.activeElement
    if (!root) {
      if (active === document.body) shell.current?.focus({ preventScroll: true })
      shell.current = null
      return
    }
    shell.current = root.closest<HTMLElement>('.app-shell')
    if (active && active !== document.body && active !== root && !active.matches('.app-shell') && !active.closest('[inert]') && !(root.contains(active) && active.matches(':disabled'))) return
    const target = root.querySelector<HTMLElement>('.courier__replace button, .courier__buy:not(:disabled)') ?? root
    target.focus({ preventScroll: true })
  })
  if (!offer) return null
  const livingPlayers = players.filter((player) => !player.dead)

  const cost = courierCost(offer)
  const funded = Object.values(pledge?.payments ?? {}).reduce((sum, amount) => sum + amount, 0)
  const remaining = Math.max(0, (cost ?? 0) - funded)
  const mine = pledge?.payments[viewer.id] ?? 0
  const contribution = viewer.dead ? 0 : online ? Math.min(Math.max(0, viewer.gold - mine), remaining) : livingPlayers.reduce((sum, player) => sum + player.gold, 0) >= remaining ? remaining : 0
  const partyCanAfford = livingPlayers.reduce((sum, player) => sum + player.gold, 0) >= remaining
  const payments = online ? { [viewer.id]: mine + contribution } : (() => {
    let left = remaining
    return Object.fromEntries(livingPlayers.map((player): [string, number] => {
      const paid = Math.min(player.gold, left)
      left -= paid
      return [player.id, paid]
    }).filter(([, paid]) => paid > 0))
  })()
  const potionBlocked = offer.kind === 'potion' && hasSozu(owner)
  const potionFull = offer.kind === 'potion' && owner.potions.length >= potionLimit(ascension, owner)
  const canFund = !viewer.dead && !potionBlocked && cost !== null && (pledge ? contribution > 0 : (!online || viewer.id === owner.id) && partyCanAfford) && (!online || viewer.id === owner.id || Boolean(pledge)) && (!potionFull || Boolean(pledge?.discardPotionId ?? discardPotionId))
  const def = offer.kind === 'relic' ? relicDef(offer.id) : potionDef(offer.id)
  const sharesCost = Boolean(pledge) || (online && contribution < remaining)
  const waiting = online && viewer.id !== owner.id && !pledge
  const action = waiting ? `Waiting for ${owner.name}` : sharesCost ? contribution > 0 || pledge ? 'Pledge' : 'Ask party' : 'Buy'
  const shownContribution = waiting ? 0 : contribution
  const notice = potionBlocked ? 'Sozu prevents gaining Potions' : cost === null ? 'Cannot be bought' : null
  return <>
    <div className="courier-backdrop" aria-hidden="true" onPointerDown={(event) => event.preventDefault()} />
    <section ref={panel} className="courier courier--offer" role="dialog" tabIndex={-1} aria-labelledby={titleId} aria-describedby={textId}>
      <h2 id={titleId} className="courier__banner"><img src={assetPath('relic-icons/the_courier.png')} alt="" />The Courier</h2>
      <div className="courier__stone">
        <div className="courier__item"><ItemImage key={offerKey} kind={offer.kind} id={offer.id} card /></div>
        <div className="courier__details">
          <h3>{def.name}</h3>
          <p id={textId} className="visually-hidden">{def.text}</p>
          {notice ? <p className="courier__notice">{notice}</p> : <div className="courier__price">
            <Gold value={cost ?? 0} />
            {funded ? <span className="courier__funding" role="meter" aria-label="Gold pledged" aria-valuemin={0} aria-valuemax={cost ?? 0} aria-valuenow={funded}>
              <span style={{ width: `${Math.min(100, funded / (cost || 1) * 100)}%` }} />
              <small>{funded}/{cost}</small>
            </span> : null}
          </div>}
          {potionFull && !potionBlocked && viewer.id === owner.id && !pledge ? <fieldset className="courier__replace" aria-label="Replace Potion">
            <legend>Replace</legend>
            {owner.potions.map((id, index) => <button type="button" key={`${id}-${index}`} title={potionDef(id).name} aria-label={potionDef(id).name}
              aria-pressed={discardPotionId === id} onClick={() => setChoice({ offerKey, potionId: discardPotionId === id ? '' : id })}><ItemImage kind="potion" id={id} /></button>)}
          </fieldset> : null}
          <div className="courier__actions">
            <button type="button" className="courier__buy" disabled={!canFund} aria-label={shownContribution ? `${action} ${contribution} Gold` : action}
              onClick={() => onResolve('buy', payments, pledge?.discardPotionId ?? (discardPotionId || undefined))}>
              {action}{shownContribution ? <Gold value={contribution} /> : null}
            </button>
            {viewer.id === owner.id ? <button type="button" className="courier__discard" onClick={() => onResolve('discard')}>Discard</button> : null}
          </div>
        </div>
      </div>
    </section>
  </>
}
