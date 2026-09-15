#!/usr/bin/env bash
set -euo pipefail

if ! systemctl --user start sts-actions-runner.service; then
  echo 'warning: the Actions runner could not be started; the game server will remain available' >&2
fi
systemctl --user start sts-room-server.service
systemctl --user is-active --quiet sts-room-server.service
echo ready
