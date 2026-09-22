// Whether the device can hover at all.
//
// Every tooltip in this app — relic chips, potion anchors, map nodes — was
// written against a pointer that can rest on a thing without activating it. A
// phone has no such pointer: the first touch IS the click, so a hover-only
// panel is not merely hard to reach, it is unreachable, and the information in
// it (what a relic does, what a room holds, what a potion costs you) silently
// stops existing.
//
// `(hover: none)` rather than `(pointer: coarse)`: coarse is true for a stylus
// and for a touchscreen laptop that also has a trackpad, and both of those CAN
// hover. What the callers actually need to know is whether hovering is
// available, and that is the question this media feature asks.
import { useEffect, useState } from 'react'

const NO_HOVER = '(hover: none)'

/**
 * How recently a `pointerdown` must have happened for the click that follows to
 * count as pointer-driven.
 *
 * A latched boolean cannot do this job: a press that never becomes a click —
 * a drag that scrolls the map, a cancelled touch — would leave the flag set and
 * misread the next keyboard activation. A timestamp expires on its own.
 *
 * Read from `Date.now()` at both ends rather than from `event.timeStamp`: the
 * two events are different types, and their timestamps are not guaranteed to
 * share an epoch. Where they did not, every elapsed time looked enormous, the
 * activation read as a key, and the gate this window protects was skipped.
 */
export const POINTER_CLICK_WINDOW_MS = 1000

function hoverUnavailable(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(NO_HOVER).matches
}

/**
 * True while the device cannot hover, so hover-revealed information needs a
 * tap path.
 *
 * Subscribed rather than read once: a hybrid laptop gaining or losing its
 * trackpad re-evaluates this feature without reloading the page.
 */
export function useHoverUnavailable(): boolean {
  const [unavailable, setUnavailable] = useState(hoverUnavailable)
  useEffect(() => {
    const query = window.matchMedia(NO_HOVER)
    const sync = () => setUnavailable(query.matches)
    sync()
    query.addEventListener('change', sync)
    return () => query.removeEventListener('change', sync)
  }, [])
  return unavailable
}
