#!/usr/bin/env bash
set -euo pipefail

if [ "${1:-}" = exec ]; then prompt=$(cat); fi
codex_bin=${STS_CODEX_BIN:-$HOME/.local/bin/codex}
auth_file=$HOME/.codex/auth.json
if [ ! -x "$codex_bin" ] || ! command -v bwrap >/dev/null; then exit 66; fi
if [ -n "${OPENAI_API_KEY:-}" ]; then mkdir -p -m 700 "$HOME/.codex"
elif [ ! -r "$auth_file" ]; then exit 66
fi
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
codex_package=$(dirname "$(dirname "$codex_script")")
if [ "$codex_script" != "$codex_package/bin/codex.js" ]; then exit 66; fi
schema_mount=()
args=("$@")
for ((index=0; index<${#args[@]}; index++)); do
  if [ "${args[index]}" != --output-schema ]; then continue; fi
  schema_file=${args[index+1]:-}
  case "$schema_file" in
    /tmp/codex-output-schema-*/schema.json) [ -f "$schema_file" ] || exit 66 ;;
    *) exit 66 ;;
  esac
  schema_mount=(--dir "$(dirname "$schema_file")" --ro-bind "$schema_file" "$schema_file")
  break
done

run_codex() {
  bwrap --die-with-parent --unshare-pid \
    --ro-bind /usr /usr --ro-bind /bin /bin --ro-bind /lib /lib --ro-bind /lib64 /lib64 \
    --dir /opt "${node_mount[@]}" --dir /etc --dir /etc/ssl \
    --ro-bind-try /etc/passwd /etc/passwd --ro-bind-try /etc/group /etc/group \
    --ro-bind-try /etc/resolv.conf /etc/resolv.conf --ro-bind-try /etc/hosts /etc/hosts \
    --ro-bind-try /etc/nsswitch.conf /etc/nsswitch.conf --ro-bind-try /etc/ssl/certs /etc/ssl/certs \
    --proc /proc --dev /dev --tmpfs /tmp "${schema_mount[@]}" \
    --dir /codex-home --bind "$HOME/.codex" /codex-home \
    --dir /workspace --dir /workspace/src --dir /workspace/scripts --dir /workspace/scripts/lib \
    --ro-bind "$PWD/src/game" /workspace/src/game \
    --ro-bind "$PWD/package.json" /workspace/package.json --ro-bind "$codex_package" /codex-cli \
    --setenv HOME /codex-home --setenv CODEX_HOME /codex-home --unsetenv OPENAI_API_KEY \
    --chdir /workspace "${NODE_BINARY}" /codex-cli/bin/codex.js "$@"
}

if [ -n "${OPENAI_API_KEY:-}" ] && ! "${NODE_BINARY}" -e '
  const { readFileSync } = require("node:fs")
  try {
    const auth = JSON.parse(readFileSync(process.argv[1], "utf8"))
    process.exit(auth.auth_mode === "apikey" && auth.OPENAI_API_KEY === process.env.OPENAI_API_KEY ? 0 : 1)
  }
  catch { process.exit(1) }
' "$auth_file"; then
  printf '%s' "$OPENAI_API_KEY" | run_codex login --with-api-key >/dev/null 2>&1 || exit 66
fi
if [ "${1:-}" != login ] && ! run_codex login status >/dev/null 2>&1; then exit 66; fi
if [ "${1:-}" = exec ]; then run_codex exec --ignore-user-config --strict-config "${@:2}" <<< "$prompt"
else run_codex "$@"
fi
