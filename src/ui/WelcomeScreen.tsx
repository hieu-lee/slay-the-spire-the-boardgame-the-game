import { useEffect, useRef, useState, type ReactNode } from 'react'
import { assetPath } from '../game/assets.ts'
import { registerProfile, savedProfile } from '../profile.ts'

export function WelcomeScreen({ children }: { children: ReactNode }) {
  const [profile, setProfile] = useState(savedProfile)
  const [revealed, setRevealed] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const [username, setUsername] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (profile || revealed) return
    const start = (event: KeyboardEvent) => {
      if (event.repeat) return
      event.preventDefault()
      setRevealed(true)
    }
    window.addEventListener('keydown', start)
    return () => window.removeEventListener('keydown', start)
  }, [profile, revealed])
  useEffect(() => { if (revealed) input.current?.focus() }, [revealed])
  if (profile) return children
  return <main className="welcome sts-scope">
    <img className="welcome__wallpaper" src={assetPath('menu/welcome-wallpaper.webp')} alt="" />
    {!revealed ? <button type="button" className="welcome__start" onClick={() => setRevealed(true)}>
      <span>Tap, click, or press any key to start</span>
    </button> : <form className="reward-screen reward-screen--loot welcome__panel" onSubmit={async (event) => {
      event.preventDefault()
      if (pending) return
      setPending(true)
      setError('')
      try { setProfile(await registerProfile(username)) }
      catch (cause) { setError(cause instanceof Error ? cause.message : 'The Spire is out of reach. Please try again.') }
      finally { setPending(false) }
    }}>
      <h1 className="reward-screen__title"><label htmlFor="welcome-name">How should we call you?</label></h1>
      <div className="reward-screen__players">
        <p>Your name will be remembered in the Spire.</p>
        <input ref={input} id="welcome-name" autoComplete="nickname" minLength={2} maxLength={24} required
          value={username} onChange={(event) => setUsername(event.target.value)}
          aria-describedby="welcome-hint welcome-error" disabled={pending} placeholder="Your username" />
        <p id="welcome-hint">2–24 letters, numbers, spaces, underscores or hyphens.</p>
        <p id="welcome-error" role="alert">{error}</p>
        <button type="submit" className="welcome__confirm" disabled={pending || username.trim().length < 2}
          aria-label={pending ? 'Reserving your name' : 'Confirm username'}><span aria-hidden="true">{pending ? '…' : '✓'}</span></button>
      </div>
    </form>}
  </main>
}
