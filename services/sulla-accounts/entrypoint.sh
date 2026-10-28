#!/bin/sh
# Sulla Desktop · https://sulladesktop.com
# Copyright (c) 2025-2026 Merchant Protocol LLC.
# SPDX-License-Identifier: GPL-2.0-or-later
# "Sulla" is a trademark. See TRADEMARK.md.

set -eu

readonly runtime_uid=10001
readonly runtime_gid=10001
readonly private_dir=/run/sulla-accounts-private

fail() {
  echo "sulla-accounts: $*" >&2
  exit 64
}

require_value() {
  eval "value=\${$1:-}"
  [ -n "$value" ] || fail "$1 is required"
}

copy_secret() {
  source_variable="$1"
  destination_name="$2"
  required="${3:-required}"
  eval "source_path=\${$source_variable:-}"
  if [ -z "$source_path" ]; then
    [ "$required" = optional ] && return 1
    fail "$source_variable is required"
  fi
  [ -f "$source_path" ] && [ ! -L "$source_path" ] || fail "$source_variable must name a regular, non-symlink file"
  destination_path="${private_dir}/${destination_name}"
  cp -- "$source_path" "$destination_path"
  chown "$runtime_uid:$runtime_gid" "$destination_path"
  chmod 0600 "$destination_path"
  printf '%s\n' "$destination_path"
}

read_secret() {
  secret_path="$1"
  [ -s "$secret_path" ] || fail "$secret_path is empty"
  LC_ALL=C tr -d '\000' <"$secret_path"
}

run_unprivileged() {
  setpriv --reuid="$runtime_uid" --regid="$runtime_gid" --init-groups -- "$@"
}

[ "$(id -u)" -eq 0 ] || fail "entrypoint must begin as root to stage file secrets"
mkdir -p "$private_dir"
chown "$runtime_uid:$runtime_gid" "$private_dir"
chmod 0700 "$private_dir"

mode="${SULLA_ACCOUNTS_MODE:-desktop}"
[ "$mode" = desktop ] || fail "server mode requires ghcr.io/merchantprotocol/sulla-server-accounts"

export SULLA_ACCOUNTS_SESSION_SECRET_FILE="$(copy_secret SULLA_ACCOUNTS_SESSION_SECRET_SOURCE_FILE session.secret)"
export SULLA_ACCOUNTS_ENCRYPTION_KEY_FILE="$(copy_secret SULLA_ACCOUNTS_ENCRYPTION_KEY_SOURCE_FILE encryption.key)"
if service_tokens_path="$(copy_secret SULLA_ACCOUNTS_SERVICE_TOKENS_SOURCE_FILE service-tokens.json optional)"; then
  export SULLA_ACCOUNTS_SERVICE_TOKENS_FILE="$service_tokens_path"
fi
export SULLA_ACCOUNTS_BOOTSTRAP_SECRET_FILE="$(copy_secret SULLA_ACCOUNTS_BOOTSTRAP_SECRET_SOURCE_FILE bootstrap.secret)"

database_username_path="$(copy_secret SULLA_ACCOUNTS_DATABASE_USERNAME_FILE database.username)"
database_password_path="$(copy_secret SULLA_ACCOUNTS_DATABASE_PASSWORD_FILE database.password)"
database_username="$(read_secret "$database_username_path")"
database_password="$(read_secret "$database_password_path")"
require_value SULLA_ACCOUNTS_DATABASE_HOST
require_value SULLA_ACCOUNTS_DATABASE_NAME
database_port="${SULLA_ACCOUNTS_DATABASE_PORT:-5432}"
export database_username database_password database_port
export SULLA_ACCOUNTS_DATABASE_URL_FILE="${private_dir}/database.url"
run_unprivileged node --input-type=module -e '
  import { writeFileSync } from "node:fs";
  const credentials = `${encodeURIComponent(process.env.database_username)}:${encodeURIComponent(process.env.database_password)}`;
  writeFileSync(process.env.SULLA_ACCOUNTS_DATABASE_URL_FILE, `postgresql://${credentials}@${process.env.SULLA_ACCOUNTS_DATABASE_HOST}:${process.env.database_port}/${process.env.SULLA_ACCOUNTS_DATABASE_NAME}`, { mode: 0o600 });
'
unset database_username database_password
unset database_port

exec setpriv --reuid="$runtime_uid" --regid="$runtime_gid" --init-groups -- node dist/index.js
