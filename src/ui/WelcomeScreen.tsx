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
  const choose = (next: Mode) => { setMode(next); setSwitching(true); setError(''); setPassword(''); setShowPassword(false) }
  const creating = securing || mode === 'create'
  const title = securing ? 'Create a password' : mode === 'login' ? 'Log in' : 'Create your account'
  const submitLabel = securing ? 'Save password' : mode === 'login' ? 'Log in' : 'Create account'
  const ready = password.length >= MIN_PASSWORD_LENGTH && (securing || username.trim().length >= 2)
  return <main className="welcome sts-scope" data-editing={editing}>
    <img className="welcome__wallpaper" src={assetPath('menu/welcome-wallpaper.webp')} alt="" />
    {!revealed ? <button type="button" className="welcome__start" onClick={() => setRevealed(true)}>
      <span>Tap, click, or press any key to start</span>
    </button> : <form className="reward-screen reward-screen--loot welcome__panel" onSubmit={async (event) => {
      event.preventDefault()
      if (pending || !ready) return
      // Mask the field again so password managers see a password field when the form is sent.
      setShowPassword(false)
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
        <div className="welcome__field">
          <input ref={securing ? firstField : undefined} id="welcome-password" aria-label="Password" type={showPassword ? 'text' : 'password'}
            autoComplete={creating ? 'new-password' : 'current-password'} minLength={creating ? MIN_PASSWORD_LENGTH : 1} maxLength={MAX_PASSWORD_LENGTH} required
            value={password} onFocus={() => setEditing(true)} onChange={(event) => setPassword(event.target.value)}
            aria-describedby="welcome-hint welcome-error" disabled={pending} placeholder={creating ? `Password (${MIN_PASSWORD_LENGTH}+)` : 'Your password'} />
          <button type="button" className="welcome__reveal" aria-label="Show password" aria-pressed={showPassword} disabled={pending}
            onPointerDown={(event) => event.preventDefault()} onClick={() => setShowPassword((shown) => !shown)}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" />{showPassword ? <path d="M4 20 20 4" /> : null}</svg>
          </button>
        </div>
        <p id="welcome-hint">{creating ? `${securing ? '' : '2–24 letters, numbers, spaces, underscores or hyphens. '}Password: at least ${MIN_PASSWORD_LENGTH} characters.` : ''}</p>
        <p id="welcome-error" role="alert">{error}</p>
        <button type="submit" className="welcome__confirm" disabled={pending || !ready}>{pending ? 'Please wait…' : submitLabel}</button>
        <p className="welcome__switch">
          {securing || mode === 'create'
            ? <button type="button" className="welcome__link" disabled={pending} onClick={() => choose('login')}>{securing ? <strong>Use a different account</strong> : <>Already have an account? <strong>Log in</strong></>}</button>
            : <button type="button" className="welcome__link" disabled={pending} onClick={() => choose('create')}>New here? <strong>Create an account</strong></button>}
        </p>
      </div>
    </form>}
  </main>
}
