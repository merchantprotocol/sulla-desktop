#!/bin/sh
set -eu

mode="${SULLA_ACCOUNTS_MODE:-desktop}"
case "$mode" in
  desktop|server) ;;
  *) echo "SULLA_ACCOUNTS_MODE must be desktop or server" >&2; exit 64 ;;
esac

if [ "$mode" = server ]; then
  : "${SULLA_ACCOUNTS_KEYCLOAK_ISSUER:?server mode requires SULLA_ACCOUNTS_KEYCLOAK_ISSUER}"
  : "${SULLA_ACCOUNTS_KEYCLOAK_AUDIENCE:?server mode requires SULLA_ACCOUNTS_KEYCLOAK_AUDIENCE}"
  : "${SULLA_ACCOUNTS_KEYCLOAK_DATABASE_URL:?server mode requires SULLA_ACCOUNTS_KEYCLOAK_DATABASE_URL}"
  : "${SULLA_ACCOUNTS_KEYCLOAK_DATABASE_USERNAME:?server mode requires SULLA_ACCOUNTS_KEYCLOAK_DATABASE_USERNAME}"
  : "${SULLA_ACCOUNTS_KEYCLOAK_DATABASE_PASSWORD:?server mode requires SULLA_ACCOUNTS_KEYCLOAK_DATABASE_PASSWORD}"
  : "${KEYCLOAK_ADMIN:?server mode requires KEYCLOAK_ADMIN}"
  : "${KEYCLOAK_ADMIN_PASSWORD:?server mode requires KEYCLOAK_ADMIN_PASSWORD}"
fi

accounts_pid=""
keycloak_pid=""
stop_children() {
  [ -z "$keycloak_pid" ] || kill -TERM "$keycloak_pid" 2>/dev/null || true
  [ -z "$accounts_pid" ] || kill -TERM "$accounts_pid" 2>/dev/null || true
  set +e
  [ -z "$keycloak_pid" ] || wait "$keycloak_pid" 2>/dev/null || true
  [ -z "$accounts_pid" ] || wait "$accounts_pid" 2>/dev/null || true
  set -e
}

terminate() {
  status="$1"
  trap - INT TERM HUP
  stop_children
  exit "$status"
}
trap 'terminate 130' INT
trap 'terminate 143' TERM
trap 'terminate 129' HUP

if [ "$mode" = server ]; then
  realm="${SULLA_ACCOUNTS_KEYCLOAK_REALM:-sulla}"
  case "$realm" in
    ''|*[!A-Za-z0-9._-]*) echo "SULLA_ACCOUNTS_KEYCLOAK_REALM is invalid" >&2; exit 64 ;;
  esac
  public_url="${SULLA_ACCOUNTS_PUBLIC_URL%/}"
  expected_issuer="${public_url}/auth/realms/${realm}"
  if [ "$SULLA_ACCOUNTS_KEYCLOAK_ISSUER" != "$expected_issuer" ]; then
    echo "SULLA_ACCOUNTS_KEYCLOAK_ISSUER must equal ${expected_issuer}" >&2
    exit 64
  fi

  # Keycloak imports this realm only on first boot; its database remains authoritative after that.
  export SULLA_ACCOUNTS_KEYCLOAK_REALM="$realm" public_url
  node --input-type=module -e '
    import { writeFileSync } from "node:fs";
    const realm = process.env.SULLA_ACCOUNTS_KEYCLOAK_REALM;
    const clientId = process.env.SULLA_ACCOUNTS_KEYCLOAK_AUDIENCE;
    const publicUrl = process.env.public_url;
    writeFileSync(`/opt/keycloak/data/import/${realm}-realm.json`, JSON.stringify({
      realm,
      enabled: true,
      registrationAllowed: false,
      resetPasswordAllowed: true,
      clients: [{
        clientId,
        name: "Sulla Accounts",
        protocol: "openid-connect",
        publicClient: true,
        standardFlowEnabled: true,
        directAccessGrantsEnabled: false,
        redirectUris: [`${publicUrl}/v1/oidc/callback`],
        attributes: { "pkce.code.challenge.method": "S256" },
      }],
    }), { mode: 0o600 });
  '

  # Port 8080 is reachable only on the Compose network so the separate gateway can proxy it.
  export KC_DB=postgres
  export KC_DB_URL="$SULLA_ACCOUNTS_KEYCLOAK_DATABASE_URL"
  export KC_DB_USERNAME="$SULLA_ACCOUNTS_KEYCLOAK_DATABASE_USERNAME"
  export KC_DB_PASSWORD="$SULLA_ACCOUNTS_KEYCLOAK_DATABASE_PASSWORD"
  export KC_HTTP_ENABLED=true
  export KC_HTTP_PORT=8080
  export KC_HTTP_HOST=0.0.0.0
  export KC_HTTP_MANAGEMENT_HOST=127.0.0.1
  export KC_HTTP_MANAGEMENT_PORT=9000
  export KC_HTTP_MANAGEMENT_SCHEME=http
  export KC_HOSTNAME_STRICT=true
  export KC_HOSTNAME="${public_url}/auth"
  export KC_PROXY_HEADERS=xforwarded
  export KC_HTTP_RELATIVE_PATH=/auth
  export KC_BOOTSTRAP_ADMIN_USERNAME="${KEYCLOAK_ADMIN}"
  export KC_BOOTSTRAP_ADMIN_PASSWORD="${KEYCLOAK_ADMIN_PASSWORD}"
  /opt/keycloak/bin/kc.sh start --optimized --import-realm &
  keycloak_pid=$!

  attempts=0
  until curl --fail --silent --show-error --max-time 2 http://127.0.0.1:9000/health/ready >/dev/null 2>&1; do
    if ! kill -0 "$keycloak_pid" 2>/dev/null; then
      set +e
      wait "$keycloak_pid"
      status=$?
      set -e
      keycloak_pid=""
      exit "$status"
    fi
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 60 ]; then
      echo "Keycloak did not become ready within 120 seconds" >&2
      terminate 1
    fi
    sleep 2
  done
fi

node dist/index.js &
accounts_pid=$!

while :; do
  if ! kill -0 "$accounts_pid" 2>/dev/null; then
    set +e
    wait "$accounts_pid"
    status=$?
    set -e
    accounts_pid=""
    stop_children
    exit "$status"
  fi
  if [ -n "$keycloak_pid" ] && ! kill -0 "$keycloak_pid" 2>/dev/null; then
    set +e
    wait "$keycloak_pid"
    status=$?
    set -e
    keycloak_pid=""
    stop_children
    exit "$status"
  fi
  sleep 1
done