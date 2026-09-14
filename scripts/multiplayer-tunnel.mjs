import { chmodSync, closeSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { pathToFileURL } from 'node:url'

const PYJAM_HOST = 'tunnel.pyjam.as'
const KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/
const SLUG_PATTERN = '[1-9a-km-z]{6}'
const MAX_CONFIG_BYTES = 16 * 1024
const REQUIRED_FIELDS = new Set([
  'Interface.Address',
  'Interface.PrivateKey',
  'Peer.PublicKey',
  'Peer.AllowedIPs',
  'Peer.Endpoint',
])

function wireguardKey(value, label) {
  if (!KEY_PATTERN.test(value)) throw new Error(`Invalid pyjam ${label}.`)
  const decoded = Buffer.from(value, 'base64')
  if (decoded.length !== 32 || decoded.toString('base64') !== value) throw new Error(`Invalid pyjam ${label}.`)
  return value
}

function hostRoute(value, label) {
  const match = /^([^/]+)\/(\d+)$/.exec(value)
  if (!match || isIP(match[1]) !== 4 || match[2] !== '32') throw new Error(`Invalid pyjam ${label}.`)
  return value
}

function pyjamAddress(value) {
  const route = hostRoute(value, 'address')
  const octets = route.slice(0, route.indexOf('/')).split('.').map(Number)
  const host = octets[2] * 256 + octets[3]
  if (octets[0] !== 10 || octets[1] !== 101 || host < 2 || host > 65534) {
    throw new Error('Invalid pyjam address.')
  }
  return route
}

function pyjamAllowedIPs(value) {
  const route = hostRoute(value, 'allowed IPs')
  if (route !== '10.101.0.1/32') throw new Error('Invalid pyjam allowed IPs.')
  return route
}

function endpoint(value) {
  const match = /^([^:]+):(\d+)$/.exec(value)
  const port = Number(match?.[2])
  if (!match || match[1] !== PYJAM_HOST || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Invalid pyjam endpoint.')
  }
  return `${PYJAM_HOST}:${port}`
}

export function sanitizePyjamConfig(source) {
  if (Buffer.byteLength(source) > MAX_CONFIG_BYTES) throw new Error('Invalid pyjam configuration size.')
  const fields = new Map()
  const urls = new Set()
  let section = ''
  let interfaceCount = 0
  let peerCount = 0

  for (const originalLine of source.split(/\r?\n/)) {
    const line = originalLine.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const sectionMatch = /^\[([A-Za-z]+)]$/.exec(line)
    if (sectionMatch) {
      section = sectionMatch[1]
      if (section === 'Interface') interfaceCount += 1
      else if (section === 'Peer') peerCount += 1
      else throw new Error('Invalid pyjam configuration section.')
      continue
    }
    const directive = /^([A-Za-z]+)\s*=\s*(.*)$/.exec(line)
    if (!directive || !section) throw new Error('Invalid pyjam configuration syntax.')
    const [, key, value] = directive
    const field = `${section}.${key}`
    if (REQUIRED_FIELDS.has(field)) {
      if (fields.has(field)) throw new Error(`Duplicate pyjam ${key}.`)
      fields.set(field, value)
    }
    if (field === 'Interface.PostUp') {
      const pattern = new RegExp(`https://(${SLUG_PATTERN})\\.tunnel\\.pyjam\\.as/?(?=$|[\\s'"\\\\])`, 'g')
      for (const match of value.matchAll(pattern)) urls.add(`https://${match[1]}.${PYJAM_HOST}`)
    }
  }

  if (interfaceCount !== 1 || peerCount !== 1) throw new Error('Invalid pyjam configuration structure.')
  const address = pyjamAddress(fields.get('Interface.Address') ?? '')
  const privateKey = wireguardKey(fields.get('Interface.PrivateKey') ?? '', 'private key')
  const publicKey = wireguardKey(fields.get('Peer.PublicKey') ?? '', 'public key')
  const allowedIPs = pyjamAllowedIPs(fields.get('Peer.AllowedIPs') ?? '')
  const peerEndpoint = endpoint(fields.get('Peer.Endpoint') ?? '')
  if (urls.size !== 1) throw new Error('Invalid pyjam public URL.')

  return {
    config: `[Interface]\nAddress = ${address}\nPrivateKey = ${privateKey}\n\n[Peer]\nPublicKey = ${publicKey}\nAllowedIPs = ${allowedIPs}\nEndpoint = ${peerEndpoint}\nPersistentKeepalive = 21\n`,
    url: [...urls][0],
  }
}

function writePrivateFile(path, contents) {
  const descriptor = openSync(path, 'wx', 0o600)
  try {
    writeFileSync(descriptor, contents)
  } finally {
    closeSync(descriptor)
  }
  chmodSync(path, 0o600)
}

function main([command, ...args]) {
  if (command === 'sanitize' && args.length === 2) {
    const sanitized = sanitizePyjamConfig(readFileSync(args[0], 'utf8'))
    writePrivateFile(args[1], sanitized.config)
    process.stdout.write(`${sanitized.url}\n`)
    return
  }
  throw new Error('Usage: multiplayer-tunnel.mjs sanitize <input> <output>')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
