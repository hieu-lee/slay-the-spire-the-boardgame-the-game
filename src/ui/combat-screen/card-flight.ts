export const CARD_FLIGHT_MS = 1500
export const CARD_TRAVEL_START_MS = 720
export const CARD_SMOKE_MS = 900

/** Snapshot the visible pile, never the private cards inside it. */
export function cardFlightPath(destination: 'draw' | 'discard' | 'exhaust' | 'stage') {
  const x = innerWidth / 2
  const handY = innerHeight - 90
  const stageY = innerHeight * .43
  const pile = document.querySelector(`[data-pile="${destination}"]`)?.getBoundingClientRect()
  const endX = pile ? pile.left + pile.width / 2 : x
  const endY = pile ? pile.top + pile.height / 2 : stageY - 80
  const curve = `Q ${endX} ${stageY - 90} ${endX} ${endY}`
  const trailPath = `M ${x} ${stageY} ${curve}`
  const path = `M ${x} ${handY} L ${x} ${stageY} ${curve}`
  const measure = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  measure.setAttribute('d', path)
  const hold = `${Math.abs(handY - stageY) / measure.getTotalLength() * 100}%`
  measure.setAttribute('d', trailPath)
  const length = measure.getTotalLength()
  const smoke = destination === 'stage' ? [] : Array.from({ length: 32 }, (_, index) => {
    const fraction = index / 31
    const point = measure.getPointAtLength(length * fraction)
    return { x: point.x, y: point.y, delay: CARD_TRAVEL_START_MS + (CARD_FLIGHT_MS - CARD_TRAVEL_START_MS) * fraction, turn: index * 137.5 }
  })
  return { path, smoke, hold }
}
