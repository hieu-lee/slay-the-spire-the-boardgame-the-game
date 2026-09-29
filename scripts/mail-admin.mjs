#!/usr/bin/env node
// Read and answer players' letters.
//
//   STS_MAIL_ADMIN_TOKEN=... node scripts/mail-admin.mjs            list threads
//   STS_MAIL_ADMIN_TOKEN=... node scripts/mail-admin.mjs read NAME  show a thread and mark it read
//   STS_MAIL_ADMIN_TOKEN=... node scripts/mail-admin.mjs reply NAME "Thanks for the report!"
//   STS_MAIL_ADMIN_TOKEN=... node scripts/mail-admin.mjs announce "What is new" [--dry-run]
//                                                       one letter to every player except the mailbox admins
//
// The server only answers these requests when it runs with the same
// STS_MAIL_ADMIN_TOKEN (at least 24 characters). STS_MAIL_SERVER picks the
// server; it defaults to the local room server on the host.

const token = process.env.STS_MAIL_ADMIN_TOKEN
const server = process.env.STS_MAIL_SERVER ?? 'http://127.0.0.1:8787'
const [command = 'list', username, ...words] = process.argv.slice(2)

if (!token) {
  console.error('Set STS_MAIL_ADMIN_TOKEN to the token the room server was started with.')
  process.exit(2)
}

async function call(path, init = {}) {
  const response = await fetch(new URL(path, server), {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...init.headers },
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.error ?? `${response.status} ${response.statusText}`)
  return body
}

const when = (at) => new Date(at).toISOString().replace('T', ' ').slice(0, 16)

if (command === 'list') {
  const { threads } = await call('/api/mail/admin')
  if (!threads.length) console.log('No letters yet.')
  for (const thread of threads) {
    const flag = thread.unread ? `${thread.unread} new` : thread.lastFrom === 'player' ? 'unanswered' : 'answered'
    console.log(`${thread.username.padEnd(24)} ${flag.padEnd(10)} ${when(thread.lastAt)}  ${(thread.preview ?? '').replace(/\s+/g, ' ')}`)
  }
} else if (command === 'read' && username) {
  const { threads: [thread] } = await call(`/api/mail/admin?${new URLSearchParams({ username, markRead: 'true' })}`)
  if (!thread) throw new Error(`No letters from ${username}.`)
  for (const letter of thread.letters) {
    console.log(`\n${letter.from === 'player' ? username : 'You'} · ${when(letter.at)}\n${letter.body}`)
  }
} else if (command === 'reply' && username && words.length) {
  await call('/api/mail/admin/reply', { method: 'POST', body: JSON.stringify({ username, body: words.join(' ') }) })
  console.log(`Replied to ${username}.`)
} else if (command === 'announce' && username) {
  // A live send reaches every player, so a mistyped flag must stop it rather than end up in the letter.
  const flags = [username, ...words].filter((word) => word.startsWith('-'))
  const unknown = flags.filter((flag) => flag !== '--dry-run')
  if (unknown.length) {
    console.error(`Unknown option ${unknown[0]}: nothing was sent. Only --dry-run is accepted.`)
    process.exit(2)
  }
  const dryRun = flags.length > 0
  const text = [username, ...words].filter((word) => !word.startsWith('-')).join(' ')
  if (!text) {
    console.error('Write the announcement after the command: announce "message" [--dry-run]. Nothing was sent.')
    process.exit(2)
  }
  const result = await call('/api/mail/admin/announce', { method: 'POST', body: JSON.stringify({ body: text, dryRun }) })
  const skipped = [`${result.admins} mailbox admin${result.admins === 1 ? '' : 's'}`, `${result.already} who already have it`,
    ...(result.stale ? [`${result.stale} with an old mailbox under their name`] : [])].join(', ')
  console.log(dryRun ? `Dry run: would send to ${result.recipients} player${result.recipients === 1 ? '' : 's'} (skipping ${skipped}).`
    : `Sent to ${result.sent} player${result.sent === 1 ? '' : 's'} (skipped ${skipped}).`)
} else {
  console.error('Usage: mail-admin.mjs [list | read NAME | reply NAME "message" | announce "message" [--dry-run]]')
  process.exit(2)
}
