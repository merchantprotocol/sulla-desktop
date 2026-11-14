#!/bin/sh
# Sulla Desktop · https://sulladesktop.com
# Copyright (c) 2025-2026 Merchant Protocol LLC.
# SPDX-License-Identifier: GPL-2.0-or-later
# "Sulla" is a trademark. See TRADEMARK.md.
#
# Build one service image locally for THIS machine only.
#
# Usage: scripts/build-service-image.sh <service> [--push] [--platform linux/amd64]
#   e.g. scripts/build-service-image.sh sulla-files --push
#
# The default platform is this Mac's own architecture (linux/arm64 on Apple
# Silicon). Multi-arch builds run the other architecture under QEMU, which is
# many times slower and starves the whole machine (load average 50-95), so they
# are opt-in only: pass --platform linux/amd64,linux/arm64 deliberately.
set -eu

service="${1:?usage: build-service-image.sh <service> [--push] [--platform <p>]}"
shift
push=""
platform=""
while [ $# -gt 0 ]; do
  case "$1" in
    --push) push="--push" ;;
    --platform) platform="${2:?--platform needs a value}"; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

if [ -z "$platform" ]; then
  case "$(uname -m)" in
    arm64|aarch64) platform="linux/arm64" ;;
    x86_64|amd64) platform="linux/amd64" ;;
    *) echo "unsupported host architecture: $(uname -m)" >&2; exit 1 ;;
  esac
fi

root="$(cd "$(dirname "$0")/.." && pwd)"
sha="$(git -C "$root" rev-parse HEAD)"
tag="ghcr.io/merchantprotocol/${service}:sha-${sha}"
echo "building ${tag} for ${platform} only"
# --load keeps a single-platform image in the local daemon when not pushing.
[ -n "$push" ] || push="--load"
exec docker buildx build --platform "$platform" \
  -f "$root/services/${service}/Dockerfile" -t "$tag" $push "$root"
