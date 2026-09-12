const HOSTED_SESSION = import.meta.env.VITE_HOSTED_SESSION === 'true'
const MULTIPLAYER_PROTOCOL_VERSION = 1

let roomOrigin: string | null = null
let entryRequestIds = false
let webSocketActionAcks = false
const failedOrigins = new Set<string>()

export function resetRoomEndpoint(failedUrl?: string) {
  if (failedUrl && HOSTED_SESSION) failedOrigins.add(new URL(failedUrl, location.href).origin)
  roomOrigin = null
  entryRequestIds = false
  webSocketActionAcks = false
}

export const supportsEntryRequestIds = () => !HOSTED_SESSION || entryRequestIds
export const supportsWebSocketActionAcks = () => HOSTED_SESSION && webSocketActionAcks

export async function roomUrl(path: string) {
  if (!HOSTED_SESSION) return path
  if (!roomOrigin) {
    const configUrl = new URL('session.json', document.baseURI)
    configUrl.searchParams.set('handoff', Date.now().toString())
    const response = await fetch(configUrl, { cache: 'no-store', signal: AbortSignal.timeout(5_000) })
    if (!response.ok) throw new Error('Could not find the multiplayer server')
    const session = await response.json()
    if (session.protocolVersion !== MULTIPLAYER_PROTOCOL_VERSION) throw new Error('The multiplayer client needs to be updated')
    const origins = [...new Set([
      ...(Array.isArray(session.origins) ? session.origins : []),
      session.origin,
    ])].filter((origin): origin is string => typeof origin === 'string')
    try {
      const configuredOrigins = origins.map((origin) => new URL(origin))
      if (configuredOrigins.some((origin) => !['http:', 'https:'].includes(origin.protocol))) throw new Error('Invalid multiplayer server')
      for (const failed of failedOrigins) {
        if (!configuredOrigins.some((origin) => origin.origin === failed)) failedOrigins.delete(failed)
      }
      let candidates = configuredOrigins.filter((origin) => !failedOrigins.has(origin.origin))
      if (candidates.length === 0) {
        failedOrigins.clear()
        candidates = configuredOrigins
      }
      const selected = await Promise.any(candidates.map(async (configured) => {
        try {
          const health = await fetch(new URL('/api/health', configured), {
            cache: 'no-store', signal: AbortSignal.timeout(5_000),
          })
          if (!health.ok) throw new Error('Multiplayer server unavailable')
          const status = await health.json()
          if (status.protocolVersion !== MULTIPLAYER_PROTOCOL_VERSION) throw new Error('Multiplayer server incompatible')
          return {
            origin: configured.origin,
            entryRequestIds: status.entryRequestIds === true,
            webSocketActionAcks: status.webSocketActionAcks === true,
          }
        } catch (error) {
          failedOrigins.add(configured.origin)
          throw error
        }
      }))
      roomOrigin = selected.origin
      entryRequestIds = selected.entryRequestIds
      webSocketActionAcks = selected.webSocketActionAcks
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
