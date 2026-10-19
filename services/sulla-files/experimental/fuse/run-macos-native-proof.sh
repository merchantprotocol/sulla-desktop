#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
repository_root=$(git -C "$script_dir" rev-parse --show-toplevel)
native_dependencies=${SULLA_FILES_PROOF_NATIVE_NODE_MODULES:-/Users/jonathonbyrdziak/Sites/sulla/sulla-desktop/node_modules}
electron_binary="$native_dependencies/electron/dist/Electron.app/Contents/MacOS/Electron"

if [ "$(uname -s)" != Darwin ]; then
  echo 'The native proof runner must run on macOS.' >&2
  exit 1
fi
if [ ! -x "$electron_binary" ]; then
  echo 'The existing native Electron binary was not found; do not install dependencies for this proof.' >&2
  exit 1
fi

stage_parent=${TMPDIR:-/tmp}
stage_parent=${stage_parent%/}
stage_parent=$(CDPATH= cd -- "$stage_parent" && pwd -P)
stage_root=$(mktemp -d "$stage_parent/sulla-files-native-proof-stage.XXXXXX")
stage_root=$(CDPATH= cd -- "$stage_root" && pwd -P)

cleanup() {
  case "$stage_root" in
    "$stage_parent"/sulla-files-native-proof-stage.*)
      if [ -d "$stage_root" ] && [ ! -L "$stage_root" ] && [ -O "$stage_root" ]; then rm -rf -- "$stage_root"; fi
      ;;
  esac
}
trap cleanup EXIT

case "$stage_root" in
  "$stage_parent"/sulla-files-native-proof-stage.*) ;;
  *) echo 'mktemp returned an unexpected proof staging path.' >&2; exit 1 ;;
esac
if [ ! -O "$stage_root" ] || [ -L "$stage_root" ]; then
  echo 'Proof staging root is not an owned directory.' >&2
  exit 1
fi

source_root="$stage_root/source"
profile_root="$stage_root/electron-profile"
mkdir -m 700 "$source_root" "$profile_root" \
  "$profile_root/user-data" "$profile_root/session-data" \
  "$profile_root/cache" "$profile_root/media-cache" \
  "$profile_root/logs" "$profile_root/crash-dumps"
git -C "$repository_root" archive --format=tar HEAD | tar -x -C "$source_root"
ln -s "$native_dependencies" "$source_root/node_modules"

cd "$source_root"
PATH="${SULLA_FILES_PROOF_PG_BIN:-/opt/homebrew/bin}:/opt/homebrew/bin:$PATH" \
NODE_OPTIONS=--import=tsx \
SULLA_FILES_MACOS_NATIVE_PROOF=1 \
SULLA_FILES_PROOF_PORT="${SULLA_FILES_PROOF_PORT:-48793}" \
SULLA_FILES_PROOF_FUSE_IMAGE="${SULLA_FILES_PROOF_FUSE_IMAGE:-sulla-files-fuse-proof:local}" \
SULLA_FILES_PROOF_ELECTRON_ROOT="$profile_root" \
"$electron_binary" \
  --user-data-dir="$profile_root/user-data" \
  --disk-cache-dir="$profile_root/cache" \
  --media-cache-dir="$profile_root/media-cache" \
  --crash-dumps-dir="$profile_root/crash-dumps" \
  --log-file="$profile_root/logs/electron.log" \
  services/sulla-files/experimental/fuse/macos-native-proof-bootstrap.mjs
