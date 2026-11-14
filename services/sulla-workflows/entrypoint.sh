#!/bin/sh
# Sulla Desktop · https://sulladesktop.com
# Copyright (c) 2025-2026 Merchant Protocol LLC.
# SPDX-License-Identifier: GPL-2.0-or-later
# "Sulla" is a trademark. See TRADEMARK.md.

set -eu

readonly private_dir=/run/sulla-workflows-private

join_docker_group() {
  [ -S /var/run/docker.sock ] || return 0
  socket_gid="$(stat -c %g /var/run/docker.sock)"
  socket_group="$(awk -F: -v gid="$socket_gid" '$3 == gid { print $1; exit }' /etc/group)"
  if [ -z "$socket_group" ]; then
    socket_group=sulla-docker
    addgroup -S -g "$socket_gid" "$socket_group"
  fi
  addgroup node "$socket_group" >/dev/null 2>&1 || true
}

[ "$(id -u)" -eq 0 ] || { echo "sulla-workflows: entrypoint must begin as root to stage runner credentials" >&2; exit 64; }
mkdir -p "$private_dir"
chown node:node "$private_dir"
chmod 0700 "$private_dir"

if [ "${SULLA_WORKFLOW_ROLE:-manager}" = runner ]; then
  bootstrap_token=/run/sulla-workflows-bootstrap/sulla-run-token
  [ -f "$bootstrap_token" ] && [ ! -L "$bootstrap_token" ] || { echo "sulla-workflows: runner bootstrap token is missing" >&2; exit 64; }
  cp -- "$bootstrap_token" "$private_dir/run.token"
  chown node:node "$private_dir/run.token"
  chmod 0400 "$private_dir/run.token"
  rm -f -- "$bootstrap_token"
  rmdir /run/sulla-workflows-bootstrap 2>/dev/null || true
  SULLA_RUN_TOKEN="$(cat "$private_dir/run.token")"
  export SULLA_RUN_TOKEN
  rm -f -- "$private_dir/run.token"
fi

join_docker_group

exec setpriv --reuid=node --regid=node --init-groups -- "$@"
