#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
K8S_DIR="$SCRIPT_DIR/k8s"
NAMESPACE="sulla"
SECRET_NAME="sulla-server"

fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

command -v kubectl >/dev/null 2>&1 || fail "kubectl is required (it is installed with k3s)"
command -v openssl >/dev/null 2>&1 || fail "openssl is required; run: apt-get install -y openssl"
ENV_FILE="$SCRIPT_DIR/server.env"
[[ -r "$ENV_FILE" ]] || fail "missing $ENV_FILE; run install.sh first"
# shellcheck disable=SC1090
. "$ENV_FILE"
: "${SULLA_POSTGRES_PASSWORD:?missing PostgreSQL password}"
: "${SULLA_VAULT_JWT_SECRET:?missing JWT secret}"
: "${SULLA_VAULT_SERVER_BOOTSTRAP_TOKEN:?missing bootstrap token}"
: "${SULLA_FILES_CAPABILITY_SIGNING_KEY:?missing Files capability signing key}"
: "${SULLA_PROJECTS_DATABASE_PASSWORD:?missing Projects database password}"
: "${SULLA_PROJECTS_JWT_SECRET:?missing Projects JWT secret}"
: "${SULLA_PROJECTS_JWT_ISSUER:?missing Projects JWT issuer}"
: "${SULLA_PROJECTS_JWT_AUDIENCE:?missing Projects JWT audience}"
: "${SULLA_ACCOUNTS_KEYCLOAK_AUTHORITY_ID:?missing Accounts Keycloak authority id}"
: "${SULLA_ACCOUNTS_WEB_REDIRECT_URIS:?missing Accounts web redirect URIs}"
: "${SULLA_ACCOUNTS_IMAGE:?missing pinned Accounts image}"
: "${SULLA_AGENTS_IMAGE:?missing pinned Agents image}"
: "${SULLA_WORKFLOWS_IMAGE:?missing pinned Workflows image}"
: "${SULLA_TOOLS_IMAGE:?missing pinned Tools image}"
: "${SULLA_AGENT_API_TOKEN:?missing Agents API token}"
: "${SULLA_ACCOUNTS_SESSION_SECRET_FILE:?missing Accounts session secret file}"
: "${SULLA_ACCOUNTS_ENCRYPTION_KEY_FILE:?missing Accounts encryption key file}"
: "${SULLA_ACCOUNTS_ADMIN_SECRET_FILE:?missing Accounts admin secret file}"
: "${SULLA_ACCOUNTS_SERVICE_TOKENS_FILE:?missing Accounts service token file}"
: "${SULLA_ACCOUNTS_VAULT_TOKEN_FILE:?missing Vault Accounts token file}"
: "${SULLA_ACCOUNTS_FILES_TOKEN_FILE:?missing Files Accounts token file}"
: "${SULLA_ACCOUNTS_PROJECTS_TOKEN_FILE:?missing Projects Accounts token file}"
: "${SULLA_ACCOUNTS_AGENTS_TOKEN_FILE:?missing Agents Accounts token file}"
: "${SULLA_ACCOUNTS_WORKFLOWS_TOKEN_FILE:?missing Workflows Accounts token file}"
: "${SULLA_ACCOUNTS_KEYCLOAK_ADMIN_USERNAME_FILE:?missing Keycloak admin username file}"
: "${SULLA_ACCOUNTS_KEYCLOAK_ADMIN_PASSWORD_FILE:?missing Keycloak admin password file}"
: "${SULLA_ACCOUNTS_KEYCLOAK_WEB_CLIENT_SECRET_FILE:?missing Keycloak web client secret file}"
: "${SULLA_FILES_MASTER_KEY:?missing persistent Files master; run install.sh or restore secure configuration}"
[[ "$SULLA_FILES_MASTER_KEY" =~ ^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$ ]] || fail "invalid Files master encoding"
: "${SULLA_VAULT_IMAGE:?missing pinned vault image}"
: "${SULLA_FILES_IMAGE:?missing pinned Files image}"
: "${SULLA_PROJECTS_IMAGE:?missing pinned Projects image}"
: "${SULLA_CONSOLE_IMAGE:?missing pinned Console image}"
: "${SULLA_STORAGE_CLASS:?missing storage class}"
: "${SULLA_STORAGE_SIZE:?missing storage size}"
: "${SULLA_FILES_STORAGE_SIZE:?missing Files storage size}"
: "${SULLA_KUBECONTEXT:?missing Kubernetes context}"
if [[ ${SULLA_INGRESS_MODE:-create} == create ]]; then : "${SULLA_HOSTNAME:?missing ingress hostname}"; fi

KUBECTL=(kubectl)
[[ -z ${SULLA_KUBECONFIG:-} ]] || KUBECTL+=(--kubeconfig "$SULLA_KUBECONFIG")
KUBECTL+=(--context "$SULLA_KUBECONTEXT")

"${KUBECTL[@]}" cluster-info >/dev/null 2>&1 || fail "kubectl cannot reach the saved cluster context"
if "${KUBECTL[@]}" get namespace "$NAMESPACE" >/dev/null 2>&1; then
  managed_by="$("${KUBECTL[@]}" get namespace "$NAMESPACE" -o jsonpath='{.metadata.labels.app\.kubernetes\.io/managed-by}')"
  [[ "$managed_by" == sulla-server-installer ]] || fail "namespace $NAMESPACE already exists and is not owned by this installer; refusing to overwrite it"
else
  "${KUBECTL[@]}" apply -f "$K8S_DIR/namespace.yaml"
fi

  for owned_resource in "secret/$SECRET_NAME" pvc/postgres-data pvc/files-data configmap/sulla-gateway; do
  if "${KUBECTL[@]}" --namespace "$NAMESPACE" get "$owned_resource" >/dev/null 2>&1; then
    managed_by="$("${KUBECTL[@]}" --namespace "$NAMESPACE" get "$owned_resource" -o jsonpath='{.metadata.labels.app\.kubernetes\.io/managed-by}')"
    [[ "$managed_by" == sulla-server-installer ]] || fail "$NAMESPACE/$owned_resource already exists and is not owned by this installer; refusing to overwrite it"
  fi
done

"${KUBECTL[@]}" --namespace "$NAMESPACE" create secret generic "$SECRET_NAME" \
  --from-literal=postgres-username=sulla --from-literal=postgres-password="$SULLA_POSTGRES_PASSWORD" \
  --from-literal=postgres-database=sulla \
  --from-literal=database-url="postgresql://sulla:${SULLA_POSTGRES_PASSWORD}@postgres:5432/sulla" \
  --from-literal=files-database-url="postgresql://sulla:${SULLA_POSTGRES_PASSWORD}@postgres:5432/sulla_files" \
  --from-literal=postgres-admin-database-url="postgresql://sulla:${SULLA_POSTGRES_PASSWORD}@postgres:5432/postgres" \
  --from-literal=projects-migration-database-url="postgresql://sulla:${SULLA_POSTGRES_PASSWORD}@postgres:5432/sulla_projects" \
  --from-literal=projects-database-url="postgresql://sulla_projects_service:${SULLA_PROJECTS_DATABASE_PASSWORD}@postgres:5432/sulla_projects" \
  --from-literal=projects-database-password="$SULLA_PROJECTS_DATABASE_PASSWORD" \
  --from-literal=projects-jwt-secret="$SULLA_PROJECTS_JWT_SECRET" \
  --from-literal=projects-jwt-issuer="$SULLA_PROJECTS_JWT_ISSUER" \
  --from-literal=projects-jwt-audience="$SULLA_PROJECTS_JWT_AUDIENCE" \
  --from-literal=jwt-secret="$SULLA_VAULT_JWT_SECRET" \
  --from-literal=files-capability-signing-key="$SULLA_FILES_CAPABILITY_SIGNING_KEY" \
  --from-literal=files-master-key="$SULLA_FILES_MASTER_KEY" \
  --from-literal=bootstrap-token="$SULLA_VAULT_SERVER_BOOTSTRAP_TOKEN" \
  --from-literal=accounts-session="$(cat "$SULLA_ACCOUNTS_SESSION_SECRET_FILE")" \
  --from-literal=accounts-encryption="$(cat "$SULLA_ACCOUNTS_ENCRYPTION_KEY_FILE")" \
  --from-literal=accounts-admin="$(cat "$SULLA_ACCOUNTS_ADMIN_SECRET_FILE")" \
  --from-literal=accounts-service-tokens="$(cat "$SULLA_ACCOUNTS_SERVICE_TOKENS_FILE")" \
  --from-literal=accounts-vault-token="$(cat "$SULLA_ACCOUNTS_VAULT_TOKEN_FILE")" \
  --from-literal=accounts-files-token="$(cat "$SULLA_ACCOUNTS_FILES_TOKEN_FILE")" \
  --from-literal=accounts-projects-token="$(cat "$SULLA_ACCOUNTS_PROJECTS_TOKEN_FILE")" \
  --from-literal=accounts-agents-token="$(cat "$SULLA_ACCOUNTS_AGENTS_TOKEN_FILE")" \
  --from-literal=accounts-workflows-token="$(cat "$SULLA_ACCOUNTS_WORKFLOWS_TOKEN_FILE")" \
  --from-literal=keycloak-admin-username="$(cat "$SULLA_ACCOUNTS_KEYCLOAK_ADMIN_USERNAME_FILE")" \
  --from-literal=keycloak-admin-password="$(cat "$SULLA_ACCOUNTS_KEYCLOAK_ADMIN_PASSWORD_FILE")" \
  --from-literal=keycloak-web-client-secret="$(cat "$SULLA_ACCOUNTS_KEYCLOAK_WEB_CLIENT_SECRET_FILE")" \
  --from-literal=agents-database-url="postgresql://sulla:${SULLA_POSTGRES_PASSWORD}@postgres:5432/sulla_agents" \
  --from-literal=workflows-database-url="postgresql://sulla:${SULLA_POSTGRES_PASSWORD}@postgres:5432/sulla_workflows" \
  --from-literal=tools-database-url="postgresql://sulla:${SULLA_POSTGRES_PASSWORD}@postgres:5432/sulla_tools" \
  --from-literal=agent-api-token="$SULLA_AGENT_API_TOKEN" \
  --from-literal=workflows-runner-image="${SULLA_WORKFLOW_RUNNER_IMAGE:-ghcr.io/merchantprotocol/sulla-workflows:sha-${SULLA_SOURCE_SHA:0:12}}" \
  --dry-run=client -o yaml | \
  sed '/^metadata:$/a\  labels:\n    app.kubernetes.io/managed-by: sulla-server-installer' | \
  "${KUBECTL[@]}" apply -f - >/dev/null

"${KUBECTL[@]}" --namespace "$NAMESPACE" create configmap sulla-gateway \
  --from-file=nginx.conf="$SCRIPT_DIR/gateway/nginx.kubernetes.conf.template" \
  --dry-run=client -o yaml | \
  sed '/^metadata:$/a\  labels:\n    app.kubernetes.io/managed-by: sulla-server-installer' | \
  "${KUBECTL[@]}" apply -f - >/dev/null

rendered="$(mktemp)"; rendered_files="$(mktemp)"; rendered_projects="$(mktemp)"; rendered_console="$(mktemp)"; rendered_storage="$(mktemp)"; trap 'rm -f "$rendered" "$rendered_files" "$rendered_projects" "$rendered_console" "$rendered_storage"' EXIT
sed "s|__SULLA_VAULT_IMAGE__|${SULLA_VAULT_IMAGE}|g" "$K8S_DIR/sulla-vault.yaml" >"$rendered"
sed "s|__SULLA_FILES_IMAGE__|${SULLA_FILES_IMAGE}|g" "$K8S_DIR/sulla-files.yaml" >"$rendered_files"
sed "s|__SULLA_PROJECTS_IMAGE__|${SULLA_PROJECTS_IMAGE}|g" "$K8S_DIR/sulla-projects.yaml" >"$rendered_projects"
rendered_accounts="$(mktemp)"; rendered_agents="$(mktemp)"; rendered_workflows="$(mktemp)"; rendered_tools="$(mktemp)"
trap 'rm -f "$rendered" "$rendered_files" "$rendered_projects" "$rendered_console" "$rendered_storage" "$rendered_accounts" "$rendered_agents" "$rendered_workflows" "$rendered_tools"' EXIT
sed -e "s|__SULLA_ACCOUNTS_IMAGE__|${SULLA_ACCOUNTS_IMAGE}|g" -e "s|__SULLA_ACCOUNTS_AUTHORITY_ID__|${SULLA_ACCOUNTS_KEYCLOAK_AUTHORITY_ID}|g" -e "s|__SULLA_PUBLIC_URL__|${SULLA_PUBLIC_URL}|g" -e "s|__SULLA_ACCOUNTS_REDIRECT_URIS__|${SULLA_ACCOUNTS_WEB_REDIRECT_URIS}|g" "$K8S_DIR/sulla-accounts.yaml" >"$rendered_accounts"
sed "s|__SULLA_AGENTS_IMAGE__|${SULLA_AGENTS_IMAGE}|g" "$K8S_DIR/sulla-agents.yaml" >"$rendered_agents"
sed "s|__SULLA_WORKFLOWS_IMAGE__|${SULLA_WORKFLOWS_IMAGE}|g" "$K8S_DIR/sulla-workflows.yaml" >"$rendered_workflows"
sed "s|__SULLA_TOOLS_IMAGE__|${SULLA_TOOLS_IMAGE}|g" "$K8S_DIR/sulla-tools.yaml" >"$rendered_tools"
sed "s|__SULLA_CONSOLE_IMAGE__|${SULLA_CONSOLE_IMAGE}|g" "$K8S_DIR/sulla-console.yaml" >"$rendered_console"
sed -e "s|__SULLA_STORAGE_CLASS__|${SULLA_STORAGE_CLASS}|g" -e "s|__SULLA_STORAGE_SIZE__|${SULLA_STORAGE_SIZE}|g" -e "s|__SULLA_FILES_STORAGE_SIZE__|${SULLA_FILES_STORAGE_SIZE}|g" "$K8S_DIR/storage.yaml" >"$rendered_storage"
"${KUBECTL[@]}" --namespace "$NAMESPACE" apply -f "$rendered_storage"
"${KUBECTL[@]}" --namespace "$NAMESPACE" apply -f "$K8S_DIR/postgres.yaml"
"${KUBECTL[@]}" --namespace "$NAMESPACE" delete job sulla-db-init --ignore-not-found >/dev/null 2>&1 || true
"${KUBECTL[@]}" --namespace "$NAMESPACE" apply -f "$K8S_DIR/db-init.yaml"
"${KUBECTL[@]}" --namespace "$NAMESPACE" wait --for=condition=complete job/sulla-db-init --timeout=5m
"${KUBECTL[@]}" --namespace "$NAMESPACE" apply -f "$rendered"
"${KUBECTL[@]}" --namespace "$NAMESPACE" apply -f "$rendered_files"
"${KUBECTL[@]}" --namespace "$NAMESPACE" apply -f "$rendered_projects"
"${KUBECTL[@]}" --namespace "$NAMESPACE" apply -f "$rendered_accounts"
"${KUBECTL[@]}" --namespace "$NAMESPACE" apply -f "$rendered_agents"
"${KUBECTL[@]}" --namespace "$NAMESPACE" apply -f "$rendered_workflows"
"${KUBECTL[@]}" --namespace "$NAMESPACE" apply -f "$rendered_tools"
"${KUBECTL[@]}" --namespace "$NAMESPACE" apply -f "$rendered_console"
"${KUBECTL[@]}" --namespace "$NAMESPACE" apply -f "$K8S_DIR/sulla-gateway.yaml"
if [[ ${SULLA_INGRESS_MODE:-create} == create ]]; then
  ingress="$(mktemp)"
  cat >"$ingress" <<EOF
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata: {name: sulla-vault, namespace: sulla}
spec:
EOF
  if [[ -n ${SULLA_TLS_SECRET:-} ]]; then cat >>"$ingress" <<EOF
  tls:
    - hosts: [${SULLA_HOSTNAME}]
      secretName: ${SULLA_TLS_SECRET}
EOF
  fi
  cat >>"$ingress" <<EOF
  rules:
    - host: ${SULLA_HOSTNAME}
      http: {paths: [{path: /, pathType: Prefix, backend: {service: {name: sulla-gateway, port: {name: http}}}}]}
EOF
  "${KUBECTL[@]}" --namespace "$NAMESPACE" apply -f "$ingress"; rm -f "$ingress"
fi
"${KUBECTL[@]}" --namespace "$NAMESPACE" rollout status deployment/postgres --timeout=5m
"${KUBECTL[@]}" --namespace "$NAMESPACE" rollout status deployment/sulla-vault --timeout=5m
"${KUBECTL[@]}" --namespace "$NAMESPACE" rollout status deployment/sulla-files --timeout=5m
"${KUBECTL[@]}" --namespace "$NAMESPACE" rollout status deployment/sulla-projects --timeout=5m
"${KUBECTL[@]}" --namespace "$NAMESPACE" rollout status deployment/sulla-accounts --timeout=5m
"${KUBECTL[@]}" --namespace "$NAMESPACE" rollout status deployment/sulla-agents --timeout=5m
"${KUBECTL[@]}" --namespace "$NAMESPACE" rollout status deployment/sulla-workflows --timeout=5m
"${KUBECTL[@]}" --namespace "$NAMESPACE" rollout status deployment/sulla-tools --timeout=5m
"${KUBECTL[@]}" --namespace "$NAMESPACE" rollout status deployment/sulla-console --timeout=5m
"${KUBECTL[@]}" --namespace "$NAMESPACE" rollout status deployment/sulla-gateway --timeout=5m

printf '\nSulla services are ready:\n'
"${KUBECTL[@]}" --namespace "$NAMESPACE" get pods,pvc,services -o wide
