import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sanitizePyjamConfig } from './multiplayer-tunnel.mjs'

const privateKey = Buffer.alloc(32, 1).toString('base64')
const publicKey = Buffer.alloc(32, 2).toString('base64')
const sourceConfig = (url = 'https://abc123.tunnel.pyjam.as/') => `[Interface]
Address = 10.101.0.2/32
PrivateKey = ${privateKey}
DNS = 1.1.1.1
Table = 123
PreUp = echo unsafe
PostUp = printf 'Ready on ${url}\\n'
PostDown = echo unsafe

[Peer]
PublicKey = ${publicKey}
AllowedIPs = 10.101.0.1/32
Endpoint = tunnel.pyjam.as:54321
PersistentKeepalive = 999
`

const sanitized = sanitizePyjamConfig(sourceConfig())
assert.equal(sanitized.url, 'https://abc123.tunnel.pyjam.as')
assert.equal(sanitizePyjamConfig(sourceConfig('https://moo123.tunnel.pyjam.as/')).url, 'https://moo123.tunnel.pyjam.as')
assert.match(sanitized.config, /^Address = 10\.101\.0\.2\/32$/m)
assert.match(sanitized.config, /^AllowedIPs = 10\.101\.0\.1\/32$/m)
assert.match(sanitized.config, /^Endpoint = tunnel\.pyjam\.as:54321$/m)
assert.match(sanitized.config, /^PersistentKeepalive = 21$/m)
assert.doesNotMatch(sanitized.config, /PostUp|PreUp|PostDown|DNS|Table|999|printf/)
for (const url of [
  'https://ABC123.tunnel.pyjam.as/',
  'https://abc-23.tunnel.pyjam.as/',
  'https://abc123.example.com/',
  'https://abc123.tunnel.pyjam.as.evil/',
]) {
  assert.throws(() => sanitizePyjamConfig(sourceConfig(url)), /Invalid pyjam public URL/)
}
assert.throws(
  () => sanitizePyjamConfig(sourceConfig().replace('AllowedIPs = 10.101.0.1/32', 'AllowedIPs = 0.0.0.0/0')),
  /Invalid pyjam allowed IPs/,
)
assert.throws(
  () => sanitizePyjamConfig(sourceConfig().replace('Address = 10.101.0.2/32', 'Address = not-an-ip/32')),
  /Invalid pyjam address/,
)
assert.throws(
  () => sanitizePyjamConfig(sourceConfig().replace('Address = 10.101.0.2/32', 'Address = 169.254.169.254/32')),
  /Invalid pyjam address/,
)
assert.throws(
  () => sanitizePyjamConfig(sourceConfig().replace('AllowedIPs = 10.101.0.1/32', 'AllowedIPs = 10.101.0.2/32')),
  /Invalid pyjam allowed IPs/,
)
assert.throws(
  () => sanitizePyjamConfig(sourceConfig().replace(`PrivateKey = ${privateKey}`, 'PrivateKey = invalid')),
  /Invalid pyjam private key/,
)
assert.throws(
  () => sanitizePyjamConfig(sourceConfig().replace(`PublicKey = ${publicKey}`, 'PublicKey = invalid')),
  /Invalid pyjam public key/,
)
assert.throws(
  () => sanitizePyjamConfig(sourceConfig().replace('Endpoint = tunnel.pyjam.as:54321', 'Endpoint = attacker.test:54321')),
  /Invalid pyjam endpoint/,
)
assert.throws(() => sanitizePyjamConfig('x'.repeat(16 * 1024 + 1)), /Invalid pyjam configuration size/)

const directory = mkdtempSync(join(tmpdir(), 'sts-multiplayer-tunnel-'))
try {
  const input = join(directory, 'remote.conf')
  const output = join(directory, 'sanitized.conf')
  writeFileSync(input, sourceConfig())
  const result = spawnSync(process.execPath, ['scripts/multiplayer-tunnel.mjs', 'sanitize', input, output], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, 'https://abc123.tunnel.pyjam.as\n')
  assert(!`${result.stdout}${result.stderr}`.includes(privateKey), 'the private key was disclosed')
  assert.equal(statSync(output).mode & 0o777, 0o600)

  const invalidInput = join(directory, 'invalid.conf')
  writeFileSync(invalidInput, sourceConfig('https://invalid.example.com/'))
  const rejected = spawnSync(process.execPath, ['scripts/multiplayer-tunnel.mjs', 'sanitize', invalidInput, join(directory, 'rejected.conf')], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8',
  })
  assert.notEqual(rejected.status, 0)
  assert(!`${rejected.stdout}${rejected.stderr}`.includes(privateKey), 'a rejected private key was disclosed')
} finally {
  rmSync(directory, { recursive: true, force: true })
}

const workflow = readFileSync(new URL('../.github/workflows/multiplayer-session.yml', import.meta.url), 'utf8')
const viteConfig = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8')
assert.match(workflow, /MULTIPLAYER_TUNNEL_PROVIDER: \$\{\{ vars\.MULTIPLAYER_TUNNEL_PROVIDER \}\}/)
const selectProvider = workflow.split('      - name: Select the tunnel provider\n')[1]
  .split('      - uses: actions/checkout@v4')[0].split('        run: |\n')[1].replace(/^          /gm, '')
const selectorDirectory = mkdtempSync(join(tmpdir(), 'sts-multiplayer-tunnel-selector-'))
try {
  for (const [value, expected] of [[undefined, 'pyjam'], ['', 'pyjam'], ['cloudflare', 'cloudflare'], ['pyjam', 'pyjam']]) {
    const envFile = join(selectorDirectory, `env-${value ?? 'missing'}`)
    const env = { ...process.env, GITHUB_ENV: envFile }
    delete env.MULTIPLAYER_TUNNEL_PROVIDER
    if (value !== undefined) env.MULTIPLAYER_TUNNEL_PROVIDER = value
    const selected = spawnSync('bash', ['-e', '-c', selectProvider], { env, encoding: 'utf8' })
    assert.equal(selected.status, 0, selected.stderr)
    assert.equal(readFileSync(envFile, 'utf8'), `TUNNEL_PROVIDER=${expected}\n`)
  }
  const rejected = spawnSync('bash', ['-e', '-c', selectProvider], {
    env: { ...process.env, GITHUB_ENV: join(selectorDirectory, 'rejected'), MULTIPLAYER_TUNNEL_PROVIDER: 'other' },
    encoding: 'utf8',
  })
  assert.equal(rejected.status, 2)
  assert.match(rejected.stdout, /Unknown MULTIPLAYER_TUNNEL_PROVIDER; expected empty, "cloudflare", or "pyjam"/)
} finally {
  rmSync(selectorDirectory, { recursive: true, force: true })
}
assert.match(workflow, /if: env\.TUNNEL_PROVIDER == 'pyjam'\n\s+run: sudo apt-get[\s\S]+wireguard-tools/)
assert.match(workflow, /ref: \$\{\{ github\.workflow_sha \}\}[\s\S]+path: \.multiplayer-workflow/)
assert.match(workflow, /node \.multiplayer-workflow\/scripts\/multiplayer-tunnel\.mjs sanitize/)
assert.match(workflow, /if: always\(\) && env\.TUNNEL_PROVIDER == 'pyjam'/)
assert.match(workflow, /sudo wg-quick down "\$RUNNER_TEMP\/pyjam-tunnel\.conf"/)
assert(workflow.indexOf('"$tunnel_url/api/health"') < workflow.indexOf('Point the stable Pages URL at this session'))
assert.match(viteConfig, /process\.env\.TUNNEL_PROVIDER === 'pyjam' \? \['\.tunnel\.pyjam\.as']/)
assert.match(workflow, /probe_response=\$\(curl[\s\S]+\"\$tunnel_url\/\$probe_file\"/)
assert.match(workflow, /\[ "\$probe_response" = "\$probe_value" \]\n\s+tunnel_urls\+=/)
const cleanup = workflow.split('      - name: Stop the pyjam WireGuard tunnel\n')[1]
  .split('        run: |\n')[1].replace(/^          /gm, '')
const cleanupDirectory = mkdtempSync(join(tmpdir(), 'sts-multiplayer-tunnel-cleanup-'))
try {
  const cleanupResult = spawnSync('bash', ['-e', '-c', `sudo() { printf '%s\\n' "$*" > "$CLEANUP_LOG"; }\n${cleanup}`], {
    env: { ...process.env, RUNNER_TEMP: cleanupDirectory, CLEANUP_LOG: join(cleanupDirectory, 'cleanup.log') },
    encoding: 'utf8',
  })
  assert.equal(cleanupResult.status, 0, cleanupResult.stderr)
  assert.equal(readFileSync(join(cleanupDirectory, 'cleanup.log'), 'utf8'), `wg-quick down ${join(cleanupDirectory, 'pyjam-tunnel.conf')}\n`)
} finally {
  rmSync(cleanupDirectory, { recursive: true, force: true })
}

console.log('Multiplayer tunnel provider selection, pyjam sanitization, URL validation, secret handling and cleanup pass')
