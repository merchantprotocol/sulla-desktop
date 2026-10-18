#!/bin/sh
set -eu
umask 077

base_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/preview-secrets"
mkdir -p "$base_dir/local" "$base_dir/authority-a" "$base_dir/authority-b" "$base_dir/tls"
printf '%s' sulla >"$base_dir/database.username"
openssl rand -hex 32 >"$base_dir/database.password"

write_authority_secrets() {
  name="$1"
  issuer="$2"
  directory="$base_dir/$name"
  openssl rand -hex 32 >"$directory/session.secret"
  openssl rand 32 >"$directory/encryption.key"
  openssl rand -hex 32 >"$directory/admin.secret"
  printf '%s' preview-admin >"$directory/keycloak-admin.username"
  openssl rand -hex 32 >"$directory/keycloak-admin.password"
  openssl rand -hex 32 >"$directory/web-client.secret"
  synthetic_password="$(openssl rand -hex 16)"
  printf '{"type":"password","temporary":false,"value":"%s"}' "$synthetic_password" >"$directory/synthetic-user-credential.json"
  service_token="$(openssl rand -hex 32)"
  printf '{"workflows":{"token":"%s","issuers":["%s"],"allowedAudiences":["sulla-workflows"],"pathPrefixes":["/v1/private/schedule-grants/"],"methods":["POST"]}}' \
    "$service_token" "$issuer" >"$directory/service-tokens.json"
}

openssl rand -hex 32 >"$base_dir/local/bootstrap.secret"
openssl rand -hex 32 >"$base_dir/local/session.secret"
openssl rand 32 >"$base_dir/local/encryption.key"
printf '{}' >"$base_dir/local/service-tokens.json"
write_authority_secrets authority-a https://authority-a.localhost:8787/auth/realms/sulla
write_authority_secrets authority-b https://authority-b.localhost:8787/auth/realms/sulla

openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 7 \
  -subj '/CN=Sulla Accounts synthetic preview' \
  -addext 'subjectAltName=DNS:accounts.localhost,DNS:authority-a.localhost,DNS:authority-b.localhost' \
  -keyout "$base_dir/tls/tls.key" -out "$base_dir/tls/tls.crt" >/dev/null 2>&1
cp "$base_dir/tls/tls.crt" "$base_dir/tls/ca.crt"
find "$base_dir" -type f -exec chmod 0600 {} \;
echo "Synthetic preview secrets and CA created under deploy/accounts/preview-secrets (never commit this directory)."
