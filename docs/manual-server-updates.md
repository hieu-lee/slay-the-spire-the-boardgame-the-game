# Manual server updates

After a host with `manualHandoff: true` in the live `session.json` has started,
use **Actions → Request safe server update → Run workflow** on `master`.
Enter the current `runId` from
<https://hieu-lee.github.io/slay-the-spire-the-boardgame-the-game/session.json>.
With an authenticated repository maintainer account, the equivalent command is:

```sh
gh workflow run request-session-handoff.yml --ref master -f run_id=HOST_RUN_ID
```

A successful request records an authenticated GitHub Actions signal for that host; it does not mean deployment has finished. Within its next polling cycle
(about a minute), the host starts preparing the latest master version. Once a
replacement is healthy, the existing handoff freezes writes, flushes and encrypts
the complete store, and restores it on the replacement. Rooms, reconnect state,
usernames, archived runs, and saved decks travel together.

Verify that the live `session.json` switches to a new run with `sourceRunId`
matching the requested host, and that the new endpoint is healthy. Check the
host's Actions run if preparation or deployment fails. Do not cancel the source
runner or dispatch a fresh session to accelerate the update: that bypasses the
final export. Repeated requests for the same host are harmless; requests for an
old host or a host without the capability fail validation.

This control first becomes available after the scheduled handoff installs it.
Publishing a newer static client alone does not upgrade a running host.

## Reliability behavior

Each host publishes two independently generated tunnel origins. The client probes
both and reconnects through whichever is healthy. During a planned handoff, the
retiring runner bridges reads and reconnects as soon as the restored successor is
healthy, enables mutations only after Pages publishes that exact successor, and
keeps the old URL bridged for twelve more minutes. CDN delay therefore no longer
leaves active rooms pointed at a dead server or risks acknowledging changes on an
unpublished replacement.

This removes the stale-URL/CDN part of a planned handoff and tolerates one failed
tunnel. The exact-state transfer still restarts WebSockets, which the client
reconnects automatically. GitHub limits hosted jobs to six hours, and Cloudflare
explicitly provides no Quick Tunnel uptime guarantee. Eliminating those
provider-level risks requires an always-on service with a stable hostname and
replicated durable storage; a single attached disk still creates a restart or
hardware-failure outage.

- [GitHub Actions limits](https://docs.github.com/en/actions/reference/limits)
- [Cloudflare Quick Tunnel limits](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)
- [Fly volume redundancy](https://fly.io/docs/volumes/overview/)
- [Render persistent-disk limitations](https://render.com/docs/disks)
