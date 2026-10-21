#!/bin/sh
set -eu

token_file=${SULLA_FILES_FUSE_TOKEN_FILE:-/run/sulla-files-fuse/token}
mount_path=${SULLA_FILES_FUSE_MOUNT_PATH:-/mnt/sulla-files}

[ -f "$token_file" ] || { echo "Files mount capability is unavailable" >&2; exit 1; }
# A crashed FUSE process can leave the shared mountpoint busy. Tear it down before
# recreating the directory so Docker's restart policy can actually recover it.
fusermount3 -uz "$mount_path" 2>/dev/null || umount -l "$mount_path" 2>/dev/null || true
mkdir -p "$mount_path"
exec python3 /usr/local/libexec/sulla-files-fuse.py \
  --url "${SULLA_FILES_FUSE_URL:-https://sulla_files:8792}" \
  "$mount_path"
