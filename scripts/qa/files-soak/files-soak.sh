#!/usr/bin/env bash
# Sulla Desktop · https://sulladesktop.com
# Copyright (c) 2025-2026 Merchant Protocol LLC.
# SPDX-License-Identifier: GPL-2.0-or-later
# "Sulla" is a trademark. See TRADEMARK.md.
# Runs inside the Desktop VM. Data is restricted to one per-run QA folder under the
# detected personal Files collection; crash tests intentionally restart its services.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ $# -lt 1 ]]; then
  echo "usage: files-soak.sh <bulk|append|ops|crash|load|cloud|all|cleanup> [--with-app-restart]" >&2
  exit 2
fi

PHASE=""
WITH_APP_RESTART="false"
for arg in "$@"; do
  case "$arg" in
    --with-app-restart) WITH_APP_RESTART="true" ;;
    bulk|append|ops|crash|load|cloud|all|cleanup) PHASE="$arg" ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done
if [[ -z "$PHASE" ]]; then echo "usage: files-soak.sh <phase|all|cleanup> [--with-app-restart]" >&2; exit 2; fi

exec python3 -I "$SCRIPT_DIR/files-soak.py" "$PHASE" "$WITH_APP_RESTART"
