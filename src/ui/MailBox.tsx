import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { fetchMailbox, MAIL_POLLING, MAX_LETTER_LENGTH, sendLetter, type Letter } from '../mail.ts'

const POLL_MS = 90_000
const FIRST_POLL_MS = 1_500

const stamp = (at: number) => new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

function Envelope() {
  return (
    <svg className="mailbox__envelope" viewBox="0 0 64 48" aria-hidden="true" focusable="false">
      <path className="mailbox__envelope-back" d="M4 8.5C4 5.5 6.4 3 9.5 3h45C57.6 3 60 5.5 60 8.5v31c0 3-2.4 5.5-5.5 5.5h-45C6.4 45 4 42.5 4 39.5z" />
      <path className="mailbox__envelope-fold" d="M6 41.5 26.5 24M58 41.5 37.5 24" />
      <path className="mailbox__envelope-flap" d="M5.5 6.5 32 28 58.5 6.5" />
      <circle className="mailbox__envelope-seal" cx="32" cy="27" r="7" />
      <path className="mailbox__envelope-sigil" d="M32 22.5 35 27l-3 4.5-3-4.5z" />
    </svg>
  )
}

/**
 * Letters to the developer, from the main menu's top-right corner. The badge
 * counts replies the player has not opened yet.
 */
export function MailBox() {
  const [open, setOpen] = useState(false)
  const [unread, setUnread] = useState(0)
  const [letters, setLetters] = useState<Letter[] | null>(null)
  const [draft, setDraft] = useState('')
  const [status, setStatus] = useState<'idle' | 'loading' | 'sending'>('idle')
  const [error, setError] = useState('')
  const dialog = useRef<HTMLDialogElement | null>(null)
  const thread = useRef<HTMLOListElement | null>(null)
  const composer = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    const element = dialog.current
    if (!element) return
    if (open) { if (!element.open) element.showModal() } else if (element.open) element.close()
  }, [open])

  useEffect(() => {
    if (!MAIL_POLLING || open) return undefined
    let cancelled = false
    const check = () => {
      if (document.visibilityState !== 'visible') return
      fetchMailbox().then((mailbox) => { if (!cancelled) setUnread(mailbox.unread) }, () => {})
    }
    const first = window.setTimeout(check, FIRST_POLL_MS)
    const poll = window.setInterval(check, POLL_MS)
    document.addEventListener('visibilitychange', check)
    return () => {
      cancelled = true
      window.clearTimeout(first)
      window.clearInterval(poll)
      document.removeEventListener('visibilitychange', check)
    }
  }, [open])

  useLayoutEffect(() => {
    const list = thread.current
    if (list) list.scrollTop = list.scrollHeight
  }, [letters])

  const openMailbox = useCallback(() => {
    setOpen(true)
    setError('')
    setStatus('loading')
    fetchMailbox(true).then((mailbox) => {
      setLetters(mailbox.letters)
      setUnread(0)
    }, (reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => {
      setStatus('idle')
      requestAnimationFrame(() => composer.current?.focus())
    })
  }, [])

  const send = () => {
    const body = draft.trim()
    if (!body || status !== 'idle') return
    setStatus('sending')
    setError('')
    sendLetter(body).then((mailbox) => {
      setLetters(mailbox.letters)
      setDraft('')
    }, (reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => setStatus('idle'))
  }

  const badge = unread > 99 ? '99+' : String(unread)
  return (
    <>
      <button type="button" className="mailbox__open" onClick={openMailbox}
        aria-label={unread ? `Mail, ${unread} unread` : 'Mail'} title="Mail">
        <Envelope />
        {unread ? <span className="mailbox__badge" aria-hidden="true">{badge}</span> : null}
      </button>
      <dialog ref={dialog} className="mailbox" aria-labelledby="mailbox-title" onClose={() => setOpen(false)}>
        <div className="mailbox__panel">
          <header className="mailbox__header">
            <h2 id="mailbox-title">Letters</h2>
            <button type="button" className="mailbox__close" aria-label="Close" onClick={() => setOpen(false)}>×</button>
          </header>
          <ol className="mailbox__thread" ref={thread} aria-label="Letters" aria-busy={status === 'loading' || undefined}>
            {letters?.length ? letters.map((letter) => (
              <li key={letter.id} className={`mailbox__letter mailbox__letter--${letter.from}`}>
                <p>{letter.body}</p>
                <small>{letter.from === 'developer' ? 'Developer' : 'You'} · {stamp(letter.at)}</small>
              </li>
            )) : status === 'loading' ? null : <li className="mailbox__empty">Bugs, ideas, a kind word — write to the developer.</li>}
          </ol>
          {error ? <p className="mailbox__error" role="alert">{error}</p> : null}
          <form className="mailbox__compose" onSubmit={(event) => { event.preventDefault(); send() }}>
            <label className="visually-hidden" htmlFor="mailbox-draft">Your letter</label>
            <textarea id="mailbox-draft" ref={composer} value={draft} maxLength={MAX_LETTER_LENGTH} rows={3}
              placeholder="Dear developer…" onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); send() }
              }} />
            <div className="mailbox__compose-foot">
              <span className="mailbox__count" aria-hidden={draft.length < MAX_LETTER_LENGTH - 200 || undefined}>
                {draft.length >= MAX_LETTER_LENGTH - 200 ? `${draft.length}/${MAX_LETTER_LENGTH}` : ''}
              </span>
              <button type="submit" className="mailbox__send" disabled={!draft.trim() || status !== 'idle'}>
                {status === 'sending' ? 'Sending…' : 'Send'}
              </button>
            </div>
          </form>
        </div>
      </dialog>
    </>
  )
}
