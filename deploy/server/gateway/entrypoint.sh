#!/bin/sh
set -eu

TLS_DIRECTIVES=""
if [ -n "${SULLA_TLS_CERT_CONTAINER_PATH:-}" ]; then
  test -r "$SULLA_TLS_CERT_CONTAINER_PATH"
  test -r "$SULLA_TLS_KEY_CONTAINER_PATH"
  TLS_DIRECTIVES=" ssl; ssl_certificate ${SULLA_TLS_CERT_CONTAINER_PATH}; ssl_certificate_key ${SULLA_TLS_KEY_CONTAINER_PATH}"
fi
export TLS_DIRECTIVES

DNS_RESOLVER="$(awk '$1 == "nameserver" && $2 ~ /^[0-9a-fA-F:.]+$/ { print $2; exit }' /etc/resolv.conf)"
[ -n "$DNS_RESOLVER" ] || { echo 'gateway: no DNS resolver found in /etc/resolv.conf' >&2; exit 1; }
export DNS_RESOLVER

cat >/tmp/sulla-proxy-params.conf <<'EOF'
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection $connection_upgrade;
proxy_set_header Host $http_host;
proxy_set_header X-Forwarded-Host $http_host;
proxy_set_header X-Forwarded-Proto $sulla_forwarded_proto;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
EOF

envsubst '${TLS_DIRECTIVES} ${DNS_RESOLVER}' </etc/sulla/nginx.conf.template >/tmp/nginx.conf
exec nginx -c /tmp/nginx.conf -g 'daemon off;'
