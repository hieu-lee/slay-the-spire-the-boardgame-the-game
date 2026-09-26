import { savedProfile, type Profile } from './profile.ts'
import { resetRoomEndpoint, roomUrl } from './multiplayer/room-endpoint.ts'

const REQUEST_TIMEOUT_MS = 8_000
/** Matches the room server's limit in scripts/lib/mail.mjs. */
export const MAX_LETTER_LENGTH = 2_000

export type Letter = { id: string; from: 'player' | 'developer'; body: string; at: number }
export type Mailbox = { letters: Letter[]; unread: number }

/**
 * Only a hosted build polls on its own. A local build's `/api` is a dev proxy
 * that is usually pointing at nothing, and a background request failing on
 * every menu visit would be noise; opening the mailbox still asks.
 */
export const MAIL_POLLING = import.meta.env.VITE_HOSTED_SESSION === 'true' || import.meta.env.VITE_MAIL === 'true'

type Reply = { status: number; body: Record<string, unknown> }

async function post(path: string, body: Record<string, unknown>): Promise<Reply> {
  try {
    const response = await fetch(await roomUrl(path), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    return { status: response.status, body: await response.json().catch(() => ({})) }
  } catch {
    resetRoomEndpoint()
    throw new Error('The post office is closed right now. Try again later.')
  }
}

function mailbox({ status, body }: Reply): Mailbox {
  if (status < 200 || status >= 300) throw new Error(typeof body.error === 'string' ? body.error : 'The letter could not be delivered.')
  return { letters: Array.isArray(body.letters) ? body.letters as Letter[] : [], unread: Number(body.unread) || 0 }
}

function profile(): Profile {
  const saved = savedProfile()
  if (!saved) throw new Error('Choose a name before writing a letter.')
  return saved
}

export async function fetchMailbox(markRead = false): Promise<Mailbox> {
  return mailbox(await post('/api/mail', { token: profile().token, markRead }))
}

export async function sendLetter(body: string): Promise<Mailbox> {
  const { username, token } = profile()
  const sent = await post('/api/mail/send', { token, body })
  if (sent.status !== 409 || sent.body.code !== 'profile') return mailbox(sent)
  // A server that has lost this browser's name (a reset store, another host)
  // takes the same claim again, and the letter goes out on the second try.
  const claimed = await post('/api/profile', { username, token })
  if (claimed.status !== 200) throw new Error(typeof claimed.body.error === 'string' ? claimed.body.error : 'Your name could not be registered.')
  return mailbox(await post('/api/mail/send', { token, body }))
}
