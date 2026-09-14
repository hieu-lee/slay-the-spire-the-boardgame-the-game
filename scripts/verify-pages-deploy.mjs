import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { validateSessionConfig } from './validate-session-config.mjs'

const workflow = readFileSync(new URL('../.github/workflows/pages-deploy.yml', import.meta.url), 'utf8')
assert.match(workflow, /actions\/checkout@v4\s+with:\s+persist-credentials: false/)
assert.doesNotMatch(workflow, /timeout-minutes: 15\s+env:\s+GH_TOKEN:/)
assert.match(workflow, /Verify the room endpoint immediately before deployment\s+env:\s+GH_TOKEN: \$\{\{ github\.token \}\}/)
assert.match(workflow, /producer_title[\s\S]*Multiplayer handoff from \$migration_source[\s\S]*handoff-selected-\$migration_source/)
assert.match(workflow, /expected_sha=\$selected_sha[\s\S]*else[\s\S]*expected_sha=\$\(gh api .*git\/ref\/heads\/master/)
assert.match(workflow, /Verify the migration producer remains live[\s\S]*PAGES_SOURCE_RUN_ID[\s\S]*in_progress/)
const stableOrigin = 'https://sts-94-239-51-8.2001-861-388c-4ee0-c3d5-2f30-1be7-2e79.sslip.io:18443'
const sha = 'a'.repeat(40)

for (const [config, accepted] of [
  [{ protocolVersion: 1, sha, runId: '12', origin: stableOrigin, origins: [stableOrigin] }, true],
  [{ protocolVersion: 1, sha, runId: '12', origin: 'https://abc123.tunnel.pyjam.as', origins: ['https://abc123.tunnel.pyjam.as'] }, true],
  [{ protocolVersion: 1, sha, runId: '12', origin: 'https://old.trycloudflare.com', origins: ['https://old.trycloudflare.com'] }, true],
  [{ protocolVersion: 1, sha, runId: '12', origin: `${stableOrigin}.evil`, origins: [] }, false],
  [{ protocolVersion: 2, sha, runId: '12', origin: stableOrigin, origins: [] }, false],
  [{ protocolVersion: 1, sha: 'b'.repeat(40), runId: '12', origin: stableOrigin, origins: [] }, false],
  [{ protocolVersion: 1, sha, runId: 12, origin: stableOrigin, origins: [] }, false],
  [{ protocolVersion: 1, sha, runId: '12', origin: stableOrigin, origins: [123] }, false],
]) {
  let valid = true
  try {
    validateSessionConfig(config, { sha, stableOrigin })
  } catch {
    valid = false
  }
  assert.equal(valid, accepted, JSON.stringify(config))
}

assert.match(workflow, /timeout 300s gh run download/)
assert.match(workflow, /Verify the room endpoint immediately before deployment/)
assert.match(workflow, /\.profiles == true/)
assert.match(workflow, /validate-session-config\.mjs/)
assert.match(workflow, /actions\/deploy-pages@v4/)
console.log('✓ Pages accepts the stable host plus one-time legacy handoff origins')
