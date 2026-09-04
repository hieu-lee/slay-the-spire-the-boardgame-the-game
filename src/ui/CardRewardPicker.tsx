import { useEffect, useRef, type CSSProperties } from 'react'
import { assetPath } from '../game/assets.ts'
import { Card } from './Card.tsx'

type Props = {
  choices: readonly string[]
  upgraded?: boolean
  disabled?: boolean
  uidPrefix?: string
  style?: CSSProperties
  onChoose: (index: number) => void
  onSkip: () => void
}

/** The one card-reward surface, regardless of whether combat, an Event, Neow, or a Relic created it. */
export function CardRewardPicker({ choices, upgraded = false, disabled = false, uidPrefix = 'card-reward', style, onChoose, onSkip }: Props) {
  const picker = useRef<HTMLElement>(null)
  const rewardKey = `${uidPrefix}:${upgraded}:${choices.join(',')}`
  const pickerStyle = { ...style, '--reward-card-count': Math.max(choices.length, 1) } as CSSProperties
  useEffect(() => {
    const root = picker.current
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    root?.focus()
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !root) return
      const controls = [...root.querySelectorAll<HTMLElement>('button:not(:disabled):not([aria-disabled="true"]), [tabindex="0"]:not([aria-disabled="true"])')]
      const first = controls[0]
      const last = controls.at(-1)
      if (!first || !last) return event.preventDefault()
      if (event.shiftKey && (document.activeElement === root || document.activeElement === first)) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    root?.addEventListener('keydown', trap)
    return () => { root?.removeEventListener('keydown', trap); if (previous?.isConnected) previous.focus() }
  }, [rewardKey])
  return <section ref={picker} className="reward-screen reward-screen--card-choice" style={pickerStyle}
    role="dialog" aria-modal="true" tabIndex={-1} aria-labelledby={`${uidPrefix}-title`}>
    <h2 className="reward-screen__title" id={`${uidPrefix}-title`}>Choose a Card</h2>
    <div className="reward-screen__cards">
      {choices.map((defId, index) => <Card key={`${defId}-${index}`}
        card={{ uid: `${uidPrefix}-${index}`, defId, upgraded }} playable={!disabled}
        tabIndex={disabled ? -1 : undefined}
        onClick={() => !disabled && onChoose(index)} />)}
    </div>
    <button className="reward-screen__skip" type="button" disabled={disabled} onClick={onSkip}>Skip</button>
  </section>
}

export function CardRewardIcon({ rare = false }: { rare?: boolean }) {
  return <img src={assetPath(`icons/${rare ? 'rare-' : ''}card-reward.png`)} alt="" />
}
