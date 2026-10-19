#!/bin/sh
set -eu

collection_file=${SULLA_FILES_FUSE_COLLECTION_FILE:-/run/sulla-files-fuse/collection}
token_file=${SULLA_FILES_FUSE_TOKEN_FILE:-/run/sulla-files-fuse/token}
mount_path=${SULLA_FILES_FUSE_MOUNT_PATH:-/mnt/sulla-files}

[ -f "$collection_file" ] || { echo "Files collection identity is unavailable" >&2; exit 1; }
[ -f "$token_file" ] || { echo "Files mount capability is unavailable" >&2; exit 1; }
collection=$(head -c 64 "$collection_file" | tr -d '\r\n')
case "$collection" in
  ????????-????-????-????-????????????) ;;
  *) echo "Files collection identity is invalid" >&2; exit 1 ;;
esac

exec python3 /usr/local/libexec/sulla-files-fuse.py \
  --url "${SULLA_FILES_FUSE_URL:-https://sulla_files:8792}" \
  --collection "$collection" \
  "$mount_path"
