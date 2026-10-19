#!/bin/sh
set -eu
# Compose file secrets are often root-owned; stage only this service capability,
# then run the application as the unprivileged image user.
if [ "$(id -u)" = 0 ]; then
  if [ -n "${SULLA_PROJECTS_ACCOUNTS_SERVICE_TOKEN_FILE:-}" ]; then
    source_file="$SULLA_PROJECTS_ACCOUNTS_SERVICE_TOKEN_FILE"
    test -f "$source_file" && test ! -L "$source_file"
    mkdir -p /run/sulla-projects-private
    chmod 0700 /run/sulla-projects-private
    cp "$source_file" /run/sulla-projects-private/accounts-token
    chmod 0600 /run/sulla-projects-private/accounts-token
    chown -R node:node /run/sulla-projects-private
    export SULLA_PROJECTS_ACCOUNTS_SERVICE_TOKEN_FILE=/run/sulla-projects-private/accounts-token
  fi
  exec su-exec node "$@"
fi
exec "$@"
