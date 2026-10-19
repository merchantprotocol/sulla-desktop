#!/bin/sh
set -eu

readonly private_dir=/run/sulla-agents-private

fail() {
  echo "sulla-agents: $*" >&2
  exit 64
}

stage_secret() {
  variable="$1"
  name="$2"
  eval "source_path=\${$variable:-}"
  [ -n "$source_path" ] || return 0
  [ -f "$source_path" ] && [ ! -L "$source_path" ] || fail "$variable must name a regular, non-symlink file"
  destination_path="${private_dir}/${name}"
  cp -- "$source_path" "$destination_path"
  chown node:node "$destination_path"
  chmod 0600 "$destination_path"
  export "$variable=$destination_path"
}

[ "$(id -u)" -eq 0 ] || fail "entrypoint must begin as root to stage file secrets"
mkdir -p "$private_dir"
chown node:node "$private_dir"
chmod 0700 "$private_dir"

stage_secret SULLA_ACCOUNTS_SERVICE_TOKEN_FILE accounts-service.token
stage_secret SULLA_OPENAI_API_KEY_FILE openai-api.key
stage_secret SULLA_ANTHROPIC_API_KEY_FILE anthropic-api.key

if [ -S /var/run/docker.sock ]; then
  socket_gid="$(stat -c %g /var/run/docker.sock)"
  socket_group="$(awk -F: -v gid="$socket_gid" '$3 == gid { print $1; exit }' /etc/group)"
  if [ -z "$socket_group" ]; then
    socket_group=sulla-docker
    addgroup -S -g "$socket_gid" "$socket_group"
  fi
  addgroup node "$socket_group" >/dev/null 2>&1 || true
fi

exec setpriv --reuid=node --regid=node --init-groups -- "$@"
