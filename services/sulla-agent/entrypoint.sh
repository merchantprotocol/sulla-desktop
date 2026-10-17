#!/bin/sh
set -eu

# Credentials are mounted from a VM tmpfs directory, never recorded in Docker's
# environment config. Read each file once and unlink it before starting the CLI.
secret_dir=/run/secrets/sulla-agent
for secret_name in SULLA_API_TOKEN SULLA_TOOL_SESSION SULLA_AGENT_INSTRUCTIONS_B64; do
  secret_file="$secret_dir/$secret_name"
  if [ -f "$secret_file" ]; then
    secret_value=$(cat "$secret_file")
    # Capability/session leases stay mounted so the wrapper can pick up
    # atomic renewals. One-shot instructions are removed immediately.
    case "$secret_name" in SULLA_API_TOKEN|SULLA_TOOL_SESSION) ;; *) rm -f "$secret_file" ;; esac
    export "$secret_name=$secret_value"
    unset secret_value
  fi
done

if [ -n "${SULLA_AGENT_INSTRUCTIONS_B64:-}" ]; then
  printf '%s' "$SULLA_AGENT_INSTRUCTIONS_B64" | base64 -d > /tmp/sulla-agent-instructions.md
  chmod 600 /tmp/sulla-agent-instructions.md
  unset SULLA_AGENT_INSTRUCTIONS_B64
fi

exec node /usr/local/libexec/sulla-agent-supervisor.mjs
