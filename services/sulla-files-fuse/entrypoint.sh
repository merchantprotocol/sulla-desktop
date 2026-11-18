#!/bin/sh
# Sulla Desktop · https://sulladesktop.com
# Copyright (c) 2025-2026 Merchant Protocol LLC.
# SPDX-License-Identifier: GPL-2.0-or-later
# "Sulla" is a trademark. See TRADEMARK.md.

set -eu

token_file=${SULLA_FILES_FUSE_TOKEN_FILE:-/run/sulla-files-fuse/token}
mount_path=${SULLA_FILES_FUSE_MOUNT_PATH:-/mnt/sulla/files}
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
  awk -v path="$mount_path" '$5 == path { opt = $6; for (i = 7; $i != "-"; i++) opt = opt " " $i; fs = $(i + 1) } END { if (fs != "") print fs " " opt }' /proc/self/mountinfo
}

top_is_fuse() {
  top=$(top_mount)
  case "${top%% *}" in fuse|fuse.*) return 0 ;; esac
  return 1
}

# Find the non-FUSE mount that anchors mount_path. Mountinfo is ordered by
# mount creation, so replace equal mount-point matches to retain the top stack entry.
containing_mount() {
  awk -v path="$2" '
    $5 != "" && ($5 == "/" || path == $5 || index(path, $5 "/") == 1) {
      opt = ""; for (i = 7; $i != "-" && i <= NF; i++) opt = opt " " $i
      fs = $(i + 1)
      if (fs !~ /^fuse(\.|$)/ && length($5) >= best) {
        best = length($5); result = $5 " " fs opt
      }
    }
    END { if (result != "") print result }
  ' "$1"
}

fail() {
  emit "$1" "$2"
  status failed ",\"reason\":\"$1\"$2"
  exit 1
}

emit entrypoint-start ",\"pid\":$$,\"mountPath\":\"$mount_path\",\"tokenFile\":\"$token_file\",\"tokenWaitSeconds\":$token_wait"

# The shared /mnt/sulla parent is only the propagation anchor. Never mount or
# detach FUSE there: the adapter owns the replaceable child mount exclusively.
[ "$mount_path" = /mnt/sulla/files ] || fail invalid-mount-path ",\"mountPath\":\"$mount_path\",\"expected\":\"/mnt/sulla/files\""

waited=0
while [ ! -s "$token_file" ]; do
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
# pyfuse3 does not act on FUSE_INTERRUPT; callers must rely on bounded network
# waits (SULLA_FILES_FUSE_MAX_WAIT_S) and terminate a blocked process if needed.
emit token-present ",\"waitedSeconds\":$waited"
status starting

# A crashed FUSE process can leave stale adapter layers on the shared mountpoint.
# Only ever remove FUSE layers: the bind underneath is the shared propagation
# anchor, and detaching it makes the new mount invisible outside this container.
# Every layer must go before a daemon mounts again: one lazy unmount removes only the
# top layer, so a restart that unmounted once stacked a second FUSE mount on the first.
clear_stale_fuse_layers() {
  layers=0
  while top_is_fuse; do
    [ "$layers" -ge 8 ] && fail stale-mount-stuck ",\"layers\":$layers"
    emit stale-mount-detected ",\"layer\":$layers,\"fsType\":\"${top%% *}\""
    fusermount3 -uz "$mount_path" 2>/dev/null || umount -l "$mount_path" 2>/dev/null || fail stale-mount-unremovable ",\"layer\":$layers"
    layers=$((layers + 1))
  done
}

clear_stale_fuse_layers

# This directory lives on the guest bind and may not exist in a read-only image.
# Create it only after stale FUSE layers are gone: stat on a dead layer fails
# with ENOTCONN, which would make mkdir -p abort the restart it should recover.
[ -d "$mount_path" ] || mkdir -p "$mount_path" || fail mountpoint-missing ",\"mount\":\"$mount_path\""

# Leave a read-only sentinel mount underneath FUSE. If the adapter dies, shared
# containers see this marker instead of an apparently empty writable tmpfs dir.
# Reuse the existing bind on restart; stacking bind mounts would make teardown
# ambiguous and could leave the sentinel writable after enough restarts.
top_is_readonly_nonfuse() {
  top=$(top_mount)
  case "${top%% *}" in fuse|fuse.*) return 1 ;; esac
  case " $top " in *" ro"*) return 0 ;; esac
  return 1
}

if ! top_is_readonly_nonfuse; then
  : > "$mount_path/SULLA-FILES-NOT-MOUNTED" || fail marker-create-failed ",\"mount\":\"$mount_path\""
  mount --bind "$mount_path" "$mount_path" || fail sentinel-bind-failed ",\"mount\":\"$mount_path\""
  mount -o remount,bind,ro "$mount_path" || fail sentinel-remount-failed ",\"mount\":\"$mount_path\""
fi

anchor=$(containing_mount /proc/self/mountinfo "$mount_path")
anchor_mount=${anchor%% *}
anchor_fs=$(printf '%s\n' "$anchor" | awk '{print $2}')
case " $anchor " in
  *" shared:"*) emit anchor-shared ",\"mount\":\"$anchor_mount\",\"fsType\":\"$anchor_fs\"" ;;
  *) fail anchor-not-shared ",\"mount\":\"${anchor_mount:-none}\",\"fsType\":\"${anchor_fs:-none}\",\"hint\":\"mount $mount_path from the guest with :rshared over a shared anchor\"" ;;
esac

stopping=0
daemon_pid=
backoff=2
shutdown() {
  stopping=1
  if [ -n "$daemon_pid" ]; then kill -TERM "$daemon_pid" 2>/dev/null || true; fi
}
trap shutdown TERM INT

while :; do
  daemon_started=$(date +%s)
  emit daemon-exec ",\"url\":\"${SULLA_FILES_FUSE_URL:-https://sulla_files:8792}\""
  python3 /usr/local/libexec/sulla-files-fuse.py \
    --url "${SULLA_FILES_FUSE_URL:-https://sulla_files:8792}" \
    --status-file "$status_file" \
    "$mount_path" &
  daemon_pid=$!
  if wait "$daemon_pid"; then daemon_status=0; else daemon_status=$?; fi
  daemon_pid=
  [ "$stopping" -eq 1 ] && exit 0
  [ "$daemon_status" -eq 0 ] && exit 0

  # A daemon that ran for a minute was healthy: a crash after that restarts at the base backoff, not the grown one.
  if [ $(( $(date +%s) - daemon_started )) -ge 60 ]; then backoff=2; fi
  emit daemon-restart ",\"exitCode\":$daemon_status,\"backoffSeconds\":$backoff"
  status restarting ",\"exitCode\":$daemon_status,\"backoffSeconds\":$backoff"
  clear_stale_fuse_layers
  sleep "$backoff" &
  sleep_pid=$!
  wait "$sleep_pid" || true
  [ "$stopping" -eq 1 ] && exit 0
  backoff=$((backoff * 2))
  [ "$backoff" -gt 15 ] && backoff=15
done
