#!/bin/sh
set -eu
rootfs=$1
output=$2
epoch=${SOURCE_DATE_EPOCH:-0}
# The console driver is a module, so the kernel starts PID 1 with no stdio.
# The Go agent's runtime then opens /dev/null before main() runs and exits if
# it can't, panicking the kernel. Ship the two nodes devtmpfs isn't there for yet.
mkdir -p "$rootfs/dev"
[ -c "$rootfs/dev/console" ] || mknod -m 600 "$rootfs/dev/console" c 5 1
[ -c "$rootfs/dev/null" ] || mknod -m 666 "$rootfs/dev/null" c 1 3
find "$rootfs" -print0 | xargs -0 touch -h -d "@$epoch"
(cd "$rootfs" && find . -xdev -print0 | LC_ALL=C sort -z | cpio --null -o --format=newc --owner=0:0 2>/dev/null | gzip -n -9 > "$output")
