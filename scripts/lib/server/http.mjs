import { timingSafeEqual } from 'node:crypto'
import { ownerOf } from '../mail.mjs'
import { findSeat } from '../rooms.mjs'

export const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
}
export const MAX_BODY = 64 * 1024
export const MAX_RATE_KEYS = 1024
export const MAX_RESTRICTED_NETWORKS = 256
export const SPIRE_REJECTION = 'Spire rejects room-temperature IQ'

export function send(response, status, body) {
  response.writeHead(status, JSON_HEADERS)
  response.end(JSON.stringify(body))
}

export async function readJson(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY) throw Object.assign(new Error('Request body is too large'), { status: 413 })
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error('JSON body must be an object')
    return body
  } catch {
    throw Object.assign(new Error('JSON body must be an object'), { status: 400 })
  }
}

export function applyCors(request, response, allowedOrigin) {
  if (allowedOrigin && request.headers.origin === allowedOrigin) {
    response.setHeader('access-control-allow-origin', allowedOrigin)
    response.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
    response.setHeader('access-control-allow-headers', 'content-type, x-room-token')
    response.setHeader('access-control-max-age', '600')
    response.setHeader('vary', 'Origin')
  }
  if (request.method === 'OPTIONS') {
    response.writeHead(allowedOrigin && request.headers.origin === allowedOrigin ? 204 : 403)
    response.end()
    return true
  }
  if (allowedOrigin && request.headers.origin && request.headers.origin !== allowedOrigin) {
    send(response, 403, { error: 'Origin not allowed' })
    return true
  }
  return false
}

export const tokenOf = (request) => request.headers['x-room-token']?.toString()
export const codeOf = (value) => value.trim().toUpperCase()
export const requestIdOf = (value) => {
  if (value === undefined) return undefined
  if (typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) return value
  throw Object.assign(new Error('Invalid request ID'), { status: 400 })
}
export const sourceOf = (request) => request.headers['cf-connecting-ip']?.toString()
  ?? request.socket.remoteAddress
  ?? 'unknown'

/** Groups an IPv6 address by its /64, which one household's rotating addresses share. */
export function networkOf(source) {
  // A dual-stack socket reports IPv4 clients as ::ffff:a.b.c.d.
  if (source.toLowerCase().startsWith('::ffff:')) source = source.slice(7)
  if (!source.includes(':') || source.includes('.')) return source
  const [head, tail] = source.split('::')
  const before = head ? head.split(':') : []
  const after = tail ? tail.split(':') : []
  const groups = tail === undefined ? before : [...before, ...Array(Math.max(0, 8 - before.length - after.length)).fill('0'), ...after]
  return groups.slice(0, 4).map((group) => Number.parseInt(group, 16).toString(16)).join(':')
}

export function consume(map, key, windowMs, maximum, now = Date.now()) {
  const rate = map.get(key)
  if (!rate || now - rate.startedAt >= windowMs) {
    if (!rate && map.size >= MAX_RATE_KEYS) return false
    map.set(key, { startedAt: now, count: 1 })
    return true
  }
  rate.count += 1
  return rate.count <= maximum
}

export function pruneRateMap(map, windowMs, now) {
  for (const [key, rate] of map) if (now - rate.startedAt >= windowMs) map.delete(key)
}

export function createRestrictionPolicy({ restrictedUsernames } = {}) {
  // STS_RESTRICTED_USERNAMES (comma separated) names accounts the Spire turns away: no room to
  // create or join, and no new account from the network they were last seen on. The networks
  // are remembered only while the process runs; the account's own browser reports in on load.
  const restrictedNames = new Set((typeof restrictedUsernames === 'string' ? restrictedUsernames.split(',') : restrictedUsernames ?? [])
    .map((value) => String(value).normalize('NFKC').trim().toLowerCase()).filter(Boolean))
  const restrictedNetworks = new Set()
  // Seats keep the first 24 characters of whatever name they were sent, so match on those.
  const isRestrictedName = (name) => name !== undefined && restrictedNames.has(String(name).slice(0, 24).normalize('NFKC').trim().toLowerCase())
  const isRestrictedNetwork = (request) => restrictedNetworks.has(networkOf(sourceOf(request)))
  const noteRestrictedSource = (request) => {
    const network = networkOf(sourceOf(request))
    // Re-adding moves a known network to the back; the cap keeps probing from many addresses from growing the list without end.
    restrictedNetworks.delete(network)
    restrictedNetworks.add(network)
    if (restrictedNetworks.size > MAX_RESTRICTED_NETWORKS) restrictedNetworks.delete(restrictedNetworks.values().next().value)
  }
  const rejectRestricted = () => { throw Object.assign(new Error(SPIRE_REJECTION), { status: 403 }) }
  const seatRestricted = (room, token) => isRestrictedName(findSeat(room, token)?.name)

  return {
    restrictedNames,
    restrictedNetworks,
    isRestrictedName,
    isRestrictedNetwork,
    noteRestrictedSource,
    rejectRestricted,
    seatRestricted,
  }
}

export function createMailAdminAuth({
  mailAdminToken,
  mailAdminOwners,
  store,
  failureWindowMs,
  maxFailures,
}) {
  const mailAdminFailures = new Map()
  const mailAdminKey = typeof mailAdminToken === 'string' && mailAdminToken.length >= 24 ? Buffer.from(`Bearer ${mailAdminToken}`) : null
  if (mailAdminToken && !mailAdminKey) console.warn('Mail replies disabled: STS_MAIL_ADMIN_TOKEN must be at least 24 characters')
  const delegatedMailOwners = new Set((typeof mailAdminOwners === 'string' ? mailAdminOwners.split(',') : mailAdminOwners ?? [])
    .map((value) => String(value).trim().toLowerCase()).filter((value) => /^[0-9a-f]{64}$/.test(value)))
  const delegatedMailProfile = (token) => {
    const profile = typeof token === 'string' ? store.profiles.find((entry) => entry.token === token) : undefined
    return profile && delegatedMailOwners.has(ownerOf(profile.token)) ? profile : undefined
  }
  // Failures are always counted: when the table is full the oldest source makes
  // room, so a flood of fresh addresses cannot switch the lockout off.
  const mailAdminAuthorized = (request, now = Date.now()) => {
    const source = sourceOf(request)
    const failures = mailAdminFailures.get(source)
    const current = failures && now - failures.startedAt < failureWindowMs ? failures : undefined
    const offered = Buffer.from(request.headers.authorization?.toString() ?? '')
    const matches = offered.length === mailAdminKey.length && timingSafeEqual(offered, mailAdminKey)
    if (matches && (current?.count ?? 0) < maxFailures) return true
    if (!matches) {
      if (!current && mailAdminFailures.size >= MAX_RATE_KEYS) mailAdminFailures.delete(mailAdminFailures.keys().next().value)
      mailAdminFailures.delete(source)
      mailAdminFailures.set(source, { startedAt: current?.startedAt ?? now, count: (current?.count ?? 0) + 1 })
    }
    return false
  }
  const sweep = (now) => pruneRateMap(mailAdminFailures, failureWindowMs, now)

  return {
    mailAdminKey,
    delegatedMailOwners,
    delegatedMailProfile,
    mailAdminAuthorized,
    sweep,
  }
}
