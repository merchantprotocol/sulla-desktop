#!/bin/sh
# Sulla Desktop · https://sulladesktop.com
# Copyright (c) 2025-2026 Merchant Protocol LLC.
# SPDX-License-Identifier: GPL-2.0-or-later
# "Sulla" is a trademark. See TRADEMARK.md.

# Builds the app-owned Alpine Docker guest rootfs imported by the Windows WSL2 adapter.
# Requires Docker Buildx; this does not install or enable WSL on the host.
set -eu

repo=$(CDPATH= cd -- "$(dirname "$0")/../../.." && pwd)
arch=${1:-amd64}
case "$arch" in amd64|arm64) ;; *) echo "usage: $0 [amd64|arm64] [output-directory]" >&2; exit 2;; esac
output=${2:-"$repo/assets/runtime/guest/dist/wsl/$arch"}
mkdir -p "$output"
docker buildx build --platform "linux/$arch" --target wsl-import-rootfs \
  --build-arg SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-0}" \
  --output "type=local,dest=$output" "$repo"
(cd "$output" && sha256sum -c rootfs.tar.sha256)
