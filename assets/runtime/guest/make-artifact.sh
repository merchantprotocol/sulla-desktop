#!/bin/sh
set -eu
rootfs=$1
output=$2
epoch=${SOURCE_DATE_EPOCH:-0}
find "$rootfs" -print0 | xargs -0 touch -h -d "@$epoch"
(cd "$rootfs" && find . -xdev -print0 | LC_ALL=C sort -z | cpio --null -o --format=newc --owner=0:0 2>/dev/null | gzip -n -9 > "$output")
