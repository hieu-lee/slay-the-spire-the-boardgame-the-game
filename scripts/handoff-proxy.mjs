import { createServer, request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { existsSync } from 'node:fs'
import { WebSocket, WebSocketServer } from 'ws'

const MAX_BUFFERED_BYTES = 256 * 1024
const HEALTH_TIMEOUT_MS = 750

export function createHandoffProxy(targets, {
  requestTimeoutMs = 1_500, webSocketTimeoutMs = 3_000, writeMarker,
} = {}) {
  const origins = (Array.isArray(targets) ? targets : [targets]).map((target) => new URL(target))
  if (origins.length === 0 || origins.some((origin) => !['http:', 'https:'].includes(origin.protocol))) {
    throw new Error('Handoff targets must use HTTP or HTTPS')
  }
  const failed = new Set()
  const writesAllowed = () => !writeMarker || existsSync(writeMarker)
  const chooseOrigin = async () => {
    let candidates = origins.filter((origin) => !failed.has(origin.origin))
    if (candidates.length === 0) {
      failed.clear()
      candidates = origins
    }
    for (const origin of candidates) {
      try {
        const response = await fetch(new URL('/api/health', origin), { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) })
        if (response.ok) return origin
      } catch {}
      failed.add(origin.origin)
    }
    throw new Error('No handoff successor is healthy')
  }
  const targetUrl = (path, origin) => {
    const parsed = new URL(path ?? '/', 'http://handoff.invalid')
    if (parsed.origin !== 'http://handoff.invalid') throw new Error('Invalid handoff path')
    return new URL(`${parsed.pathname}${parsed.search}`, origin)
  }
  const webSockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 })
  const forward = async (request, response, retry = true) => {
    if (!writesAllowed() && !['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      response.writeHead(503, { 'content-type': 'application/json', 'retry-after': '1' })
      return response.end('{"error":"Handoff successor is not published yet"}')
    }
    let origin, url
    try {
      origin = await chooseOrigin()
      url = targetUrl(request.url, origin)
    } catch {
      response.writeHead(origin ? 400 : 502, { 'content-type': 'application/json' })
      return response.end('{"error":"Handoff successor unavailable"}')
    }
    const headers = { ...request.headers, host: origin.host }
    delete headers.connection
    const requestUpstream = origin.protocol === 'https:' ? httpsRequest : httpRequest
    const idempotent = ['GET', 'HEAD', 'OPTIONS'].includes(request.method)
    let retryStarted = false
    const retryOnce = () => {
      if (!retry || !idempotent || retryStarted || response.headersSent || response.destroyed) return false
      retryStarted = true
      void forward(request, response, false)
      return true
    }
    const upstream = requestUpstream(url, {
      method: request.method, headers, signal: AbortSignal.timeout(requestTimeoutMs),
    }, (upstreamResponse) => {
      if ((upstreamResponse.statusCode ?? 500) >= 500) {
        failed.add(origin.origin)
        if (retryOnce()) {
          upstreamResponse.resume()
          return
        }
      }
      const interrupted = () => {
        if (response.destroyed) return
        failed.add(origin.origin)
        response.destroy(new Error('Handoff successor interrupted the response'))
      }
      upstreamResponse.once('aborted', interrupted)
      upstreamResponse.once('error', interrupted)
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers)
      upstreamResponse.pipe(response)
    })
    const stopUpstream = () => {
      if (!response.writableEnded) {
        failed.add(origin.origin)
        upstream.destroy()
      }
    }
    request.once('aborted', stopUpstream)
    response.once('close', stopUpstream)
    upstream.on('error', (error) => {
      if (request.aborted || response.destroyed) return
      failed.add(origin.origin)
      if (retryStarted) return
      if (retryOnce()) return
      if (response.headersSent) return response.destroy(error)
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'application/json' })
      response.end('{"error":"Handoff successor unavailable"}')
    })
    upstream.setTimeout(requestTimeoutMs, () => upstream.destroy(new Error('Handoff successor timed out')))
    if (retry) request.pipe(upstream)
    else upstream.end()
  }
  const server = createServer((request, response) => {
    response.on('error', () => {})
    void forward(request, response)
  })

  const pendingUpgrades = new Set()
  server.on('upgrade', (request, socket, head) => {
    socket.on('error', () => {})
    if (pendingUpgrades.size >= 32) {
      socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n')
      return socket.destroy()
    }
    pendingUpgrades.add(socket)
    let cancelled = false
    let pendingUpstream
    const cancelPending = () => {
      cancelled = true
      pendingUpstream?.terminate()
      pendingUpstream = undefined
    }
    socket.once('close', cancelPending)
    socket.once('end', cancelPending)
    void (async () => {
      let upstream
      let upstreamOrigin
      for (let attempts = 0; attempts < origins.length; attempts += 1) {
        if (cancelled || socket.destroyed) break
        let origin
        try {
          origin = await chooseOrigin()
        } catch { break }
        if (cancelled || socket.destroyed) break
        const url = targetUrl(request.url, origin)
        url.protocol = origin.protocol === 'https:' ? 'wss:' : 'ws:'
        try {
          upstream = await new Promise((resolve, reject) => {
            const candidate = new WebSocket(url, {
              headers: request.headers.origin ? { origin: request.headers.origin } : undefined,
              maxPayload: 64 * 1024,
            })
            pendingUpstream = candidate
            const timeout = setTimeout(() => {
              candidate.terminate()
              reject(new Error('WebSocket handoff timed out'))
            }, webSocketTimeoutMs)
            candidate.once('open', () => {
              clearTimeout(timeout)
              resolve(candidate)
            })
            candidate.once('error', (error) => {
              clearTimeout(timeout)
              reject(error)
            })
          })
          upstreamOrigin = origin
          break
        } catch {
          failed.add(origin.origin)
        }
      }
      if (!upstream || cancelled || socket.destroyed) {
        upstream?.terminate()
        return socket.destroy()
      }
      socket.off('close', cancelPending)
      socket.off('end', cancelPending)
      pendingUpgrades.delete(socket)
      webSockets.handleUpgrade(request, socket, head, (client) => {
        client.on('error', () => {})
        client.on('message', (data, binary) => {
          if (upstream.readyState !== WebSocket.OPEN) return
          if (!writesAllowed()) {
            try {
              if (JSON.parse(data.toString()).type === 'action') return client.close(1013, 'Successor not published')
            } catch {}
          }
          if (upstream.bufferedAmount > MAX_BUFFERED_BYTES) {
            client.terminate()
            return upstream.terminate()
          }
          upstream.send(data, { binary })
        })
        upstream.on('message', (data, binary) => {
          if (client.readyState !== WebSocket.OPEN) return
          if (client.bufferedAmount > MAX_BUFFERED_BYTES) {
            client.terminate()
            return upstream.terminate()
          }
          client.send(data, { binary })
        })
        client.on('close', (code, reason) => upstream.close([1005, 1006].includes(code) ? 1012 : code, reason))
        upstream.on('close', (code, reason) => {
          if (code === 1006) failed.add(upstreamOrigin.origin)
          client.close([1005, 1006].includes(code) ? 1012 : code, reason)
        })
      })
    })().catch(() => socket.destroy()).finally(() => pendingUpgrades.delete(socket))
  })

  return server
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const targets = process.env.STS_HANDOFF_PROXY_TARGETS
  if (!targets) throw new Error('STS_HANDOFF_PROXY_TARGETS is required')
  createHandoffProxy(JSON.parse(targets), {
    writeMarker: process.env.STS_HANDOFF_PROXY_WRITE_MARKER,
  }).listen(Number(process.env.PORT) || 8787, '127.0.0.1')
}
