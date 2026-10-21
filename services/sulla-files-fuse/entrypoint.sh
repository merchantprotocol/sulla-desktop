#!/bin/sh
set -eu

token_file=${SULLA_FILES_FUSE_TOKEN_FILE:-/run/sulla-files-fuse/token}
mount_path=${SULLA_FILES_FUSE_MOUNT_PATH:-/mnt/sulla-files}
# Desktop reads this (docker exec cat) to tell a slow-but-progressing adapter from a dead one.
status_file=${SULLA_FILES_FUSE_STATUS_FILE:-/tmp/sulla-files-fuse-status.json}
# Desktop writes the capability only after Files unlocks (and migrations finish),
# so wait for it here instead of crash-looping one identical line per restart.
token_wait=${SULLA_FILES_FUSE_TOKEN_WAIT_SECONDS:-300}

emit() {
  printf '{"ts":"%s","source":"sulla-files-fuse","event":"%s"%s}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "${2:-}" >&2
}

# phase, then optional extra JSON fields (leading comma). Written atomically.
status() {
  printf '{"phase":"%s","updatedAt":"%s","pid":%s%s}\n' "$1" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$$" "${2:-}" > "$status_file.new" && mv "$status_file.new" "$status_file"
}

# Topmost mount at the path: "<fstype> <optional fields>" (mountinfo lists mounts in mount order).
top_mount() {
  awk -v path="$mount_path" '$5 == path { opt = ""; for (i = 7; $i != "-"; i++) opt = opt " " $i; fs = $(i + 1) } END { if (fs != "") print fs opt }' /proc/self/mountinfo
}

top_is_fuse() {
  top=$(top_mount)
  case "${top%% *}" in fuse|fuse.*) return 0 ;; esac
  return 1
}

fail() {
  emit "$1" "$2"
  status failed ",\"reason\":\"$1\"$2"
  exit 1
}

emit entrypoint-start ",\"pid\":$$,\"mountPath\":\"$mount_path\",\"tokenFile\":\"$token_file\",\"tokenWaitSeconds\":$token_wait"

waited=0
while [ ! -f "$token_file" ]; do
  if [ "$waited" -ge "$token_wait" ]; then
    dir=$(dirname "$token_file")
    if [ -d "$dir" ]; then dir_state=present; entries=$(ls -A "$dir" 2>/dev/null | wc -l | tr -d ' '); else dir_state=missing; entries=0; fi
    echo "Files mount capability is unavailable" >&2
    fail token-unavailable ",\"waitedSeconds\":$waited,\"tokenDir\":\"$dir_state\",\"tokenDirEntries\":$entries"
  fi
  if [ $((waited % 15)) -eq 0 ]; then
    emit token-waiting ",\"waitedSeconds\":$waited"
  fi
  status waiting-token ",\"waitedSeconds\":$waited"
  sleep 1
  waited=$((waited + 1))
done
emit token-present ",\"waitedSeconds\":$waited"
status starting

# A crashed FUSE process can leave stale adapter layers on the shared mountpoint.
# Only ever remove FUSE layers: the bind underneath is the shared propagation
# anchor, and detaching it makes the new mount invisible outside this container.
layers=0
while top_is_fuse; do
  [ "$layers" -ge 8 ] && fail stale-mount-stuck ",\"layers\":$layers"
  emit stale-mount-detected ",\"layer\":$layers,\"fsType\":\"${top%% *}\""
  fusermount3 -uz "$mount_path" 2>/dev/null || umount -l "$mount_path" 2>/dev/null || fail stale-mount-unremovable ",\"layer\":$layers"
  layers=$((layers + 1))
done

top=$(top_mount)
case " $top " in
  *" shared:"*) emit anchor-shared ",\"mount\":\"$top\"" ;;
  *) fail anchor-not-shared ",\"mount\":\"${top:-none}\",\"hint\":\"mount $mount_path from the guest with :rshared over a shared anchor\"" ;;
esac

emit daemon-exec ",\"url\":\"${SULLA_FILES_FUSE_URL:-https://sulla_files:8792}\""
exec python3 /usr/local/libexec/sulla-files-fuse.py \
  --url "${SULLA_FILES_FUSE_URL:-https://sulla_files:8792}" \
  --status-file "$status_file" \
  "$mount_path"
