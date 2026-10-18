#!/bin/sh
set -eu

TLS_DIRECTIVES=""
if [ -n "${SULLA_TLS_CERT_CONTAINER_PATH:-}" ] || [ -n "${SULLA_TLS_KEY_CONTAINER_PATH:-}" ]; then
  : "${SULLA_TLS_CERT_CONTAINER_PATH:?TLS certificate and key must be configured together}"
  : "${SULLA_TLS_KEY_CONTAINER_PATH:?TLS certificate and key must be configured together}"
  test -r "$SULLA_TLS_CERT_CONTAINER_PATH"
  test -r "$SULLA_TLS_KEY_CONTAINER_PATH"
  TLS_DIRECTIVES=" ssl; ssl_certificate ${SULLA_TLS_CERT_CONTAINER_PATH}; ssl_certificate_key ${SULLA_TLS_KEY_CONTAINER_PATH}"
fi
export TLS_DIRECTIVES
envsubst '${TLS_DIRECTIVES}' </etc/sulla/nginx.conf.template >/tmp/nginx.conf
exec nginx -c /tmp/nginx.conf -g 'daemon off;'
