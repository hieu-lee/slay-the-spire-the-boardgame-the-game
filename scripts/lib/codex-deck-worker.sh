#!/usr/bin/env bash
set -euo pipefail

codex_bin=${STS_CODEX_BIN:-$HOME/.local/bin/codex}
worker_home=$HOME/.local/share/slay-the-spire-server/codex
auth_file=$worker_home/auth.json
if [ ! -r "$auth_file" ] || [ ! -x "$codex_bin" ] || ! command -v bwrap >/dev/null; then exit 66; fi
codex_script=$(readlink -f "$codex_bin")
if [ ! -f "$codex_script" ] || [ ! -x "${NODE_BINARY:-}" ]; then exit 66; fi
node_binary=$(readlink -f "$NODE_BINARY")
node_mount=()
case "$node_binary" in
  /opt/*/bin/node)
    node_root=$(dirname "$(dirname "$node_binary")")
    node_mount=(--ro-bind "$node_root" "$node_root") ;;
  /usr/*) ;;
  *) exit 66 ;;
esac
if ! "${NODE_BINARY}" -e 'const { readFileSync } = require("node:fs"); try { process.exit(JSON.parse(readFileSync(process.argv[1], "utf8")).auth_mode === "chatgpt" ? 0 : 1) } catch { process.exit(1) }' "$auth_file"; then exit 66; fi
codex_package=$(dirname "$(dirname "$codex_script")")
if [ "$codex_script" != "$codex_package/bin/codex.js" ]; then exit 66; fi
chmod 700 "$worker_home"

run_codex() {
  bwrap --die-with-parent --unshare-pid \
    --ro-bind /usr /usr --ro-bind /bin /bin --ro-bind /lib /lib --ro-bind /lib64 /lib64 \
    --dir /opt "${node_mount[@]}" --dir /etc --dir /etc/ssl \
    --ro-bind-try /etc/passwd /etc/passwd --ro-bind-try /etc/group /etc/group \
    --ro-bind-try /etc/resolv.conf /etc/resolv.conf --ro-bind-try /etc/hosts /etc/hosts \
    --ro-bind-try /etc/nsswitch.conf /etc/nsswitch.conf --ro-bind-try /etc/ssl/certs /etc/ssl/certs \
    --proc /proc --dev /dev --tmpfs /tmp \
    --dir /codex-home --bind "$worker_home" /codex-home \
    --dir /workspace --dir /workspace/src --dir /workspace/scripts --dir /workspace/scripts/lib \
    --ro-bind "$PWD/src/game" /workspace/src/game \
    --ro-bind "$PWD/scripts/lib/deck-type.schema.json" /workspace/scripts/lib/deck-type.schema.json \
    --ro-bind "$PWD/package.json" /workspace/package.json --ro-bind "$codex_package" /codex-cli \
    --setenv HOME /codex-home --setenv CODEX_HOME /codex-home \
    --chdir /workspace "${NODE_BINARY}" /codex-cli/bin/codex.js "$@"
}

if [ "${1:-}" != login ] && ! run_codex login status >/dev/null 2>&1; then exit 66; fi
run_codex "$@"
