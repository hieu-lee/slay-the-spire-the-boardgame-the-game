import { createHash, randomUUID } from 'node:crypto'

// Letters between a player and the developer. One thread per profile, keyed by
// username and bound to a hash of the profile's claim token: the token itself
// never reaches the archive, and a thread that outlives its profile (a restored
// backup, a reset registry) cannot be read by whoever claims the name next.

export const MAX_LETTER_LENGTH = 2_000
export const MAX_THREAD_LETTERS = 100
/** Player letters in a row with no reply; the next one waits for an answer. */
export const MAX_UNANSWERED_LETTERS = 20
export const MAX_THREADS = 20_000
/** Every letter body together. The archive is one JSON file on the host. */
export const MAX_MAIL_CHARACTERS = 8_000_000

const invalid = (message, status = 400) => { throw Object.assign(new Error(message), { status }) }
// C0 and C1 controls and bidirectional overrides: letters are printed raw in the
// developer's terminal, where these would run as escape sequences or reorder text.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g
const nameKey = (name) => name.normalize('NFKC').toLowerCase()
export const ownerOf = (token) => createHash('sha256').update(`sts-mail:${token}`).digest('hex')

function letterBody(value) {
  const body = typeof value === 'string' ? value.normalize('NFC').replace(/\r\n?/g, '\n').replace(CONTROL, '').trim() : ''
  if (!body) invalid('Write something first.')
  if (body.length > MAX_LETTER_LENGTH) invalid(`Keep letters under ${MAX_LETTER_LENGTH} characters.`)
  return body
}

export function restoreMail(saved) {
  if (!Array.isArray(saved)) return []
  return saved.filter((thread) => typeof thread?.username === 'string' && Array.isArray(thread.letters)).map((thread) => ({
    username: thread.username,
    owner: typeof thread.owner === 'string' ? thread.owner : '',
    letters: thread.letters.filter((letter) => typeof letter?.id === 'string' && typeof letter.body === 'string' &&
      (letter.from === 'player' || letter.from === 'developer') && Number.isFinite(letter.at)).slice(-MAX_THREAD_LETTERS),
    playerReadAt: Number.isFinite(thread.playerReadAt) ? thread.playerReadAt : 0,
    developerReadAt: Number.isFinite(thread.developerReadAt) ? thread.developerReadAt : 0,
  }))
}

/** The registered profile for a name typed in any case. */
function profileNamed(profiles, name) {
  if (typeof name !== 'string' || !name.trim()) return undefined
  const key = nameKey(name.trim())
  return profiles.find((profile) => nameKey(profile.username) === key)
}

const threadOf = (mail, username) => mail.find((thread) => thread.username === username)
/** The profile's own thread; one left behind by an earlier owner of the name is not theirs. */
const ownThread = (mail, profile) => {
  const thread = threadOf(mail, profile.username)
  return thread && thread.owner === ownerOf(profile.token) ? thread : undefined
}
const characters = (mail) => mail.reduce((sum, thread) => sum + thread.letters.reduce((total, letter) => total + letter.body.length, 0), 0)

function unreadFor(thread, reader) {
  if (!thread) return 0
  const from = reader === 'player' ? 'developer' : 'player'
  const readAt = reader === 'player' ? thread.playerReadAt : thread.developerReadAt
  return thread.letters.filter((letter) => letter.from === from && letter.at > readAt).length
}

const publicLetters = (thread) => (thread?.letters ?? []).map(({ id, from, body, at }) => ({ id, from, body, at }))

/** What a player may see: their own letters and the developer's replies. */
export function playerInbox(mail, profile, { markRead = false, now = Date.now() } = {}) {
  const thread = ownThread(mail, profile)
  const unread = unreadFor(thread, 'player')
  if (markRead && thread && unread) thread.playerReadAt = now
  return { letters: publicLetters(thread), unread: markRead ? 0 : unread, changed: markRead && unread > 0 }
}

function append(mail, profile, from, value, now, maxCharacters) {
  const body = letterBody(value)
  const owner = ownerOf(profile.token)
  let thread = threadOf(mail, profile.username)
  if (thread && thread.owner !== owner) invalid('That name belonged to someone else here. Please choose another name.', 409)
  if (from === 'player' && thread) {
    const lastReply = thread.letters.findLastIndex((letter) => letter.from === 'developer')
    if (thread.letters.length - 1 - lastReply >= MAX_UNANSWERED_LETTERS) invalid('Your letters are waiting to be read. Please wait for a reply.', 429)
  }
  if (characters(mail) + body.length > maxCharacters) invalid('The mailbox is full. Please try again later.', 503)
  if (!thread) {
    if (mail.length >= MAX_THREADS) invalid('The mailbox is full. Please try again later.', 503)
    thread = { username: profile.username, owner, letters: [], playerReadAt: 0, developerReadAt: 0 }
    mail.push(thread)
  }
  const letter = { id: randomUUID(), from, body, at: now }
  thread.letters.push(letter)
  const trimmed = thread.letters.length > MAX_THREAD_LETTERS ? thread.letters.splice(0, thread.letters.length - MAX_THREAD_LETTERS) : []
  return () => {
    const at = thread.letters.indexOf(letter)
    if (at >= 0) thread.letters.splice(at, 1)
    thread.letters.unshift(...trimmed)
    if (thread.letters.length === 0) mail.splice(mail.indexOf(thread), 1)
  }
}

/** Appends a player's letter; the returned `undo` takes it back if it could not be saved. */
export function sendPlayerLetter(mail, profile, body, { now = Date.now(), maxCharacters = MAX_MAIL_CHARACTERS } = {}) {
  const undo = append(mail, profile, 'player', body, now, maxCharacters)
  return { ...playerInbox(mail, profile, { now }), undo }
}

export function sendDeveloperReply(mail, name, body, profiles, { now = Date.now(), maxCharacters = MAX_MAIL_CHARACTERS } = {}) {
  const profile = profileNamed(profiles, name)
  if (!profile) invalid('No player by that name.', 404)
  const undo = append(mail, profile, 'developer', body, now, maxCharacters)
  return { username: profile.username, letters: threadOf(mail, profile.username).letters.length, undo }
}

/** Threads newest first, each with how many player letters the developer has not read. */
export function developerInbox(mail, profiles, { username: name, markRead = false, now = Date.now() } = {}) {
  const username = name === undefined ? undefined : profileNamed(profiles, name)?.username ?? name
  const threads = username === undefined ? mail : mail.filter((thread) => thread.username === username)
  let changed = false
  const summary = threads.map((thread) => {
    const unread = unreadFor(thread, 'developer')
    if (markRead && unread) {
      thread.developerReadAt = now
      changed = true
    }
    return {
      username: thread.username,
      unread,
      lastAt: thread.letters.at(-1)?.at ?? 0,
      lastFrom: thread.letters.at(-1)?.from,
      ...(username === undefined ? { preview: thread.letters.at(-1)?.body.slice(0, 120) } : { letters: publicLetters(thread) }),
    }
  })
  return { threads: summary.sort((left, right) => right.lastAt - left.lastAt), changed }
}
