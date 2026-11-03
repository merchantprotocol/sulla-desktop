#!/usr/bin/env bash
# Sulla Desktop · https://sulladesktop.com
# Copyright (c) 2025-2026 Merchant Protocol LLC.
# SPDX-License-Identifier: GPL-2.0-or-later
set -euo pipefail
if [[ "$(uname -s)" != Darwin ]]; then echo "This real-VM simulator is macOS-only." >&2; exit 2; fi
if [[ $# -ne 1 ]]; then echo "Usage: $0 /path/to/Sulla Desktop.app-or-DMG" >&2; exit 2; fi
source_path="$1"; fresh_home="$(mktemp -d "${TMPDIR:-/tmp}/sulla-fresh-install.XXXXXX")"
app_path="$source_path"
if [[ "$source_path" == *.dmg ]]; then
  mount_point="$(mktemp -d "${TMPDIR:-/tmp}/sulla-dmg.XXXXXX")"; hdiutil attach "$source_path" -nobrowse -mountpoint "$mount_point" >/dev/null
  app_path="$(find "$mount_point" -maxdepth 1 -name '*.app' -print -quit)"; trap 'hdiutil detach "$mount_point" >/dev/null 2>&1 || true; rmdir "$mount_point" 2>/dev/null || true' EXIT
fi
if [[ ! -d "$app_path" || "$app_path" != *.app ]]; then echo "No .app found at $source_path" >&2; exit 2; fi
echo "Fresh HOME: $fresh_home"; echo "Your real HOME is untouched. Launching $app_path"
HOME="$fresh_home" open -n "$app_path" --args
echo; echo "After quitting Sulla, delete the simulator with:"; printf 'rm -rf %q\n' "$fresh_home"
