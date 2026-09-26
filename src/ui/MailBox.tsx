import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  fetchMailDesk,
  fetchMailbox,
  MAIL_POLLING,
  MAX_LETTER_LENGTH,
  sendLetter,
  sendMailDeskReply,
  type Letter,
  type MailThread,
} from '../mail.ts'

const POLL_MS = 90_000
const FIRST_POLL_MS = 1_500

const stamp = (at: number) => new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
function lastFrom(letters: Letter[], from: Letter['from']) {
  for (let index = letters.length - 1; index >= 0; index -= 1) {
    const letter = letters[index]
    if (letter?.from === from) return letter.at
  }
  return 0
}

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
  const [admin, setAdmin] = useState(false)
  const [personalOpen, setPersonalOpen] = useState(false)
  const [personalUnread, setPersonalUnread] = useState(0)
  const [threads, setThreads] = useState<MailThread[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [status, setStatus] = useState<'idle' | 'loading' | 'sending'>('idle')
  const [error, setError] = useState('')
  const dialog = useRef<HTMLDialogElement | null>(null)
  const thread = useRef<HTMLOListElement | null>(null)
  const composer = useRef<HTMLTextAreaElement | null>(null)
  const requestVersion = useRef(0)
  const readThroughAt = useRef(0)

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
      fetchMailbox().then((mailbox) => {
        if (cancelled) return
        setAdmin(mailbox.admin)
        setUnread(mailbox.unread)
        setPersonalUnread(mailbox.personalUnread)
      }, () => {})
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

  useEffect(() => {
    if (!open || (admin && !personalOpen) || !(admin ? personalUnread : unread) || letters === null) return
    let cancelled = false
    const frame = requestAnimationFrame(() => {
      if (!dialog.current?.open) return
      fetchMailbox(true, readThroughAt.current).then((mailbox) => {
        if (cancelled) return
        if (admin) setPersonalUnread(mailbox.personalUnread)
        else setUnread(mailbox.unread)
      }, () => {})
    })
    return () => { cancelled = true; cancelAnimationFrame(frame) }
  }, [open, admin, personalOpen, personalUnread, unread, letters])

  const selectedUnread = threads?.find((mailThread) => mailThread.username === selected)?.unread ?? 0
  useEffect(() => {
    if (!open || !admin || !selected || !selectedUnread || letters === null) return
    let cancelled = false
    const frame = requestAnimationFrame(() => {
      if (!dialog.current?.open) return
      fetchMailDesk(selected, true, readThroughAt.current).then((desk) => {
        if (cancelled) return
        setUnread(desk.unread)
        setThreads((current) => current?.map((mailThread) => mailThread.username === selected
          ? { ...mailThread, unread: desk.threads[0]?.unread ?? 0 } : mailThread) ?? null)
      }, () => {})
    })
    return () => { cancelled = true; cancelAnimationFrame(frame) }
  }, [open, admin, selected, selectedUnread, letters])

  const openMailbox = useCallback(() => {
    const request = ++requestVersion.current
    setOpen(true)
    setError('')
    setStatus('loading')
    setSelected(null)
    setPersonalOpen(false)
    setLetters(null)
    fetchMailbox().then(async (mailbox) => {
      if (request !== requestVersion.current || !dialog.current?.open) return
      setAdmin(mailbox.admin)
      setPersonalUnread(mailbox.personalUnread)
      if (mailbox.admin) {
        const desk = await fetchMailDesk()
        if (request !== requestVersion.current || !dialog.current?.open) return
        setThreads(desk.threads)
        setLetters(null)
        setUnread(desk.unread)
      } else {
        setThreads(null)
        readThroughAt.current = lastFrom(mailbox.letters, 'developer')
        setLetters(mailbox.letters)
        setUnread(mailbox.unread)
        requestAnimationFrame(() => composer.current?.focus())
      }
    }).catch((reason: unknown) => {
      if (request === requestVersion.current) setError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => { if (request === requestVersion.current) setStatus('idle') })
  }, [])

  const backToDesk = () => {
    setSelected(null)
    setPersonalOpen(false)
    setLetters(null)
    setDraft('')
    setError('')
    const request = ++requestVersion.current
    setThreads(null)
    setStatus('loading')
    fetchMailDesk().then((desk) => {
      if (request !== requestVersion.current || !dialog.current?.open) return
      setThreads(desk.threads)
      setUnread(desk.unread)
    }, (reason: unknown) => {
      if (request === requestVersion.current) setError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => { if (request === requestVersion.current) setStatus('idle') })
  }

  const openPersonal = () => {
    if (status !== 'idle') return
    const request = ++requestVersion.current
    setPersonalOpen(true)
    setLetters(null)
    setError('')
    setStatus('loading')
    fetchMailbox().then((mailbox) => {
      if (request !== requestVersion.current || !dialog.current?.open) return
      readThroughAt.current = lastFrom(mailbox.letters, 'developer')
      setLetters(mailbox.letters)
      setPersonalUnread(mailbox.personalUnread)
      setUnread(mailbox.unread)
    }, (reason: unknown) => {
      if (request === requestVersion.current) setError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => { if (request === requestVersion.current) setStatus('idle') })
  }

  const openThread = (username: string) => {
    if (status !== 'idle') return
    const request = ++requestVersion.current
    setStatus('loading')
    setError('')
    fetchMailDesk(username).then((desk) => {
      if (request !== requestVersion.current || !dialog.current?.open) return
      setSelected(username)
      const viewedLetters = desk.threads[0]?.letters ?? []
      readThroughAt.current = lastFrom(viewedLetters, 'player')
      setLetters(viewedLetters)
      setUnread(desk.unread)
      setThreads((current) => current?.map((mailThread) => mailThread.username === username
        ? { ...mailThread, unread: desk.threads[0]?.unread ?? 0 } : mailThread) ?? null)
      requestAnimationFrame(() => composer.current?.focus())
    }, (reason: unknown) => {
      if (request === requestVersion.current) setError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => { if (request === requestVersion.current) setStatus('idle') })
  }

  const send = () => {
    const body = draft.trim()
    if (!body || status !== 'idle') return
    const request = requestVersion.current
    setStatus('sending')
    setError('')
    if (admin && !selected) return
    const delivery = selected ? sendMailDeskReply(selected, body) : sendLetter(body)
    delivery.then((mailbox) => {
      if (request !== requestVersion.current || !dialog.current?.open) return
      if ('threads' in mailbox) {
        const updated = mailbox.threads[0]
        const last = updated?.letters?.at(-1)
        readThroughAt.current = lastFrom(updated?.letters ?? [], 'player')
        setLetters(updated?.letters ?? [])
        setUnread(mailbox.unread)
        if (updated && last) setThreads((current) => current ? current.map((mailThread) => mailThread.username === updated.username
          ? { ...mailThread, unread: updated.unread, lastAt: last.at, lastFrom: last.from, preview: last.body.slice(0, 120) }
          : mailThread).sort((left, right) => right.lastAt - left.lastAt) : null)
      } else {
        readThroughAt.current = lastFrom(mailbox.letters, 'developer')
        setLetters(mailbox.letters)
        setUnread(mailbox.unread)
      }
      setDraft('')
    }, (reason: unknown) => {
      if (request === requestVersion.current) setError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => { if (request === requestVersion.current) setStatus('idle') })
  }

  const totalUnread = unread + (admin ? personalUnread : 0)
  const badge = totalUnread > 99 ? '99+' : String(totalUnread)
  return (
    <>
      <button type="button" className="mailbox__open" onClick={openMailbox}
        aria-label={totalUnread ? `Mail, ${totalUnread} unread` : 'Mail'} title="Mail">
        <Envelope />
        {totalUnread ? <span className="mailbox__badge" aria-hidden="true">{badge}</span> : null}
      </button>
      <dialog ref={dialog} className="mailbox" aria-labelledby="mailbox-title"
        onCancel={(event) => { if (status === 'sending') event.preventDefault() }}
        onClose={() => { requestVersion.current += 1; setOpen(false); setSelected(null); setPersonalOpen(false) }}>
        <div className="mailbox__panel">
          <header className="mailbox__header">
            {admin && (selected || personalOpen) ? <button type="button" className="mailbox__back" aria-label="Back to server mail"
              disabled={status === 'sending'} onClick={backToDesk}>‹</button> : null}
            <h2 id="mailbox-title">{admin ? personalOpen ? 'Your letters' : selected ?? 'Server mail' : 'Letters'}</h2>
            <button type="button" className="mailbox__close" aria-label="Close" disabled={status === 'sending'}
              onClick={() => { requestVersion.current += 1; setOpen(false) }}>×</button>
          </header>
          {admin && !selected && !personalOpen ? <ol className="mailbox__threads" aria-label="Server mail" aria-busy={status === 'loading' || undefined}>
            <li className="mailbox__personal"><button type="button" onClick={openPersonal}>
              <strong>Your letters</strong>
              <small>{personalUnread ? `${personalUnread} new` : 'Personal mail'}</small>
            </button></li>
            {threads?.length ? threads.map((mailThread) => <li key={mailThread.username}>
              <button type="button" onClick={() => openThread(mailThread.username)}>
                <strong>{mailThread.username}</strong>
                <span>{mailThread.preview}</span>
                <small>{mailThread.unread ? `${mailThread.unread} new` : mailThread.lastFrom === 'player' ? 'Unanswered' : 'Answered'} · {stamp(mailThread.lastAt)}</small>
              </button>
            </li>) : status === 'loading' ? null : <li className="mailbox__empty">No player letters yet.</li>}
          </ol> : <ol className="mailbox__thread" ref={thread} aria-label="Letters" aria-busy={status === 'loading' || undefined}>
              {letters?.length ? letters.map((letter) => (
                <li key={letter.id} className={`mailbox__letter mailbox__letter--${letter.from}`}>
                  <p>{letter.body}</p>
                  <small>{admin && !personalOpen
                    ? letter.from === 'developer' ? 'You' : selected
                    : letter.from === 'developer' ? 'Developer' : 'You'} · {stamp(letter.at)}</small>
                </li>
              )) : status === 'loading' ? null : <li className="mailbox__empty">{personalOpen ? 'No personal letters yet.' : admin ? 'This thread is empty.' : 'Bugs, ideas, a kind word — write to the developer.'}</li>}
            </ol>}
          {error ? <p className="mailbox__error" role="alert">{error}</p> : null}
          {!admin || selected ? <form className="mailbox__compose" onSubmit={(event) => { event.preventDefault(); send() }}>
              <label className="visually-hidden" htmlFor="mailbox-draft">{admin && selected ? `Reply to ${selected}` : 'Your letter'}</label>
              <textarea id="mailbox-draft" ref={composer} value={draft} maxLength={MAX_LETTER_LENGTH} rows={3}
                placeholder={admin && selected ? `Reply to ${selected}…` : 'Dear developer…'} onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); send() }
                }} />
              <div className="mailbox__compose-foot">
                <span className="mailbox__count" aria-hidden={draft.length < MAX_LETTER_LENGTH - 200 || undefined}>
                  {draft.length >= MAX_LETTER_LENGTH - 200 ? `${draft.length}/${MAX_LETTER_LENGTH}` : ''}
                </span>
                <button type="submit" className="mailbox__send" disabled={!draft.trim() || status !== 'idle'}>
                  {status === 'sending' ? 'Sending…' : admin && selected ? 'Reply' : 'Send'}
                </button>
              </div>
            </form> : null}
        </div>
      </dialog>
    </>
  )
}
