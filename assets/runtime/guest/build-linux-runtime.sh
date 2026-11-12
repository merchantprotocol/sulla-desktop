#!/bin/sh
# Sulla Desktop · https://sulladesktop.com
# Copyright (c) 2025-2026 Merchant Protocol LLC.
# SPDX-License-Identifier: GPL-2.0-or-later
# "Sulla" is a trademark. See TRADEMARK.md.

# Builds the Linux executor image on the local Docker Engine and prints its
# image ID. It installs nothing on the host and pushes nothing.
set -eu

repo=$(CDPATH= cd -- "$(dirname "$0")/../../.." && pwd)
arch=${1:-$(uname -m | sed -e 's/x86_64/amd64/' -e 's/aarch64/arm64/')}
case "$arch" in arm64|amd64) ;; *) echo "usage: $0 [arm64|amd64]" >&2; exit 2;; esac
tag=${SULLA_LINUX_RUNTIME_TAG:-sulla-desktop-linux-runtime:0.3.0}
docker buildx build --platform "linux/$arch" --target linux-runtime --file "$repo/assets/runtime/guest/Dockerfile" \
  --tag "$tag" --load "$repo"
docker image inspect --format '{{.Id}} {{.Architecture}}' "$tag"
