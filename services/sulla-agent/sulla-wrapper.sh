#!/bin/sh
# Sulla Desktop · https://sulladesktop.com
# Copyright (c) 2025-2026 Merchant Protocol LLC.
# SPDX-License-Identifier: GPL-2.0-or-later
# "Sulla" is a trademark. See TRADEMARK.md.

set -eu

# Let the CLI recover the nearest process session (including scrubbed Codex
# shells) before it selects a lease. Never load the launcher session first.
SULLA_CONTAINER_CLI=1 exec /usr/local/libexec/sulla-remote "$@"
