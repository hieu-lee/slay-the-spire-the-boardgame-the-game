const HOSTED_SESSION = import.meta.env.VITE_HOSTED_SESSION === 'true'
const MULTIPLAYER_PROTOCOL_VERSION = 1

let roomOrigin: string | null = null

export function resetRoomEndpoint() {
  roomOrigin = null
}

export async function roomUrl(path: string) {
  if (!HOSTED_SESSION) return path
  if (!roomOrigin) {
    const configUrl = new URL('session.json', document.baseURI)
    configUrl.searchParams.set('handoff', Date.now().toString())
    const response = await fetch(configUrl, { cache: 'no-store' })
    if (!response.ok) throw new Error('Could not find the multiplayer server')
    const session = await response.json()
    if (session.protocolVersion !== MULTIPLAYER_PROTOCOL_VERSION) throw new Error('The multiplayer client needs to be updated')
    const configured = new URL(session.origin)
    if (!['http:', 'https:'].includes(configured.protocol)) throw new Error('Invalid multiplayer server')
    roomOrigin = configured.origin
  }
  return new URL(path, `${roomOrigin}/`).href
}

export async function roomWebSocketUrl(code: string) {
  const url = new URL(await roomUrl(`/ws?room=${encodeURIComponent(code)}`), location.href)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.href
}
