import { useEffect } from 'react'

/** Native image cursors fall back near viewport edges in Chromium. */
export function GameCursor() {
  useEffect(() => {
    const layer = document.createElement('div')
    layer.className = 'game-cursor'
    layer.setAttribute('popover', 'manual')
    layer.setAttribute('aria-hidden', 'true')
    const normal = new Image()
    const pressed = new Image()
    normal.src = '/assets/ui/cursor.png'
    pressed.src = '/assets/ui/cursor-click.png'
    layer.append(normal, pressed)
    document.body.append(layer)
    let ready = false
    let disposed = false
    Promise.all([normal.decode(), pressed.decode()]).then(() => {
      if (!disposed) ready = true
    }).catch(() => { /* Keep the native fallback if an asset cannot load. */ })

    const hide = () => {
      layer.hidePopover()
      document.documentElement.classList.remove('game-cursor-active')
    }
    const move = (event: PointerEvent) => {
      if (!ready || event.pointerType !== 'mouse' || event.clientX < 0 || event.clientY < 0 ||
          event.clientX >= innerWidth || event.clientY >= innerHeight) {
        hide()
        return
      }
      layer.style.setProperty('--cursor-x', `${event.clientX - 14}px`)
      layer.style.setProperty('--cursor-y', `${event.clientY - 12}px`)
      layer.classList.toggle('game-cursor--pressed', event.buttons !== 0)
      layer.showPopover()
      document.documentElement.classList.add('game-cursor-active')
    }
    const leave = (event: PointerEvent) => { if (!event.relatedTarget) hide() }
    // Reinsert above newly opened modal dialogs in the browser's top layer.
    const observer = new MutationObserver(() => {
      if (layer.matches(':popover-open')) {
        layer.hidePopover()
        layer.showPopover()
      }
    })
    observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['open'] })
    for (const type of ['pointermove', 'pointerdown', 'pointerup'] as const) document.addEventListener(type, move, true)
    document.addEventListener('pointerout', leave, true)
    document.addEventListener('pointercancel', hide, true)
    document.addEventListener('visibilitychange', hide)
    window.addEventListener('blur', hide)
    return () => {
      disposed = true
      observer.disconnect()
      for (const type of ['pointermove', 'pointerdown', 'pointerup'] as const) document.removeEventListener(type, move, true)
      document.removeEventListener('pointerout', leave, true)
      document.removeEventListener('pointercancel', hide, true)
      document.removeEventListener('visibilitychange', hide)
      window.removeEventListener('blur', hide)
      hide()
      layer.remove()
    }
  }, [])
  return null
}
