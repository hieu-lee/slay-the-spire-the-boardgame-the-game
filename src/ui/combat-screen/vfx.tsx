// The visual effect a play puts on the board.
//
// An authoritative presentation event says who acted, on whom, and with what;
// this turns that into the overlay both the actor and the target render, and
// works out when a weapon is supposed to make contact.
import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal, flushSync } from 'react-dom'
import { assetPath } from '../../game/assets.ts'
import { combatBodyPoint } from '../combat-geometry.ts'
import { combatArtReady, combatArtSize, onCombatArtReady, type CombatArtElement } from '../CombatAnimation.tsx'
import type { ActiveCombatVfx } from './types.ts'
import { cardDef } from '../../game/cards.ts'
import type { CombatPresentationEvent, CombatState } from '../../game/combat.ts'
import { cardVfxRecipe, shivVfxRecipe, vfxAssetPath, vfxToneColor } from '../combat-vfx.ts'

const OFFENSIVE_VFX_FAMILIES = new Set([
  'slash', 'blunt', 'projectile', 'shiv', 'lightning', 'frost', 'dark',
])

/**
 * How far apart consecutive end-of-turn orb reveals land, in ms.
 *
 * The engine resolves every ordered orb before the client sees any of it, so
 * two or three orbs can arrive in the SAME state update — with nothing here,
 * they would all flash on the same frame, one burst standing in for however
 * many orbs actually fired. `usePresentationEvents` extends each such event's
 * lifetime by this much per sibling ahead of it in the same arrival batch, and
 * CombatScreen delays its reveal by the same amount, so they read as separate
 * beats — zap, pause, zap — rather than one.
 */
export const DEFECT_EVOKE_CONTACT_MS = 240
export const ORB_END_TURN_STAGGER_MS = 380
export const SLIME_COMMAND_ANIMATION_MS = 1_700
export const SLIME_COMMAND_CONTACT_MS = 850
export const SLIME_SPAWN_ANIMATION_MS = 1_550
export const SLIME_SPAWN_CONTACT_MS = 800
export const COMBAT_OUTCOME_DELAY_MS = 2_500
export const COMBAT_OUTCOME_SOUND_DELAY_MS = 2_400

export const isEndTurnLightning = (event: CombatPresentationEvent): boolean =>
  event.kind === 'orb' && event.orb === 'lightning' && event.sourceId === 'orb-end-turn'

export const combatOutcomeAnimationActive = (): boolean => Boolean(document.querySelector(
  '.slime-party__actor--commanding, .character-attack--slime_boss',
))

export const isCharacterAttack = ({ event, recipe }: ActiveCombatVfx): boolean =>
  event.kind !== 'potion' && event.kind !== 'orb' && event.kind !== 'slime' && event.enemyIds.length > 0 &&
  (event.kind === 'shiv' ||
    event.kind === 'card' && cardDef(event.sourceId).cardKind !== 'slime' &&
      ((event.resolvedType ?? cardDef(event.sourceId).type) === 'attack' ||
        OFFENSIVE_VFX_FAMILIES.has(recipe.family)))

export function isHermitAttack(state: CombatState, event?: CombatPresentationEvent): boolean {
  if (!event || (event.kind !== 'card' && event.kind !== 'shiv') ||
    !state.players.some(p => p.id === event.actorId && p.character === 'hermit')) return false
  return isCharacterAttack({ event, recipe: event.kind === 'shiv' ? shivVfxRecipe()
    : cardVfxRecipe('hermit', event.sourceId, event.kind === 'card' ? event.mode : undefined,
      event.kind === 'card' ? event.upgraded : undefined, event.kind === 'card' ? event.resolvedType : undefined) })
}

export function characterAttackContactMs(
  state: CombatState,
  targetId: string,
  event?: CombatPresentationEvent,
): number {
  if (event?.kind === 'orb' && event.sourceId === 'orb-evoke' && event.orb !== 'frost' &&
    event.enemyIds.includes(targetId) && state.players.some(p=>p.id===event.actorId&&p.character==='defect')) {
    return DEFECT_EVOKE_CONTACT_MS
  }
  if (!event || event.kind === 'potion' || event.kind === 'orb' || event.kind === 'turn' ||
    !event.enemyIds.includes(targetId)) return 0
  if (event.kind === 'slime') return SLIME_COMMAND_CONTACT_MS + event.animationIndex * SLIME_COMMAND_ANIMATION_MS
  const actor = state.players.find((player) => player.id === event.actorId)
  if (!actor) return 0
  const active = {
    event,
    recipe: event.kind === 'shiv'
      ? shivVfxRecipe()
      : cardVfxRecipe(actor.character, event.sourceId, event.mode, event.upgraded, event.resolvedType),
  }
  if (!isCharacterAttack(active)) return 0
  const targetIndex = Math.max(0, event.enemyIds.indexOf(targetId))
  if (actor.character === 'hermit') return HERMIT_VOLLEYS[0].ms + HERMIT_FLIGHT_MS
  if (actor.character === 'silent') return 1_025 + targetIndex * 70
  if (actor.character === 'defect') return 1_110 + targetIndex * 70
  if (actor.character === 'watcher') return 1_050 + targetIndex * 70
  if (actor.character === 'hexaghost') return 1_450 + targetIndex * 70
  if (actor.character === 'slime_boss') return SLIME_COMMAND_CONTACT_MS + targetIndex * 70
  return 630
}

export function latestTargetPresentationEvent(
  events: readonly CombatPresentationEvent[] | undefined,
  targetId: string,
): CombatPresentationEvent | undefined {
  for (let index = (events?.length ?? 0) - 1; index >= 0; index--) {
    const event = events![index]!
    if (event.enemyIds.includes(targetId) || event.playerIds.includes(targetId)) return event
  }
  return undefined
}

export function CombatVfx({
  active,
  role,
  attackContactMs = 0,
  revealDelayMs = 0,
  targetEnemyId,
}: {
  active: ActiveCombatVfx
  role: 'actor' | 'target'
  attackContactMs?: number
  /** Staggers this event's own reveal behind an earlier one in the same
   * state update — see CombatScreen's `orbEndTurnRevealDelayMs`. */
  revealDelayMs?: number
  targetEnemyId?: string
}) {
  const { event, recipe } = active
  const lightningStrike = role === 'target' && isEndTurnLightning(event)
  const image = lightningStrike
    ? assetPath('combat/vfx/actions/turn-lightning-strike.webp')
    : vfxAssetPath(recipe)
  const imageUrl = new URL(image, window.location.href).href
  const anchor = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const source = anchor.current
    const combat = source?.closest<HTMLElement>('.combat')
    const portrait = lightningStrike && targetEnemyId
      ? combat?.querySelector<HTMLElement>(`.enemy[data-enemy-id="${CSS.escape(targetEnemyId)}"] .enemy__portrait`)
      : source?.closest<HTMLElement>('.seat__portrait, .enemy__portrait')
    if (!source || !portrait || role !== 'target') return
    const art = portrait.querySelector<CombatArtElement>(':scope > :is(img, video)')
    const measure = () => {
      const rect = portrait.getBoundingClientRect()
      if (lightningStrike && combat) {
        const combatRect = combat.getBoundingClientRect()
        const enemyRect = portrait.closest<HTMLElement>('.enemy')!.getBoundingClientRect()
        // Span the combat scene while keeping the baked ground contact on the
        // target's resting feet, independent of its death transform.
        const ground = enemyRect.top + portrait.offsetTop + portrait.offsetHeight - combatRect.top
        const center = enemyRect.left + portrait.offsetLeft + portrait.offsetWidth / 2 - combatRect.left
        source.style.setProperty('--lightning-center-x', `${center}px`)
        source.style.setProperty('--lightning-ground-y', `${ground}px`)
        source.style.setProperty('--lightning-height', `${ground / .94}px`)
      } else {
        const body = combatBodyPoint(portrait)
        source.style.setProperty('--vfx-center-x', `${body.x - rect.left}px`)
        source.style.setProperty('--vfx-center-y', `${body.y - rect.top}px`)
      }
    }
    measure()
    const removeReady = art ? onCombatArtReady(art, measure) : () => undefined
    portrait.addEventListener('load', measure, true)
    portrait.addEventListener('loadeddata', measure, true)
    const resize = new ResizeObserver(measure)
    resize.observe(portrait)
    if (lightningStrike && combat) resize.observe(combat)
    if (lightningStrike) combat?.addEventListener('scroll', measure, { capture: true, passive: true })
    return () => {
      resize.disconnect()
      removeReady()
      portrait.removeEventListener('load', measure, true)
      portrait.removeEventListener('loadeddata', measure, true)
      if (lightningStrike) combat?.removeEventListener('scroll', measure, true)
    }
  }, [event.seq, role, lightningStrike, targetEnemyId])

  return (
    <span
      ref={anchor}
      className={[
        'combat-vfx', `combat-vfx--${role}`, `combat-vfx--${recipe.family}`,
        role === 'target' && attackContactMs > 0 ? 'combat-vfx--attack-impact' : '',
      ].filter(Boolean).join(' ')}
      data-vfx-seq={event.seq}
      data-vfx-kind={event.kind}
      data-vfx-source={event.sourceId}
      data-vfx-family={recipe.family}
      data-vfx-motion={recipe.actorMotion}
      data-vfx-asset={recipe.asset}
      data-vfx-tone={recipe.tone}
      data-vfx-target={targetEnemyId}
      data-lightning-strike={lightningStrike || undefined}
      style={{
        '--vfx-image': `url("${imageUrl}")`,
        '--vfx-tone-color': vfxToneColor(recipe.tone),
        ...(attackContactMs > 0 ? { '--attack-impact-delay': `${attackContactMs}ms` } : {}),
        ...(revealDelayMs > 0 ? { '--vfx-reveal-delay': `${revealDelayMs}ms` } : {}),
      } as React.CSSProperties}
      aria-hidden="true"
    />
  )
}

/** Evokes use their authoritative target list, independent of the card's normal attack. */
export function DefectEvokeVfx({ event }: { event: Extract<CombatPresentationEvent, { kind: 'orb' }> }) {
  const anchor = useRef<HTMLSpanElement>(null)
  const [beams, setBeams] = useState<{ id: string; length: number; angle: number }[]>([])
  const targets = event.enemyIds.join('|')
  useLayoutEffect(() => {
    const source = anchor.current
    const board = source?.closest('.board')
    const portrait = source?.closest<HTMLElement>('.seat__portrait')
    if (!source || !board || !portrait) return
    const measure = () => {
      // Finishing an attack replaces the keyed idle image while evokes can
      // still be playing. Never measure the detached image from an earlier render.
      const art = portrait.querySelector<CombatArtElement>(':scope > :is(img, video)')
      if (!art || !combatArtReady(art)) return
      const { width: naturalWidth, height: naturalHeight } = combatArtSize(art)
      const image = art.getBoundingClientRect()
      const parent = portrait.getBoundingClientRect()
      const fit = Math.min(image.width / naturalWidth, image.height / naturalHeight)
      // Mouth registration in the 400 x 266 idle rig, including its transparent
      // overscan. The rendered image rect already includes the character scale.
      const body = combatBodyPoint(portrait)
      const sourceScale = naturalWidth / 400
      source.style.left = `${(event.orb === 'frost' ? body.x : image.left + (image.width - naturalWidth * fit) / 2 + 222 * sourceScale * fit) - parent.left}px`
      source.style.top = `${(event.orb === 'frost' ? body.y : image.bottom - (naturalHeight - 89 * sourceScale) * fit) - parent.top}px`
      if (event.orb === 'frost') return
      const origin = source.getBoundingClientRect()
      setBeams(event.enemyIds.flatMap(id => {
        const target = board.querySelector<HTMLElement>(`.enemy[data-enemy-id="${CSS.escape(id)}"] .enemy__portrait`)
        if (!target) return []
        const body = combatBodyPoint(target)
        const dx = body.x - origin.left
        const dy = body.y - origin.top
        return [{ id, length: Math.hypot(dx, dy), angle: Math.atan2(dy, dx) * 180 / Math.PI }]
      }))
    }
    measure()
    board.addEventListener('load', measure, true)
    board.addEventListener('loadeddata', measure, true)
    const resize = new ResizeObserver(measure)
    resize.observe(board)
    resize.observe(portrait)
    return () => {
      resize.disconnect()
      board.removeEventListener('load', measure, true)
      board.removeEventListener('loadeddata', measure, true)
    }
  }, [event.seq, event.orb, targets])
  return <span ref={anchor} className={`defect-evoke defect-evoke--${event.orb}`}
    data-evoke-seq={event.seq} aria-hidden="true">
    {event.orb === 'frost' ? <img className="defect-evoke__frost"
      src={assetPath('combat/vfx/actions/turn-frost-passive-impact.webp')} alt="" /> : beams.map(beam => (
      <span className="defect-evoke__ray" data-evoke-target={beam.id} key={beam.id}
        style={{ '--beam-length': `${beam.length}px`, '--beam-angle': `${beam.angle}deg` } as CSSProperties}>
        <svg viewBox="0 0 1000 40" preserveAspectRatio="none" className="defect-evoke__beam">
          {event.orb === 'lightning' ? <>
            <path className="defect-evoke__glow" d="M0 20 L110 15 180 25 270 8 330 28 455 14 510 31 640 9 730 26 850 14 920 23 1000 20" />
            <path d="M0 20 L110 15 180 25 270 8 330 28 455 14 510 31 640 9 730 26 850 14 920 23 1000 20" />
            <path className="defect-evoke__fork" d="M200 21 L315 34 450 26 M610 15 L710 4 820 13" />
          </> : <>
            <path className="defect-evoke__glow" d="M0 20 Q250 10 500 20 T1000 20" />
            <path d="M0 20 Q250 10 500 20 T1000 20" />
            <path className="defect-evoke__fork" d="M0 20 Q250 36 500 20 T1000 20" />
          </>}
        </svg>
      </span>
    ))}
  </span>
}

// Flash onsets and barrel tips in the canonical 400x400 Hermit rig.
// Keep in sync with drawn.py's poses 8, 10, 12, 14, 16 (including its sway).
export const HERMIT_VOLLEYS = [
  { ms: 611, muzzles: [[328, 218], [272, 253]] },
  { ms: 733, muzzles: [[337, 218], [275, 246]] },
  { ms: 856, muzzles: [[295, 218], [226, 246]] },
  { ms: 978, muzzles: [[303, 218], [226, 244]] },
  { ms: 1100, muzzles: [[313, 218], [243, 244]] },
] as const
export const HERMIT_ATTACK_MS = 1_650
export const HERMIT_FLIGHT_MS = 180
// Both barrels arrive together: one impact and damage step per volley/target.
export const HERMIT_IMPACT_COUNT = HERMIT_VOLLEYS.length

/** Mounted with the decoded one-shot pose, so every flash shares its clock. */
export function HermitBullets({ event }: { event: CombatPresentationEvent }) {
  const anchor = useRef<HTMLSpanElement>(null)
  const [shots, setShots] = useState<{ id: string; volley: string; impact: boolean; ms: number; x: number; y: number; dx: number; dy: number; target: HTMLElement; impactX: number; impactY: number }[]>([])
  useLayoutEffect(() => {
    const source = anchor.current
    const pose = source?.parentElement
    const art = pose?.querySelector<CombatArtElement>(':scope > :is(img, video)')
    const board = source?.closest('.board')
    if (!source || !pose || !art || !board) return
    const measure = () => {
      const rect = art.getBoundingClientRect()
      const parent = source.getBoundingClientRect()
      const { width: naturalWidth, height: naturalHeight } = combatArtSize(art)
      const fit = Math.min(rect.width / naturalWidth, rect.height / naturalHeight)
      if (!Number.isFinite(fit)) return
      const sourceScale = naturalWidth / 400
      setShots(HERMIT_VOLLEYS.flatMap((volley, i) => volley.muzzles.flatMap(([mx, my], gun) => {
        const x = rect.left + (rect.width - naturalWidth * fit) / 2 + mx * sourceScale * fit
        const y = rect.bottom - (naturalHeight - my * sourceScale) * fit
        return event.enemyIds.flatMap(id => {
          const target = board.querySelector<HTMLElement>(`.enemy[data-enemy-id="${CSS.escape(id)}"] .enemy__portrait`)
          if (!target) return []
          const body = combatBodyPoint(target)
          return [{ id: `${i}-${gun}-${id}`, volley: `${i}-${id}`, impact: gun === 0, ms: volley.ms, x: x - parent.left, y: y - parent.top,
            dx: body.x - x, dy: body.y - y, target,
            impactX: body.x - target.getBoundingClientRect().left, impactY: body.y - target.getBoundingClientRect().top }]
        })
      })))
    }
    measure()
    const resize = new ResizeObserver(measure)
    resize.observe(board)
    resize.observe(pose)
    const onLoad = ({ target }: Event) => {
      if (target instanceof HTMLElement && target.classList.contains('enemy__art--cutout')) measure()
    }
    board.addEventListener('load', onLoad, true)
    board.addEventListener('loadeddata', onLoad, true)
    return () => {
      resize.disconnect()
      board.removeEventListener('load', onLoad, true)
      board.removeEventListener('loadeddata', onLoad, true)
    }
  }, [event])
  return <span ref={anchor} className="hermit-shots" aria-hidden="true" data-hermit-seq={event.seq}>
    {shots.map(shot => <span key={shot.id} className="hermit-shot" data-shot={shot.id} data-volley={shot.volley}
      style={{ left: shot.x, top: shot.y, '--shot-dx': `${shot.dx}px`, '--shot-dy': `${shot.dy}px`,
        '--shot-angle': `${Math.atan2(shot.dy, shot.dx)}rad`, '--shot-delay': `${shot.ms}ms`,
        '--shot-flight': `${HERMIT_FLIGHT_MS}ms` } as CSSProperties}>
      <span className="hermit-shot__flight"><span className="hermit-shot__bullet">
        <img src={assetPath('combat/vfx/actions/hermit-bullet.webp')} alt="" />
      </span></span>
      {shot.impact && createPortal(<span className="hermit-shot__impact" data-hermit-impact-seq={event.seq} data-shot={shot.id} data-volley={shot.volley}
        onAnimationStart={animation => {
          if (animation.animationName !== 'hermit-bullet-impact') return
          // Animation events are not discrete React input: commit HP before this impact paints.
          flushSync(() => shot.target.dispatchEvent(new CustomEvent('hermit-impact', { bubbles: true,
            detail: { seq: event.seq, shot: shot.id, x: shot.impactX, y: shot.impactY } })))
        }}
        style={{ left: shot.impactX, top: shot.impactY, '--shot-delay': `${shot.ms}ms`,
          '--shot-flight': `${HERMIT_FLIGHT_MS}ms`,
          backgroundImage: `url("${assetPath('combat/vfx/actions/hermit-impact.webp')}")` } as CSSProperties}
        aria-hidden="true" />, shot.target)}
    </span>)}
  </span>
}
