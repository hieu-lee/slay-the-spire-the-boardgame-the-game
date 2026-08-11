import { useEffect, useRef, useState } from 'react'
import type React from 'react'
import { createPortal } from 'react-dom'
import { cardDef, faceOf } from '../game/cards.ts'
import type { Amount, CardDef } from '../game/cards.ts'
import { cardImagePath } from '../game/assets.ts'
import type { CardInstance } from '../game/types.ts'

type PowerRowProps = { powers: CardInstance[] }

/** The enlarged card: which one, and where to put it. */
type Zoom = { uid: string; src: string; x: number; y: number; pinned: boolean }

const ZOOM_WIDTH = 190
const ZOOM_HEIGHT = ZOOM_WIDTH * (4 / 3)
const MARGIN = 8

/**
 * Powers in play, as the miniature face-up cards they physically are.
 *
 * p.12: a Power is "placed face up in front of you". Everything else on the
 * board is a symbol or a piece of art, so a Power rendered as its own name in a
 * text pill was the one status that read like a web page rather than a table.
 * The scan carries its own rules text, so enlarging it beats printing a second
 * copy of that text in prose beside it.
 */
/**
 * Only one enlarged card exists at a time, across every seat on the board.
 *
 * Each row used to own its own pin, so a four-player board could hold four
 * 190x253 cards open at once, stacked over each other — and click-away never
 * closed them, because it matched ANY row's `.powers` rather than the one that
 * opened it. A module-level owner is the smallest thing that makes "one open
 * card" true no matter how many rows are on screen.
 */
const closers = new Set<() => void>()
/**
 * Whether the open card is PINNED, at module level.
 *
 * A row can only see its own state, so another row read `zoom === null`, put
 * its hover card up, and destroyed a pin it had no idea existed. The pin has
 * to be visible to every row, not just the one holding it.
 */
let pinnedBy: (() => void) | null = null

function zoomIsPinnedElsewhere(close: () => void): boolean {
  return pinnedBy !== null && pinnedBy !== close
}

function claimTheOnlyZoom(close: () => void, pinned: boolean) {
  for (const other of closers) if (other !== close) other()
  pinnedBy = pinned ? close : null
}

function releaseZoom(close: () => void) {
  if (pinnedBy === close) pinnedBy = null
}

export function PowerRow({ powers }: PowerRowProps) {
  const [zoom, setZoom] = useState<Zoom | null>(null)
  // The SAME function object that is registered below, so this row can ask the
  // others to close without also closing itself.
  const close = useRef(() => setZoom(null))

  useEffect(() => {
    const mine = close.current
    closers.add(mine)
    return () => {
      closers.delete(mine)
      releaseZoom(mine)
    }
  }, [])

  // A pinned card must not outlive the Power that opened it.
  useEffect(() => {
    if (zoom && !powers.some((card) => card.uid === zoom.uid)) setZoom(null)
  }, [powers, zoom])

  // While a card is pinned, Escape has to work from anywhere and the card must
  // not sit at coordinates measured against a window that has since changed
  // size. A listener on the tile could not do either: once Tab moved focus off
  // the row, the only way out was a mouse click on the same 34x22 tile.
  useEffect(() => {
    if (!zoom?.pinned) return undefined
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === 'Escape') drop()
    }
    const drop = () => {
      releaseZoom(close.current)
      setZoom(null)
    }
    // Clicking anywhere else puts the card down, the way it would at a table.
    // Without this it floated over the board while you played your turn.
    const clickAway = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null
      if (!target?.closest('.powers')) drop()
    }
    document.addEventListener('keydown', dismiss)
    document.addEventListener('pointerdown', clickAway)
    window.addEventListener('resize', drop)
    // Scrolling too: the card is positioned against the tile's coordinates at
    // the moment it opened, so scrolling the board leaves it floating over an
    // unrelated row. Captured, because the board scrolls, not the window.
    document.addEventListener('scroll', drop, true)
    return () => {
      document.removeEventListener('keydown', dismiss)
      document.removeEventListener('pointerdown', clickAway)
      window.removeEventListener('resize', drop)
      document.removeEventListener('scroll', drop, true)
    }
  }, [zoom?.pinned])

  if (powers.length === 0) return null

  /**
   * Places the enlarged card next to its tile, clamped to the viewport.
   *
   * Computed here rather than in CSS because the card is rendered into
   * `document.body`. `position: fixed` alone does NOT reliably escape the
   * board's scroll container, and at smaller viewports half the card was
   * being cut off at the board's edge.
   */
  function place(target: HTMLElement, card: CardInstance, pinned: boolean) {
    const tile = target.getBoundingClientRect()
    const def = faceOf(cardDef(card.defId), card.upgraded)
    const x = Math.min(Math.max(MARGIN, tile.left), window.innerWidth - ZOOM_WIDTH - MARGIN)
    // Prefer above the tile, the way a card held up over the table reads; drop
    // below when there is no room above.
    const above = tile.top - ZOOM_HEIGHT - MARGIN
    const below = tile.bottom + MARGIN
    const y =
      above >= MARGIN
        ? above
        : Math.max(MARGIN, Math.min(below, window.innerHeight - ZOOM_HEIGHT - MARGIN))
    // Whoever opens one closes everybody else's — unless somebody else has
    // deliberately pinned theirs, which a passing hover must not destroy.
    if (!pinned && zoomIsPinnedElsewhere(close.current)) return
    claimTheOnlyZoom(close.current, pinned)
    setZoom({ uid: card.uid, src: cardImagePath(def, card.upgraded), x, y, pinned })
  }

  return (
    <>
      <ul className="powers" aria-label="Powers in play">
        {powers.map((card) => {
          const def = faceOf(cardDef(card.defId), card.upgraded)
          const countdown = def.effects.find((effect) => effect.kind === 'countdownDamage')
          const buffer = def.effects.find((effect) => effect.kind === 'preventHpLoss')
          const counterLimit = countdown?.cubes ?? (buffer?.kind === 'preventHpLoss' && buffer.uses > 1
            ? buffer.uses
            : undefined)
          const described = `${describePower(def)}${counterLimit ? `, ${card.counter ?? 0} of ${counterLimit} cubes` : ''}`
          const showing = zoom?.uid === card.uid
          return (
            <li key={card.uid}>
              {/* A button, not a bare tile: hover alone is unreachable on a
                  touch screen and by keyboard, which left a player with four
                  unidentifiable 34x22 blobs and no way to ask what they do. */}
              <button
                type="button"
                className={['power', showing ? 'power--open' : ''].filter(Boolean).join(' ')}
                aria-expanded={showing}
                aria-label={described}
                // A pinned card belongs to the player, not to the pointer:
                // drifting across a neighbour used to silently destroy the pin.
                onMouseEnter={(event) => {
                  if (!zoom?.pinned) place(event.currentTarget, card, false)
                }}
                onFocus={(event) => {
                  if (!zoom?.pinned) place(event.currentTarget, card, false)
                }}
                onMouseLeave={() => setZoom((current) => (current?.pinned ? current : null))}
                onBlur={() => setZoom((current) => (current?.pinned ? current : null))}
                onClick={(event: React.MouseEvent<HTMLButtonElement>) => {
                  if (showing && zoom?.pinned) {
                    releaseZoom(close.current)
                    setZoom(null)
                  } else {
                    place(event.currentTarget, card, true)
                  }
                }}
              >
                <img
                  className="power__art"
                  src={cardImagePath(def, card.upgraded)}
                  alt=""
                  loading="lazy"
                  onError={(event) => {
                    // Missing scan: fall back to the name rather than a broken
                    // image, the same way Card does.
                    event.currentTarget.style.display = 'none'
                  }}
                />
                <span className="power__fallback" aria-hidden="true">
                  {def.name}
                </span>
                {counterLimit ? (
                  <span className="power__counter" aria-hidden="true">◆{card.counter ?? 0}/{counterLimit}</span>
                ) : null}
              </button>
            </li>
          )
        })}
      </ul>

      {/* Into the body, so nothing on the board can clip it. */}
      {zoom
        ? createPortal(
            <img
              className="power__zoom"
              src={zoom.src}
              alt=""
              aria-hidden="true"
              style={{ left: `${Math.round(zoom.x)}px`, top: `${Math.round(zoom.y)}px` }}
            />,
            document.body,
          )
        : null}
    </>
  )
}

/** "Metallicize: 1 Block at the end of each turn" — name, effect, and when. */
export function describePower(def: CardDef): string {
  if (def.corruptSkills) return `${def.name}: your Skills cost 0 and Exhaust when played`
  if (def.retainBlock) return `${def.name}: keep leftover Block at the start of your turn, maximum 20`
  const when = def.trigger?.kind === 'onPlayCard' && def.trigger.cardType
    ? `whenever you play a ${def.trigger.cardType} card`
    : def.trigger?.kind === 'onDraw' && (def.trigger.cardType || def.trigger.cardTypes)
      ? `whenever you draw a ${def.trigger.cardType ?? def.trigger.cardTypes!.join(' or ')} card`
    : def.trigger ? WHEN[def.trigger.kind] : undefined
  const effectOwnsScope = def.effects.some((effect) => effect.kind === 'countdownDamage')
  const where = effectOwnsScope ? '' : def.target === 'allEnemies'
    ? ' to every enemy'
    : def.target === 'row' ? ' to one enemy row and any boss'
    : def.target === 'enemy' ? ' to one enemy' : ''
  const effects = def.effects.map(describeEffect).filter(Boolean).join(', ')
  if (!effects) return def.name
  const what = `${effects}${where}`
  if (def.activeAbility) return `${def.name}: ${what}, activate once per turn`
  return when
    ? `${def.name}: ${what} ${when}${def.oncePerTurn ? ', once per turn' : ''}`
    : `${def.name}: ${what}`
}

const WHEN: Record<string, string> = {
  startOfCombat: 'at the start of combat',
  startOfTurn: 'at the start of each turn',
  endOfTurn: 'at the end of each turn',
  endOfCombat: 'at the end of combat',
  dieRelic: 'on the matching die roll',
  onPlayCard: 'whenever you play a card',
  onDiscard: 'whenever a card effect makes you discard one or more cards',
  onExhaust: 'whenever you exhaust a card',
  onDraw: 'whenever you draw a card',
  onEnterStance: 'whenever you enter a stance',
  onScry: 'whenever you scry',
  onGainBlock: 'whenever you gain Block',
  onApplyPoison: 'when you put Poison on an enemy',
  onPutEnemyToken: 'whenever you put a token on an enemy',
  onShuffle: 'whenever you shuffle',
}

/**
 * A printed number, or a description of the one the board works out.
 *
 * `hit` and `block` amounts are no longer plain numbers, and a template literal
 * accepts an object without complaint — so the compiler stopped being able to
 * catch this and the row would have read "[object Object] Block". No Power
 * carries a computed amount today; this is here so that the first one to do so
 * reads as something rather than as a bug.
 */
function amountLabel(amount: Amount): string {
  if (typeof amount === 'number') return String(amount)
  const parts = [String(amount.base)]
  if (amount.per) parts.push(`per ${amount.per}`)
  if (amount.bonus) parts.push(`+${amount.bonus.plus} conditional`)
  if (amount.targetTokens) parts.push(`per target ${amount.targetTokens.join(' and ')}`)
  return parts.join(' ')
}

function describeEffect(effect: CardDef['effects'][number]): string {
  switch (effect.kind) {
    case 'block':
      return `${amountLabel(effect.amount)} Block`
    case 'gainStrength':
      return `${effect.amount} Strength`
    case 'draw':
      return `draw ${effect.amount}`
    case 'damage':
      return `${effect.amount} damage${effect.when?.kind === 'handEmpty' ? ' if your hand is empty' : ''}`
    case 'hit':
      return `${amountLabel(effect.amount)} damage`
    case 'gainEnergy':
      return `${effect.amount} Energy`
    case 'channel':
      return `channel ${effect.amount} ${effect.orb} Orb${effect.amount === 1 ? '' : 's'}`
    case 'gainShiv':
      return `${effect.amount} Shiv${effect.amount === 1 ? '' : 's'}`
    case 'gainOrbSlots':
      return `gain ${effect.amount} Orb slots`
    case 'gainOrbEvokeBonus':
      return `Orb Evoke effects get +${effect.amount}`
    case 'gainDarkOrbEvokeBonus':
      return `Dark Orb Evoke effects get +${effect.amount}`
    case 'gainOrbEndTurnBonus':
      return `Orb end-of-turn effects get +${effect.amount}`
    case 'gainLightningEndTurnBonus':
      return `Lightning Orb end-of-turn effects get +${effect.amount}`
    case 'lightningTargetsRow':
      return 'Lightning damages every enemy in a chosen row, plus the boss'
    case 'triggerOrbEndTurn':
      return `trigger 1 Orb's end-of-turn ability ${effect.amount === 1 ? 'once' : `${effect.amount} times`}`
    case 'gainWrathAttackDamageBonus':
      return `Attacks deal +${effect.amount} damage while in Wrath`
    case 'gainShivDamageBonus':
      return `Shivs deal +${effect.amount} damage`
    case 'gainCardBlockBonus':
      return `Attack and Skill Block gets +${effect.amount}`
    case 'gainHitPoison':
      return `hits apply ${effect.amount} Poison`
    case 'upgradeStarterCards':
      return `starter Strikes deal +${effect.amount} damage and starter Defends gain +${effect.amount} Block`
    case 'countdownDamage':
      return `place a cube; at ${effect.cubes} cubes deal ${effect.damage} damage to every enemy, then Exhaust this Power`
    case 'preventHpLoss':
      return effect.uses === 1
        ? 'prevent the next HP loss, then Exhaust this Power'
        : `prevent the next ${effect.uses} HP losses, then Exhaust this Power`
    case 'doubleNextAttackOrSkill':
      return 'your next Attack or Skill this turn is played twice, with separate choices and modifiers'
    case 'drawAndPlayFree':
      return 'draw 1 card, immediately play it for 0 Energy; if it cannot be played, discard it'
    case 'heal':
      return `heal ${effect.amount}`
    case 'poison':
      return `${effect.amount} Poison`
    case 'applyWeak':
      return `${effect.amount} Weak`
    case 'applyVulnerable':
      return `${effect.amount} Vulnerable`
    default:
      // Deliberately silent: a Power whose effect has no phrase yet is better
      // described by name alone than by a made-up one.
      return ''
  }
}
