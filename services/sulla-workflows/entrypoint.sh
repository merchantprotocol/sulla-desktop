#!/bin/sh
set -eu

readonly private_dir=/run/sulla-workflows-private

fail() {
  echo "sulla-workflows: $*" >&2
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

exec su-exec node:node "$@"
