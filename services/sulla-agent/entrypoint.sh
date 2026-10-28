#!/bin/sh
# Sulla Desktop · https://sulladesktop.com
# Copyright (c) 2025-2026 Merchant Protocol LLC.
# SPDX-License-Identifier: GPL-2.0-or-later
# "Sulla" is a trademark. See TRADEMARK.md.

set -eu

# Credentials are staged before container start, never recorded in Docker's
# environment config. Move renewable leases into tmpfs, and unlink every
# one-shot value before starting the provider process.
secret_dir=/run/secrets/sulla-agent
staging_dir=/run/sulla-bootstrap
if [ "${SULLA_AGENT_MANAGED:-}" = "1" ]; then
  attempts=0
  while [ ! -f "$staging_dir/.ready" ] && [ "$attempts" -lt 200 ]; do
    sleep 0.05
    attempts=$((attempts + 1))
  done
  [ -f "$staging_dir/.ready" ] || { echo "managed agent secrets did not arrive" >&2; exit 78; }
  rm -f "$staging_dir/.ready"
fi
for secret_name in SULLA_API_TOKEN SULLA_TOOL_SESSION SULLA_AGENT_INSTRUCTIONS_B64 SULLA_AGENT_PROMPT_B64 OPENAI_API_KEY ANTHROPIC_API_KEY; do
  secret_file="$staging_dir/$secret_name"
  [ -f "$secret_file" ] || secret_file="$secret_dir/$secret_name"
  if [ -f "$secret_file" ]; then
    secret_value=$(cat "$secret_file")
    # Capability/session leases stay mounted so the wrapper can pick up
    # atomic renewals. One-shot instructions are removed immediately.
    case "$secret_name" in
      SULLA_API_TOKEN|SULLA_TOOL_SESSION)
        if [ "$secret_file" != "$secret_dir/$secret_name" ]; then
          cp "$secret_file" "$secret_dir/$secret_name"
          chmod 0400 "$secret_dir/$secret_name"
          rm -f "$secret_file"
        fi
        ;;
      *) rm -f "$secret_file" ;;
    esac
    export "$secret_name=$secret_value"
    unset secret_value
  fi
done

if [ -n "${SULLA_AGENT_INSTRUCTIONS_B64:-}" ]; then
  printf '%s' "$SULLA_AGENT_INSTRUCTIONS_B64" | base64 -d > /tmp/sulla-agent-instructions.md
  chmod 600 /tmp/sulla-agent-instructions.md
  unset SULLA_AGENT_INSTRUCTIONS_B64
fi

if [ -n "${SULLA_AGENT_PROMPT_B64:-}" ]; then
  export SULLA_AGENT_PROMPT="$(printf '%s' "$SULLA_AGENT_PROMPT_B64" | base64 -d)"
  unset SULLA_AGENT_PROMPT_B64
fi

# In transport mode Desktop keeps the canonical graph/control plane and uses
# this container as one persistent job-scoped process and filesystem runtime.
# Provider CLIs are started with authenticated `docker exec` calls and the
# lifecycle owner removes the container in its finally path.
if [ "${SULLA_AGENT_MODE:-}" = "transport" ]; then
  exec sleep infinity
fi

exec node /usr/local/libexec/sulla-agent-supervisor.mjs
