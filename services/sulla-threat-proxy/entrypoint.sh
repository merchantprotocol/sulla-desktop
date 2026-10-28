#!/bin/sh
# Sulla Desktop · https://sulladesktop.com
# Copyright (c) 2025-2026 Merchant Protocol LLC.
# SPDX-License-Identifier: GPL-2.0-or-later
# "Sulla" is a trademark. See TRADEMARK.md.

# Starts mitmdump with the Sulla addons. State layout (bind-mounted from the
# Sulla runtime data disk, provisioned by Desktop):
#   mitm/       0700  mitmproxy confdir: the CA private key never leaves it
#   cache/      0700  verdict cache (SQLite)
#   config/     0700  proxy.json, written by Desktop (read-only here)
#   blocklist/  0755  urlhaus.txt, written by Desktop (read-only here)
#   public/     0755  ca.crt + ca-bundle.pem: the only files agent containers mount
set -eu

state="${SULLA_PROXY_STATE_DIR:-/var/lib/sulla-threat-proxy}"
port="${SULLA_PROXY_LISTEN_PORT:-8890}"
mode="${SULLA_PROXY_MODE:-transparent}"
addons=/opt/sulla-threat-proxy/addons

for dir in mitm cache public; do
  if [ ! -d "$state/$dir" ] || [ ! -w "$state/$dir" ]; then
    echo "sulla-threat-proxy: $state/$dir must be a directory writable by uid $(id -u)" >&2
    exit 78
  fi
done

# Create the CA once; later starts reuse it.
umask 077
python3 -c 'import sys; from mitmproxy.certs import CertStore; CertStore.from_store(sys.argv[1], "mitmproxy", 2048)' "$state/mitm"

# Publish the public certificate only, plus a bundle of the system roots and
# the CA for clients whose CA setting replaces (not extends) their trust store.
umask 022
cp "$state/mitm/mitmproxy-ca-cert.pem" "$state/public/.ca.crt.tmp"
chmod 0644 "$state/public/.ca.crt.tmp"
mv -f "$state/public/.ca.crt.tmp" "$state/public/ca.crt"
cat /etc/ssl/certs/ca-certificates.crt "$state/mitm/mitmproxy-ca-cert.pem" > "$state/public/.ca-bundle.pem.tmp"
chmod 0644 "$state/public/.ca-bundle.pem.tmp"
mv -f "$state/public/.ca-bundle.pem.tmp" "$state/public/ca-bundle.pem"

# connection_strategy=lazy: the upstream connection is opened only after the
# request hooks ran, so a blocked URL never gets a TCP/TLS connection.
exec mitmdump \
  --mode "$mode" \
  --listen-host "${SULLA_PROXY_LISTEN_HOST:-0.0.0.0}" \
  --listen-port "$port" \
  --set confdir="$state/mitm" \
  --set connection_strategy=lazy \
  --set block_global=false \
  --set stream_large_bodies=16m \
  --set flow_detail=0 \
  -s "$addons/url_filter.py" \
  -s "$addons/prompt_injection.py"
