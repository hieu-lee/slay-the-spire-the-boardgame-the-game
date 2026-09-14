#!/usr/bin/env bash
set -euo pipefail

root=$(pwd)
data_dir="$HOME/.local/share/slay-the-spire-server"
store="$data_dir/rooms.json"
hold_file="$data_dir/migration-hold"
releases_dir="$data_dir/releases"
source_run=${SOURCE_RUN_ID:-}
source_wait=${SOURCE_WAIT_SECONDS:-19200}
session_sha=${SESSION_SHA:-${GITHUB_SHA:-}}
mode=${1:-deploy}

[[ "$session_sha" =~ ^[0-9a-f]{40}$ ]]
release="$releases_dir/$session_sha"
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

if [ -n "$source_run" ]; then
  case "$source_run" in *[!0-9]*) echo 'Invalid source run id.' >&2; exit 2;; esac
  case "$source_wait" in *[!0-9]*|'') echo 'Invalid source wait.' >&2; exit 2;; esac
  [ "$source_wait" -ge 60 ] && [ "$source_wait" -le 19200 ]
  next_store="$data_dir/rooms.next.${GITHUB_RUN_ID}.json"
  rm -f -- "$next_store"
  recover_wait_failure() {
    status=$?
    trap - EXIT
    rm -f -- "$next_store"
    bash "$root/infra/watchdog-wsl-host.sh" >/dev/null 2>&1 || true
    exit "$status"
  }
  trap recover_wait_failure EXIT

  room_store_ready=false
  handoff_download_attempt=0
  source_deadline=$((SECONDS + source_wait))
  while [ "$SECONDS" -lt "$source_deadline" ]; do
    remaining=$((source_deadline - SECONDS))
    command_timeout=$((remaining < 30 ? remaining : 30))
    artifact=$(timeout "${command_timeout}s" gh api "repos/$GITHUB_REPOSITORY/actions/runs/$source_run/artifacts" \
      --jq ".artifacts[] | select(.name == \"room-store-$source_run\" and .expired == false) | .id" 2>/dev/null || true)
    if [ -n "$artifact" ]; then
      remaining=$((source_deadline - SECONDS))
      if [ "$remaining" -gt 0 ]; then
        handoff_download_attempt=$((handoff_download_attempt + 1))
        handoff_dir="$RUNNER_TEMP/handoff-$handoff_download_attempt"
        rm -rf -- "$handoff_dir"
        command_timeout=$((remaining < 30 ? remaining : 30))
        if timeout "${command_timeout}s" gh run download "$source_run" --repo "$GITHUB_REPOSITORY" \
            --name "room-store-$source_run" --dir "$handoff_dir" &&
            [ -s "$handoff_dir/rooms.json.gpg" ]; then
          room_store_ready=true
          break
        fi
        rm -rf -- "$handoff_dir"
      fi
    fi
    remaining=$((source_deadline - SECONDS))
    [ "$remaining" -gt 0 ] || break
    sleep_for=$((remaining < 10 ? remaining : 10))
    sleep "$sleep_for"
  done
  [ "$room_store_ready" = true ]
  selection_ready=false
  for attempt in 1 2 3 4 5; do
    selection_dir="$RUNNER_TEMP/selection-$attempt"
    rm -rf -- "$selection_dir"
    if timeout 30s gh run download "$source_run" --repo "$GITHUB_REPOSITORY" \
        --name "handoff-selected-$source_run" --dir "$selection_dir" &&
        [ -s "$selection_dir/handoff-selected" ]; then
      selection_ready=true
      break
    fi
    rm -rf -- "$selection_dir"
    sleep 5
  done
  [ "$selection_ready" = true ]
  selected_run=$(sed -n '1p' "$selection_dir/handoff-selected")
  if [ "$selected_run" != "$GITHUB_RUN_ID" ]; then
    case "$selected_run" in *[!0-9]*|'') echo 'Invalid selected successor id.' >&2; exit 2;; esac
    selected_state=$(timeout 30s gh api "repos/$GITHUB_REPOSITORY/actions/runs/$selected_run" \
      --jq '[.status, (.conclusion // "")] | join(" ")')
    selected_status=${selected_state%% *}
    selected_conclusion=${selected_state#* }
    [ "$selected_status" = completed ]
    case "$selected_conclusion" in
      failure|cancelled|timed_out|stale|action_required) ;;
      *) echo 'The originally selected successor has not failed.' >&2; exit 1;;
    esac
  fi
  [ "$(sed -n '2p' "$selection_dir/handoff-selected")" = "$SESSION_SHA" ]
  printf '%s' "$ROOM_STORE_KEY" | gpg --batch --yes --pinentry-mode loopback --passphrase-fd 0 \
    --output "$next_store" --decrypt "$handoff_dir/rooms.json.gpg"
  node "$release/infra/validate-room-store.mjs" "$next_store" "$release/scripts/lib/rooms.mjs"
fi

previous_release=$(readlink -f "$data_dir/current" 2>/dev/null || true)
unit_file="$HOME/.config/systemd/user/sts-room-server.service"
unit_backup="$data_dir/sts-room-server.service.backup.${GITHUB_RUN_ID:-$$}"
store_backup="$data_dir/rooms.backup.${GITHUB_RUN_ID:-$$}.json"
hold_backup="$data_dir/migration-hold.backup.${GITHUB_RUN_ID:-$$}"
previous_unit=false
previous_store=false
previous_hold=false
unit_installed=false
release_swapped=false
store_swapped=false
deployment_complete=false
if [ -f "$unit_file" ]; then
  cp -p "$unit_file" "$unit_backup"
  previous_unit=true
fi
if [ -f "$store" ]; then
  cp -p "$store" "$store_backup"
  previous_store=true
fi
if [ -f "$hold_file" ]; then
  cp -p "$hold_file" "$hold_backup"
  previous_hold=true
fi

check_health() {
  node --input-type=module - "$@" <<'NODE'
const origins = process.argv.slice(2)
for (const origin of origins) {
  let lastError
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(20_000) })
      const health = await response.json()
      if (!response.ok || health.protocolVersion !== 1 || health.profiles !== true || health.webSocketActionAcks !== true) {
        throw new Error(`Incompatible health response from ${origin}`)
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

finish_deployment() {
  status=$?
  trap - EXIT
  if [ "$deployment_complete" != true ]; then
    set +e
    systemctl --user stop sts-room-server.service
    if [ "$previous_hold" = true ]; then
      mv -f "$hold_backup" "$hold_file"
    fi
    if [ "$store_swapped" = true ]; then
      if [ "$previous_store" = true ]; then
        mv -f "$store_backup" "$store"
      else
        rm -f -- "$store"
      fi
    fi
    if [ "$release_swapped" = true ] && [ -n "$previous_release" ] && [ -d "$previous_release" ]; then
      ln -sfn "$previous_release" "$data_dir/current.rollback"
      mv -Tf "$data_dir/current.rollback" "$data_dir/current"
    fi
    if [ "$unit_installed" = true ]; then
      if [ "$previous_unit" = true ]; then
        mv -f "$unit_backup" "$unit_file"
      else
        rm -f -- "$unit_file"
      fi
    fi
    systemctl --user daemon-reload
    watchdog_state=$(bash "$root/infra/watchdog-wsl-host.sh" 2>/dev/null || true)
    if [ "$watchdog_state" = ready ] && ! check_health http://127.0.0.1:8787; then
      echo 'Deployment and automatic rollback both failed; inspect sts-room-server.service.' >&2
    elif [ "$watchdog_state" != ready ] && [ "$watchdog_state" != held ]; then
      echo 'Deployment rollback could not restore the service watchdog.' >&2
    fi
    [ "$status" -ne 0 ] || status=1
  fi
  rm -f -- "$unit_backup" "$store_backup" "$hold_backup" "${next_store:-}"
  exit "$status"
}
trap finish_deployment EXIT

install -m 0644 "$release/infra/systemd/sts-room-server.service" "$unit_file"
unit_installed=true
ln -sfn "$release" "$data_dir/current.next"
mv -Tf "$data_dir/current.next" "$data_dir/current"
release_swapped=true
systemctl --user daemon-reload
if [ -n "${next_store:-}" ]; then
  systemctl --user stop sts-room-server.service 2>/dev/null || true
  mv "$next_store" "$store"
  chmod 600 "$store"
  store_swapped=true
fi
rm -f -- "$hold_file"
systemctl --user enable --now sts-room-server.service
systemctl --user restart sts-room-server.service

check_health http://127.0.0.1:8787 "$MULTIPLAYER_SERVER_ORIGIN"
deployment_complete=true
trap - EXIT
rm -f -- "$unit_backup" "$store_backup" "$hold_backup" "${next_store:-}"

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
