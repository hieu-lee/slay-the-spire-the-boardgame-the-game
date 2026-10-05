// Kratos's Rage of Sparta meter: the God of War III glyph, filled with molten
// Rage from the bottom of its ring up its two pillars. Drawn in SVG because the
// emblem is plain geometry; the painted look comes from the bronze bevel, the
// ember channel and a heavy dark outline, as on the game's other icons.
import { useEffect, useId, useRef, useState } from 'react'
import { CAPS } from '../../game/types.ts'

/** The glyph's vertical span inside the 120x150 viewBox, used for the fill level. */
const GLYPH_TOP = 8
const GLYPH_BOTTOM = 140

/** Two capped pillars with outward barbs; the ring that joins them is drawn as a stroke. */
const PILLARS = [
  'M24 8H56V20H50V82H38V56H23V68H14V46H38V20H24Z',
  'M96 8H64V20H70V82H82V56H97V68H106V46H82V20H96Z',
]
const RING_WIDTH = 15
/** Bronze rim width around the molten channel. */
const RIM = 3.5

export function RageMeter({ rage, held, onToggleHold }: {
  rage: number
  held: boolean
  onToggleHold: () => void
}) {
  const id = useId().replace(/:/g, '')
  const level = Math.max(0, Math.min(CAPS.rage, rage))
  const full = level >= CAPS.rage
  const fillTop = GLYPH_BOTTOM - (GLYPH_BOTTOM - GLYPH_TOP) * (level / CAPS.rage)
  // Flare when Rage rises and flash when an Unleash spends it.
  const previous = useRef(level)
  const [change, setChange] = useState<{ kind: 'gain' | 'spend'; beat: number } | null>(null)
  useEffect(() => {
    if (level === previous.current) return
    const kind = level > previous.current ? 'gain' : 'spend'
    previous.current = level
    setChange((current) => ({ kind, beat: (current?.beat ?? 0) + 1 }))
  }, [level])

  // The whole glyph in one paint: filled pillars plus the ring stroke, widened by any outline.
  const shapes = (paint: string, outline = 0, fill = paint) => (
    <g strokeLinejoin="round">
      {PILLARS.map((d) => <path key={d} d={d} fill={fill} stroke={outline ? paint : undefined} strokeWidth={outline || undefined} />)}
      <circle cx="60" cy="104" r="28" fill="none" stroke={paint} strokeWidth={RING_WIDTH + outline} />
    </g>
  )

  return (
    <button type="button" className="rage-meter" data-rage={level} data-full={full || undefined}
      data-held={held || undefined}
      data-change={change ? `${change.kind}-${change.beat % 2}` : undefined}
      aria-pressed={held}
      aria-label={`Rage ${level} of ${CAPS.rage}. ${held
        ? 'Holding Rage: Unleash clauses are skipped. Press to unleash again.'
        : 'Unleash spends Rage when able. Press to hold Rage.'}`}
      title={held ? 'Holding Rage — click to Unleash again' : 'Rage of Sparta — click to hold Rage'}
      onClick={onToggleHold}>
      <svg viewBox="0 0 120 150" aria-hidden="true" focusable="false">
        <defs>
          <linearGradient id={`${id}-bronze`} x1="0" y1="0" x2="0.35" y2="1">
            <stop offset="0" stopColor="#ffe6a3" />
            <stop offset="0.28" stopColor="#d99b3b" />
            <stop offset="0.62" stopColor="#8c4f1c" />
            <stop offset="1" stopColor="#4a2410" />
          </linearGradient>
          <linearGradient id={`${id}-molten`} x1="0" y1="1" x2="0" y2="0">
            <stop offset="0" stopColor="#ff6a12" />
            <stop offset="0.45" stopColor="#ffb22e" />
            <stop offset="1" stopColor="#ffd968" />
          </linearGradient>
          <linearGradient id={`${id}-ember`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#4d0e0b" />
            <stop offset="1" stopColor="#24070a" />
          </linearGradient>
          {/* Painted grain so the flat fills read as brushed metal and lava. */}
          <filter id={`${id}-grain`} x="-10%" y="-10%" width="120%" height="120%">
            <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="7" result="noise" />
            <feColorMatrix in="noise" type="saturate" values="0" result="mono" />
            <feComposite in="mono" in2="SourceGraphic" operator="in" result="speckle" />
            <feBlend in="SourceGraphic" in2="speckle" mode="multiply" />
          </filter>
          <mask id={`${id}-glyph`} maskUnits="userSpaceOnUse" x="0" y="0" width="120" height="150">
            {shapes('white')}
            <path d="M54 118h12l-6 24z" fill="black" />
          </mask>
          {/* The channel is the glyph less its rim, so the bronze edge frames the lava. */}
          <mask id={`${id}-channel`} maskUnits="userSpaceOnUse" x="0" y="0" width="120" height="150">
            {PILLARS.map((d) => <path key={d} d={d} fill="white" stroke="black" strokeWidth={RIM * 2} strokeLinejoin="round" />)}
            <circle cx="60" cy="104" r="28" fill="none" stroke="white" strokeWidth={RING_WIDTH - RIM * 2} />
            <path d="M50 116h20l-10 28z" fill="black" />
          </mask>
          <clipPath id={`${id}-level`}>
            <rect className="rage-meter__level" x="0" y={fillTop} width="120" height={150 - fillTop} />
          </clipPath>
        </defs>
        <g className="rage-meter__emblem">
          {shapes('#130805', 8)}
          <g mask={`url(#${id}-glyph)`} filter={`url(#${id}-grain)`}>
            <rect width="120" height="150" fill={`url(#${id}-bronze)`} />
          </g>
          <g mask={`url(#${id}-channel)`}>
            <rect width="120" height="150" fill={`url(#${id}-ember)`} />
            <g clipPath={`url(#${id}-level)`}>
              <rect className="rage-meter__molten" width="120" height="150" fill={`url(#${id}-molten)`}
                filter={`url(#${id}-grain)`} />
            </g>
          </g>
          {/* Two short specular strokes on the caps. */}
          <path d="M28 11h22M70 11h22" stroke="#fff3c4" strokeWidth="1.6" strokeLinecap="round" opacity="0.75" />
          <path d="M54 118h12l-6 24z" fill="#130805" />
        </g>
        <text className="rage-meter__count" x="60" y="111" textAnchor="middle">{level}</text>
      </svg>
      {held ? <span className="rage-meter__held" aria-hidden="true">Hold</span> : null}
    </button>
  )
}
