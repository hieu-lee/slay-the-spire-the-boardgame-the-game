const invalid = (message, status = 400) => { throw Object.assign(new Error(message), { status }) }

export function claimProfile(profiles, value) {
  if (typeof value?.token !== 'string' || !/^[0-9a-f-]{36}$/.test(value.token)) invalid('Invalid profile token')
  const username = typeof value.username === 'string' ? value.username.normalize('NFKC').trim() : ''
  if (username.length > 24 || !/^[\p{L}\p{N}][\p{L}\p{N} _-]{1,23}$/u.test(username)) {
    invalid('Use 2–24 letters, numbers, spaces, underscores or hyphens.')
  }
  const existing = profiles.find((profile) => profile.token === value.token)
  if (existing) return existing
  if (profiles.some((profile) => profile.username.normalize('NFKC').toLowerCase() === username.normalize('NFKC').toLowerCase())) {
    invalid('That name is already taken. Try another.', 409)
  }
  if (profiles.length >= 20_000) invalid('The name registry is full. Please try again later.', 503)
  const profile = { token: value.token, username }
  profiles.push(profile)
  return profile
}
