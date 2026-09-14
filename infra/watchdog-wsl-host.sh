#!/usr/bin/env bash
set -euo pipefail

repository='hieu-lee/slay-the-spire-the-boardgame-the-game'
data_dir="$HOME/.local/share/slay-the-spire-server"
hold_file="$data_dir/migration-hold"

active_migration_hold() {
  local run_id=$1 deadline=$2 extra=$3 now=$4 status=$5
  [[ "$run_id" =~ ^[0-9]+$ ]] && [[ "$deadline" =~ ^[0-9]+$ ]] &&
    [ -z "$extra" ] && [ "$deadline" -gt "$now" ] && [ "$status" != completed ]
}

main() {
  systemctl --user start sts-actions-runner.service 2>/dev/null || true
  if [ -f "$hold_file" ]; then
    read -r run_id deadline extra < "$hold_file" || true
    status=
    if [[ "${run_id:-}" =~ ^[0-9]+$ ]] && [[ "${deadline:-}" =~ ^[0-9]+$ ]] &&
        [ -z "${extra:-}" ] && [ "$deadline" -gt "$(date +%s)" ]; then
      status=$(timeout 30s gh api "repos/$repository/actions/runs/$run_id" --jq .status 2>/dev/null || true)
    fi
    if active_migration_hold "${run_id:-}" "${deadline:-}" "${extra:-}" "$(date +%s)" "$status"; then
      systemctl --user stop sts-room-server.service
      ! systemctl --user is-active --quiet sts-room-server.service
      echo held
      exit 0
    fi
    rm -f -- "$hold_file"
  fi

  systemctl --user start sts-room-server.service
  echo ready
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
