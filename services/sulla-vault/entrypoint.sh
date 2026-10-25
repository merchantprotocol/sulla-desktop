#!/bin/sh
set -eu

run_as=node:node
if [ -n "${SULLA_VAULT_UID:-}" ] && [ -n "${SULLA_VAULT_GID:-}" ]; then
  run_as="${SULLA_VAULT_UID}:${SULLA_VAULT_GID}"
fi
if [ -n "${SULLA_VAULT_ACCOUNTS_SERVICE_TOKEN_FILE:-}" ]; then
  mkdir -p /run/sulla-vault-secrets
  chmod 0700 /run/sulla-vault-secrets
  cp "$SULLA_VAULT_ACCOUNTS_SERVICE_TOKEN_FILE" /run/sulla-vault-secrets/accounts-token
  chown -R "$run_as" /run/sulla-vault-secrets
  chmod 0600 /run/sulla-vault-secrets/accounts-token
  export SULLA_VAULT_ACCOUNTS_SERVICE_TOKEN_FILE=/run/sulla-vault-secrets/accounts-token
fi
if [ -n "${SULLA_VAULT_PROVIDERS_SERVICE_TOKEN_FILE:-}" ]; then
  mkdir -p /run/sulla-vault-secrets
  chmod 0700 /run/sulla-vault-secrets
  cp "$SULLA_VAULT_PROVIDERS_SERVICE_TOKEN_FILE" /run/sulla-vault-secrets/providers-token
  chown -R "$run_as" /run/sulla-vault-secrets
  chmod 0600 /run/sulla-vault-secrets/providers-token
  export SULLA_VAULT_PROVIDERS_SERVICE_TOKEN_FILE=/run/sulla-vault-secrets/providers-token
fi
exec su-exec "$run_as" "$@"
