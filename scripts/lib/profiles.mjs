import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scryptAsync = promisify(scrypt)
const KEY_LENGTH = 64
const MIN_PASSWORD_LENGTH = 8
const MAX_PASSWORD_LENGTH = 128
const invalid = (message, status = 400) => { throw Object.assign(new Error(message), { status }) }
const nameKey = (username) => username.normalize('NFKC').toLowerCase()

async function hashPassword(password) {
  const salt = randomBytes(16)
  const key = await scryptAsync(password.normalize('NFKC'), salt, KEY_LENGTH)
  return `${salt.toString('hex')}:${key.toString('hex')}`
}

async function matchesPassword(stored, password) {
  const [salt, key] = stored.split(':')
  const expected = Buffer.from(key, 'hex')
  const actual = await scryptAsync(password.normalize('NFKC'), Buffer.from(salt, 'hex'), KEY_LENGTH)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

// Unknown names still pay for one hash so response time does not reveal which names exist.
const decoyHash = hashPassword('decoy-password')

function passwordOf(value) {
  const password = value?.password
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    invalid(`Use a password of ${MIN_PASSWORD_LENGTH}–${MAX_PASSWORD_LENGTH} characters.`)
  }
  return password
}

/**
 * Registers a new name, or sets the first password on a profile that predates passwords.
 * Retrying with the same token and password is safe, so a lost response never strands a name.
 */
export async function claimProfile(profiles, value) {
  if (typeof value?.token !== 'string' || !/^[0-9a-f-]{36}$/.test(value.token)) invalid('Invalid profile token')
  const username = typeof value.username === 'string' ? value.username.normalize('NFKC').trim() : ''
  if (username.length > 24 || !/^[\p{L}\p{N}][\p{L}\p{N} _-]{1,23}$/u.test(username)) {
    invalid('Use 2–24 letters, numbers, spaces, underscores or hyphens.')
  }
  const password = passwordOf(value)
  // Hash before touching the registry: everything after the await is synchronous, so two
  // concurrent claims of one name cannot both pass the uniqueness check.
  const passwordHash = await hashPassword(password)
  const existing = profiles.find((profile) => profile.token === value.token)
  if (existing) {
    if (nameKey(existing.username) !== nameKey(username)) invalid('That account belongs to a different name.', 409)
    if (!existing.passwordHash) { existing.passwordHash = passwordHash; return existing }
    if (await matchesPassword(existing.passwordHash, password)) return existing
    invalid('This account already has a password. Log in instead.', 409)
  }
  if (profiles.some((profile) => nameKey(profile.username) === nameKey(username))) {
    invalid('That name is already taken. Try another.', 409)
  }
  if (profiles.length >= 20_000) invalid('The name registry is full. Please try again later.', 503)
  const profile = { token: value.token, username, passwordHash }
  profiles.push(profile)
  return profile
}

export async function loginProfile(profiles, value) {
  const username = typeof value?.username === 'string' ? value.username : ''
  const password = typeof value?.password === 'string' && value.password.length <= MAX_PASSWORD_LENGTH ? value.password : ''
  const profile = username ? profiles.find((entry) => nameKey(entry.username) === nameKey(username.trim())) : undefined
  const ok = await matchesPassword(profile?.passwordHash ?? await decoyHash, password)
  if (profile && !profile.passwordHash) {
    invalid('This account has no password yet. Open the game in the browser where you created it to set one.', 403)
  }
  if (!profile || !ok) invalid('Wrong username or password.', 401)
  return profile
}
