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
if [ -n "${SULLA_FILES_ACCOUNTS_SERVICE_TOKEN_FILE:-}" ]; then
  mkdir -p /run/sulla-files-secrets
  chmod 0700 /run/sulla-files-secrets
  cp "$SULLA_FILES_ACCOUNTS_SERVICE_TOKEN_FILE" /run/sulla-files-secrets/accounts-token
  chown -R "$run_as" /run/sulla-files-secrets
  chmod 0600 /run/sulla-files-secrets/accounts-token
  export SULLA_FILES_ACCOUNTS_SERVICE_TOKEN_FILE=/run/sulla-files-secrets/accounts-token
fi
exec su-exec "$run_as" "$@"
