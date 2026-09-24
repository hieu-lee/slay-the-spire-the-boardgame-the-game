import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'vite'
import { validateSessionConfig } from './validate-session-config.mjs'

const workflow = readFileSync(new URL('../.github/workflows/pages-deploy.yml', import.meta.url), 'utf8')
assert.match(workflow, /actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7\.0\.1[\s\S]*?with:[\s\S]*?persist-credentials: false/)
assert.match(workflow, /workflow_call:/)
assert.match(workflow, /workflow_dispatch:/)
assert.match(workflow, /node-version: 24/)
assert.match(workflow, /VITE_ASSET_CDN_ORIGIN="https:\/\/cdn\.jsdelivr\.net\/gh\/\$GITHUB_REPOSITORY@\$DEPLOY_SHA\/public\/assets" VITE_CAMPFIRE_BACKUP_ORIGIN="https:\/\/raw\.githubusercontent\.com\/\$GITHUB_REPOSITORY\/\$DEPLOY_SHA\/public\/assets" VITE_SINGLE_PLAYER=false VITE_HOSTED_SESSION=true pnpm build/)
assert.match(workflow, /find dist\/assets\/combat\/rigged -type f -name '\*\.mov' -delete/)
assert.match(workflow, /find dist\/assets\/bgm -type f -delete/)
assert.match(workflow, /find dist\/assets\/noncombat\/campfire -type f -name '\*_firecamp\.webp' ! -name 'empty_firecamp\.webp' -delete/)
assert.match(workflow, /for file in empty_firecamp\.webp rest\.webp smith\.webp; do test -s/)
assert.match(workflow, /hero-defect-idle\.mov[\s\S]*content-type: video\/quicktime/)
assert.match(workflow, /exordium\.mp3[\s\S]*content-type: audio\/mpeg/)
assert.match(workflow, /if ! curl[\s\S]*cdn\.jsdelivr\.net[\s\S]*ironclad_silent_firecamp\.webp[\s\S]*content-type: image\/webp'; then/)
assert.match(workflow, /raw\.githubusercontent\.com[\s\S]*ironclad_silent_firecamp\.webp[\s\S]*content-type: image\/webp'[\s\S]*fi/)
assert.match(workflow, /du -sb dist[\s\S]*-le 850000000/)
assert.match(workflow, /MULTIPLAYER_SERVER_ORIGIN\/api\/health/)
assert.match(workflow, /\.webSocketActionAcks == true/)
assert.match(workflow, /\.releaseSha == \$sha/)
assert.match(workflow, /validate-session-config\.mjs/)
assert.match(workflow, /actions\/configure-pages@45bfe0192ca1faeb007ade9deae92b16b8254a0d # v6\.0\.0/)
assert.match(workflow, /actions\/upload-pages-artifact@fc324d3547104276b827a68afc52ff2a11cc49c9 # v5\.0\.0/)
assert.match(workflow, /actions\/deploy-pages@368f82528645a54fb793d4d04e342629a3f51346 # v5\.0\.1/)
assert.doesNotMatch(workflow, /push:\s+branches:/)
assert.doesNotMatch(workflow, /artifact_name|source_run_id|handoff|trycloudflare|pyjam/i)

const previousCdn = process.env.VITE_ASSET_CDN_ORIGIN
const previousCampfire = process.env.VITE_CAMPFIRE_BACKUP_ORIGIN
const cdn = 'https://cdn.example/public/assets'
const campfireOrigin = 'https://raw.githubusercontent.com/example/game/sha/public/assets'
process.env.VITE_ASSET_CDN_ORIGIN = cdn
process.env.VITE_CAMPFIRE_BACKUP_ORIGIN = campfireOrigin
const vite = await createServer({ server: { middlewareMode: true }, logLevel: 'silent' })
try {
  const { assetPath, campfireScenePath } = await vite.ssrLoadModule('/src/game/assets.ts')
  assert.equal(campfireScenePath(['ironclad', 'silent']), `${cdn}/noncombat/campfire/ironclad_silent_firecamp.webp`)
  assert.equal(campfireScenePath(['ironclad', 'silent'], true), `${campfireOrigin}/noncombat/campfire/ironclad_silent_firecamp.webp`)
  assert.equal(campfireScenePath([]), '/assets/noncombat/campfire/empty_firecamp.webp')
  assert.equal(assetPath('noncombat/campfire/rest.webp'), '/assets/noncombat/campfire/rest.webp')
  assert.equal(assetPath('noncombat/campfire/smith.webp'), '/assets/noncombat/campfire/smith.webp')
  assert.equal(assetPath('bgm/exordium.mp3'), `${cdn}/bgm/exordium.mp3`)
  assert.equal(assetPath('cards/strike.webp'), '/assets/cards/strike.webp')
} finally {
  await vite.close()
  if (previousCdn === undefined) delete process.env.VITE_ASSET_CDN_ORIGIN
  else process.env.VITE_ASSET_CDN_ORIGIN = previousCdn
  if (previousCampfire === undefined) delete process.env.VITE_CAMPFIRE_BACKUP_ORIGIN
  else process.env.VITE_CAMPFIRE_BACKUP_ORIGIN = previousCampfire
}

const stableOrigin = 'https://sts-94-239-51-8.2001-861-388c-4ee0-c3d5-2f30-1be7-2e79.sslip.io:18443'
const sha = 'a'.repeat(40)
for (const [config, accepted] of [
  [{ protocolVersion: 1, sha, runId: '12', origin: stableOrigin, alwaysOn: true }, true],
  [{ protocolVersion: 1, sha, runId: '12', origin: 'https://abc123.tunnel.pyjam.as', alwaysOn: true }, false],
  [{ protocolVersion: 1, sha, runId: '12', origin: stableOrigin, origins: [stableOrigin], alwaysOn: true }, false],
  [{ protocolVersion: 1, sha, runId: '12', sourceRunId: '11', origin: stableOrigin, alwaysOn: true }, false],
  [{ protocolVersion: 1, sha, runId: '12', origin: stableOrigin, alwaysOn: false }, false],
  [{ protocolVersion: 2, sha, runId: '12', origin: stableOrigin, alwaysOn: true }, false],
  [{ protocolVersion: 1, sha: 'b'.repeat(40), runId: '12', origin: stableOrigin, alwaysOn: true }, false],
  [{ protocolVersion: 1, sha, runId: 12, origin: stableOrigin, alwaysOn: true }, false],
]) {
  let valid = true
  try { validateSessionConfig(config, { sha, stableOrigin }) } catch { valid = false }
  assert.equal(valid, accepted, JSON.stringify(config))
}

console.log('✓ Pages publishes only the stable always-on multiplayer origin')
