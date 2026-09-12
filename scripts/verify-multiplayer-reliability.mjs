import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const workflow = readFileSync(new URL('../.github/workflows/multiplayer-session.yml', import.meta.url), 'utf8')
const run = (script, env = {}, cwd) => spawnSync('bash', ['-e', '-c', script], {
  cwd, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 5000,
})
const publish = workflow.split('      - name: Point the stable Pages URL at this session\n')[1]
  .split('      - uses: actions/upload-artifact@v4')[0]
  .split('        run: |\n')[1].replace(/^          /gm, '')
const directory = mkdtempSync(join(tmpdir(), 'sts-multiplayer-reliability-'))

try {
  mkdirSync(join(directory, 'dist'))
  const envFile = join(directory, 'github-env')
  const result = run(publish, {
      EXPECTED_PROTOCOL_VERSION: '1', GITHUB_ENV: envFile, GITHUB_RUN_ID: '222',
      HANDOFF_AFTER_SECONDS: '600', HANDOFF_DEADLINE: '2000', SESSION_SHA: 'a'.repeat(40),
      SOURCE_RUN_ID: '111', TUNNEL_URL: 'https://two.trycloudflare.com',
      TUNNEL_URLS: '["https://one.trycloudflare.com","https://two.trycloudflare.com"]',
    }, directory)
  assert.equal(result.status, 0, result.stderr)
  const session = JSON.parse(readFileSync(join(directory, 'pages/session.json'), 'utf8'))
  assert.deepEqual(session.origins, ['https://one.trycloudflare.com', 'https://two.trycloudflare.com'])
  assert.equal(session.origin, 'https://two.trycloudflare.com')
  assert.equal(session.manualHandoff, true)

  const publishedConfig = workflow.indexOf('$PAGES_URL/session.json?handoff=')
  const bridge = workflow.indexOf('STS_HANDOFF_PROXY_TARGETS="$successors"')
  const readBridge = workflow.indexOf('Bridge reads from the old endpoint to the restored successor')
  assert(readBridge > workflow.indexOf('room-store-${{ github.run_id }}'))
  assert(readBridge < workflow.indexOf('Start and verify the successor'))
  assert(bridge > publishedConfig)
  assert(bridge > workflow.indexOf('if [ "$successor_healthy" = true ]'))
  assert.match(workflow, /for tunnel_number in 1 2/)
  assert.match(workflow, /printf '%s\\n%s\\n%s\\n' "\$TUNNEL_URL" "\$SESSION_SHA" "\$TUNNEL_URLS"/)
  assert.match(workflow, /STS_HANDOFF_PROXY_TARGETS="\$successors"/)
  assert.match(workflow, /STS_HANDOFF_PROXY_WRITE_MARKER="\$RUNNER_TEMP\/handoff-proxy-writes"/)
  assert.match(workflow, /bridge_targets=\$\(jq -c 'unique' <<< "\$SELECTED_ORIGINS"\)/)

  const chooseSource = workflow.split('      - name: Choose the room source for this push\n')[1]
    .split('      - uses: actions/checkout@v4')[0].split('        run: |\n')[1].replace(/^          /gm, '')
  const stubs = `timeout() { shift; "$@"; }
gh() { [[ "$*" == *git/ref/heads/master* ]] && echo ${'a'.repeat(40)} || echo in_progress; }
curl() {
  local url=\${!#}
  [[ "$url" == *session.json* ]] && { printf '%s' "$CONFIG"; return; }
  [[ "$url" == https://two.trycloudflare.com/api/health ]] && { printf '{"protocolVersion":1,"profiles":true}'; return; }
  [[ "$url" == https://two.trycloudflare.com/ ]] && return
  return 22
}
`
  const config = JSON.stringify({ runId: '111', origin: 'https://one.trycloudflare.com', origins: ['https://one.trycloudflare.com', 'https://two.trycloudflare.com'] })
  const chooseResult = run(`${stubs}\n${chooseSource}`, {
    CONFIG: config, EXPECTED_PROTOCOL_VERSION: '1', GITHUB_ENV: envFile,
    GITHUB_REPOSITORY: 'owner/game', GITHUB_RUN_ID: '222', PAGES_URL: 'https://pages.test',
  })
  assert.equal(chooseResult.status, 0, chooseResult.stderr)
  assert.match(readFileSync(envFile, 'utf8'), /PUBLISH_CLIENT=true\nSOURCE_RUN=111/)

  const waitForState = workflow.split('      - name: Wait for the frozen room state\n')[1]
    .split('      - name: Restore rooms from the previous runner')[0].split('        run: |\n')[1].replace(/^          /gm, '')
  const waitResult = run(`${stubs}
sleep() { :; }
gh() {
  if [ "$1 $2" = 'run download' ]; then
    while [ "$1" != --dir ]; do shift; done
    mkdir -p "$2"
    [[ "$2" == */selection ]] && printf '222\\n%s\\n' "$SESSION_SHA" > "$2/handoff-selected"
    return 0
  else echo 123; fi
}
${waitForState}`, {
    CONFIG: config, EXPECTED_PROTOCOL_VERSION: '1', GITHUB_REPOSITORY: 'owner/game',
    GITHUB_RUN_ID: '222', RUNNER_TEMP: directory, SESSION_SHA: 'a'.repeat(40),
    SOURCE_RUN_ID: '111', SOURCE_WAIT_SECONDS: '60',
    TUNNEL_URLS: '["https://one.trycloudflare.com","https://two.trycloudflare.com"]',
  })
  assert.equal(waitResult.status, 0, waitResult.stderr + waitResult.stdout)

  const startServer = workflow.split('      - name: Start the room server\n')[1]
    .split('      - name: Recheck the source archive before publishing')[0].split('        run: |\n')[1].replace(/^          /gm, '')
  const startResult = run(`nohup() { :; }
curl() {
  local url=\${!#}
  [[ "$url" == http://127.0.0.1:5180/api/health || "$url" == https://one.trycloudflare.com/api/health || "$url" == https://two.trycloudflare.com/api/health ]]
}
${startServer}`, {
    GITHUB_ENV: envFile, RUNNER_TEMP: directory,
    TUNNEL_URLS: '["https://one.trycloudflare.com","https://two.trycloudflare.com"]',
  })
  assert.equal(startResult.status, 0, startResult.stderr + startResult.stdout)
  assert.match(readFileSync(envFile, 'utf8'), /TUNNEL_URL=https:\/\/one\.trycloudflare\.com/)
  assert.match(startServer, /public_origins_ready=false/)

  const verify = workflow.split('      - name: Start and verify the successor\n')[1]
    .split('          exit 1')[0]
  const grace = verify.indexOf('bridge_grace=720')
  const bridgeStart = verify.indexOf('STS_HANDOFF_PROXY_TARGETS="$successors"')
  const writesEnabled = verify.indexOf('touch "$RUNNER_TEMP/handoff-proxy-writes"')
  assert(grace > verify.indexOf('successor_healthy" = true'))
  assert(bridgeStart > verify.indexOf('successor_healthy" = true'))
  assert(bridgeStart < grace)
  assert(writesEnabled > bridgeStart)
  assert(writesEnabled < grace)
  assert(verify.indexOf('sleep 0.25') > verify.indexOf('successor_healthy" = true'))
  assert(verify.indexOf('sleep 0.25') < bridgeStart)
  assert(verify.indexOf('! kill -0 "$bridge_pid"', bridgeStart) > bridgeStart)
  assert(verify.indexOf('sleep "$bridge_grace"', grace) > grace)
  assert(verify.indexOf('kill "$bridge_pid"', bridgeStart) > bridgeStart)
  assert(verify.indexOf('handoff-proxy.pid', grace) > grace)
  assert(verify.indexOf('exit 0', grace) > grace)
  console.log('✓ dead primaries fall back to a healthy secondary and the old bridge overlaps Pages propagation')
} finally {
  rmSync(directory, { recursive: true, force: true })
}
