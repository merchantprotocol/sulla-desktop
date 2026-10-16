#!/bin/sh
set -eu
if [ -n "${SULLA_FILES_UID:-}" ] && [ -n "${SULLA_FILES_GID:-}" ]; then
  chown -R "${SULLA_FILES_UID}:${SULLA_FILES_GID}" /var/lib/sulla-files
  exec gosu "${SULLA_FILES_UID}:${SULLA_FILES_GID}" "$@"
fi
exec gosu node:node "$@"
