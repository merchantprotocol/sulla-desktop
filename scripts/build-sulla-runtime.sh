#!/bin/sh
# Builds the native Sulla runtime for this Mac into resources/darwin/sulla-runtime/,
# where Desktop (dev and packaged) looks for it:
#   sulla-runtime              host binary (swift build -c release)
#   guest/vmlinuz              guest kernel      (assets/runtime/guest/build.sh, needs Docker buildx)
#   guest/initramfs.img        guest initramfs
#
# Usage: scripts/build-sulla-runtime.sh [arm64|x86_64]   (default: this Mac's architecture)
#
# The binary is ad-hoc signed with the Virtualization entitlement so a dev build can
# run it; scripts/package.ts re-signs it with the release identity. CI builds the same
# artifacts in .github/workflows/sulla-runtime-host-macos.yml and sulla-runtime-guest.yml.
set -eu

[ "$(uname -s)" = Darwin ] || { echo "build-sulla-runtime: macOS is required" >&2; exit 1; }
root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
arch=${1:-$(uname -m)}
case "$arch" in
  arm64) guest_arch=arm64 ;;
  x86_64) guest_arch=amd64 ;;
  *) echo "usage: $0 [arm64|x86_64]" >&2; exit 2 ;;
esac
out="$root/resources/darwin/sulla-runtime"
mkdir -p "$out/guest"

(cd "$root/src/runtime-host/macos" && swift build -c release --arch "$arch")
cp "$root/src/runtime-host/macos/.build/$arch-apple-macosx/release/sulla-runtime" "$out/sulla-runtime"
codesign --force --sign - --entitlements "$root/src/runtime-host/macos/sulla-runtime.entitlements" "$out/sulla-runtime"

guest_out=$(mktemp -d)
trap 'rm -rf "$guest_out"' EXIT
"$root/assets/runtime/guest/build.sh" "$guest_arch" "$guest_out"
cp "$guest_out/vmlinuz" "$guest_out/initramfs.img" "$out/guest/"
echo "build-sulla-runtime: wrote $out"
