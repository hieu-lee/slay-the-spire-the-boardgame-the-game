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
indefinitely in `rooms.json.leaderboard.json` and its append-only `rooms.json.leaderboard.log`, while
player profiles remain in `rooms.json`. Back up and restore these together with the optional
`rooms.json.stats.json` and `rooms.json.stats.log` classification sidecars;
never replace the entire store to clean up stale rooms.

If the Bbox public IPv4 or delegated IPv6 prefix changes, the mapping task regenerates and
reloads Caddy, verifies the replacement HTTPS origin, updates
`MULTIPLAYER_SERVER_ORIGIN`, and dispatches a client-only Pages refresh. Failures stay in
`router-pinhole.log` and retry on the next hourly renewal.

## Shop packs and coins at the table

Each browser reports the Shop packs it owns (and has switched on) when it creates or joins
a room and every time its socket authenticates, beside its campaign unlocks. The server keeps
only known pack ids, in catalogue order, on the seat. A room plays every pack that **at least
one seated player** brought: while the room is in the lobby that union is recomputed whenever
a seat joins, leaves or reports a new list, and the lobby shows it as a "Slayer packs in play"
strip naming whose each pack is. `startRun` freezes the union into the run's
`meta.cardPacks`; from then on nothing a seat reports changes the run, and a Catch Up joiner
is dealt reward decks from the frozen set. The seats' lists are saved with the room JSON and
re-validated on restart; the next lobby (after **Prepare next run**) recomputes the union.

Boss coins are only promised during the run. When the party records the result (`finishRun`
finalizes the run), each browser pays its own wallet once from the finalized snapshot's
`run.campaign.bossCoins`. A Catch Up joiner's snapshot carries their own hero's
`campaign.joinedAfterBosses` entry, so they are paid only for bosses beaten after they joined.
`returnToLobby` adds the recorded run's awards and each seat's offset to `room.recordedRuns`
(saved with the room; the last 8 recorded runs, shares keyed by seat token so a reused player
id inherits nothing, and dropped when their seat leaves). The lobby snapshot sends a seat its
own shares of every run it played, so a player who was away for one or more recordings is still
paid for each when they reconnect. A browser pays a seat's coins only to the account that took
the seat in that tab (remembered in sessionStorage); if another account signed in since, the
coins are not paid and the seat is told why. See [shop.md](shop.md).

## Player letters

The Shop announcement is prepared in `docs/announcements/shop-and-slayer-pack.txt`. After the
Shop is deployed, check it with a dry run, then send it once (deploy the room server before
publishing the Pages client, so the legacy-coin cutoff is set first; see [shop.md](shop.md)):

```sh
STS_MAIL_ADMIN_TOKEN=... node scripts/mail-admin.mjs announce --file docs/announcements/shop-and-slayer-pack.txt --dry-run
STS_MAIL_ADMIN_TOKEN=... node scripts/mail-admin.mjs announce --file docs/announcements/shop-and-slayer-pack.txt
```

Accounts' coins for their earlier runs are claimed through `POST /api/profile/coins` and
`/api/profile/coins/confirm` (see [shop.md](shop.md)); the grants are stored in the room store
next to the profiles.

Players write to the developer from the envelope in the main menu's top-right corner, and
the badge counts replies they have not opened. Letters live in `rooms.json.mail.json`, one
thread per player; back it up with the other `rooms.json` sidecars. The first mailbox check
creates a welcome letter for an empty non-admin thread when the archive can save it; an
unsaved welcome never prevents reading the mailbox.
The hosted main menu checks immediately after a player registers or returns, so the unread
badge appears without opening the envelope.

Replies need an admin token of at least 24 characters. Put it in
`~/.config/slay-the-spire-server/mail.env` once and restart the service:

```bash
printf 'STS_MAIL_ADMIN_TOKEN=%s\n' "$(openssl rand -hex 24)" > ~/.config/slay-the-spire-server/mail.env
chmod 600 ~/.config/slay-the-spire-server/mail.env
systemctl --user restart sts-room-server.service
```

Then, from WSL with the same token in the environment:

```bash
export $(cat ~/.config/slay-the-spire-server/mail.env)
node scripts/mail-admin.mjs                      # threads, newest first
node scripts/mail-admin.mjs read TestPlayer      # a thread, marked read
node scripts/mail-admin.mjs reply TestPlayer "Thanks — fixed in the next build!"
node scripts/mail-admin.mjs announce "Replays now have speed, pause and a seek bar!" --dry-run
node scripts/mail-admin.mjs announce "Replays now have speed, pause and a seek bar!"
```

`announce` sends one developer letter to every registered player except the delegated mailbox
accounts below. It is safe to run twice: players who already hold that exact letter are skipped
(names whose mailbox belongs to an earlier owner are skipped too), and a player who has never
opened the mailbox gets the welcome letter first. `--dry-run` only counts, and it reports a full
mailbox the same way a real send would. It needs the room server to run a build that has the endpoint.

Without the token the admin endpoints do not exist; players can still write.

Trusted player profiles can also manage the shared server mailbox from the in-game
envelope. Configure their mail owner hashes, not their display names, so reclaiming a
name can never grant mailbox access:

```bash
node - <<'NODE'
const { createHash } = require('node:crypto')
const store = require(process.env.HOME + '/.local/share/slay-the-spire-server/rooms.json')
const names = new Set(['BestDefect2002', 'test1'].map((name) => name.toLowerCase()))
const owners = store.profiles.filter((profile) => names.has(profile.username.toLowerCase()))
  .map((profile) => createHash('sha256').update(`sts-mail:${profile.token}`).digest('hex'))
if (owners.length !== names.size) throw new Error('Every delegated mailbox account must already have a profile')
console.log(`STS_MAIL_ADMIN_OWNERS=${owners.join(',')}`)
NODE
```

Append that one output line to `mail.env` and restart the service. Delegated accounts
share one handled/unhandled state: opening a thread on either account clears it for both.
Their envelope opens the server desk directly; they can answer incoming letters and
read their own letters, but cannot compose personal mail. Historic letters they sent
do not appear in their own desk.
Letters one delegate sent before promotion remain visible to other delegates as server mail.

## Reliable voice across restrictive networks

Without configuration, voice uses public STUN and connects directly when the peers'
networks permit it. Direct WebRTC can fail behind restrictive NATs or firewalls. The room
server still supports server-only TURN credentials through `CLOUDFLARE_TURN_KEY_ID` and
`CLOUDFLARE_TURN_API_TOKEN`; this affects optional voice relay only and is not used to
host game traffic.
