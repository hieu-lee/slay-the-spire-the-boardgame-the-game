#!/usr/bin/env bash
set -euo pipefail

repo='hieu-lee/slay-the-spire-the-boardgame-the-game'
repo_url="https://github.com/$repo"
runner_version='2.337.0'
runner_sha256='70920811a4f8ad4328818682bca5c6469c1c942fab52448868071d0063816613'
runner_archive="$HOME/.cache/actions-runner-linux-x64-$runner_version.tar.gz"
runner_dir="$HOME/.local/share/actions-runner"
unit_dir="$HOME/.config/systemd/user"
data_dir="$HOME/.local/share/slay-the-spire-server"
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)

for command in apt-get curl cut dpkg-deb find gh git loginctl mktemp node pnpm seq sha256sum sort systemctl tar timeout; do
  command -v "$command" >/dev/null || { echo "Missing required command: $command" >&2; exit 1; }
done
[ "$(command -v node)" = /usr/local/bin/node ] || {
  echo 'The room service requires Node at /usr/local/bin/node.' >&2
  exit 1
}

mkdir -p "$HOME/.cache" "$HOME/.local/share" "$unit_dir" "$data_dir"
chmod 700 "$data_dir"
if [ ! -e "$data_dir/current" ]; then
  pnpm --dir "$root" install --frozen-lockfile
  initial_sha=$(git -C "$root" rev-parse HEAD)
  SESSION_SHA="$initial_sha" bash "$root/infra/deploy-local-server.sh" prepare
  ln -sfn "$data_dir/releases/$initial_sha" "$data_dir/current"
fi

if [ ! -x "$runner_dir/run.sh" ]; then
  curl --fail --location --retry 5 --retry-all-errors --continue-at - \
    "https://github.com/actions/runner/releases/download/v$runner_version/actions-runner-linux-x64-$runner_version.tar.gz" \
    --output "$runner_archive"
  printf '%s  %s\n' "$runner_sha256" "$runner_archive" | sha256sum --check
  mkdir -p "$runner_dir"
  tar -xzf "$runner_archive" -C "$runner_dir"
fi

runner_lib="$runner_dir/_localdeps/usr/lib/x86_64-linux-gnu"
if ! /sbin/ldconfig -p | grep -q libicu; then
  if ! find "$runner_lib" -maxdepth 1 -name 'libicuuc.so.*' -print -quit 2>/dev/null | grep -q .; then
    (
      cd "$HOME/.cache"
      apt-get download libicu78
      icu_deb=$(find . -maxdepth 1 -name 'libicu78_*.deb' -print -quit)
      test -n "$icu_deb"
      dpkg-deb -x "$icu_deb" "$runner_dir/_localdeps"
    )
  fi
  export LD_LIBRARY_PATH="$runner_lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi

if [ ! -f "$runner_dir/.runner" ]; then
  registration_token=$(gh api --method POST "repos/$repo/actions/runners/registration-token" --jq .token)
  (
    cd "$runner_dir"
    export DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1
    ./config.sh --unattended --url "$repo_url" --token "$registration_token" \
      --name DESKTOP-09UIMTJ-WSL --labels sts-server --work _work --replace
  )
  unset registration_token
fi

install -m 0644 "$root/infra/systemd/sts-actions-runner.service" "$unit_dir/sts-actions-runner.service"
install -m 0644 "$root/infra/systemd/sts-room-server.service" "$unit_dir/sts-room-server.service"
loginctl enable-linger "$USER"
[ "$(loginctl show-user "$USER" -p Linger --value)" = yes ]
systemctl --user daemon-reload
systemctl --user enable --now sts-actions-runner.service sts-room-server.service

systemctl --user is-active --quiet sts-actions-runner.service
systemctl --user is-active --quiet sts-room-server.service
curl --fail --silent --show-error --retry 30 --retry-all-errors --retry-delay 1 \
  http://127.0.0.1:8787/api/health >/dev/null
runner_online=false
for attempt in $(seq 1 30); do
  status=$(gh api "repos/$repo/actions/runners" \
    --jq '.runners[] | select(.name == "DESKTOP-09UIMTJ-WSL") | .status' 2>/dev/null || true)
  if [ "$status" = online ]; then
    runner_online=true
    break
  fi
  sleep 2
done
[ "$runner_online" = true ]
echo 'WSL multiplayer services are installed and healthy.'
