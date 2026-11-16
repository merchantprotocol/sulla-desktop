#!/bin/sh
# Sulla Desktop · https://sulladesktop.com
# Copyright (c) 2025-2026 Merchant Protocol LLC.
# SPDX-License-Identifier: GPL-2.0-or-later
# "Sulla" is a trademark. See TRADEMARK.md.

set -eu

# The launcher rotates the shared API capability while a long-running worker
# is alive. Refresh it for each call, but preserve the process-bound graph
# session so this CLI cannot borrow another chat’s identity.
secret_dir=/run/secrets/sulla-agent
. /usr/local/libexec/sulla-secret-env.sh
load_sulla_api_token "$secret_dir"
load_sulla_tool_session "$secret_dir"

exec /usr/local/libexec/sulla-remote "$@"
