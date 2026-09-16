import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { validateSessionConfig } from './validate-session-config.mjs'

const workflow = readFileSync(new URL('../.github/workflows/pages-deploy.yml', import.meta.url), 'utf8')
assert.match(workflow, /actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7\.0\.1[\s\S]*?with:[\s\S]*?persist-credentials: false/)
assert.match(workflow, /workflow_call:/)
assert.match(workflow, /workflow_dispatch:/)
assert.match(workflow, /VITE_HOSTED_SESSION=true pnpm build/)
assert.match(workflow, /MULTIPLAYER_SERVER_ORIGIN\/api\/health/)
assert.match(workflow, /\.webSocketActionAcks == true/)
assert.match(workflow, /\.releaseSha == \$sha/)
assert.match(workflow, /validate-session-config\.mjs/)
assert.match(workflow, /actions\/configure-pages@45bfe0192ca1faeb007ade9deae92b16b8254a0d # v6\.0\.0/)
assert.match(workflow, /actions\/upload-pages-artifact@fc324d3547104276b827a68afc52ff2a11cc49c9 # v5\.0\.0/)
assert.match(workflow, /actions\/deploy-pages@368f82528645a54fb793d4d04e342629a3f51346 # v5\.0\.1/)
assert.doesNotMatch(workflow, /push:\s+branches:/)
assert.doesNotMatch(workflow, /artifact_name|source_run_id|handoff|trycloudflare|pyjam/i)

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
