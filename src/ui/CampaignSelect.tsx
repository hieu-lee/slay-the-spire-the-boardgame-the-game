import { useEffect, useRef, useState } from 'react'
import { assetPath, isPreloadedImageDecoded, preloadImages } from '../game/assets.ts'
import type { RuleSet } from '../game/meta.ts'
import './styles/campaign-select.css'

const CAMPAIGN_ART: Record<RuleSet, string> = {
  base: 'menu/campaign-standard-menu.webp',
  downfall: 'menu/campaign-downfall-menu.webp',
}
const CAMPAIGN_ART_PATHS = Object.values(CAMPAIGN_ART)

type Props = {
  onChoose: (campaign: RuleSet) => void
  onBack?: () => void
  disabled?: boolean
  message?: string
}

function CampaignArt({ campaign }: { campaign: RuleSet }) {
  const image = useRef<HTMLImageElement>(null)
  const path = CAMPAIGN_ART[campaign]
  const [decoded, setDecoded] = useState(false)
  useEffect(() => {
    let active = true
    const element = image.current
    if (!element) return undefined
    void element.decode().then(
      () => { if (active) setDecoded(true) },
      // Reveal a browser-provided broken-image indicator instead of leaving a
      // permanently blank panel if an asset cannot be decoded.
      () => { if (active) setDecoded(true) },
    )
    return () => { active = false }
  }, [])
  return <img ref={image} data-decoded={decoded || undefined} src={assetPath(path)} alt="" />
}

export function CampaignSelect({ onChoose, onBack, disabled = false, message }: Props) {
  const heading = useRef<HTMLHeadingElement>(null)
  const [ready, setReady] = useState(() => CAMPAIGN_ART_PATHS.every(isPreloadedImageDecoded))
  useEffect(() => {
    if (ready) return
    let active = true
    void preloadImages(CAMPAIGN_ART_PATHS, { decode: true, fetchPriority: 'high' }).then(() => {
      if (active) setReady(true)
    })
    return () => { active = false }
  }, [ready])
  useEffect(() => { heading.current?.focus() }, [ready])
  if (!ready) return <section className="campaign-select" aria-label="Choose your campaign">
    {onBack ? <button className="campaign-select__back ribbon-back" type="button" aria-label="Back" title="Back" onClick={onBack}><span aria-hidden="true" /></button> : null}
    <h1 className="visually-hidden" ref={heading} tabIndex={-1}>Choose your campaign</h1>
    <p className="campaign-select__status" role="status">Preparing campaign artwork…</p>
  </section>
  return <section className="campaign-select" aria-label="Choose your campaign">
    {onBack ? <button className="campaign-select__back ribbon-back" type="button" aria-label="Back" title="Back" onClick={onBack}><span aria-hidden="true" /></button> : null}
    <h1 className="visually-hidden" ref={heading} tabIndex={-1}>Choose your campaign</h1>
    <div className="campaign-select__split">
      {(['base', 'downfall'] as const).map((campaign) => <button
        key={campaign} type="button" className={`campaign-select__side campaign-select__side--${campaign}`}
        disabled={disabled} onClick={() => onChoose(campaign)}
        aria-label={campaign === 'base' ? 'Start standard campaign' : 'Start Downfall campaign'}>
        <CampaignArt campaign={campaign} />
        <span className="campaign-select__copy">
          <strong>{campaign === 'base' ? 'Slay the Spire' : 'Downfall'}</strong>
        </span>
      </button>)}
    </div>
    {message ? <p className="campaign-select__status" role="status">{message}</p> : null}
  </section>
}
