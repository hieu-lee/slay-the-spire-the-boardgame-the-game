import { useEffect, useState } from 'react'
import type { EventEffect } from '../game/events.ts'
import { Icon, dieIcon } from './Icon.tsx'
import { useReducedEffects } from './combat-screen/hooks.ts'
import { DIE_FACES, dieOutcomes } from './die-outcomes.ts'

const TUMBLE_MS = 720
const TUMBLE_STEP_MS = 90

/**
 * Rolls already shown, so a die only tumbles the first time it lands. The same
 * roll is redrawn whenever the event panel swaps screens, and a second tumble
 * would read as a re-roll. Forgotten when an event screen opens: card ids and
 * seat ids repeat from run to run.
 */
const shownRolls = new Set<string>()
export const forgetShownRolls = () => shownRolls.clear()

type EventDieProps = {
  face: number
  /** Identifies this roll across remounts. */
  rollKey: string
  results?: EventEffect['results']
}

/** The event die as it lands, beside the printed table it was rolled against. */
export function EventDie({ face, rollKey, results }: EventDieProps) {
  const reduced = useReducedEffects()
  const fresh = !reduced && !shownRolls.has(rollKey)
  const [shown, setShown] = useState(fresh ? 1 + (face % 6) : face)
  const [landed, setLanded] = useState(!fresh)

  useEffect(() => {
    if (!fresh) {
      setShown(face)
      setLanded(true)
      return undefined
    }
    setLanded(false)
    let step = 0
    const tumble = window.setInterval(() => {
      step += 1
      setShown(1 + ((face + step * 4 + (step >> 1)) % 6))
    }, TUMBLE_STEP_MS)
    const land = window.setTimeout(() => {
      window.clearInterval(tumble)
      shownRolls.add(rollKey)
      setShown(face)
      setLanded(true)
    }, TUMBLE_MS)
    return () => {
      window.clearInterval(tumble)
      window.clearTimeout(land)
      // Confirming mid-tumble swaps screens; the next screen shows it landed.
      shownRolls.add(rollKey)
    }
  }, [face, fresh, rollKey])

  const outcomes = results ? dieOutcomes(results) : null
  const rolled = outcomes?.[face as keyof typeof outcomes]
  return (
    <div className="event-die" data-landed={landed || undefined}>
      <span className="event-die__cube" aria-hidden="true"><Icon name={dieIcon(shown)} size={64} /></span>
      <span className="visually-hidden" role="status">Rolled {face}{rolled ? `: ${rolled.label}` : ''}</span>
      {outcomes ? (
        <ol className="event-die__table" aria-label="Die results">
          {DIE_FACES.map((pip) => {
            const outcome = outcomes[pip]
            return (
              <li key={pip} data-tone={outcome.tone} data-hit={landed && pip === face ? true : undefined}
                aria-label={`${pip}: ${outcome.label}`}>
                <Icon name={dieIcon(pip)} size={22} />
                <span className="event-die__outcome" title={outcome.label}>
                  {outcome.icon ? <Icon name={outcome.icon} size={20} /> : null}
                  {outcome.text ? <span>{outcome.text}</span> : null}
                </span>
              </li>
            )
          })}
        </ol>
      ) : null}
    </div>
  )
}
