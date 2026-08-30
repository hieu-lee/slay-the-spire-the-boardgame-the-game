import { useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { GameSettings } from './game-settings.ts'
import { defaultGameSettings } from './game-settings.ts'

type Tab = 'general' | 'video' | 'audio'

export function SettingsDialog({ open, onClose, settings, onChange, generalChildren }: {
  open: boolean
  onClose: () => void
  settings: GameSettings
  onChange: (settings: GameSettings) => void
  generalChildren?: ReactNode
}) {
  const id = useId()
  const dialog = useRef<HTMLDialogElement>(null)
  /**
   * How many reopen-driven `close` events are still owed, so a reopen is never
   * read as the player leaving settings. A COUNT, not a flag: `close()` fires
   * its event from a queued task, so two reopens before the first event is
   * delivered would leave a flag consumed once and the second close honoured —
   * which would shut the menu the moment fullscreen was entered and left again.
   */
  const suppressedCloses = useRef(0)
  const [tab, setTab] = useState<Tab>(generalChildren ? 'general' : 'video')
  const [fullscreen, setFullscreen] = useState(Boolean(document.fullscreenElement))
  const [fullscreenError, setFullscreenError] = useState('')

  useEffect(() => {
    const node = dialog.current
    if (!node) return
    if (open && !node.open) {
      setTab(generalChildren ? 'general' : 'video')
      node.showModal()
    }
    else if (!open && node.open) node.close()
  }, [generalChildren, open])

  useEffect(() => {
    const update = () => {
      setFullscreen(Boolean(document.fullscreenElement))
      // The top layer paints in the order elements joined it, and the fullscreen
      // element joins after this dialog already did — so <html> and its opaque
      // ::backdrop cover the settings menu the moment fullscreen is entered.
      // Closing and reopening moves the dialog back to the end of the layer.
      const node = dialog.current
      if (!node?.open) return
      const focused = document.activeElement
      suppressedCloses.current += 1
      node.close()
      node.showModal()
      if (focused instanceof HTMLElement && node.contains(focused)) focused.focus()
    }
    document.addEventListener('fullscreenchange', update)
    return () => document.removeEventListener('fullscreenchange', update)
  }, [])

  const set = <K extends keyof GameSettings>(key: K, value: GameSettings[K]) => onChange({ ...settings, [key]: value })
  const toggleFullscreen = async () => {
    setFullscreenError('')
    try {
      if (document.fullscreenElement) await document.exitFullscreen()
      else await document.documentElement.requestFullscreen()
    } catch {
      setFullscreenError('Fullscreen is unavailable in this browser window.')
    }
  }

  return (
    <dialog ref={dialog} className="settings-dialog" aria-labelledby={`${id}-title`}
      onCancel={(event) => { event.preventDefault(); onClose() }}
      onClose={() => { if (suppressedCloses.current > 0) suppressedCloses.current -= 1; else onClose() }}>
      <section className="settings-dialog__panel">
        <header>
          <button type="button" className="settings-dialog__back" onClick={onClose}>← Back</button>
          <h2 id={`${id}-title`}>Settings</h2>
        </header>
        <nav aria-label="Settings sections">
          {(generalChildren ? ['general', 'video', 'audio'] as const : ['video', 'audio'] as const)
            .map((section) => <button type="button" key={section}
            id={`${id}-${section}-tab`} aria-pressed={tab === section}
            aria-controls={`${id}-${section}-panel`} onClick={() => setTab(section)}>{section}</button>)}
        </nav>
        <div className="settings-dialog__body">
          {tab === 'general' ? <section id={`${id}-general-panel`} role="tabpanel" aria-labelledby={`${id}-general-tab`}>
            {generalChildren}
          </section> : null}
          {tab === 'video' ? <section id={`${id}-video-panel`} role="tabpanel" aria-labelledby={`${id}-video-tab`}>
            <div className="settings-action">
              <span><strong>Display mode</strong><small>{fullscreen ? 'Fullscreen' : 'Windowed'}</small></span>
              <button type="button" aria-pressed={fullscreen} onClick={() => void toggleFullscreen()}>
                {fullscreen ? 'Leave fullscreen' : 'Enter fullscreen'}
              </button>
            </div>
            <label className="settings-toggle">
              <span><strong>Reduce motion</strong><small>Disable decorative movement and transitions.</small></span>
              <input type="checkbox" checked={settings.reducedMotion} onChange={(event) => set('reducedMotion', event.target.checked)} />
            </label>
            <label className="settings-toggle">
              <span><strong>High-contrast UI</strong><small>Strengthen panel edges and readable text.</small></span>
              <input type="checkbox" checked={settings.highContrast} onChange={(event) => set('highContrast', event.target.checked)} />
            </label>
            {fullscreenError ? <p className="settings-dialog__error" role="alert">{fullscreenError}</p> : null}
          </section> : null}
          {tab === 'audio' ? <section id={`${id}-audio-panel`} role="tabpanel" aria-labelledby={`${id}-audio-tab`}>
            <Volume label="Music" value={settings.bgmVolume} onChange={(value) => set('bgmVolume', value)} />
            <Volume label="Sound effects" value={settings.sfxVolume} onChange={(value) => set('sfxVolume', value)} />
            <Volume label="Voice chat" value={settings.voiceVolume} onChange={(value) => set('voiceVolume', value)} />
          </section> : null}
        </div>
        <button type="button" className="settings-dialog__reset" onClick={() => onChange(defaultGameSettings())}>Reset settings</button>
      </section>
    </dialog>
  )
}

function Volume({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return <label className="settings-volume">
    <span><strong>{label}</strong><output>{value}%</output></span>
    <input type="range" min="0" max="100" step="5" value={value}
      aria-label={`${label} volume`} onChange={(event) => onChange(Number(event.target.value))} />
  </label>
}
