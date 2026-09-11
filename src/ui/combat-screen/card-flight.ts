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
  return { path, trailPath, hold: `${Math.abs(handY - stageY) / measure.getTotalLength() * 100}%` }
}
