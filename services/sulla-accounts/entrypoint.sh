#!/bin/sh
set -eu

readonly runtime_uid=10001
readonly runtime_gid=10001
readonly private_dir=/run/sulla-accounts-private

fail() {
  echo "sulla-accounts: $*" >&2
  exit 64
}

require_value() {
  eval "value=\${$1:-}"
  [ -n "$value" ] || fail "$1 is required"
}

copy_secret() {
  source_variable="$1"
  destination_name="$2"
  required="${3:-required}"
  eval "source_path=\${$source_variable:-}"
  if [ -z "$source_path" ]; then
    [ "$required" = optional ] && return 1
    fail "$source_variable is required"
  fi
  [ -f "$source_path" ] && [ ! -L "$source_path" ] || fail "$source_variable must name a regular, non-symlink file"
  destination_path="${private_dir}/${destination_name}"
  cp -- "$source_path" "$destination_path"
  chown "$runtime_uid:$runtime_gid" "$destination_path"
  chmod 0600 "$destination_path"
  printf '%s\n' "$destination_path"
}

read_secret() {
  secret_path="$1"
  [ -s "$secret_path" ] || fail "$secret_path is empty"
  LC_ALL=C tr -d '\000' <"$secret_path"
}

run_unprivileged() {
  setpriv --reuid="$runtime_uid" --regid="$runtime_gid" --init-groups -- "$@"
}

[ "$(id -u)" -eq 0 ] || fail "entrypoint must begin as root to stage file secrets"
mkdir -p "$private_dir"
chown "$runtime_uid:$runtime_gid" "$private_dir"
chmod 0700 "$private_dir"

mode="${SULLA_ACCOUNTS_MODE:-desktop}"
case "$mode" in
  desktop|server) ;;
  *) fail "SULLA_ACCOUNTS_MODE must be desktop or server" ;;
esac

export SULLA_ACCOUNTS_SESSION_SECRET_FILE="$(copy_secret SULLA_ACCOUNTS_SESSION_SECRET_SOURCE_FILE session.secret)"
export SULLA_ACCOUNTS_ENCRYPTION_KEY_FILE="$(copy_secret SULLA_ACCOUNTS_ENCRYPTION_KEY_SOURCE_FILE encryption.key)"
if service_tokens_path="$(copy_secret SULLA_ACCOUNTS_SERVICE_TOKENS_SOURCE_FILE service-tokens.json optional)"; then
  export SULLA_ACCOUNTS_SERVICE_TOKENS_FILE="$service_tokens_path"
fi
if [ "$mode" = desktop ]; then
  export SULLA_ACCOUNTS_BOOTSTRAP_SECRET_FILE="$(copy_secret SULLA_ACCOUNTS_BOOTSTRAP_SECRET_SOURCE_FILE bootstrap.secret)"
else
  export SULLA_ACCOUNTS_ADMIN_SECRET_FILE="$(copy_secret SULLA_ACCOUNTS_ADMIN_SECRET_SOURCE_FILE admin.secret)"
fi

database_username_path="$(copy_secret SULLA_ACCOUNTS_DATABASE_USERNAME_FILE database.username)"
database_password_path="$(copy_secret SULLA_ACCOUNTS_DATABASE_PASSWORD_FILE database.password)"
database_username="$(read_secret "$database_username_path")"
database_password="$(read_secret "$database_password_path")"
require_value SULLA_ACCOUNTS_DATABASE_HOST
require_value SULLA_ACCOUNTS_DATABASE_NAME
database_port="${SULLA_ACCOUNTS_DATABASE_PORT:-5432}"
export database_username database_password database_port
export SULLA_ACCOUNTS_DATABASE_URL_FILE="${private_dir}/database.url"
run_unprivileged node --input-type=module -e '
  import { writeFileSync } from "node:fs";
  const credentials = `${encodeURIComponent(process.env.database_username)}:${encodeURIComponent(process.env.database_password)}`;
  writeFileSync(process.env.SULLA_ACCOUNTS_DATABASE_URL_FILE, `postgresql://${credentials}@${process.env.SULLA_ACCOUNTS_DATABASE_HOST}:${process.env.database_port}/${process.env.SULLA_ACCOUNTS_DATABASE_NAME}`, { mode: 0o600 });
'
unset database_username database_password
unset database_port

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

reconcile_keycloak() {
  realm="$1"
  admin_username="$2"
  admin_password="$3"
  native_client_id="$4"
  native_redirect_uri="$5"
  web_client_id="$6"
  web_client_secret="$7"
  service_audiences="$8"

  export realm native_client_id native_redirect_uri web_client_id web_client_secret service_audiences
  realm_file="${private_dir}/realm.json"
  native_client_file="${private_dir}/native-client.json"
  web_client_file="${private_dir}/web-client.json"
  run_unprivileged node --input-type=module -e '
    import { writeFileSync } from "node:fs";
    const audiences = process.env.service_audiences.split(",").map(value => value.trim()).filter(Boolean);
    for (const audience of audiences) {
      if (!/^[A-Za-z0-9._-]+$/.test(audience)) throw new Error(`invalid audience ${audience}`);
      writeFileSync(`/run/sulla-accounts-private/scope-${audience}.json`, JSON.stringify({
        name: `sulla-audience-${audience}`,
        protocol: "openid-connect",
        attributes: { "display.on.consent.screen": "false", "sulla.reconciliation.version": "1" },
        protocolMappers: [{
          name: `audience-${audience}`,
          protocol: "openid-connect",
          protocolMapper: "oidc-audience-mapper",
          consentRequired: false,
          config: { "included.custom.audience": audience, "access.token.claim": "true", "id.token.claim": "false" },
        }],
      }), { mode: 0o600 });
    }
    const optionalClientScopes = audiences.map(audience => `sulla-audience-${audience}`);
    writeFileSync(process.argv[1], JSON.stringify({ realm: process.env.realm, enabled: true, registrationAllowed: false, resetPasswordAllowed: true }), { mode: 0o600 });
    writeFileSync(process.argv[2], JSON.stringify({
      clientId: process.env.native_client_id,
      name: "Sulla Desktop",
      protocol: "openid-connect",
      publicClient: true,
      standardFlowEnabled: true,
      directAccessGrantsEnabled: false,
      redirectUris: [process.env.native_redirect_uri],
      webOrigins: [],
      attributes: { "pkce.code.challenge.method": "S256", "sulla.reconciliation.version": "1" },
      optionalClientScopes,
    }), { mode: 0o600 });
    writeFileSync(process.argv[3], JSON.stringify({
      clientId: process.env.web_client_id,
      name: "Sulla Accounts Web",
      protocol: "openid-connect",
      publicClient: false,
      secret: process.env.web_client_secret,
      standardFlowEnabled: true,
      directAccessGrantsEnabled: false,
      redirectUris: process.env.SULLA_ACCOUNTS_KEYCLOAK_WEB_REDIRECT_URIS.split(",").map(value => value.trim()).filter(Boolean),
      webOrigins: [process.env.SULLA_ACCOUNTS_PUBLIC_URL],
      attributes: { "sulla.reconciliation.version": "1" },
      optionalClientScopes,
    }), { mode: 0o600 });
  ' "$realm_file" "$native_client_file" "$web_client_file"

  kcadm=/opt/keycloak/bin/kcadm.sh
  kcadm_config="${private_dir}/kcadm.config"
  run_unprivileged "$kcadm" config credentials --config "$kcadm_config" \
    --server http://127.0.0.1:8080/auth --realm master --user "$admin_username" --password "$admin_password" >/dev/null
  if ! run_unprivileged "$kcadm" get "realms/${realm}" --config "$kcadm_config" >/dev/null 2>&1; then
    run_unprivileged "$kcadm" create realms --config "$kcadm_config" -f "$realm_file" >/dev/null
  else
    run_unprivileged "$kcadm" update "realms/${realm}" --config "$kcadm_config" -f "$realm_file" >/dev/null
  fi

  old_ifs=$IFS
  IFS=,
  for audience in $service_audiences; do
    IFS=$old_ifs
    scope_name="sulla-audience-${audience}"
    scope_file="${private_dir}/scope-${audience}.json"
    scope_id="$(run_unprivileged "$kcadm" get client-scopes --config "$kcadm_config" -r "$realm" -q "name=${scope_name}" --fields id --format csv --noquotes | sed -n '1p')"
    if [ -n "$scope_id" ]; then
      run_unprivileged "$kcadm" update "client-scopes/${scope_id}" --config "$kcadm_config" -r "$realm" -f "$scope_file" >/dev/null
    else
      run_unprivileged "$kcadm" create client-scopes --config "$kcadm_config" -r "$realm" -f "$scope_file" >/dev/null
    fi
    IFS=,
  done
  IFS=$old_ifs

  for specification in "${native_client_id}:${native_client_file}" "${web_client_id}:${web_client_file}"; do
    client_id=${specification%%:*}
    client_file=${specification#*:}
    internal_id="$(run_unprivileged "$kcadm" get clients --config "$kcadm_config" -r "$realm" -q "clientId=${client_id}" --fields id --format csv --noquotes | sed -n '1p')"
    if [ -n "$internal_id" ]; then
      run_unprivileged "$kcadm" update "clients/${internal_id}" --config "$kcadm_config" -r "$realm" -f "$client_file" >/dev/null
    else
      run_unprivileged "$kcadm" create clients --config "$kcadm_config" -r "$realm" -f "$client_file" >/dev/null
    fi
  done
  unset realm native_client_id native_redirect_uri web_client_id web_client_secret service_audiences
}

if [ "$mode" = server ]; then
  require_value SULLA_ACCOUNTS_KEYCLOAK_ISSUER
  require_value SULLA_ACCOUNTS_PUBLIC_URL
  realm="${SULLA_ACCOUNTS_KEYCLOAK_REALM:-sulla}"
  case "$realm" in
    ''|*[!A-Za-z0-9._-]*) fail "SULLA_ACCOUNTS_KEYCLOAK_REALM is invalid" ;;
  esac
  public_url="${SULLA_ACCOUNTS_PUBLIC_URL%/}"
  expected_issuer="${public_url}/auth/realms/${realm}"
  [ "$SULLA_ACCOUNTS_KEYCLOAK_ISSUER" = "$expected_issuer" ] || fail "SULLA_ACCOUNTS_KEYCLOAK_ISSUER must equal ${expected_issuer}"

  keycloak_db_username_path="$(copy_secret SULLA_ACCOUNTS_KEYCLOAK_DATABASE_USERNAME_FILE keycloak-database.username)"
  keycloak_db_password_path="$(copy_secret SULLA_ACCOUNTS_KEYCLOAK_DATABASE_PASSWORD_FILE keycloak-database.password)"
  keycloak_admin_username_path="$(copy_secret SULLA_ACCOUNTS_KEYCLOAK_ADMIN_USERNAME_FILE keycloak-admin.username)"
  keycloak_admin_password_path="$(copy_secret SULLA_ACCOUNTS_KEYCLOAK_ADMIN_PASSWORD_FILE keycloak-admin.password)"
  web_client_secret_path="$(copy_secret SULLA_ACCOUNTS_KEYCLOAK_WEB_CLIENT_SECRET_FILE keycloak-web-client.secret)"
  keycloak_db_username="$(read_secret "$keycloak_db_username_path")"
  keycloak_db_password="$(read_secret "$keycloak_db_password_path")"
  keycloak_admin_username="$(read_secret "$keycloak_admin_username_path")"
  keycloak_admin_password="$(read_secret "$keycloak_admin_password_path")"
  web_client_secret="$(read_secret "$web_client_secret_path")"
  require_value SULLA_ACCOUNTS_KEYCLOAK_DATABASE_URL
  native_client_id="${SULLA_ACCOUNTS_KEYCLOAK_NATIVE_CLIENT_ID:-sulla-desktop}"
  native_redirect_uri="http://127.0.0.1:3020/v1/oidc/callback"
  case "$native_redirect_uri" in
    http://127.0.0.1:*/oidc/callback|http://\[::1\]:*/oidc/callback) ;;
    *) fail "SULLA_ACCOUNTS_KEYCLOAK_DESKTOP_REDIRECT_URI must be an exact loopback /oidc/callback URI" ;;
  esac
  web_client_id="${SULLA_ACCOUNTS_KEYCLOAK_WEB_CLIENT_ID:-sulla-web}"
  require_value SULLA_ACCOUNTS_KEYCLOAK_WEB_REDIRECT_URIS
  membership_audience="${SULLA_ACCOUNTS_KEYCLOAK_MEMBERSHIP_AUDIENCE:-sulla-membership}"
  resource_audiences="${SULLA_ACCOUNTS_KEYCLOAK_RESOURCE_AUDIENCES:-sulla-projects,sulla-files,sulla-vault,sulla-workflows}"
  service_audiences="${membership_audience},${resource_audiences}"

  export KC_DB=postgres
  export KC_DB_URL="$SULLA_ACCOUNTS_KEYCLOAK_DATABASE_URL"
  export KC_DB_USERNAME="$keycloak_db_username"
  export KC_DB_PASSWORD="$keycloak_db_password"
  export KC_HTTP_ENABLED=true KC_HTTP_PORT=8080 KC_HTTP_HOST=0.0.0.0
  export KC_HTTP_MANAGEMENT_HOST=127.0.0.1 KC_HTTP_MANAGEMENT_PORT=9000 KC_HTTP_MANAGEMENT_SCHEME=http
  export KC_HOSTNAME_STRICT=true KC_HOSTNAME="${public_url}/auth" KC_PROXY_HEADERS=xforwarded KC_HTTP_RELATIVE_PATH=/auth
  export KC_BOOTSTRAP_ADMIN_USERNAME="$keycloak_admin_username" KC_BOOTSTRAP_ADMIN_PASSWORD="$keycloak_admin_password"
  run_unprivileged /opt/keycloak/bin/kc.sh start --optimized &
  keycloak_pid=$!

  attempts=0
  until curl --fail --silent --show-error --max-time 2 http://127.0.0.1:9000/auth/health/ready >/dev/null 2>&1; do
    kill -0 "$keycloak_pid" 2>/dev/null || { wait "$keycloak_pid" || true; keycloak_pid=""; exit 1; }
    attempts=$((attempts + 1))
    [ "$attempts" -lt 60 ] || { echo "Keycloak did not become ready within 120 seconds" >&2; terminate 1; }
    sleep 2
  done
  reconcile_keycloak "$realm" "$keycloak_admin_username" "$keycloak_admin_password" \
    "$native_client_id" "$native_redirect_uri" "$web_client_id" "$web_client_secret" "$service_audiences"
  unset keycloak_db_username keycloak_db_password keycloak_admin_username keycloak_admin_password web_client_secret
  unset KC_DB_PASSWORD KC_BOOTSTRAP_ADMIN_USERNAME KC_BOOTSTRAP_ADMIN_PASSWORD
fi

run_unprivileged node dist/index.js &
accounts_pid=$!

while :; do
  if ! kill -0 "$accounts_pid" 2>/dev/null; then
    set +e; wait "$accounts_pid"; status=$?; set -e
    accounts_pid=""
    stop_children
    exit "$status"
  fi
  if [ -n "$keycloak_pid" ] && ! kill -0 "$keycloak_pid" 2>/dev/null; then
    set +e; wait "$keycloak_pid"; status=$?; set -e
    keycloak_pid=""
    stop_children
    exit "$status"
  fi
  sleep 1
done
