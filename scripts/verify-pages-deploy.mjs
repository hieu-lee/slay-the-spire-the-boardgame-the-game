import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
console.log('✓ Pages artifact downloads retry once with a five-minute attempt budget')
