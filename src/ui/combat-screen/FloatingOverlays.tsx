import { memo, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { relicIconPath } from '../../game/assets.ts'
import type { CardInstance } from '../../game/types.ts'
import { Card } from '../Card.tsx'
import { FlyingCard } from './portraits.tsx'
import { SmokeTrail } from './SmokeTrail.tsx'
import type {
  CardDrag,
  CardFlight,
  ChamberReturnFlight,
  EndTurnEffectDrag,
  SlimeCardZoom,
} from './types.ts'
import { dragArrowPath } from './useCombatDrag.ts'

export type FloatingOverlaysProps = {
  viewerCharacter: string
  stanceChangedThisTurn: boolean | undefined
  slimeCardZoom: SlimeCardZoom | null
  chamberReturnFlights: readonly ChamberReturnFlight[]
  cardDrag: CardDrag | null
  cardDragOverlay: RefObject<HTMLDivElement | null>
  cardDragArrow: RefObject<SVGPathElement | null>
  cardDragArrowShadow: RefObject<SVGPathElement | null>
  endTurnEffectDrag: EndTurnEffectDrag | null
  endTurnEffectDragOverlay: RefObject<HTMLDivElement | null>
  endTurnEffectDragArrow: RefObject<SVGPathElement | null>
  endTurnEffectDragArrowShadow: RefObject<SVGPathElement | null>
  endTurnEffectDragCard: CardInstance | undefined
  endTurnEffectDragRelicId: string | undefined
  endTurnEffectDragSlimeAsset: string | undefined
  cardFlights: readonly CardFlight[]
}

export const FloatingOverlays = memo(function FloatingOverlays({
  viewerCharacter,
  stanceChangedThisTurn,
  slimeCardZoom,
  chamberReturnFlights,
  cardDrag,
  cardDragOverlay,
  cardDragArrow,
  cardDragArrowShadow,
  endTurnEffectDrag,
  endTurnEffectDragOverlay,
  endTurnEffectDragArrow,
  endTurnEffectDragArrowShadow,
  endTurnEffectDragCard,
  endTurnEffectDragRelicId,
  endTurnEffectDragSlimeAsset,
  cardFlights,
}: FloatingOverlaysProps) {
  return (
    <>
      {slimeCardZoom ? createPortal(
        <span className="power__zoom slime-party__zoom" role="tooltip"
          style={{ left: slimeCardZoom.x, top: slimeCardZoom.y }}>
          <Card stanceChangedThisTurn={stanceChangedThisTurn} card={slimeCardZoom.card} playable={false} immediateArt />
        </span>,
        document.body,
      ) : null}
      {chamberReturnFlights.map((flight) => (
        <div key={flight.card.uid} className="chamber-return-flight" style={{
          left: flight.left,
          top: flight.top,
          width: flight.width,
          height: flight.height,
          '--chamber-return-x': `${flight.x}px`,
          '--chamber-return-y': `${flight.y}px`,
          '--chamber-return-index': flight.index,
        } as React.CSSProperties} aria-hidden="true" inert>
          <Card stanceChangedThisTurn={stanceChangedThisTurn} card={flight.card} playable={false} immediateArt />
        </div>
      ))}
      {cardDrag ? (
        <>
          {cardDrag.needsEnemy || cardDrag.needsPlayer ? (
            <svg className="card-target-arrow" aria-hidden="true">
              <defs>
                <marker id="card-target-arrowhead" markerUnits="userSpaceOnUse"
                  markerWidth="22" markerHeight="22" refX="18" refY="11" orient="auto">
                  <path d="M 0 0 L 22 11 L 0 22 Z" />
                </marker>
              </defs>
              <path ref={cardDragArrowShadow} className="card-target-arrow__shadow"
                d={dragArrowPath(cardDrag.startX, cardDrag.startY, -45, cardDrag.x, cardDrag.y)} />
              <path ref={cardDragArrow} className="card-target-arrow__line"
                d={dragArrowPath(cardDrag.startX, cardDrag.startY, -45, cardDrag.x, cardDrag.y)} />
            </svg>
          ) : null}
          <div ref={cardDragOverlay} className="card-drag" style={{
            left: cardDrag.startX,
            top: cardDrag.startY - 90,
            '--drag-y': `${Math.max(0, cardDrag.y - cardDrag.startY + 210)}px`,
            '--drag-turn': `${Math.max(-8, Math.min(8, (cardDrag.x - cardDrag.startX) / 24))}deg`,
          } as React.CSSProperties} aria-hidden="true" inert>
            <Card stanceChangedThisTurn={stanceChangedThisTurn} card={cardDrag.card} playable={false} immediateArt />
          </div>
        </>
      ) : null}
      {endTurnEffectDrag ? (
        <>
          <svg className="card-target-arrow end-turn-target-arrow" aria-hidden="true">
            <defs>
              <marker id="end-turn-target-arrowhead" markerUnits="userSpaceOnUse"
                markerWidth="22" markerHeight="22" refX="18" refY="11" orient="auto">
                <path d="M 0 0 L 22 11 L 0 22 Z" />
              </marker>
            </defs>
            <path ref={endTurnEffectDragArrowShadow} className="card-target-arrow__shadow"
              d={dragArrowPath(
                endTurnEffectDrag.startX,
                endTurnEffectDrag.startY,
                endTurnEffectDrag.y < endTurnEffectDrag.startY ? -28 : 28,
                endTurnEffectDrag.x,
                endTurnEffectDrag.y,
              )} />
            <path ref={endTurnEffectDragArrow} className="card-target-arrow__line end-turn-target-arrow__line"
              d={dragArrowPath(
                endTurnEffectDrag.startX,
                endTurnEffectDrag.startY,
                endTurnEffectDrag.y < endTurnEffectDrag.startY ? -28 : 28,
                endTurnEffectDrag.x,
                endTurnEffectDrag.y,
              )} />
          </svg>
          <div ref={endTurnEffectDragOverlay}
            className={endTurnEffectDragCard ? 'end-turn-effect-drag end-turn-effect-drag--card' : 'end-turn-effect-drag'}
            style={{ left: endTurnEffectDrag.startX, top: endTurnEffectDrag.startY } as React.CSSProperties}
            aria-hidden="true" inert>
            {endTurnEffectDragCard ? <Card stanceChangedThisTurn={stanceChangedThisTurn} card={endTurnEffectDragCard} playable={false} immediateArt />
              : endTurnEffectDragRelicId ? (
                <img className="item-icon-image" src={relicIconPath(endTurnEffectDragRelicId)} alt="" />
              )
              : endTurnEffectDragSlimeAsset ? (
                <img className="end-turn-effect__slime" src={endTurnEffectDragSlimeAsset} alt="" />
              ) : (
              <span className={`token--orb token--orb-${endTurnEffectDrag.sourceOrb ?? (endTurnEffectDrag.ability.visual?.kind === 'orb'
                ? endTurnEffectDrag.ability.visual.orb
                : 'lightning')}`} />
            )}
          </div>
        </>
      ) : null}
      {cardFlights.map((flight) => (
        <div key={flight.beat} className={`card-flight-effect card-flight--${viewerCharacter}`} aria-hidden="true" inert>
          {flight.destination !== 'stage' ? <SmokeTrail path={flight.trailPath} bounds={flight.trailBounds} /> : null}
          {!flight.landed ? <FlyingCard flight={flight} character={viewerCharacter} /> : null}
        </div>
      ))}
    </>
  )
})
