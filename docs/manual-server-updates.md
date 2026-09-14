# Server updates

Every push to `master` now uses the `sts-server` self-hosted runner on
`DESKTOP-09UIMTJ`. The workflow installs dependencies, repoints the persistent release
symlink, restarts the room service, verifies the local and public health endpoints, and
then republishes the GitHub Pages client.

The room store is outside the Actions checkout and is flushed by the server before a
normal restart. WebSockets reconnect to the same stable hostname, so an update creates a
short reconnect rather than the multi-runner state transfer previously needed for
expiring tunnel hosts.

To republish only the client configuration:

```bash
gh workflow run multiplayer-session.yml --ref master -f refresh_only=true
```

The legacy `Request safe server update` workflow remains only for the one-time transfer
from the last hosted runner. It should not be used after `session.json` reports
`"alwaysOn": true`.

Before an update, verify that the runner is online:

```bash
gh api repos/hieu-lee/slay-the-spire-the-boardgame-the-game/actions/runners \
  --jq '.runners[] | {name,status,busy}'
```

After an update, verify the service and published routing:

```bash
systemctl --user status sts-room-server.service
curl --fail https://sts-94-239-51-8.2001-861-388c-4ee0-c3d5-2f30-1be7-2e79.sslip.io:18443/api/health
curl --fail https://hieu-lee.github.io/slay-the-spire-the-boardgame-the-game/session.json
```
