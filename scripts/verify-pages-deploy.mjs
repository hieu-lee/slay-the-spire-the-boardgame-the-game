import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const workflow = readFileSync(new URL('../.github/workflows/pages-deploy.yml', import.meta.url), 'utf8')
const step = workflow.split('      - name: Download and validate the prepared site\n')[1]
  .split('          desired_run=')[0]
  .split('        run: |\n')[1]
  .replace(/^          /gm, '')

for (const [failures, expected] of [[0, true], [1, true], [2, false]]) {
  const directory = mkdtempSync(join(tmpdir(), 'sts-pages-deploy-'))
  try {
    const result = spawnSync('bash', ['-e', '-c', `
      timeout() { shift; "$@"; }
      sleep() { :; }
      gh() {
        calls=$((calls + 1))
        [ "$calls" -gt "$FAILURES" ] || return 1
        while [ "$#" -gt 0 ]; do
          if [ "$1" = --dir ]; then mkdir -p "$2"; printf '{}' > "$2/session.json"; return; fi
          shift
        done
        return 1
      }
      calls=0
      ${step}
    `], { cwd: directory, env: { ...process.env, FAILURES: String(failures), RUNNER_TEMP: directory }, encoding: 'utf8' })
    assert.equal(result.status === 0, expected, result.stderr)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

assert.match(workflow, /timeout-minutes: 15/)
assert.match(step, /timeout 300s gh run download/)
assert(workflow.indexOf('actions/upload-pages-artifact@v4') > workflow.indexOf('Verify the room endpoint immediately before deployment'))
assert.match(workflow, /jq --arg origin "\$healthy_origin" '\.origin = \$origin'/)
const originValidation = `jq -e ${workflow.split('          jq -e ')[1]
  .split('      - uses: actions/configure-pages@v5')[0].replace(/^          /gm, '')}`
for (const [origins, accepted] of [
  [['https://one.trycloudflare.com'], true],
  [['https://abc123.tunnel.pyjam.as'], true],
  [['https://one.trycloudflare.com', 'https://moo123.tunnel.pyjam.as'], true],
  [['https://abc123.tunnel.pyjam.as.evil'], false],
  [['https://abc123.tunnel.pyjam.as\nhttps://moo123.tunnel.pyjam.as'], false],
  [['https://abc123.tunnel.pyjam.as\n'], false],
  [['https://invalid.example.com'], false],
]) {
  const directory = mkdtempSync(join(tmpdir(), 'sts-pages-origins-'))
  try {
    mkdirSync(join(directory, 'pages'))
    writeFileSync(join(directory, 'pages/session.json'), JSON.stringify({ origin: origins[0], origins }))
    const result = spawnSync('bash', ['-e', '-c', originValidation], { cwd: directory, encoding: 'utf8' })
    assert.equal(result.status === 0, accepted, result.stderr)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}
for (const config of [
  { origin: 'https://abc123.tunnel.pyjam.as', origins: false },
  { origin: 'https://abc123.tunnel.pyjam.as', origins: [123] },
  { origin: null, origins: ['https://abc123.tunnel.pyjam.as'] },
]) {
  const directory = mkdtempSync(join(tmpdir(), 'sts-pages-origin-types-'))
  try {
    mkdirSync(join(directory, 'pages'))
    writeFileSync(join(directory, 'pages/session.json'), JSON.stringify(config))
    const result = spawnSync('bash', ['-e', '-c', originValidation], { cwd: directory, encoding: 'utf8' })
    assert.notEqual(result.status, 0, JSON.stringify(config))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}
console.log('✓ Pages artifacts retry once and accept only supported tunnel origins')
