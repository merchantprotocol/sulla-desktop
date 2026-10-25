#!/bin/sh
set -eu

repo=$(CDPATH= cd -- "$(dirname "$0")/../../.." && pwd)
arch=${1:-arm64}
case "$arch" in arm64|amd64) ;; *) echo "usage: $0 [arm64|amd64]" >&2; exit 2;; esac
output=${2:-"$repo/assets/runtime/guest/dist/$arch"}
mkdir -p "$output"
docker buildx build --platform "linux/$arch" --file "$repo/assets/runtime/guest/Dockerfile" \
  --build-arg SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-0}" --output "type=local,dest=$output" "$repo"
(cd "$output" && sha256sum -c SHA256SUMS)
