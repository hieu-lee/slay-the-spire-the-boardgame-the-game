// A held relic, shown the way the digital game shows it: a rimmed token in a
// row along the HUD, with the relic's NAME and printed TEXT on hover or focus.
// Before this the header rendered a bare icon whose only label was the raw
// definition id, so a player could see that they owned six relics and read what
// none of them did.
//
// RelicBar and RelicOptionText are exported; RelicChip is deliberately not, because
// the tooltip is positioned against the BAR rather than against its own chip —
// see the comment on `.relic-bar` in src/ui/chrome/tooltips.css — so a lone chip
// outside a bar would place its tooltip against whatever happened to be
// positioned further up the tree. `relicOptionLabel` is also exported: a pure
// formatter, no DOM. `RelicOptionText` is the prose those option buttons print
// on a device that cannot open a `title`.
import { useCallback, useEffect, useRef, useState } from 'react'
import { relicDef } from '../game/relics.ts'
import type { RelicDef } from '../game/relics.ts'
import type { RelicInstance } from '../game/types.ts'
import { relicIconPath } from '../game/assets.ts'
import { POINTER_CLICK_WINDOW_MS, useHoverUnavailable } from './touch-input.ts'

/**
 * How each relic pool reads on the token. All five, not just the three the
 * tooltip used to name: `solo` and `special` were falling through to a bare
 * "Relic" and losing the one thing that distinguishes them.
 */
const RELIC_POOL_LABEL: Record<RelicDef['pool'], string> = {
  starting: 'Starter Relic',
  ordinary: 'Relic',
  boss: 'Boss Relic',
  solo: 'Solo Relic',
  special: 'Special Relic',
}

/**
 * The physical rule, but only when the printed text does not already say it.
 *
 * Twenty-six of the fifty-three relics carrying a `rule` repeat it inside
 * `text`, so showing both made the tooltip — and the screen reader reading the
 * chip's label — say the same sentence twice: "Akabeko. Relic. Once per combat:
 * gain 1 Strength for one Attack. Gain 1 Strength for one Attack."
 *
 * Case and punctuation are normalised away before comparing, because the two
 * fields are authored separately: a rule is usually spliced into the text with
 * its first letter lowercased, and six pairs differ by punctuation alone —
 * a comma against a colon ("When you Rest, heal 3" vs "When you Rest: heal 3"),
 * or a semicolon against a full stop that then capitalises the next word
 * ("then discard; cannot be used" vs "then discard. Cannot be used"). Stripping
 * every non-alphanumeric rather than the two or three seen today is why this
 * keeps working when someone re-punctuates a card.
 *
 * ponytail: a containment test, not a diff. It catches a rule the text quotes
 * whole, which is every duplicate in the current set; a rule reworded rather
 * than quoted would still print twice. Reach for a similarity score only if
 * relic copy starts being paraphrased.
 */
function distinctRule(def: RelicDef): string | undefined {
  if (!def.rule) return undefined
  const flatten = (line: string) => line.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  return flatten(def.text).includes(flatten(def.rule)) ? undefined : def.rule
}

/**
 * Name, rarity, printed text and any physical rule, in the tooltip frame.
 *
 * Deliberately `aria-hidden`: it repeats what the chip's own `aria-label`
 * already says, and a `role="tooltip"` nothing points at with
 * `aria-describedby` is inert anyway.
 */
function RelicTooltip({ id, note }: { id: string; note?: string }) {
  const def = relicDef(id)
  const rule = distinctRule(def)
  return (
    <span className="relic-tip" aria-hidden="true">
      <strong className="relic-tip__name">{def.name}</strong>
      <span className="relic-tip__pool">{RELIC_POOL_LABEL[def.pool]}</span>
      <span className="relic-tip__text">{def.text}</span>
      {rule ? <span className="relic-tip__rule">{rule}</span> : null}
      {note ? <span className="relic-tip__note">{note}</span> : null}
    </span>
  )
}

/**
 * A relic on a single line, for the `title` of an option button on a device that
 * can open one. Where there is no hover, `RelicOptionText` prints the same rules
 * beside the name instead and the call sites drop this `title`, so the sentence
 * is not also announced as a description of the name that now contains it.
 *
 * `withCost` is opt-in per call site, because one select serves every relic
 * event: printed unconditionally, the merchant price read as a fee being
 * charged on Face Trader, which swaps relic for relic with no gold in it.
 *
 * Where it IS printed, `cost ?? 0` matches what the engine actually pays
 * (`event-room.ts` resolves `relic-cost` the same way), so a boss relic reads
 * "(0 Gold)" rather than going silent — on The Moai Head that zero is the whole
 * decision, and it is the case a plain `cost === undefined` check hid.
 */
export function relicOptionLabel(id: string, withCost = false): string {
  const def = relicDef(id)
  return `${def.name}${withCost ? ` (${def.cost ?? 0} Gold)` : ''} — ${def.text}`
}

/**
 * The printed rules for a relic option button, which otherwise shows an icon
 * and a name and keeps its text in a `title`.
 *
 * A `title` is the one tooltip a touchscreen can never open, and these buttons
 * ask the player which relic to give up or trade away — the decision that needs
 * the rules most. So the text is always in the DOM and CSS reveals it where
 * hovering does not exist, which is the same substitution the merchant shelves
 * already make for their bare-icon stock (see chrome/merchant-rug.css).
 *
 * Deliberately NOT `aria-hidden`. The obvious argument for hiding it is that
 * the same sentence is already in the button's `title` — but a `title` becomes
 * only the accessible DESCRIPTION once a button has text content, and
 * title-derived descriptions are the least reliably announced thing on the very
 * platform this text was added for (VoiceOver on iOS). Hiding it would have put
 * the rules on screen for a sighted touch player and withheld them from a
 * touch screen-reader player, which is the opposite of the point. It joins the
 * button's accessible name instead.
 */
export function RelicOptionText({ id, withCost = false }: { id: string; withCost?: boolean }) {
  const def = relicDef(id)
  return (
    <span className="relic-option__text">
      {withCost ? `(${def.cost ?? 0} Gold) ` : ''}{def.text}
    </span>
  )
}

/**
 * One relic token. A spent relic greys out rather than disappearing, the way
 * the physical component is turned face down but stays on the table.
 *
 * The `aria-label` carries every line the tooltip shows — name, rarity, printed
 * text, physical rule, and the spent or remaining-uses note — because a
 * hover-only tooltip is invisible to a screen reader. It needs `role="img"`: a
 * bare `tabIndex` span resolves to `role="generic"`, where `aria-label` is
 * prohibited and several screen readers drop it, so the relic would have
 * announced nothing at all.
 */
function RelicChip({ relic, chipKey, tapOpen, onTapOpen }: {
  relic: RelicInstance
  chipKey: string
  tapOpen: boolean
  onTapOpen: (key: string, open: boolean) => void
}) {
  const def = relicDef(relic.defId)
  const rarity = RELIC_POOL_LABEL[def.pool]
  // WCAG 1.4.13, both halves. The tooltip is a 320px panel covering the potion
  // belt, and it stays up while the pointer is on it (`pointer-events: auto` in
  // src/ui/chrome/tooltips.css) — which means it also swallows clicks meant for the
  // belt. That is only acceptable because Escape reliably puts it away.
  //
  // Hence a document listener rather than an `onKeyDown` on the chip: a mouse
  // user who hovers a relic never gives it DOM focus, so a handler on the chip
  // would never see their Escape and they would be left with a panel they could
  // not clear except by moving the pointer.
  //
  // Hover and focus are tracked SEPARATELY because they are independent — a
  // chip can be clicked (focus) and then un-hovered, or Tabbed to and then
  // hovered. Collapsing them into one `active` flag meant either trigger's exit
  // tore down the listener while the other was still showing the panel through
  // `:focus-within`, leaving a tooltip on screen that Escape could not close —
  // the exact failure this listener exists to prevent, reached sideways.
  //
  // Escape is stopped in capture so a stack of dismissables unwinds top-down,
  // the way Escape behaves everywhere else: this press closes the tooltip, and
  // the next one reaches PowerRow's document listener to drop a pinned card,
  // because `showing` has flipped false and the cleanup has run by then. The
  // cost is that a pinned card needs a second press while a relic happens to be
  // hovered.
  //
  // Two chips can be `showing` at once (one focused, one hovered), so one press
  // dismisses both — `stopPropagation` does not stop sibling listeners on the
  // same node. Left alone: the focused chip's panel was already suppressed by
  // the hovered one, and 1.4.13 wants a dismissal to hold while focus does.
  //
  // Leaving the chip re-arms it, so the next look at this relic still explains.
  //
  // On touch the chip is reached by tapping it. Whether that tap also FOCUSES
  // it is engine-dependent — WebKit does here, real iOS Safari is reported not
  // to for a `tabindex` span — so the panel cannot be left to `:focus-within`
  // and `tapToRead` drives it explicitly from the tap instead. A tap DOES leave
  // `:hover` stuck on the chip, which is a separate nuisance the stylesheet
  // suppresses; see chrome/tooltips.css.
  //
  // The open chip is owned by the BAR rather than by each chip. Every tip is
  // anchored to the bar at one shared `left` and `z-index`, so two open panels
  // land on the same rect and print two sentences over each other. A pointer
  // never gets there because `.relic-bar:has(.relic-chip:hover)` arbitrates —
  // but a tap leaves `:hover` on the last chip TOUCHED rather than on the open
  // one, so that rule cannot referee here, and one owner cannot have two.
  const tapToRead = useHoverUnavailable()
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const pointerActivatedAt = useRef(Number.NEGATIVE_INFINITY)
  // `hovered` is dropped on touch for the reason PotionIcon drops it: a tap sets
  // it through an emulated `mouseenter` and `onMouseLeave` may never arrive, so
  // it would latch — holding the panel open, and holding `dismissed` true so a
  // later Tab back to this chip showed nothing.
  const showing = (((!tapToRead && hovered) || focused) && !dismissed) || tapOpen
  useEffect(() => {
    if (!showing) return undefined
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onTapOpen(chipKey, false)
      setDismissed(true)
    }
    document.addEventListener('keydown', dismiss, true)
    return () => document.removeEventListener('keydown', dismiss, true)
  }, [showing, onTapOpen, chipKey])
  // Re-arm only once BOTH triggers are gone. WCAG 1.4.13 wants dismissed
  // content to stay dismissed while hover or focus persists, so releasing one
  // of the two must not bring the panel back under the player's pointer.
  useEffect(() => {
    if ((tapToRead || !hovered) && !focused && !tapOpen) setDismissed(false)
  }, [hovered, focused, tapOpen, tapToRead])
  // The engine drops a finite-use relic on its last use rather than leaving it
  // at zero, so this branch is defensive: if one ever does reach 0 it reads as
  // spent, not as "0 uses remaining".
  const note = relic.spent ? 'Face down — already used.'
    : relic.uses === 0 ? 'Used up.'
      : relic.uses !== undefined ? `${relic.uses} use${relic.uses === 1 ? '' : 's'} remaining.`
        : undefined
  return (
    <span className={`relic-chip${relic.spent ? ' relic-chip--spent' : ''}`} tabIndex={0} role="img"
      data-tip-dismissed={dismissed ? 'true' : undefined}
      // The panel cannot be left to `:focus-within` on a phone: iOS Safari does
      // not focus a `tabindex` span when you tap it, so the chip stayed silent
      // on the one platform this whole path exists for. This attribute drives
      // the panel from the tap itself, independent of focus.
      data-tip-open={tapOpen ? 'true' : undefined}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      // Where a tap DOES focus the chip, focus opens the panel before this
      // handler runs — so a bare `dismissed` toggle would shut the panel that
      // same tap had just raised. `tapOpen` holds it open past that focus, and
      // the next tap both closes it and dismisses, so focus alone cannot bring
      // it straight back.
      onPointerDown={tapToRead ? () => { pointerActivatedAt.current = Date.now() } : undefined}
      onClick={tapToRead ? (event) => {
        // Keyboard activation already has this panel open through focus, so the
        // toggle belongs to pointer-driven taps only. Detected from a preceding
        // `pointerdown` on this chip rather than from `MouseEvent.detail`: the
        // engines do not agree on what `detail` a synthesised tap carries, and
        // a false negative here silently removes the tap path this exists for.
        // Keyboard only when both signals agree; see PotionIcon. A relic panel
        // is harmless either way, but one rule across the three surfaces beats
        // three subtly different ones.
        const keyboardActivated = event.detail === 0 &&
          Date.now() - pointerActivatedAt.current > POINTER_CLICK_WINDOW_MS
        if (keyboardActivated) return
        if (tapOpen) {
          onTapOpen(chipKey, false)
          setDismissed(true)
          return
        }
        onTapOpen(chipKey, true)
        setDismissed(false)
      } : undefined}
      aria-label={[`${def.name}.`, `${rarity}.`, def.text, distinctRule(def), note].filter(Boolean).join(' ')}>
      <img className="item-icon-image" src={relicIconPath(relic.defId)} alt="" />
      <RelicTooltip id={relic.defId} note={note} />
    </span>
  )
}

/**
 * The whole held-relic row. Empty renders nothing rather than an empty frame.
 *
 * `role="group"` for the same reason the chip needs `role="img"`: a bare span
 * is `role="generic"`, which prohibits `aria-label`, so the row's name would be
 * discarded and the player would hear a bare run of relics belonging to nobody.
 *
 * `label` is required rather than defaulted: both shells name the seat that owns
 * the row ("Ironclad's relics"), and in multiplayer a bare "Relics" would leave
 * a screen-reader user unable to tell whose row they had landed on.
 */
export function RelicBar({ relics, label }: { relics: readonly RelicInstance[]; label: string }) {
  // Deliberately NOT guarded against an id `relicDef` does not know. CombatScreen
  // and RoomScreen read this same array unguarded, and the engine reads it in a
  // dozen more places — so skipping unknown relics here would not save the run,
  // it would show the player a hand of N-1 relics, let them plan around a board
  // state that is a lie, and crash at the first combat anyway. If a client ever
  // meets a relic it cannot name, failing loudly at the front door is the honest
  // outcome; the place to catch it would be one validation of the incoming
  // snapshot, not the one component that happens to be on screen.
  //
  // At most one chip explains itself at a time, and a tap anywhere else puts it
  // away. Both live here rather than in the chip because both are questions
  // about the STRIP: only the bar can know that opening one panel should close
  // its neighbour's, and a chip that never receives focus (see RelicChip) has
  // no blur to close itself with.
  const bar = useRef<HTMLSpanElement>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const openChip = useCallback((key: string, open: boolean) =>
    setOpenId((current) => (open ? key : current === key ? null : current)), [])
  // Keyed by relic id AND position, so a spent or granted relic mid-run cannot
  // leave the key pointing at a different relic's panel.
  const inventory = relics.map((relic, index) => `${relic.defId}-${index}`).join('\0')
  useEffect(() => setOpenId(null), [inventory])
  useEffect(() => {
    if (!openId) return undefined
    const dismiss = (event: Event) => {
      // THIS bar's chips, not any chip on the page: the run summary draws one
      // bar per seat, and a document-wide test left every other seat's panel
      // open when one of them was tapped.
      if (event.target instanceof Element && bar.current?.contains(event.target)) return
      setOpenId(null)
    }
    document.addEventListener('click', dismiss, true)
    return () => document.removeEventListener('click', dismiss, true)
  }, [openId])
  if (relics.length === 0) return null
  return (
    <span className="relic-bar" role="group" aria-label={label} ref={bar}>
      {relics.map((relic, index) => {
        const key = `${relic.defId}-${index}`
        return <RelicChip key={key} relic={relic} chipKey={key} tapOpen={openId === key}
          onTapOpen={openChip} />
      })}
    </span>
  )
}
