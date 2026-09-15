#!/usr/bin/env bash
set -euo pipefail

root=$(pwd)
data_dir="$HOME/.local/share/slay-the-spire-server"
store="$data_dir/rooms.json"
releases_dir="$data_dir/releases"
session_sha=${SESSION_SHA:-${GITHUB_SHA:-}}
mode=${1:-deploy}

[[ "$session_sha" =~ ^[0-9a-f]{40}$ ]]
release="$releases_dir/$session_sha"
unit_file="$HOME/.config/systemd/user/sts-room-server.service"
mkdir -p "$data_dir" "$releases_dir" "$HOME/.config/systemd/user"
chmod 700 "$data_dir"

prepare_release() {
  [ "$(git -C "$root" rev-parse HEAD)" = "$session_sha" ]
  if [ ! -d "$release" ]; then
    candidate=$(mktemp -d "$releases_dir/.${session_sha}.XXXXXX")
    cleanup_candidate() { rm -rf -- "$candidate"; }
    trap cleanup_candidate EXIT
    git -C "$root" archive HEAD -- package.json scripts/room-server.mjs \
      scripts/lib/rooms.mjs scripts/lib/leaderboard.mjs scripts/lib/profiles.mjs \
      src/game infra/systemd/sts-room-server.service infra/validate-room-store.mjs | tar -x -C "$candidate"
    mkdir "$candidate/node_modules"
    cp -aL "$root/node_modules/ws" "$candidate/node_modules/ws"
    chmod -R u=rwX,go=rX "$candidate"
    mv "$candidate" "$release"
    trap - EXIT
  fi
  test -f "$release/scripts/room-server.mjs"
  test -d "$release/node_modules/ws"
}

if [ "$mode" = prepare ]; then
  prepare_release
  exit 0
fi
[ "$mode" = deploy ]
test -f "$release/scripts/room-server.mjs"
test -d "$release/node_modules/ws"
if [ -f "$store" ]; then
  node "$release/infra/validate-room-store.mjs" "$store" "$release/scripts/lib/rooms.mjs"
fi

check_health() {
  expected_sha=$1
  shift
  EXPECTED_RELEASE_SHA=$expected_sha node --input-type=module - "$@" <<'NODE'
const origins = process.argv.slice(2)
const expectedSha = process.env.EXPECTED_RELEASE_SHA
for (const origin of origins) {
  let lastError
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(20_000) })
      const health = await response.json()
      if (!response.ok || health.protocolVersion !== 1 || health.profiles !== true || health.webSocketActionAcks !== true) {
        throw new Error(`Incompatible health response from ${origin}`)
      }
      if (expectedSha && health.releaseSha !== expectedSha) {
        throw new Error(`Expected release ${expectedSha} from ${origin}, received ${health.releaseSha ?? 'none'}`)
      }
      lastError = undefined
      break
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, origin.startsWith('https:') ? 2_000 : 1_000))
    }
  }
  if (lastError) throw lastError
}
NODE
}

previous_release=$(readlink -f "$data_dir/current" 2>/dev/null || true)
backup="$data_dir/sts-room-server.service.backup.${GITHUB_RUN_ID:-$$}"
had_unit=false
if [ -f "$unit_file" ]; then
  cp -p "$unit_file" "$backup"
  had_unit=true
fi
deployment_complete=false
finish_deployment() {
  status=$?
  trap - EXIT
  if [ "$deployment_complete" != true ]; then
    rollback_failed=false
    set +e
    systemctl --user stop sts-room-server.service || rollback_failed=true
    if [ -n "$previous_release" ] && [ -d "$previous_release" ]; then
      ln -sfn "$previous_release" "$data_dir/current.rollback"
      mv -Tf "$data_dir/current.rollback" "$data_dir/current" || rollback_failed=true
    else
      rm -f -- "$data_dir/current" || rollback_failed=true
    fi
    if [ "$had_unit" = true ]; then
      cp -p "$backup" "$unit_file" || rollback_failed=true
    else
      rm -f -- "$unit_file" || rollback_failed=true
    fi
    systemctl --user daemon-reload || rollback_failed=true
    if [ -n "$previous_release" ]; then
      systemctl --user start sts-room-server.service || rollback_failed=true
      check_health '' http://127.0.0.1:8787 "$MULTIPLAYER_SERVER_ORIGIN" || rollback_failed=true
    fi
    if [ "$rollback_failed" = true ]; then
      echo 'Deployment rollback failed; preserving the service-unit backup for recovery.' >&2
      status=1
    else
      rm -f -- "$backup"
    fi
    [ "$status" -ne 0 ] || status=1
  else
    rm -f -- "$backup"
  fi
  exit "$status"
}
trap finish_deployment EXIT

install -m 0644 "$release/infra/systemd/sts-room-server.service" "$unit_file"
ln -sfn "$release" "$data_dir/current.next"
mv -Tf "$data_dir/current.next" "$data_dir/current"
systemctl --user daemon-reload
systemctl --user enable sts-room-server.service
systemctl --user restart sts-room-server.service
check_health "$session_sha" http://127.0.0.1:8787 "$MULTIPLAYER_SERVER_ORIGIN"

deployment_complete=true
trap - EXIT
rm -f -- "$backup"

active_release=$(readlink -f "$data_dir/current")
mapfile -t old_releases < <(find "$releases_dir" -mindepth 1 -maxdepth 1 -type d \
  -regextype posix-extended -regex '.*/[0-9a-f]{40}' -printf '%T@ %p\n' | sort -nr | cut -d' ' -f2-)
kept=0
for old_release in "${old_releases[@]}"; do
  if [ "$old_release" = "$active_release" ] || [ "$kept" -lt 3 ]; then
    kept=$((kept + 1))
    continue
  fi
  [ "$(dirname "$old_release")" = "$releases_dir" ]
  [[ "$(basename "$old_release")" =~ ^[0-9a-f]{40}$ ]]
  rm -rf -- "$old_release"
done
