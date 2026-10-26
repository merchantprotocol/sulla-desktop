#!/usr/bin/env bash
# Track and reclaim space used by the Sulla runtime VM.
#
#   scripts/vm-disk.sh report   Print where the VM disk is going and append a
#                               snapshot to ~/sulla/logs/vm-disk.tsv
#   scripts/vm-disk.sh history  Show the recorded snapshots (growth over time)
#   scripts/vm-disk.sh clean    Prune stopped containers, unused images and build
#                               cache, then fstrim so the host file shrinks.
#                               Docker VOLUMES are never touched.
#
# Why the host file grows: the data disk image is a sparse file. Deleting data inside the
# VM does not shrink it until the freed blocks are trimmed (fstrim), so a large
# gap between "VM used" and "data.img on host" means `clean` will reclaim space.

set -euo pipefail

RUNTIME_DIR="${SULLA_RUNTIME_DIR:-$HOME/Library/Application Support/Sulla/runtime}"
SULLA_RUNTIME="${SULLA_RUNTIME:-/Applications/Sulla Desktop.app/Contents/Resources/resources/darwin/sulla-runtime/sulla-runtime}"
DISK="$RUNTIME_DIR/data.img"
LOG="$HOME/sulla/logs/vm-disk.tsv"

vm() { "$SULLA_RUNTIME" exec -- sh -c "$1"; }
host_gb() { ls -ls "$DISK" | awk '{printf "%.1f", $1*512/1073741824}'; }
host_free_gb() { df -k /System/Volumes/Data | awk 'NR==2{printf "%.1f", $4/1048576}'; }
vm_used_gb() { vm 'df -kP /mnt/data' | awk 'NR==2{printf "%.1f", $3/1048576}'; }

report() {
  local diff used free
  diff=$(host_gb); used=$(vm_used_gb); free=$(host_free_gb)
  echo "Host data.img (real size): ${diff}G"
  echo "VM /mnt/data used:         ${used}G"
  echo "Host free space:           ${free}G"
  echo
  echo "== Docker =="
  docker system df || true
  echo
  echo "== Largest VM directories =="
  vm 'du -xh -d2 /mnt/data 2>/dev/null | sort -rh | head -20'
  echo
  echo "== Stale scratch (not touched in 7+ days) =="
  vm 'find /mnt/data/tmp /mnt/data/devcache -mindepth 1 -maxdepth 2 -mtime +7 -exec du -sh {} + 2>/dev/null | sort -rh | head -15'

  mkdir -p "$(dirname "$LOG")"
  [ -f "$LOG" ] || printf 'timestamp\thost_data_img_gb\tvm_used_gb\thost_free_gb\tdocker_images\tdocker_volumes\tdocker_buildcache\n' > "$LOG"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$(date -u +%FT%TZ)" "$diff" "$used" "$free" \
    "$(docker system df --format '{{.Size}}' 2>/dev/null | sed -n 1p)" \
    "$(docker system df --format '{{.Size}}' 2>/dev/null | sed -n 3p)" \
    "$(docker system df --format '{{.Size}}' 2>/dev/null | sed -n 4p)" >> "$LOG"
  echo; echo "Snapshot appended to $LOG"
}

history() {
  [ -f "$LOG" ] || { echo "No snapshots yet. Run: $0 report"; exit 0; }
  column -t -s $'\t' "$LOG"
}

clean() {
  local before after
  before=$(host_gb)
  echo "Pruning stopped containers, unused images, build cache (volumes untouched)..."
  docker container prune -f
  docker image prune -a -f
  docker builder prune -a -f
  echo "Trimming VM disk..."
  vm 'fstrim -v /mnt/data' || true
  after=$(host_gb)
  echo "Host data.img: ${before}G -> ${after}G"
  echo "Docker volumes were not removed. Review with: docker volume ls -f dangling=true"
}

case "${1:-report}" in
  report) report ;;
  history) history ;;
  clean) clean ;;
  *) echo "usage: $0 {report|history|clean}" >&2; exit 2 ;;
esac
