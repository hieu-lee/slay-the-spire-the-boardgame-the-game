import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const workflow = readFileSync(new URL('../.github/workflows/multiplayer-session.yml', import.meta.url), 'utf8')
const request = readFileSync(new URL('../.github/workflows/request-session-handoff.yml', import.meta.url), 'utf8')
const host = workflow.split('      - name: Host and prewarm the successor\n')[1].split('      - uses: actions/upload-artifact@v4')[0]
  .split('        run: |\n')[1].replace(/^          /gm, '')
const poll = host.slice(0, host.indexOf('while [ "$(date +%s)" -lt "$PREWARM_AT" ]'))
const validate = request.split('        run: |\n')[1].replace(/^          /gm, '')
const signal = { display_title: 'Manual handoff for run 111', head_branch: 'master', event: 'workflow_dispatch', conclusion: 'success' }
const run = (script, env = {}) => spawnSync('bash', ['-e', '-c', script], {
  env: { ...process.env, GITHUB_RUN_ID: '111', GITHUB_REPOSITORY: 'owner/game', GITHUB_REF: 'refs/heads/master', ...env }, encoding: 'utf8', timeout: 5000,
})
const stubs = `timeout() { shift; "$@"; }
date() { echo 1000; }
gh() { printf '%s' "$RESPONSE"; return "${'${API_STATUS:-0}'}"; }
`
for (const [response, expected, apiStatus] of [
  [{ workflow_runs: [signal] }, 'true:1600', '0'],
  [{ workflow_runs: [{ ...signal, display_title: 'Manual handoff for run 222' }] }, 'false:5000', '0'],
  [{ workflow_runs: [{ ...signal, conclusion: 'failure' }] }, 'false:5000', '0'],
  [{ workflow_runs: [{ ...signal, conclusion: null }] }, 'false:5000', '0'],
  [{ workflow_runs: [{ ...signal, head_branch: 'feature' }] }, 'false:5000', '0'],
  [{ workflow_runs: [{ ...signal, event: 'push' }] }, 'false:5000', '0'],
  [{ workflow_runs: [] }, 'false:5000', '0'],
  [{ workflow_runs: [signal] }, 'false:5000', '1'],
]) {
  const result = run(`${stubs}\nHANDOFF_AT=5000\n${poll}\npoll_manual_handoff\necho "$manual_handoff:$HANDOFF_AT"`, { RESPONSE: JSON.stringify(response), API_STATUS: apiStatus })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim().split('\n').at(-1), expected)
}
const repeated = run(`${stubs}\nHANDOFF_AT=1200\n${poll}\npoll_manual_handoff\nRESPONSE='invalid'\npoll_manual_handoff\necho "$manual_handoff:$HANDOFF_AT"`, { RESPONSE: JSON.stringify({ workflow_runs: [signal] }) })
assert.equal(repeated.status, 0, repeated.stderr)
assert.equal(repeated.stdout.trim().split('\n').at(-1), 'true:1200', 'a request extended the scheduled deadline or was not idempotent')
for (const [target, config, status, ref, accepted] of [
  ['111', { runId: '111', manualHandoff: true }, 'in_progress', 'refs/heads/master', true],
  ['111', { runId: '222', manualHandoff: true }, 'in_progress', 'refs/heads/master', false],
  ['111', { runId: '111' }, 'in_progress', 'refs/heads/master', false],
  ['111', { runId: '111', manualHandoff: true }, 'completed', 'refs/heads/master', false],
  ['111', { runId: '111', manualHandoff: true }, 'in_progress', 'refs/heads/feature', false],
  ['x;echo bad', { runId: '111', manualHandoff: true }, 'in_progress', 'refs/heads/master', false],
]) {
  const result = run(`timeout() { shift; "$@"; }; curl() { printf '%s' "$CONFIG"; }; gh() { printf '%s' "$STATUS"; };\n${validate}`, {
    TARGET_RUN: target, CONFIG: JSON.stringify(config), STATUS: status, GITHUB_REF: ref,
  })
  assert.equal(result.status === 0, accepted, result.stderr)
}

// Exercise the real fallback admission condition as master advances during preparation.
const fallbackStart = host.indexOf('if [[ "$fallback_sha"')
const fallbackGuard = host.slice(fallbackStart, host.indexOf('selected_winner=$replacement_run', fallbackStart))
for (const [manual, candidate, expected] of [[true, 'b', false], [true, 'a', true], [false, 'b', true]]) {
  const result = run(`date() { echo 1000; }; any_origin_healthy() { return 0; };
${fallbackGuard}
echo accepted
fi`, {
    manual_handoff: String(manual), fallback_sha: candidate.repeat(40), next_sha: 'a'.repeat(40),
    fallback_started_epoch: '1000', fallback_url: 'https://candidate.test',
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.includes('accepted'), expected, 'fallback selected a stale manual candidate')
}

// Execute the actual orchestration step with a ready replacement, without a real runner or network.
const directory = mkdtempSync(join(tmpdir(), 'sts-manual-handoff-'))
try {
  const orchestration = `
    timeout() { shift; "$@"; }
    date() { echo 1000; }
    curl() { echo '{"runId":"111","sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'; }
    gh() {
      if [ "$1" = run ] && [ "$2" = download ]; then
        local destination
        while [ "$#" -gt 0 ]; do
          if [ "$1" = --dir ]; then destination=$2; break; fi
          shift
        done
        mkdir -p "$destination"
        printf '%s\\n%s\\n%s\\n' 'https://successor.test' aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa '["https://successor.test"]' > "$destination/handoff-ready"
      elif [[ "$*" == *request-session-handoff.yml* ]]; then echo "$RESPONSE"
      elif [[ "$*" == *git/ref/heads/master* ]]; then echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
      elif [[ "$*" == */artifacts* ]]; then echo "$ARTIFACTS"
      elif [[ "$*" == *run_started_at* ]]; then echo '2026-01-01T00:00:00Z'
      elif [[ "$*" == *'--jq .status' ]]; then echo in_progress
      elif [[ "$*" == *'(.id | tostring)'* ]]; then :
      elif [[ "$*" == *multiplayer-session.yml* ]]; then echo 222
      else echo "Unexpected gh call: $*" >&2; return 1
      fi
    }
    sleep() { echo 'Unexpected sleep before ready handoff' >&2; return 1; }
    PREWARM_AT=4000
    HANDOFF_AT=5000
    HANDOFF_DEADLINE=6000
    VERIFY_DEADLINE=7000
    SESSION_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
    ${host}
    [ "$HANDOFF_AT" = 1000 ]
  `
  for (const ready of [false, true]) {
    const result = run(orchestration, { RUNNER_TEMP: directory, GITHUB_ENV: join(directory, 'env'),
      RESPONSE: JSON.stringify({ workflow_runs: [signal] }), TUNNEL_URL: 'https://source.test', PAGES_URL: 'https://pages.test',
      TUNNEL_URLS: '["https://source.test"]',
      ARTIFACTS: JSON.stringify({ artifacts: ready ? [{ name: 'handoff-ready-111' }, { name: 'handoff-candidate-111' }] : [] }),
    })
    if (!ready) {
      assert.notEqual(result.status, 0, 'a request without a ready successor reached the freeze step')
      assert.match(result.stderr, /Unexpected sleep/, result.stderr)
    } else {
      assert.equal(result.status, 0, result.stderr + result.stdout)
      assert.equal(readFileSync(join(directory, 'handoff-selected'), 'utf8'), '222\naaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n')
    }
  }
  assert(workflow.indexOf('Freeze and flush the room state') > workflow.indexOf('Host and prewarm the successor'))
  assert.match(workflow, /manualHandoff:true/)
} finally { rmSync(directory, { recursive: true, force: true }) }
console.log('Manual handoff: authenticated target guards, failed/foreign requests, API failures, idempotence, deadlines and ready-successor orchestration pass')
