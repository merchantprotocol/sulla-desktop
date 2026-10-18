#!/bin/sh
set -eu
run_as=node:node
if [ -n "${SULLA_FILES_UID:-}" ] && [ -n "${SULLA_FILES_GID:-}" ]; then
  run_as="${SULLA_FILES_UID}:${SULLA_FILES_GID}"
fi
chown -R "$run_as" /var/lib/sulla-files
if [ -d /backup ]; then
  chown -R "$run_as" /backup
fi
exec su-exec "$run_as" "$@"
