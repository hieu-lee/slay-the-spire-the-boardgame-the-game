// Installed only in the disposable replay iframe. Slow frame encoding must not
// let React's removal timers outrun the animation frames being rendered.
export function createRunVodClock(doc: Document, commit: (callback: () => void) => void) {
  const channel = new MessageChannel()
  const flushes: (() => void)[] = []
  channel.port1.onmessage = () => flushes.shift()?.()
  const view = doc.defaultView!
  const native = {
    setTimeout: view.setTimeout, clearTimeout: view.clearTimeout,
    setInterval: view.setInterval, clearInterval: view.clearInterval,
    requestAnimationFrame: view.requestAnimationFrame, cancelAnimationFrame: view.cancelAnimationFrame,
    now: view.performance.now.bind(view.performance),
  }
  let now = native.now()
  let nextId = -1
  const timers = new Map<number, { at: number; callback: () => void; interval?: number }>()
  const animations = new Map<Animation, { started: number; began: boolean; ended: boolean }>()
  // Hidden iframes may never receive a browser paint tick. Deliver CSS lifecycle
  // events on movie time (not on a later real paint), exactly once.
  const blockNativeAnimationEvent = (event: Event) => {
    if (event.isTrusted) event.stopImmediatePropagation()
  }
  for (const type of ['animationstart', 'animationend']) doc.addEventListener(type, blockNativeAnimationEvent, true)
  const add = (callback: () => void, delay: number, interval?: number) => {
    const id = nextId--
    timers.set(id, { at: now + Math.max(1, delay), callback, interval })
    return id
  }
  view.setTimeout = ((callback: TimerHandler, delay = 0, ...args: unknown[]) => {
    if (typeof callback !== 'function') throw new Error('Run VOD cannot replay string timers.')
    return add(() => callback(...args), Number(delay))
  }) as typeof view.setTimeout
  view.setInterval = ((callback: TimerHandler, delay = 0, ...args: unknown[]) => {
    if (typeof callback !== 'function') throw new Error('Run VOD cannot replay string timers.')
    return add(() => callback(...args), Number(delay), Math.max(1, Number(delay)))
  }) as typeof view.setInterval
  view.clearTimeout = (id) => { timers.delete(id!); native.clearTimeout.call(view, id) }
  view.clearInterval = (id) => { timers.delete(id!); native.clearInterval.call(view, id) }
  view.requestAnimationFrame = (callback) => add(() => callback(now), 1_000 / 60)
  view.cancelAnimationFrame = (id) => { timers.delete(id); native.cancelAnimationFrame.call(view, id) }
  Object.defineProperty(view.performance, 'now', { configurable: true, value: () => now })

  const syncAnimations = () => {
    const current = new Set(doc.getAnimations())
    for (const animation of current) {
      if (!animations.has(animation)) {
        animations.set(animation, { started: now - Number(animation.currentTime ?? 0), began: false, ended: false })
        animation.pause()
      }
      const tracked = animations.get(animation)!
      const time = now - tracked.started
      if (animation.currentTime !== time) animation.currentTime = time
      if (animation instanceof view.CSSAnimation && animation.effect instanceof view.KeyframeEffect) {
        const effect = animation.effect
        const timing = effect.getComputedTiming()
        const dispatch = (type: string, elapsedTime: number) => commit(() => effect.target?.dispatchEvent(new view.AnimationEvent(type, {
          animationName: animation.animationName, elapsedTime, bubbles: true, pseudoElement: effect.pseudoElement ?? '',
        })))
        if (!tracked.began && time >= Number(timing.delay)) {
          tracked.began = true
          dispatch('animationstart', Math.max(0, -Number(timing.delay)) / 1000)
        }
        if (!tracked.ended && time >= Number(timing.endTime)) {
          tracked.ended = true
          dispatch('animationend', Number(timing.activeDuration) / 1000)
        }
      }
    }
    for (const animation of animations.keys()) if (!current.has(animation) || !animation.effect || animation.playState === 'idle') animations.delete(animation)
  }
  // Message tasks flush React without nested/background timer clamping.
  const flush = () => new Promise<void>((resolve) => {
    flushes.push(resolve)
    channel.port2.postMessage(null)
  })
  return {
    get now() { return now },
    async advance(milliseconds: number) {
      const target = now + milliseconds
      commit(() => {})
      syncAnimations()
      for (let count = 0; count < 10_000; count++) {
        const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
        if (!next) break
        const [id, timer] = next
        now = timer.at
        timers.delete(id)
        if (timer.interval) timers.set(id, { ...timer, at: now + timer.interval })
        syncAnimations()
        commit(timer.callback)
        await flush()
      }
      now = target
      await flush()
      commit(() => {})
      syncAnimations()
    },
    active() {
      syncAnimations()
      return [...animations].some(([animation, { started }]) => {
        const timing = animation.effect?.getComputedTiming()
        return Number.isFinite(Number(timing?.endTime)) && Number(timing?.endTime) > now - started
      }) || Boolean(doc.querySelector('[data-webmcp-pending="true"], .character-attack, .card-flight, .defect-evoke'))
    },
    restore() {
      Object.assign(view, {
        setTimeout: native.setTimeout, clearTimeout: native.clearTimeout,
        setInterval: native.setInterval, clearInterval: native.clearInterval,
        requestAnimationFrame: native.requestAnimationFrame, cancelAnimationFrame: native.cancelAnimationFrame,
      })
      Object.defineProperty(view.performance, 'now', { configurable: true, value: native.now })
      for (const animation of animations.keys()) if (animation.playState === 'paused') animation.play()
      timers.clear()
      for (const type of ['animationstart', 'animationend']) doc.removeEventListener(type, blockNativeAnimationEvent, true)
      channel.port1.close()
      channel.port2.close()
    },
  }
}

export type RunVodClock = ReturnType<typeof createRunVodClock>
