import { useEffect, useRef, useState, type ReactNode } from 'react'
import { assetPath } from '../game/assets.ts'
import { logIn, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, onProfileChange, registerProfile, savedProfile, secureProfile } from '../profile.ts'

type Mode = 'create' | 'login'

export function WelcomeScreen({ children }: { children: ReactNode }) {
  const [profile, setProfile] = useState(savedProfile)
  const [revealed, setRevealed] = useState(false)
  const firstField = useRef<HTMLInputElement>(null)
  const startedWithKeyboard = useRef(false)
  const [mode, setMode] = useState<Mode>('create')
  // A profile from before passwords existed is asked for one before the game opens.
  const [switching, setSwitching] = useState(false)
  const securing = Boolean(profile) && !profile?.secured && !switching
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [editing, setEditing] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => onProfileChange(() => { setProfile(savedProfile()); setSwitching(false); setMode('create'); setUsername(''); setPassword(''); setShowPassword(false) }), [])
  const gated = !profile || !profile.secured
  useEffect(() => {
    if (!gated || revealed) return
    const start = (event: KeyboardEvent) => {
      if (event.repeat) return
      event.preventDefault()
      startedWithKeyboard.current = true
      setRevealed(true)
    }
    window.addEventListener('keydown', start)
    return () => window.removeEventListener('keydown', start)
  }, [gated, revealed])
  useEffect(() => {
    if (revealed && gated && (startedWithKeyboard.current || !matchMedia('(pointer: coarse)').matches)) firstField.current?.focus()
  }, [revealed, gated, securing, mode])
  if (!gated) return children
  const choose = (next: Mode) => { setMode(next); setSwitching(true); setError(''); setPassword('') }
  const creating = securing || mode === 'create'
  const title = securing ? 'Create a password' : mode === 'login' ? 'Log in' : 'Create your account'
  const ready = password.length >= MIN_PASSWORD_LENGTH && (securing || username.trim().length >= 2)
  return <main className="welcome sts-scope" data-editing={editing}>
    <img className="welcome__wallpaper" src={assetPath('menu/welcome-wallpaper.webp')} alt="" />
    {!revealed ? <button type="button" className="welcome__start" onClick={() => setRevealed(true)}>
      <span>Tap, click, or press any key to start</span>
    </button> : <form className="reward-screen reward-screen--loot welcome__panel" onSubmit={async (event) => {
      event.preventDefault()
      if (pending || !ready) return
      setPending(true)
      setError('')
      try {
        // Saving the profile notifies the listener above, which updates the screen.
        if (securing && profile) await secureProfile(profile, password)
        else if (mode === 'login') await logIn(username, password)
        else await registerProfile(username, password)
      } catch (cause) { setError(cause instanceof Error ? cause.message : 'The Spire is out of reach. Please try again.') }
      finally { setPending(false) }
    }}>
      <h1 className="reward-screen__title">{title}</h1>
      <div className="reward-screen__players">
        {securing ? <p>Welcome back, <strong>{profile?.username}</strong>. Accounts now have passwords, so create one to keep this name safe.</p>
          : <p>{mode === 'login' ? 'Welcome back to the Spire.' : 'Your name will be remembered in the Spire.'}</p>}
        {securing ? null : <input ref={firstField} id="welcome-name" aria-label="Username" autoComplete="username" minLength={2} maxLength={24} required
          value={username} onFocus={() => setEditing(true)} onChange={(event) => setUsername(event.target.value)}
          aria-describedby="welcome-hint welcome-error" disabled={pending} placeholder="Your username" />}
        <input ref={securing ? firstField : undefined} id="welcome-password" aria-label="Password" type={showPassword ? 'text' : 'password'}
          autoComplete={creating ? 'new-password' : 'current-password'} minLength={creating ? MIN_PASSWORD_LENGTH : 1} maxLength={MAX_PASSWORD_LENGTH} required
          value={password} onFocus={() => setEditing(true)} onChange={(event) => setPassword(event.target.value)}
          aria-describedby="welcome-hint welcome-error" disabled={pending} placeholder={creating ? `Create a password (${MIN_PASSWORD_LENGTH}+ characters)` : 'Your password'} />
        <p id="welcome-hint">{creating ? `${securing ? '' : '2–24 letters, numbers, spaces, underscores or hyphens. '}Password: at least ${MIN_PASSWORD_LENGTH} characters.` : ''}</p>
        <p id="welcome-error" role="alert">{error}</p>
        <button type="submit" className="welcome__confirm" disabled={pending || !ready}
          aria-label={pending ? 'Please wait' : securing ? 'Save password' : mode === 'login' ? 'Log in' : 'Create account'}><span aria-hidden="true">{pending ? '…' : '✓'}</span></button>
        <div className="welcome__links">
          <button type="button" onClick={() => setShowPassword((shown) => !shown)}>{showPassword ? 'Hide password' : 'Show password'}</button>
          {securing || mode === 'create'
            ? <button type="button" disabled={pending} onClick={() => choose('login')}>{securing ? 'Use a different account' : 'Already have an account? Log in'}</button>
            : <button type="button" disabled={pending} onClick={() => choose('create')}>New here? Create an account</button>}
        </div>
      </div>
    </form>}
  </main>
}
