#!/bin/sh
# Downloads the latest native Sulla runtime (host binary + guest kernel/initramfs)
# that CI published from main into resources/darwin/sulla-runtime/, where Desktop
# and scripts/package.ts look for it. `just build` and `just package` run this first.
#
#   scripts/fetch-sulla-runtime.sh [arm64|x86_64]    (default: this Mac's architecture)
#
# It reads the small manifest first and only downloads the bundle when it changed.
# A runtime built by hand with scripts/build-sulla-runtime.sh is kept: delete
# resources/darwin/sulla-runtime/.local-build (or run this with SULLA_RUNTIME_FETCH=force)
# to go back to the published one. SULLA_RUNTIME_SKIP_FETCH=1 skips the download.
set -eu

[ "$(uname -s)" = Darwin ] || exit 0
root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
arch=${1:-$(uname -m)}
case "$arch" in arm64|x86_64) ;; *) echo "usage: $0 [arm64|x86_64]" >&2; exit 2 ;; esac
repo=${SULLA_RUNTIME_REPO:-merchantprotocol/sulla-desktop}
base=${SULLA_RUNTIME_BASE_URL:-"https://github.com/$repo/releases/download/sulla-runtime-latest"}
name="sulla-runtime-darwin-$arch"
out="$root/resources/darwin/sulla-runtime"
have_runtime() { [ -x "$out/sulla-runtime" ] && [ -s "$out/guest/vmlinuz" ] && [ -s "$out/guest/initramfs.img" ]; }

if [ "${SULLA_RUNTIME_SKIP_FETCH:-}" = 1 ]; then
  echo "fetch-sulla-runtime: skipped (SULLA_RUNTIME_SKIP_FETCH=1)"; exit 0
fi
if [ "${SULLA_RUNTIME_FETCH:-}" = force ]; then
  rm -f "$out/.local-build" "$out/.manifest"
fi
if [ -e "$out/.local-build" ] && have_runtime; then
  echo "fetch-sulla-runtime: keeping the runtime you built locally (remove $out/.local-build to use the published one)"; exit 0
fi

fail() {
  if have_runtime; then echo "fetch-sulla-runtime: $1; keeping the runtime already in $out" >&2; exit 0; fi
  echo "fetch-sulla-runtime: $1 and there is no runtime in $out." >&2
  echo "  Build one with scripts/build-sulla-runtime.sh, or check that CI has published $base" >&2
  exit 1
}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

curl -fsSL --retry 3 --connect-timeout 15 -o "$work/manifest" "$base/$name.manifest" || fail "could not download the runtime manifest"
sha=$(sed -n 's/^sha256 //p' "$work/manifest")
source=$(sed -n 's/^source //p' "$work/manifest")
[ -n "$sha" ] || fail "the runtime manifest is malformed"

# Newest local commit that changed the runtime, to tell the user when CI is still catching up.
local_source=$(git -C "$root" log -1 --format=%H -- src/runtime-host/macos src/runtime-agent assets/runtime/guest 2>/dev/null || true)
note() {
  if [ -n "$local_source" ] && [ "$local_source" != "$source" ]; then
    echo "fetch-sulla-runtime: note: the published runtime is from ${source%"${source#???????}"}, your checkout's newest runtime change is ${local_source%"${local_source#???????}"}."
    echo "  If that is a newer commit, CI is still building it (Actions > Sulla runtime); run this again once it finishes."
  fi
}

if have_runtime && [ -f "$out/.manifest" ] && [ "$(sed -n 's/^sha256 //p' "$out/.manifest")" = "$sha" ]; then
  echo "fetch-sulla-runtime: already up to date (${source%"${source#???????}"})"; note; exit 0
fi

echo "fetch-sulla-runtime: downloading $name (${source%"${source#???????}"})..."
curl -fSL --progress-bar --retry 3 --connect-timeout 15 -o "$work/bundle.tar.gz" "$base/$name.tar.gz" || fail "could not download the runtime bundle"
[ "$(shasum -a 256 "$work/bundle.tar.gz" | cut -d' ' -f1)" = "$sha" ] || fail "the downloaded runtime failed its checksum"

mkdir -p "$work/extract"
tar -xzf "$work/bundle.tar.gz" -C "$work/extract"
[ -s "$work/extract/sulla-runtime" ] && [ -s "$work/extract/guest/vmlinuz" ] && [ -s "$work/extract/guest/initramfs.img" ] || fail "the runtime bundle is incomplete"
chmod 0755 "$work/extract/sulla-runtime"

mkdir -p "$out/guest"
rm -f "$out/.local-build"
mv -f "$work/extract/sulla-runtime" "$out/sulla-runtime"
mv -f "$work/extract/guest/vmlinuz" "$work/extract/guest/initramfs.img" "$out/guest/"
cp "$work/manifest" "$out/.manifest"
echo "fetch-sulla-runtime: wrote $out"
note
