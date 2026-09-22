# Online co-op

The room server owns every multiplayer run. Browsers receive only the hidden cards for
their own seat and recover that seat after a refresh or closed tab. Voice is a browser-native
WebRTC mesh; the room WebSocket carries signaling only, never audio.

## Production host

Production multiplayer runs on `DESKTOP-09UIMTJ` instead of an expiring GitHub-hosted
runner or a third-party tunnel:

- GitHub Pages serves the browser client.
- The `Deploy multiplayer server` workflow uses a repository-scoped self-hosted Actions
  runner to install server releases into WSL.
- `sts-room-server.service` keeps the authoritative Node room process running and restarts
  it after a failure. The game process is a local systemd user service and does not depend
  on an Actions job staying alive.
- The `Slay the Spire WSL services` Windows task keeps the WSL user session alive. It starts
  at boot and logon, restarts after failures or power-state changes, and retries every minute
  so WSL termination cannot leave the room server or Actions runner offline indefinitely.
- Caddy runs on Windows, terminates public HTTPS and WebSocket traffic, and proxies it to
  WSL on `127.0.0.1:8787`.
- A small Windows task renews native Bbox IPv4 and IPv6 mappings every hour. IPv4
  clients enter on TCP 18443 while IPv6 clients use a PCP firewall pinhole; both reach
  Caddy on TCP 443.
- `session.json` advertises the HTTPS origin stored in the repository variable
  `MULTIPLAYER_SERVER_ORIGIN`.

The room server is tuned for 5–10 regular players spread across simultaneous four-player
rooms and accepts up to 50 authenticated WebSocket connections. Gameplay, snapshot reads,
reconnect authentication, and WebRTC signaling use separate budgets, so a four-player
burst in one category cannot disconnect a seat or starve recovery in another.
Normal over-limit traffic receives a retryable error while the socket stays open; only an
abusive 300-messages-per-second connection is closed. Slow clients have a 2 MiB outbound
buffer before the server drops them to protect the other games.

GitHub Actions has three jobs only: affected build/tests on pushes and pull requests,
GitHub Pages deployment, and server release deployment on the self-hosted runner. No hosted
runner keeps the game alive and no room state travels through Actions artifacts.

The current stable origin is
`https://sts-94-239-51-8.2001-861-388c-4ee0-c3d5-2f30-1be7-2e79.sslip.io:18443`.
Its first address label supplies the public IPv4 record and the second supplies the
public IPv6 record. No Cloudflare or Pyjam data path is involved.

## Local development

Start Vite and the room server together:

```bash
pnpm play
```

Open `http://localhost:5180`. Vite proxies `/api` and `/ws` to the authoritative room
process on `127.0.0.1:8787`.

## Host bootstrap

From WSL, install the repository runner and persistent room service:

```bash
bash infra/install-wsl-host.sh
```

From an elevated Windows PowerShell, install Caddy, its scoped inbound firewall rule,
automatic router mapping, and the boot-and-logon startup tasks:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File `
  "\\wsl.localhost\Ubuntu-26.04\home\hieul\slay-the-spire-the-boardgame-the-game\infra\windows\install-host.ps1"
```

The installer uses NAT-PMP and PCP exposed by the Bbox, so it does not require router
administrator login or a manual port-forward. The mappings have a 24-hour lease and the
`Slay the Spire router mapping` task renews them every hour.

## Verification and recovery

Check the two persistent WSL services:

```bash
systemctl --user status sts-actions-runner.service sts-room-server.service
curl --fail http://127.0.0.1:8787/api/health
curl --fail https://sts-94-239-51-8.2001-861-388c-4ee0-c3d5-2f30-1be7-2e79.sslip.io:18443/api/health
```

Room data lives outside the checkout at
`~/.local/share/slay-the-spire-server/rooms.json`. Actions deployments update the `current`
release symlink, validate the existing store, and restart the service without deleting it.
Players connected during a restart retain their seats while the browsers reconnect.
Only multiplayer rooms expire after 24 hours of inactivity. Leaderboard runs are retained
indefinitely in `rooms.json.leaderboard.json` (migrated from the original room store), while
player profiles remain in `rooms.json`. Keep both files together when backing up or restoring;
never replace the entire store to clean up stale rooms.

If the Bbox public IPv4 or delegated IPv6 prefix changes, the mapping task regenerates and
reloads Caddy, verifies the replacement HTTPS origin, updates
`MULTIPLAYER_SERVER_ORIGIN`, and dispatches a client-only Pages refresh. Failures stay in
`router-pinhole.log` and retry on the next hourly renewal.

## Reliable voice across restrictive networks

Without configuration, voice uses public STUN and connects directly when the peers'
networks permit it. Direct WebRTC can fail behind restrictive NATs or firewalls. The room
server still supports server-only TURN credentials through `CLOUDFLARE_TURN_KEY_ID` and
`CLOUDFLARE_TURN_API_TOKEN`; this affects optional voice relay only and is not used to
host game traffic.
