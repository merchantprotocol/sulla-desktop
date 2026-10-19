#!/bin/sh
set -eu

TLS_DIRECTIVES=""
if [ -n "${SULLA_TLS_CERT_CONTAINER_PATH:-}" ]; then
  test -r "$SULLA_TLS_CERT_CONTAINER_PATH"
  test -r "$SULLA_TLS_KEY_CONTAINER_PATH"
  TLS_DIRECTIVES=" ssl; ssl_certificate ${SULLA_TLS_CERT_CONTAINER_PATH}; ssl_certificate_key ${SULLA_TLS_KEY_CONTAINER_PATH}"
fi
export TLS_DIRECTIVES

cat >/tmp/sulla-proxy-params.conf <<'EOF'
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection $connection_upgrade;
proxy_set_header Host $host;
proxy_set_header X-Forwarded-Host $host;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
EOF

envsubst '${TLS_DIRECTIVES}' </etc/sulla/nginx.conf.template >/tmp/nginx.conf
exec nginx -c /tmp/nginx.conf -g 'daemon off;'
