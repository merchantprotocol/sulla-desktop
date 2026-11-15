#!/bin/sh
# Sulla Desktop · https://sulladesktop.com
# Copyright (c) 2025-2026 Merchant Protocol LLC.
# SPDX-License-Identifier: GPL-2.0-or-later
# "Sulla" is a trademark. See TRADEMARK.md.

# The API capability is shared per container and may be rotated while a worker
# runs, so refresh it for each CLI invocation. Tool sessions are process/chat
# identity: only use the mounted file as a fallback when the process has no
# session at all. Never replace an inherited session with another process's.
load_sulla_api_token() {
  secret_file=$1/SULLA_API_TOKEN
  if [ -f "$secret_file" ]; then
    secret_value=$(cat "$secret_file")
    export SULLA_API_TOKEN="$secret_value"
    unset secret_value
  fi
}

load_sulla_tool_session() {
  secret_file=$1/SULLA_TOOL_SESSION
  if [ "${SULLA_TOOL_SESSION+x}" != x ] && [ -f "$secret_file" ]; then
    secret_value=$(cat "$secret_file")
    export SULLA_TOOL_SESSION="$secret_value"
    unset secret_value
  fi
}
