import { useEffect, useRef } from 'react'
import { assetPath } from '../game/assets.ts'
import type { RuleSet } from '../game/meta.ts'
import './styles/campaign-select.css'

type Props = {
  onChoose: (campaign: RuleSet) => void
  onBack?: () => void
  disabled?: boolean
  message?: string
}

export function CampaignSelect({ onChoose, onBack, disabled = false, message }: Props) {
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => { heading.current?.focus() }, [])
  return <section className="campaign-select" aria-label="Choose your campaign">
    {onBack ? <button className="campaign-select__back ribbon-back" type="button" aria-label="Back" title="Back" onClick={onBack}><span aria-hidden="true" /></button> : null}
    <h1 className="visually-hidden" ref={heading} tabIndex={-1}>Choose your campaign</h1>
    <div className="campaign-select__split">
      {(['base', 'downfall'] as const).map((campaign) => <button
        key={campaign} type="button" className={`campaign-select__side campaign-select__side--${campaign}`}
        disabled={disabled} onClick={() => onChoose(campaign)}
        aria-label={campaign === 'base' ? 'Start standard campaign' : 'Start Downfall campaign'}>
        <img src={assetPath(`menu/campaign-${campaign === 'base' ? 'standard' : 'downfall'}.webp`)} alt="" />
        <span className="campaign-select__copy">
          <strong>{campaign === 'base' ? 'Slay the Spire' : 'Downfall'}</strong>
        </span>
      </button>)}
    </div>
    {message ? <p className="campaign-select__status" role="status">{message}</p> : null}
  </section>
}
