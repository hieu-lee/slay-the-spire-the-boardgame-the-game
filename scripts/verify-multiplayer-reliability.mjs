import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateRoomStore } from '../infra/validate-room-store.mjs'

const workflowsDirectory = new URL('../.github/workflows/', import.meta.url)
assert.deepEqual(readdirSync(workflowsDirectory).sort(), ['ci.yml', 'pages-deploy.yml', 'server-deploy.yml'])
const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
const pages = readFileSync(new URL('../.github/workflows/pages-deploy.yml', import.meta.url), 'utf8')
const server = readFileSync(new URL('../.github/workflows/server-deploy.yml', import.meta.url), 'utf8')
const service = readFileSync(new URL('../infra/systemd/sts-room-server.service', import.meta.url), 'utf8')
const runner = readFileSync(new URL('../infra/systemd/sts-actions-runner.service', import.meta.url), 'utf8')
const deploy = readFileSync(new URL('../infra/deploy-local-server.sh', import.meta.url), 'utf8')
assert.match(deploy, /active_state=\$\(systemctl --user show -p ActiveState --value sts-room-server\.service/)
assert.match(deploy, /\[ -n "\$previous_release" \] && \[ "\$server_stopped" = true \]; then\s+node "\$release\/infra\/validate-room-store\.mjs" --materialize "\$store" "\$previous_release\/scripts\/lib\/leaderboard\.mjs"/)

for (const activeState of ['active', 'inactive']) {
  const failedStopHome = mkdtempSync(join(tmpdir(), 'sts-failed-stop-'))
  try {
    const data = join(failedStopHome, '.local/share/slay-the-spire-server')
    const release = join(data, 'releases', 'a'.repeat(40))
    const previous = join(data, 'releases', 'previous')
    const commands = join(failedStopHome, 'commands')
    mkdirSync(join(release, 'node_modules/ws'), { recursive: true })
    mkdirSync(join(release, 'infra/systemd'), { recursive: true })
    mkdirSync(join(release, 'scripts'), { recursive: true })
    mkdirSync(join(previous, 'scripts', 'lib'), { recursive: true })
    mkdirSync(commands)
    symlinkSync(previous, join(data, 'current'))
    writeFileSync(join(release, 'scripts/room-server.mjs'), '')
    writeFileSync(join(release, 'infra/systemd/sts-room-server.service'), '[Service]\n')
    writeFileSync(join(release, 'infra/validate-room-store.mjs'), 'import { writeFileSync } from "node:fs"; writeFileSync(process.env.ROLLBACK_MARKER, "called")\n')
    const systemctl = join(commands, 'systemctl')
    writeFileSync(systemctl, '#!/bin/sh\ncase "$2" in\n  restart|stop) exit 1;;\n  show) printf "%s\\n" "$SIMULATED_ACTIVE_STATE";;\n  start) printf started > "$START_MARKER";;\nesac\nexit 0\n')
    chmodSync(systemctl, 0o755)
    const node = join(commands, 'node')
    writeFileSync(node, `#!/bin/sh\n[ "$1" = --input-type=module ] && exit 0\nexec "${process.execPath}" "$@"\n`)
    chmodSync(node, 0o755)
    const marker = join(failedStopHome, 'materialized')
    const startMarker = join(failedStopHome, 'restarted-current')
    const result = spawnSync('bash', ['infra/deploy-local-server.sh'], { cwd: new URL('..', import.meta.url),
      env: { ...process.env, HOME: failedStopHome, PATH: `${commands}:${process.env.PATH}`,
        SESSION_SHA: 'a'.repeat(40), ROLLBACK_MARKER: marker, START_MARKER: startMarker,
        SIMULATED_ACTIVE_STATE: activeState }, encoding: 'utf8', timeout: 10_000 })
    assert.equal(result.status, 1, result.stderr)
    assert.equal(readlinkSync(join(data, 'current')), activeState === 'inactive' ? previous : release,
      'rollback selected the wrong release after a failed stop')
    assert.equal(existsSync(marker), activeState === 'inactive', 'rollback materialized with an active server')
    assert.equal(existsSync(startMarker), true, 'failed stop left the server down')
  } finally {
    rmSync(failedStopHome, { recursive: true, force: true })
  }
}
const windowsInstall = readFileSync(new URL('../infra/windows/install-host.ps1', import.meta.url), 'utf8')
const routerMapping = readFileSync(new URL('../infra/windows/renew-router-pinhole.ps1', import.meta.url), 'utf8')
const caddy = readFileSync(new URL('../infra/windows/Caddyfile', import.meta.url), 'utf8')
const wslInstall = readFileSync(new URL('../infra/install-wsl-host.sh', import.meta.url), 'utf8')
const wslWatchdog = readFileSync(new URL('../infra/watchdog-wsl-host.sh', import.meta.url), 'utf8')
const checkoutAction = 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1'
const pnpmAction = 'pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413 # v6.1.0'
const setupNodeAction = 'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0'

const storeDirectory = mkdtempSync(join(tmpdir(), 'sts-store-'))
try {
  const store = join(storeDirectory, 'rooms.json')
  writeFileSync(store, JSON.stringify({ version: 1, rooms: [], leaderboardRuns: [] }))
  await validateRoomStore(store, new URL('./lib/rooms.mjs', import.meta.url).pathname)
} finally {
  rmSync(storeDirectory, { recursive: true, force: true })
}

assert.match(ci, /on:\s+push:\s+pull_request:/)
assert.match(ci, /pull_request:/)
assert.match(ci, /workflow_dispatch:/)
assert.match(ci, /pnpm build/)
assert.equal((ci.match(/node-version: 24/g) ?? []).length, 1)
assert.match(ci, /verify-all\.mjs --changed="\$base" --lane=light --jobs=4/)
assert.match(ci, /jobs:\s+verify:\s+runs-on: ubuntu-latest/)
assert.doesNotMatch(ci, /verify-browser:/)
assert.match(
  ci,
  /apt-get install -y(?=[^\n]*\bffmpeg\b)(?=[^\n]*\bpython3-numpy\b)(?=[^\n]*\bpython3-pil\b)(?=[^\n]*\bwebp\b)[^\n]*/,
)
assert.match(ci, /deploy-server:[\s\S]*needs: verify[\s\S]*uses: \.\/\.github\/workflows\/server-deploy\.yml/)
assert.match(ci, /deploy-pages:[\s\S]*needs: deploy-server[\s\S]*uses: \.\/\.github\/workflows\/pages-deploy\.yml/)
assert.doesNotMatch(ci, /always\(\)/)
assert.match(ci, /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/)
assert.match(ci, /github\.ref == 'refs\/heads\/master'/)

assert.match(pages, /workflow_call:/)
assert.match(pages, /workflow_dispatch:/)
assert.match(pages, /runs-on: ubuntu-latest/)
assert.match(pages, /node-version: 24/)
assert.match(pages, /VITE_ASSET_CDN_ORIGIN="https:\/\/cdn\.jsdelivr\.net\/gh\/\$GITHUB_REPOSITORY@\$DEPLOY_SHA\/public\/assets" VITE_SINGLE_PLAYER=false VITE_HOSTED_SESSION=true pnpm build/)
assert.match(pages, /find dist\/assets\/combat\/rigged -type f -name '\*\.mov' -delete/)
assert.match(pages, /find dist\/assets\/bgm -type f -delete/)
assert.match(pages, /hero-defect-idle\.mov[\s\S]*content-type: video\/quicktime/)
assert.match(pages, /exordium\.mp3[\s\S]*content-type: audio\/mpeg/)
assert.match(pages, /du -sb dist[\s\S]*-lt 1000000000/)
assert.match(pages, /MULTIPLAYER_SERVER_ORIGIN: \$\{\{ vars\.MULTIPLAYER_SERVER_ORIGIN }}/)
assert.match(pages, /protocolVersion:1,alwaysOn:true/)
assert.match(pages, /\.releaseSha == \$sha/)
assert.match(pages, /validate-session-config\.mjs/)
assert.match(pages, /actions\/configure-pages@45bfe0192ca1faeb007ade9deae92b16b8254a0d # v6\.0\.0/)
assert.match(pages, /actions\/upload-pages-artifact@fc324d3547104276b827a68afc52ff2a11cc49c9 # v5\.0\.0/)
assert.match(pages, /actions\/deploy-pages@368f82528645a54fb793d4d04e342629a3f51346 # v5\.0\.1/)
assert.match(pages, /git merge-base --is-ancestor "\$DEPLOY_SHA" origin\/master/)
assert.doesNotMatch(pages, /push:\s+branches:/)

assert.match(server, /runs-on: \[self-hosted, linux, x64, sts-server]/)
assert.match(server, /workflow_call:/)
assert.match(server, /workflow_dispatch:\s+inputs:\s+deploy_sha:/)
assert.match(server, /SESSION_SHA: \$\{\{ inputs\.deploy_sha \|\| github\.sha }}/)
assert.match(server, /test "\$\(git rev-parse origin\/master\)" = "\$SESSION_SHA"/)
assert.match(server, /bash infra\/deploy-local-server\.sh prepare/)
assert.match(server, /bash infra\/deploy-local-server\.sh/)
assert.doesNotMatch(server, /push:\s+branches:/)
assert.doesNotMatch(server, /actions: write|ROOM_STORE_KEY|GH_TOKEN/)
for (const workflow of [ci, pages, server]) {
  assert(workflow.includes(checkoutAction))
  assert(workflow.includes(pnpmAction))
  for (const checkout of workflow.split(`- uses: ${checkoutAction}`).slice(1)) {
    assert.match(checkout.split('\n      - ', 1)[0], /persist-credentials: false/)
  }
}
for (const workflow of [ci, pages]) assert(workflow.includes(setupNodeAction))
const actions = `${ci}\n${pages}\n${server}`
assert.doesNotMatch(actions, /(?:checkout|setup-node|configure-pages|upload-pages-artifact|deploy-pages|action-setup)@v\d+/)
assert.doesNotMatch(actions, /handoff|keepalive|cloudflared|tunnel\.pyjam\.as|MULTIPLAYER_TUNNEL_PROVIDER|source_run_id|manualHandoff/i)

assert.match(service, /Restart=always/)
assert.match(service, /STS_ROOM_STORE=%h\/\.local\/share\/slay-the-spire-server\/rooms\.json/)
assert.match(service, /STS_RESTART_RECOVERY=true/)
assert.match(service, /STS_RESTART_RECONNECT_MS=3600000/)
assert.match(service, /WorkingDirectory=%h\/\.local\/share\/slay-the-spire-server\/current/)
assert.doesNotMatch(service, /migration-hold|HANDOFF/)
const roomServer = readFileSync(new URL('./room-server.mjs', import.meta.url), 'utf8')
assert.match(roomServer, /export const MAX_CONNECTIONS = 50/)
assert.match(roomServer, /const MAX_MESSAGES_PER_WINDOW = 300/)
assert.match(roomServer, /const MAX_PROFILE_CLAIMS_PER_WINDOW = 30/)
assert.match(roomServer, /const MAX_READS_PER_WINDOW = 600/)
assert.match(roomServer, /const MAX_VOICE_MESSAGES_PER_WINDOW = 600/)
assert.match(roomServer, /connections: sockets\.size, connectionCapacity: maxConnections/)
assert.doesNotMatch(roomServer, /client\.rateLimited/)
assert.doesNotMatch(roomServer, /POST.*profile[\s\S]{0,180}consume\(createRates/)
assert.match(runner, /Restart=always/)
assert.match(runner, /DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1/)

assert.match(wslInstall, /loginctl enable-linger "\$USER"/)
assert.match(wslInstall, /is-active --quiet sts-actions-runner\.service[\s\S]*is-active --quiet sts-room-server\.service/)
assert.match(deploy, /releases_dir="\$data_dir\/releases"/)
assert.match(deploy, /git -C "\$root" archive HEAD -- package\.json scripts\/room-server\.mjs/)
assert.match(deploy, /cp -aL "\$root\/node_modules\/ws"/)
assert.match(deploy, /validate-room-store\.mjs/)
assert.match(deploy, /previous_release=.*readlink -f/)
assert.match(deploy, /current\.rollback/)
assert.match(deploy, /finish_deployment\(\)/)
assert.match(deploy, /check_health '' http:\/\/127\.0\.0\.1:8787 "\$MULTIPLAYER_SERVER_ORIGIN" \|\| rollback_failed=true/)
assert.match(deploy, /check_health "\$session_sha" http:\/\/127\.0\.0\.1:8787/)
assert.match(deploy, /rollback failed; preserving the service-unit backup/i)
assert.match(deploy, /webSocketActionAcks !== true/)
assert.doesNotMatch(deploy, /gh run download|ROOM_STORE_KEY|rooms\.json\.gpg|migration-hold|handoff/i)

assert.match(wslWatchdog, /start sts-actions-runner\.service/)
assert.match(wslWatchdog, /start sts-room-server\.service/)
assert.doesNotMatch(wslWatchdog, /is-active --quiet sts-actions-runner\.service/)
assert.doesNotMatch(wslWatchdog, /stop sts-room-server|migration-hold|held/)

assert.match(windowsInstall, /New-ScheduledTaskTrigger -AtStartup/)
assert.match(windowsInstall, /LogonType S4U/)
assert.match(windowsInstall, /RestartCount 999/)
assert.match(windowsInstall, /RepetitionInterval \(New-TimeSpan -Minutes 1\)/)
assert.match(windowsInstall, /MultipleInstances IgnoreNew/)
assert.match(
  windowsInstall,
  /\$wslArguments = [\s\S]{0,200}sts-actions-runner\.service sts-room-server\.service && exec sleep infinity/,
)
assert.match(
  windowsInstall,
  /Register-ScheduledTask -TaskName 'Slay the Spire WSL services'[\s\S]{0,160}-Trigger \$wslTriggers[\s\S]{0,100}-Settings \$wslSettings/,
)
assert.match(
  windowsInstall,
  /Stop-ScheduledTask -TaskName 'Slay the Spire WSL services'[^\n]*\n  Register-ScheduledTask -TaskName 'Slay the Spire WSL services'/,
)
assert.match(
  windowsInstall,
  /if \(-not \$installationSucceeded\)[\s\S]{0,900}Stop-ScheduledTask -TaskName 'Slay the Spire WSL services'[^\n]*\n      foreach \(\$taskName in \$managedTasks\)/,
)
assert.match(routerMapping, /Invoke-NatPmpMapping \$ipv4Route\.NextHop 443 18443/)
assert.match(routerMapping, /Invoke-PcpMapping \$sourceIpv6 \$scopedIpv6Gateway 443 18443/)
assert.match(routerMapping, /gh variable set MULTIPLAYER_SERVER_ORIGIN/)
assert.match(routerMapping, /gh workflow run pages-deploy\.yml/)
assert.match(routerMapping, /deploy_sha=\{0\}.*health\.releaseSha/)
assert.match(routerMapping, /session\.sha -eq \[string\]\$health\.releaseSha/)
assert.doesNotMatch(routerMapping, /multiplayer-session\.yml|manualHandoff|source_run_id/i)
assert.doesNotMatch(routerMapping, /roomReady|migration hold|watchdogState -eq 'held'/i)
assert.match(routerMapping, /Start-Sleep -Seconds 60/)
assert.match(caddy, /reverse_proxy 127\.0\.0\.1:8787/)
assert.match(caddy, /header_up Cf-Connecting-Ip \{remote_host\}/)

console.log('✓ always-on self-hosted multiplayer has focused CI, Pages, and server deployment paths')
