#!/bin/sh
set -eu

compose_file="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/compose.preview.yaml"
docker_bin="${DOCKER_BIN:-/usr/bin/docker}"
docker_host="${DOCKER_HOST:-unix:///var/run/docker.sock}"
project="${SULLA_ACCOUNTS_PREVIEW_PROJECT:-sulla-accounts-preview}"

provision_authority() {
  service="$1"
  subject="$2"
  organization_id="$3"
  membership_id="$4"
  credential_file="$5"
  "$docker_bin" -H "$docker_host" compose -p "$project" -f "$compose_file" exec -T "$service" sh -eu -c '
    config=/run/sulla-accounts-private/kcadm.config
    /opt/keycloak/bin/kcadm.sh create users --config "$config" -r sulla \
      -s username="$1" -s enabled=true >/dev/null 2>&1 || true
    subject=$(/opt/keycloak/bin/kcadm.sh get users --config "$config" -r sulla -q username="$1" --fields id --format csv --noquotes | sed -n "1p")
    test -n "$subject"
    /opt/keycloak/bin/kcadm.sh update "users/${subject}/reset-password" --config "$config" -r sulla -f "$4" >/dev/null
    admin_secret=$(cat /run/sulla-accounts-private/admin.secret)
    curl --fail --silent --show-error -X PUT \
      -H "Authorization: Bearer ${admin_secret}" -H "Content-Type: application/json" \
      --data "{\"issuer\":\"${SULLA_ACCOUNTS_KEYCLOAK_ISSUER}\",\"subject\":\"${subject}\",\"organizationId\":\"$2\",\"roles\":[\"member\"],\"groups\":[\"synthetic-preview\"]}" \
      "http://127.0.0.1:3020/v1/admin/memberships/$3" >/dev/null
  ' synthetic "$subject" "$organization_id" "$membership_id" "$credential_file"
}

provision_authority accounts-authority-a synthetic-user-a 11111111-1111-4111-8111-111111111111 aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa /run/secrets/authority_a_synthetic_user_credential
provision_authority accounts-authority-b synthetic-user-b 22222222-2222-4222-8222-222222222222 bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb /run/secrets/authority_b_synthetic_user_credential
echo "Provisioned isolated synthetic users and memberships in both preview authorities."
