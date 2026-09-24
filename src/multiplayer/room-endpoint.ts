const HOSTED_SESSION = import.meta.env.VITE_HOSTED_SESSION === 'true'
const MULTIPLAYER_PROTOCOL_VERSION = 1

let roomOrigin: string | null = null
let entryRequestIds = false
let webSocketActionAcks = false

export function resetRoomEndpoint() {
  roomOrigin = null
  entryRequestIds = false
  webSocketActionAcks = false
}

export const supportsEntryRequestIds = () => !HOSTED_SESSION || entryRequestIds
export const supportsWebSocketActionAcks = () => HOSTED_SESSION && webSocketActionAcks

export async function roomUrl(path: string) {
  if (!HOSTED_SESSION) return path
  if (!roomOrigin) {
    const configUrl = new URL(import.meta.env.VITE_NATIVE_SESSION_URL || 'session.json', document.baseURI)
    configUrl.searchParams.set('refresh', Date.now().toString())
    const response = await fetch(configUrl, { cache: 'no-store', signal: AbortSignal.timeout(5_000) })
    if (!response.ok) throw new Error('Could not find the multiplayer server')
    const session = await response.json()
    if (session.protocolVersion !== MULTIPLAYER_PROTOCOL_VERSION) throw new Error('The multiplayer client needs to be updated')
    try {
      if (typeof session.origin !== 'string') throw new Error('Invalid multiplayer server')
      const configured = new URL(session.origin)
      if (!['http:', 'https:'].includes(configured.protocol)) throw new Error('Invalid multiplayer server')
      const health = await fetch(new URL('/api/health', configured), {
        cache: 'no-store', signal: AbortSignal.timeout(5_000),
      })
      if (!health.ok) throw new Error('Multiplayer server unavailable')
      const status = await health.json()
      if (status.protocolVersion !== MULTIPLAYER_PROTOCOL_VERSION) throw new Error('Multiplayer server incompatible')
      roomOrigin = configured.origin
      entryRequestIds = status.entryRequestIds === true
      webSocketActionAcks = status.webSocketActionAcks === true
    } catch {
      throw new Error('Could not find the multiplayer server')
    }
  }
  return new URL(path, `${roomOrigin}/`).href
}

export async function roomWebSocketUrl(code: string) {
  const url = new URL(await roomUrl(`/ws?room=${encodeURIComponent(code)}`), location.href)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.href
}
