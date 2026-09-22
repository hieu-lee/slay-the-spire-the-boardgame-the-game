export type TrailBounds = { x: number; y: number; width: number; height: number }

export function animateCardFlight(element: HTMLElement, frames: Keyframe[]): Animation {
  const animation = element.animate(frames, { duration: 980, easing: 'linear', fill: 'both' })
  animation.id = 'card-resolve'
  return animation
}

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
  const trailBounds: TrailBounds = { x: Math.floor(Math.min(x, endX) - 64), y: Math.floor(Math.min(stageY - 90, endY) - 64), width: Math.ceil(Math.abs(endX - x) + 128), height: Math.ceil(Math.max(stageY, endY) - Math.min(stageY - 90, endY) + 128) }
  const transform = (pointX: number, pointY: number) =>
    `translate3d(${pointX}px, ${pointY}px, 0) translate(-50%, -50%)`
  const measure = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  measure.setAttribute('d', trailPath)
  const curveLength = measure.getTotalLength()
  const curveTransforms: string[] = []
  for (let index = 1; index < 16; index++) {
    const point = measure.getPointAtLength(curveLength * index / 16)
    curveTransforms.push(transform(point.x, point.y))
  }
  const motionFrames: Keyframe[] = [
    { offset: 0, opacity: 1, transform: `${transform(x, handY)} rotate(-5deg) scale(.88)` },
    { offset: .18, opacity: 1, transform: `${transform(x, stageY)} scale(1.58)` },
    { offset: .34, opacity: 1, transform: `${transform(x, stageY)} scale(1.05)` },
    { offset: .66, opacity: 1, transform: `${transform(x, stageY)} scale(1.05)` },
    { offset: .76, opacity: 1, transform: `${transform(x, stageY)} scale(.32)` },
    ...curveTransforms.map((position, index) => {
      const progress = (index + 1) / 16
      return { offset: .76 + .24 * progress, opacity: 1 - .3 * progress,
        transform: `${position} rotate(${12 * progress}deg) scale(${.32 - .1 * progress})` }
    }),
    { offset: 1, opacity: .7, transform: `${transform(endX, endY)} rotate(12deg) scale(.22)` },
  ]
  return { trailPath, trailBounds, motionFrames }
}
