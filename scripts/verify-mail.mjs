// The developer mailbox on the room server: players write with their profile
// token, the developer answers with an admin token, and nothing crosses between
// players' threads.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRoomServer } from './room-server.mjs'
import { createStore, saveStore } from './lib/rooms.mjs'
import {
  MAX_LETTER_LENGTH, MAX_THREAD_LETTERS, MAX_UNANSWERED_LETTERS, WELCOME_LETTER, developerInbox, ownerOf, playerInbox, sendDeveloperReply, sendPlayerLetter,
} from './lib/mail.mjs'
import { suite, check, assert, assertEqual, report } from './lib/harness.mjs'

suite('developer mail')

const adminToken = 'mail-admin-token-for-verification-0001'
const ann = { username: 'Ann', token: crypto.randomUUID() }
const bob = { username: 'Bob', token: crypto.randomUUID() }
const directory = mkdtempSync(join(tmpdir(), 'sts-mail-'))
const storeFile = join(directory, 'rooms.json')
let failSaves = false
const start = async (options = {}) => {
  const service = createRoomServer({
    storeFile, saveDelayMs: 5, mailAdminToken: adminToken, mailAdminOwners: [ownerOf(ann.token)], onSaveError: () => {},
    saveStoreImpl: (store) => { if (failSaves) throw new Error('disk full'); saveStore(store) },
    ...options,
  })
  const address = await service.listen(0)
  return { service, origin: `http://127.0.0.1:${address.port}` }
}
let { service, origin } = await start()

async function call(path, { method = 'POST', body, admin, source } = {}) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(admin ? { authorization: `Bearer ${admin}` } : {}),
      ...(source ? { 'cf-connecting-ip': source } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: response.status, body: await response.json() }
}

for (const profile of [ann, bob]) assertEqual((await call('/api/profile', { body: profile })).status, 200)

const unknown = await call('/api/mail', { body: { token: crypto.randomUUID() } })
const adminEmpty = await call('/api/mail', { body: { token: ann.token } })
check('an unregistered visitor reads an empty mailbox instead of an error', () => {
  assertEqual(unknown.status, 200)
  assertEqual(unknown.body.letters.length, 0)
  assertEqual(unknown.body.unread, 0)
  assertEqual(unknown.body.admin, false)
  assertEqual(adminEmpty.body.admin, true)
  assertEqual(adminEmpty.body.letters.length, 0, 'a delegated account received the player welcome letter')
})

const sent = await call('/api/mail/send', { body: { token: ann.token, body: '  The Lab die\u0007 rolled a 7?\r\nKidding.  ' } })
const empty = await call('/api/mail/send', { body: { token: ann.token, body: ' \u0001  ' } })
const long = await call('/api/mail/send', { body: { token: ann.token, body: 'x'.repeat(MAX_LETTER_LENGTH + 1) } })
const stranger = await call('/api/mail/send', { body: { token: crypto.randomUUID(), body: 'Hello' } })
const bobFirst = await call('/api/mail/send', { body: { token: bob.token, body: 'Bob here.' } })
check('players send cleaned letters and are refused empty, oversized or unregistered ones', () => {
  assertEqual(sent.status, 201)
  assertEqual(sent.body.letters.length, 1)
  assertEqual(sent.body.letters[0].from, 'player')
  assertEqual(sent.body.letters[0].body, 'The Lab die rolled a 7?\nKidding.')
  assertEqual(empty.status, 400)
  assertEqual(long.status, 400)
  assertEqual(stranger.status, 409)
  assertEqual(stranger.body.code, 'profile')
  assertEqual(bobFirst.status, 201)
  assertEqual(bobFirst.body.letters.length, 1, 'Bob saw a letter that is not his')
})

const noToken = await call('/api/mail/admin', { method: 'GET' })
const wrongToken = await call('/api/mail/admin', { method: 'GET', admin: `${adminToken}x`, source: '203.0.113.9' })
const wrongMethod = await call('/api/mail/admin/reply', { method: 'GET', admin: adminToken })
const listed = await call('/api/mail/admin', { method: 'GET', admin: adminToken })
const delegated = await call('/api/mail/desk', { body: { token: ann.token } })
const ordinary = await call('/api/mail/desk', { body: { token: bob.token } })
const forged = await call('/api/mail/desk', { body: { token: crypto.randomUUID() } })
check('only the admin token lists threads, each with its unread count', () => {
  assertEqual(noToken.status, 401)
  assertEqual(wrongToken.status, 401)
  assertEqual(wrongMethod.status, 405)
  assertEqual(listed.status, 200)
  assertEqual(listed.body.threads.map((thread) => thread.username).sort().join(','), 'Ann,Bob')
  const annThread = listed.body.threads.find((thread) => thread.username === 'Ann')
  assertEqual(annThread.unread, 1)
  assert(annThread.preview.startsWith('The Lab die'), 'the thread list did not preview the letter')
  assertEqual(annThread.letters, undefined, 'the thread list sent whole threads')
})
check('only owner-bound delegated profiles can open the in-game server mailbox', () => {
  assertEqual(delegated.status, 200)
  assertEqual(delegated.body.unread, 2)
  assertEqual(delegated.body.threads.map((thread) => thread.username).sort().join(','), 'Ann,Bob')
  assertEqual(delegated.body.threads[0].letters, undefined, 'the delegated thread list sent whole threads')
  assertEqual(ordinary.status, 403)
  assertEqual(forged.status, 403)
})

const newcomer = { username: 'NewPlayer', token: crypto.randomUUID() }
await call('/api/profile', { body: newcomer })
const welcomed = await call('/api/mail', { body: { token: newcomer.token } })
const welcomedAgain = await call('/api/mail', { body: { token: newcomer.token } })
const welcomeRead = await call('/api/mail', { body: { token: newcomer.token, markRead: true } })
const welcomeOnlyAdminList = await call('/api/mail/admin', { method: 'GET', admin: adminToken })
check('a non-admin empty mailbox receives one persisted welcome letter', () => {
  assertEqual(welcomed.status, 200)
  assertEqual(welcomed.body.unread, 1)
  assertEqual(welcomed.body.letters.length, 1)
  assertEqual(welcomed.body.letters[0].from, 'developer')
  assertEqual(welcomed.body.letters[0].body, WELCOME_LETTER)
  assertEqual(welcomedAgain.body.letters.length, 1, 'checking again duplicated the welcome')
  assertEqual(welcomeRead.body.unread, 0)
  assert(!welcomeOnlyAdminList.body.threads.some((thread) => thread.username === newcomer.username),
    'a welcome-only thread cluttered the server inbox')
})

const readAnn = await call('/api/mail/admin?username=ann&markRead=true', { method: 'GET', admin: adminToken })
await call('/api/mail/send', { body: { token: ann.token, body: 'One more thing!' } })
const reply = await call('/api/mail/admin/reply', { admin: adminToken, body: { username: 'ANN', body: 'Fixed in the next build!' } })
const afterReply = await call('/api/mail/admin', { method: 'GET', admin: adminToken })
const missing = await call('/api/mail/admin/reply', { admin: adminToken, body: { username: 'Nobody', body: 'Hi' } })
check('the admin reads and replies in any letter case, and a reply never marks a newer letter read', () => {
  assertEqual(readAnn.body.threads.length, 1)
  assertEqual(readAnn.body.threads[0].username, 'Ann')
  assertEqual(readAnn.body.threads[0].letters.length, 1)
  assertEqual(reply.status, 201)
  assertEqual(reply.body.username, 'Ann')
  assertEqual(reply.body.undo, undefined)
  assertEqual(afterReply.body.threads.find((thread) => thread.username === 'Ann').unread, 1,
    'replying hid the letter Ann wrote after the last read')
  assertEqual(missing.status, 404)
})

const annUnread = await call('/api/mail', { body: { token: ann.token } })
const bobInbox = await call('/api/mail', { body: { token: bob.token } })
const annRead = await call('/api/mail', { body: { token: ann.token, markRead: true } })
const annAfter = await call('/api/mail', { body: { token: ann.token } })
check('a reply lands unread in that player\'s mailbox only, and opening it clears the count', () => {
  assertEqual(annUnread.body.personalUnread, 1)
  assertEqual(annUnread.body.letters.at(-1).from, 'developer')
  assertEqual(bobInbox.body.letters.map((letter) => letter.body).join('|'), 'Bob here.')
  assertEqual(bobInbox.body.unread, 0)
  assertEqual(annRead.body.personalUnread, 0)
  assertEqual(annRead.body.letters.length, 3)
  assertEqual(annAfter.body.personalUnread, 0)
  assertEqual(annAfter.body.admin, true)
})

const cara = { username: 'Cara', token: crypto.randomUUID() }
await call('/api/profile', { body: cara })
await call('/api/mail/send', { body: { token: cara.token, body: 'Can you see this?' } })
const delegatedRead = await call('/api/mail/desk', { body: { token: ann.token, username: 'cara', markRead: true } })
await call('/api/mail/send', { body: { token: cara.token, body: 'One more detail before you answer.' } })
const delegatedReply = await call('/api/mail/desk/reply', { body: { token: ann.token, username: 'CARA', body: 'Yes, from the game.' } })
const caraInbox = await call('/api/mail', { body: { token: cara.token } })
check('a delegated account reads and answers another player without the server admin token', () => {
  assertEqual(delegatedRead.status, 200)
  assertEqual(delegatedRead.body.threads[0].username, 'Cara')
  assertEqual(delegatedRead.body.threads[0].unread, 0)
  assertEqual(delegatedReply.status, 201)
  assertEqual(delegatedReply.body.username, 'Cara')
  assertEqual(delegatedReply.body.threads[0].unread, 1, 'replying hid a letter that arrived after the thread was read')
  assertEqual(delegatedReply.body.threads[0].letters.at(-1).body, 'Yes, from the game.')
  assertEqual(caraInbox.body.unread, 1)
  assertEqual(caraInbox.body.letters.at(-1).body, 'Yes, from the game.')
})

failSaves = true
const unsaved = await call('/api/mail/send', { body: { token: bob.token, body: 'This one is lost.' } })
failSaves = false
const bobAfterFailure = await call('/api/mail', { body: { token: bob.token } })
check('a letter that could not be saved is refused and not kept', () => {
  assertEqual(unsaved.status, 503)
  assertEqual(bobAfterFailure.body.letters.length, 1)
})

const statuses = []
for (let index = 0; index < 5; index += 1) {
  statuses.push((await call('/api/mail/send', { body: { token: bob.token, body: `Letter ${index}` } })).status)
}
const lockout = []
for (let index = 0; index < 10; index += 1) lockout.push((await call('/api/mail/admin', { method: 'GET', admin: 'guess', source: '198.51.100.7' })).status)
const lockedRight = await call('/api/mail/admin', { method: 'GET', admin: adminToken, source: '198.51.100.7' })
const otherSource = await call('/api/mail/admin', { method: 'GET', admin: adminToken, source: '198.51.100.8' })
check('one profile cannot flood the mailbox and repeated bad admin tokens lock their source out', () => {
  // Bob's first letter used one of five sends; the refused save gave its use back.
  assertEqual(statuses.join(','), '201,201,201,201,429')
  assert(lockout.every((status) => status === 401))
  assertEqual(lockedRight.status, 401, 'the right token still worked from a locked-out source')
  assertEqual(otherSource.status, 200)
})

await service.close()
;({ service, origin } = await start())
const restored = await call('/api/mail', { body: { token: ann.token } })
const main = JSON.parse(readFileSync(storeFile, 'utf8'))
const archive = readFileSync(`${storeFile}.mail.json`, 'utf8')
check('letters survive a restart in their own file, without any profile token', () => {
  assertEqual(restored.body.letters.length, 3)
  assertEqual(restored.body.letters[2].body, 'Fixed in the next build!')
  assertEqual(main.mail, undefined, 'the main room store carried the mail archive')
  assertEqual(JSON.parse(archive).length, 4)
  assert(!archive.includes(ann.token) && !archive.includes(bob.token), 'a profile token leaked into the mail archive')
})
await service.close()

// The mail file is written last and is only marked clean once written, so a
// failure writing it after the main store leaves nothing half-saved.
const sidecarDirectory = mkdtempSync(join(tmpdir(), 'sts-mail-sidecar-'))
const sidecarStore = join(sidecarDirectory, 'rooms.json')
const sidecar = createRoomServer({ storeFile: sidecarStore, saveDelayMs: 5, onSaveError: () => {} })
const sidecarAddress = await sidecar.listen(0)
const sidecarOrigin = `http://127.0.0.1:${sidecarAddress.port}`
const post = (path, body) => fetch(`${sidecarOrigin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const fay = { username: 'Fay', token: crypto.randomUUID() }
await post('/api/profile', fay)
const kept = await post('/api/mail/send', { token: fay.token, body: 'Kept.' })
mkdirSync(`${sidecarStore}.mail.json.tmp`)
const blocked = await post('/api/mail/send', { token: fay.token, body: 'Refused.' })
rmSync(`${sidecarStore}.mail.json.tmp`, { recursive: true })
const later = await post('/api/mail/send', { token: fay.token, body: 'Later.' })
await sidecar.close()
const onDisk = JSON.parse(readFileSync(`${sidecarStore}.mail.json`, 'utf8'))[0].letters.map((letter) => letter.body)
const withoutMain = mkdtempSync(join(tmpdir(), 'sts-mail-orphan-'))
writeFileSync(join(withoutMain, 'rooms.json.mail.json'), '[]')
let orphanRefused = false
try { createStore({ file: join(withoutMain, 'rooms.json') }) } catch { orphanRefused = true }
writeFileSync(`${sidecarStore}.mail.json`, '{not json')
let corruptRefused = false
try { createStore({ file: sidecarStore }) } catch { corruptRefused = true }
rmSync(sidecarDirectory, { recursive: true, force: true })
rmSync(withoutMain, { recursive: true, force: true })
check('the mail file never keeps a refused letter and never loads beside a missing or broken store', () => {
  assertEqual(kept.status, 201)
  assertEqual(blocked.status, 503)
  assertEqual(later.status, 201)
  assertEqual(onDisk.join('|'), 'Kept.|Later.')
  assert(orphanRefused, 'a mail archive without its room store loaded as a fresh server')
  assert(corruptRefused, 'a corrupt mail archive was replaced with an empty one')
})

const tiny = createRoomServer({ maxMailCharacters: 12 })
const tinyAddress = await tiny.listen(0)
const tinyOrigin = `http://127.0.0.1:${tinyAddress.port}`
const cat = { username: 'Cat', token: crypto.randomUUID() }
await fetch(`${tinyOrigin}/api/profile`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cat) })
const fits = await fetch(`${tinyOrigin}/api/mail/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: cat.token, body: 'Ten chars!' }) })
const full = await fetch(`${tinyOrigin}/api/mail/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: cat.token, body: 'Overflow' }) })
await tiny.close()
const closed = createRoomServer({ mailAdminToken: undefined })
const closedAddress = await closed.listen(0)
const disabled = await fetch(`http://127.0.0.1:${closedAddress.port}/api/mail/admin`, { headers: { authorization: 'Bearer anything' } })
const warnings = []
const warn = console.warn
console.warn = (message) => warnings.push(message)
const short = createRoomServer({ mailAdminToken: 'too-short' })
console.warn = warn
const shortAddress = await short.listen(0)
const shortRefused = await fetch(`http://127.0.0.1:${shortAddress.port}/api/mail/admin`, { headers: { authorization: 'Bearer too-short' } })
check('the archive has a total budget, and admin endpoints need a long enough configured token', () => {
  assertEqual(fits.status, 201)
  assertEqual(full.status, 503)
  assertEqual(disabled.status, 404)
  assertEqual(shortRefused.status, 404)
  assert(warnings.some((message) => String(message).includes('STS_MAIL_ADMIN_TOKEN')), 'a too-short token was ignored silently')
})
await closed.close()
await short.close()

check('a thread keeps its newest letters and waits for a reply after a run of unanswered ones', () => {
  const dee = { username: 'Dee', token: 'dee-token' }
  const profiles = [dee]
  const mail = []
  let now = 0
  for (let index = 0; index < MAX_UNANSWERED_LETTERS; index += 1) sendPlayerLetter(mail, dee, `Letter ${index}`, { now: ++now })
  let waited = null
  try { sendPlayerLetter(mail, dee, 'Too many', { now: ++now }) } catch (error) { waited = error.status }
  assertEqual(waited, 429)
  for (let round = 0; round < 10; round += 1) {
    sendDeveloperReply(mail, 'dee', `Reply ${round}`, profiles, { now: ++now })
    for (let index = 0; index < 10; index += 1) sendPlayerLetter(mail, dee, `Round ${round}.${index}`, { now: ++now })
  }
  const inbox = playerInbox(mail, dee)
  assertEqual(inbox.letters.length, MAX_THREAD_LETTERS)
  assertEqual(inbox.letters.at(-1).body, 'Round 9.9')
  assertEqual(developerInbox(mail, profiles).threads[0].unread, inbox.letters.filter((letter) => letter.from === 'player').length)
  const oldest = inbox.letters[0].id
  const { undo } = sendDeveloperReply(mail, 'Dee', 'Refused by the disk', profiles, { now: ++now })
  undo()
  const restored = playerInbox(mail, dee).letters
  assertEqual(restored.length, MAX_THREAD_LETTERS)
  assertEqual(restored[0].id, oldest, 'a refused letter cost the thread its oldest letter')
  assertEqual(restored.at(-1).body, 'Round 9.9')
})

check('letters are stripped of terminal controls and a thread never passes to the next owner of a name', () => {
  const eve = { username: 'Eve', token: 'eve-token' }
  const mail = []
  const { letters } = sendPlayerLetter(mail, eve, 'Hi\u009b31m \u202eevil\u202c there\ttab', { now: 1 })
  assertEqual(letters[0].body, 'Hi31m evil there\ttab')
  const heir = { username: 'Eve', token: 'another-token' }
  assertEqual(playerInbox(mail, heir).letters.length, 0, 'a new owner of the name read the old thread')
  let refused = null
  try { sendPlayerLetter(mail, heir, 'Mine now?', { now: 2 }) } catch (error) { refused = error.status }
  assertEqual(refused, 409)
  assertEqual(JSON.stringify(mail).includes('eve-token'), false, 'the claim token reached the archive')
})

check('same-millisecond letters stay unread and globally newest after a read cursor advances', () => {
  const ivy = { username: 'Ivy', token: 'ivy-token' }
  const jay = { username: 'Jay', token: 'jay-token' }
  const profiles = [ivy, jay]
  const mail = []
  sendPlayerLetter(mail, ivy, 'First', { now: 1_000 })
  developerInbox(mail, profiles, { username: ivy.username, markRead: true, now: 1_000 })
  sendPlayerLetter(mail, jay, 'Other thread', { now: 1_000 })
  sendPlayerLetter(mail, ivy, 'Same clock, actually later', { now: 1_000 })
  const developer = developerInbox(mail, profiles)
  assertEqual(developer.threads[0].username, ivy.username)
  assertEqual(developer.threads.find((thread) => thread.username === ivy.username).unread, 1)
  sendDeveloperReply(mail, ivy.username, 'First reply', profiles, { now: 1_000 })
  playerInbox(mail, ivy, { markRead: true, now: 1_000 })
  sendDeveloperReply(mail, ivy.username, 'Same clock, new reply', profiles, { now: 1_000 })
  assertEqual(playerInbox(mail, ivy).unread, 1)
})

check('the client, deploy archive and service unit agree with the server', () => {
  const client = readFileSync(new URL('../src/mail.ts', import.meta.url), 'utf8')
  assert(client.includes(`MAX_LETTER_LENGTH = ${MAX_LETTER_LENGTH.toLocaleString('en').replace(',', '_')}`),
    'the client and server disagree on the letter length')
  const deploy = readFileSync(new URL('../infra/deploy-local-server.sh', import.meta.url), 'utf8')
  assert(/ scripts\/lib\/mail\.mjs /.test(deploy), 'the server release archive omits the mail module')
  const unit = readFileSync(new URL('../infra/systemd/sts-room-server.service', import.meta.url), 'utf8')
  assert(unit.includes('EnvironmentFile=-%h/.config/slay-the-spire-server/mail.env'), 'the service cannot load the mail admin token')
  assert(existsSync(new URL('./mail-admin.mjs', import.meta.url)), 'the admin CLI is missing')
})

rmSync(directory, { recursive: true, force: true })
report('developer mail')
