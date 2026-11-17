#!/bin/sh
# SPDX-License-Identifier: GPL-2.0-or-later
# Refresh the packaged URLhaus hosts-file snapshot from Sulla Cloud (override with URLHAUS_URL).
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TARGET="$ROOT/blocklist/urlhaus-default.txt"
TMP="$TARGET.tmp"
URL="${URLHAUS_URL:-https://sulla-workers.merchantprotocol.workers.dev/threat-intel/urlhaus.txt}"
trap 'rm -f "$TMP"' EXIT HUP INT TERM
mkdir -p "$(dirname "$TARGET")"
curl --fail --location --silent --show-error "$URL" --output "$TMP"
awk '
  /^#/ || /^[[:space:]]*$/ { next }
  {
    n = split($0, fields, /[[:space:]]+/)
    host = fields[n]
    if (n == 2 && fields[1] != "0.0.0.0") exit 2
    if (n > 2 || host !~ /^[[:alnum:].-]+\.[[:alpha:]-]+$/) exit 2
    count++
  }
  END { if (count < 100) exit 3 }
' "$TMP"
mv "$TMP" "$TARGET"
trap - EXIT HUP INT TERM
printf 'Updated %s (%s hosts)\n' "$TARGET" "$(awk '!/^#/ && NF { count++ } END { print count+0 }' "$TARGET")"
