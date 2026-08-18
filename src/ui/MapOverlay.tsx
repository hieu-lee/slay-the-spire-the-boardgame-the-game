import { useEffect, useRef, useState } from 'react'
import type { SpireMap } from '../game/map.ts'
import { MapScreen } from './MapScreen.tsx'

type MapOverlayProps = {
  map: SpireMap
  act: number
  /** This act's boss, rolled at setup and public to the table. */
  bossDefId?: string | null
}

/**
 * The map, read-only, over whatever screen the party is on.
 *
 * Deck-building decisions are made mid-fight — which reward to take, whether to
 * spend gold on removal — and every one of them is a decision about what is
 * still ahead. Making the party finish the fight before they could look was the
 * one piece of public information the game was withholding for no reason.
 *
 * A sibling of the screen it covers rather than a prop threaded into it: both
 * shells already have the run in scope here, and `CombatScreen` deliberately
 * takes combat state and nothing else.
 */
export function MapOverlay({ map, act, bossDefId }: MapOverlayProps) {
  const [open, setOpen] = useState(false)
  const dialogRef = useRef<HTMLDialogElement | null>(null)

  // Imperative `showModal`, matching every other dialog in the app: the `open`
  // attribute alone renders a non-modal dialog with no backdrop and no focus
  // trap, and Escape would not close it.
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open) { if (!dialog.open) dialog.showModal() } else if (dialog.open) dialog.close()
  }, [open])

  return (
    <>
      <button className="map-peek__open" type="button" aria-label="Map" onClick={() => setOpen(true)}>
        <img src="/assets/menu/map-scroll.png" alt="" />
      </button>
      <dialog className="map-peek" ref={dialogRef} onClose={() => setOpen(false)} aria-label={`Act ${act} map`}>
        <div className="map-peek__panel">
          <header>
            <h2>Act {act}</h2>
            <button type="button" onClick={() => setOpen(false)}>Close</button>
          </header>
          {/* `readOnly`, not `blocked`: `blocked` marks the map `inert`, which
              would kill the hover the party opened this to use. With no
              choices nothing is reachable, so nothing can be entered anyway. */}
          {open ? (
            <MapScreen map={map} choices={[]} readOnly bossDefId={bossDefId} onEnter={() => {}} />
          ) : null}
        </div>
      </dialog>
    </>
  )
}
