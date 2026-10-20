#!/bin/sh
set -eu

token_file=${SULLA_FILES_FUSE_TOKEN_FILE:-/run/sulla-files-fuse/token}
mount_path=${SULLA_FILES_FUSE_MOUNT_PATH:-/mnt/sulla-files}

[ -f "$token_file" ] || { echo "Files mount capability is unavailable" >&2; exit 1; }
exec python3 /usr/local/libexec/sulla-files-fuse.py \
  --url "${SULLA_FILES_FUSE_URL:-https://sulla_files:8792}" \
  "$mount_path"
