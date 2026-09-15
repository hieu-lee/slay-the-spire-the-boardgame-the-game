# Server updates

Every push to `master` first passes the build and focused test job. CI then calls the
`sts-server` self-hosted deployment on `DESKTOP-09UIMTJ`; only after the server is healthy
does it build and publish the matching browser client to Pages. The server deployment
repoints the persistent release symlink, restarts the room service, verifies the local and
public health endpoints, and leaves the service running after Actions exits.

The room store is outside the Actions checkout and is flushed by the server before a
normal restart. WebSockets reconnect to the same stable hostname, so an update creates a
short reconnect rather than the multi-runner state transfer previously needed for
expiring tunnel hosts.

To republish the client configuration for the currently deployed server commit:

```bash
gh workflow run pages-deploy.yml --ref master -f deploy_sha=<deployed-commit-sha>
```

To rerun the full verified server-and-client deployment for `master`:

```bash
gh workflow run ci.yml --ref master
```

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
