#!/bin/sh
# Sulla Desktop · https://sulladesktop.com
# Copyright (c) 2025-2026 Merchant Protocol LLC.
# SPDX-License-Identifier: GPL-2.0-or-later
# "Sulla" is a trademark. See TRADEMARK.md.

load_sulla_tool_session() {
  if [ "${SULLA_TOOL_SESSION+x}" != x ] && [ -f "$1/SULLA_TOOL_SESSION" ]; then
    SULLA_TOOL_SESSION=$(cat "$1/SULLA_TOOL_SESSION") || return 1
    export SULLA_TOOL_SESSION
  fi
}

# A provider or nested exec overrides the launcher graph. Look up that session's
# current lease on every invocation. Never fall back to another graph's token.
load_sulla_api_token() {
  if [ "${SULLA_TOOL_SESSION+x}" = x ]; then
    [ -n "$SULLA_TOOL_SESSION" ] || return 1
    launcher_session=$(cat "$1/SULLA_TOOL_SESSION") || return 1
    if [ "$SULLA_TOOL_SESSION" != "$launcher_session" ]; then
      digest=$(printf '%s' "$SULLA_TOOL_SESSION" | sha256sum) || return 1
      digest=$(printf '%s' "${digest%% *}" | tr 'a-f' 'A-F')
      lease_file="$1/LEASE_$digest"
    else
      lease_file="$1/SULLA_API_TOKEN"
    fi
    unset launcher_session
  else
    # Older, capability-only service launches have no MCP session.
    lease_file="$1/SULLA_API_TOKEN"
    [ -f "$lease_file" ] || return 0
  fi
  SULLA_API_TOKEN=$(cat "$lease_file") || return 1
  [ -n "$SULLA_API_TOKEN" ] || return 1
  export SULLA_API_TOKEN
}
