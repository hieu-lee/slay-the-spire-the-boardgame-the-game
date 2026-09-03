import { useEffect, useRef } from 'react'
import type { CardInstance } from '../game/types.ts'
import { Card } from './Card.tsx'

type PickerVerb = 'Remove' | 'Transform' | 'Upgrade'

type CardPickerProps = {
  cards: readonly CardInstance[]
  verb: PickerVerb
  selectedCardUids: readonly string[]
  onSelect: (uid: string) => void
  onClear: () => void
  onBack: () => void
  onConfirm: () => void
  confirmLabel?: string
  backLabel?: string
  maxSelections?: number
  confirmDisabled?: boolean
  selectionRequired?: boolean
  backDisabled?: boolean
  disabled?: boolean
}

/** The shared full-deck picker used whenever a run changes one of its cards. */
export function CardPicker({
  cards, verb, selectedCardUids, onSelect, onClear, onBack, onConfirm, confirmLabel = 'Confirm', backLabel = 'Back',
  maxSelections = 1, confirmDisabled, selectionRequired = true, backDisabled = false, disabled = false,
}: CardPickerProps) {
  const pickerRef = useRef<HTMLElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  const gridScrollTopRef = useRef(0)
  const wasPreview = useRef(false)
  const selected = cards.filter((card) => selectedCardUids.includes(card.uid))
  const preview = maxSelections === 1 && selected.length === 1
  const chosen = selected[0]
  const selectionLabel = maxSelections === 1 ? 'a card' : `${maxSelections} cards`

  useEffect(() => {
    const picker = pickerRef.current
    if (!picker) return undefined
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const controls = () => [...picker.querySelectorAll<HTMLButtonElement>('button:not([disabled]):not([aria-disabled="true"])')]
    const focusFirst = () => (controls()[0] ?? picker).focus()
    focusFirst()
    const retainFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && !picker.contains(event.target)) focusFirst()
    }
    const trapTab = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const items = controls()
      const first = items[0]
      const last = items.at(-1)
      if (!first || !last) {
        event.preventDefault()
        picker.focus()
        return
      }
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('focusin', retainFocus)
    picker.addEventListener('keydown', trapTab)
    return () => {
      document.removeEventListener('focusin', retainFocus)
      picker.removeEventListener('keydown', trapTab)
      if (restoreFocusRef.current?.isConnected) restoreFocusRef.current.focus()
    }
  }, [])

  useEffect(() => {
    const grid = gridRef.current
    const picker = pickerRef.current
    if (disabled) {
      picker?.focus({ preventScroll: true })
    } else if (preview) {
      wasPreview.current = true
      picker?.querySelector<HTMLButtonElement>('.card-picker__preview button:not([disabled]):not([aria-disabled="true"])')?.focus({ preventScroll: true })
    } else if (wasPreview.current) {
      if (grid) grid.scrollTop = gridScrollTopRef.current
      const back = picker?.querySelector<HTMLButtonElement>('.card-picker__back:not([disabled])')
      if (back) back.focus({ preventScroll: true })
      else picker?.focus({ preventScroll: true })
      wasPreview.current = false
    }
  }, [preview, disabled])

  const rememberGridScroll = () => { gridScrollTopRef.current = gridRef.current?.scrollTop ?? 0 }
  const backText = preview ? 'Back' : backLabel

  return <section ref={pickerRef} className={`card-picker${preview ? ' card-picker--previewing' : ''}`} role="dialog" aria-modal="true" tabIndex={-1}
    aria-label={`Choose ${selectionLabel} to ${verb.toLowerCase()}`}>
    <h2 className="visually-hidden">Choose {selectionLabel} to {verb}</h2>
    <div className="card-picker__body">
      <div ref={gridRef} className="card-picker__grid">
        {cards.map((card) => <Card key={card.uid} card={card} selected={selectedCardUids.includes(card.uid)}
          playable={!preview && !disabled && (selectedCardUids.includes(card.uid) || selectedCardUids.length < maxSelections)}
          tabIndex={preview || disabled || !selectedCardUids.includes(card.uid) && selectedCardUids.length >= maxSelections ? -1 : undefined}
          onClick={() => { rememberGridScroll(); onSelect(card.uid) }} />)}
        {cards.length === 0 ? <p className="card-picker__empty" role="status">No eligible cards.</p> : null}
      </div>
      {preview && chosen ? <div className="card-picker__preview" aria-live="polite">
        {verb === 'Upgrade' ? <>
          <Card card={chosen} selected playable={!disabled} tabIndex={disabled ? -1 : undefined} onClick={() => { rememberGridScroll(); onSelect(chosen.uid) }} />
          <span className="card-picker__upgrade-arrow" aria-hidden="true">›</span>
          <Card card={{ ...chosen, upgraded: true }} playable={false} tabIndex={-1} />
        </> : <Card card={chosen} selected playable={!disabled} tabIndex={disabled ? -1 : undefined} onClick={() => { rememberGridScroll(); onSelect(chosen.uid) }} />}
      </div> : null}
    </div>
    <footer className="card-picker__footer">
      <button type="button" className="card-picker__back" aria-label={backText} title={backText} disabled={disabled || backDisabled}
        onClick={() => { rememberGridScroll(); preview ? onClear() : onBack() }}><svg viewBox="0 0 100 70" aria-hidden="true"><path d="M4 39 32 9v16h26c20 0 34 13 34 30v8H75v-8c0-8-6-13-17-13H32v15z" /></svg></button>
      <p>Choose {selectionLabel} to <strong>{verb}</strong>.</p>
      <button type="button" className="card-picker__confirm" aria-label={confirmLabel} title={confirmLabel}
        disabled={disabled || confirmDisabled === true || selectionRequired && selected.length < maxSelections} onClick={onConfirm}><svg viewBox="0 0 100 70" aria-hidden="true"><path d="m12 38 21 21L88 12l-9-9-46 39-12-12z" /></svg></button>
    </footer>
  </section>
}
