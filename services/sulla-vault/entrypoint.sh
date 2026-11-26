#!/bin/sh
# Sulla Desktop · https://sulladesktop.com
# Copyright (c) 2025-2026 Merchant Protocol LLC.
# SPDX-License-Identifier: GPL-2.0-or-later
# "Sulla" is a trademark. See TRADEMARK.md.

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
# The audit file sink writes under this directory as $run_as. Desktop's dedicated named volume mounted
# at the default path starts root-owned 0755, so take ownership of that directory (not its contents)
# before dropping root. Custom spool directories are left exactly as provisioned, and a failure here
# only warns: startup must not depend on it, as before this repair.
audit_dir="${SULLA_VAULT_AUDIT_SPOOL_DIR:-/var/lib/sulla-vault}"
if [ "$audit_dir" = /var/lib/sulla-vault ]; then
  if ! { mkdir -p "$audit_dir" && chown "$run_as" "$audit_dir" && chmod 0700 "$audit_dir"; }; then
    echo "sulla-vault: could not prepare audit spool directory $audit_dir; audit file writes may fail" >&2
  fi
fi
exec su-exec "$run_as" "$@"
