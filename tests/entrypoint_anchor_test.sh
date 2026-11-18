#!/bin/sh
# Exercise the exact mountinfo lookup used by the adapter entrypoint.
set -eu
entrypoint=$(CDPATH= cd -- "$(dirname "$0")/../services/sulla-files-fuse" && pwd)/entrypoint.sh
lookup=$(sed -n '/^containing_mount() {$/,/^}$/p' "$entrypoint")
[ -n "$lookup" ] || { echo 'containing_mount function not found' >&2; exit 1; }
eval "$lookup"
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
check() {
  label=$1; expected=$2; shift 2
  printf '%s\n' "$@" > "$tmp"
  actual=$(containing_mount "$tmp" /mnt/sulla/files)
  case "$actual" in
    "$expected") ;;
    *) echo "$label: expected [$expected], got [$actual]" >&2; exit 1 ;;
  esac
}
# risk: mount propagation; directory child inherits the shared parent's anchor.
check 'shared parent' '/mnt/sulla ext4 shared:42' \
  '31 24 0:28 / /mnt/sulla rw,relatime shared:42 - ext4 /dev/vda rw'
# risk: mount propagation; a private parent must not be accepted.
check 'private parent' '/mnt/sulla ext4' \
  '31 24 0:28 / /mnt/sulla rw,relatime - ext4 /dev/vda rw'
private=$(containing_mount "$tmp" /mnt/sulla/files)
case " $private " in *" shared:"*) echo 'private parent was incorrectly accepted' >&2; exit 1 ;; esac
# risk: mount propagation; an exact shared self-bind is a valid anchor.
check 'shared self-bind' '/mnt/sulla/files ext4 shared:43' \
  '31 24 0:28 / /mnt/sulla rw,relatime shared:42 - ext4 /dev/vda rw' \
  '32 31 0:30 / /mnt/sulla/files rw,relatime shared:43 - ext4 /dev/vdb rw'
# risk: mount propagation; stale FUSE layers are cleared before lookup, and aren't anchors.
check 'FUSE ignored' '/mnt/sulla ext4 shared:42' \
  '31 24 0:28 / /mnt/sulla rw,relatime shared:42 - ext4 /dev/vda rw' \
  '32 31 0:30 / /mnt/sulla/files rw,nosuid - fuse.sulla rw'
echo 'entrypoint anchor tests: 4/4 passed'
