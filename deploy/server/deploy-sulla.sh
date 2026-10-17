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
: "${SULLA_VAULT_IMAGE:?missing pinned vault image}"
: "${SULLA_STORAGE_CLASS:?missing storage class}"
: "${SULLA_STORAGE_SIZE:?missing storage size}"
if [[ ${SULLA_INGRESS_MODE:-create} == create ]]; then : "${SULLA_HOSTNAME:?missing ingress hostname}"; fi

if [[ -z ${KUBECONFIG:-} && -r /etc/rancher/k3s/k3s.yaml ]]; then
  export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
fi

kubectl cluster-info >/dev/null 2>&1 || fail "kubectl cannot reach the cluster; run with sudo on the k3s server"
kubectl apply -f "$K8S_DIR/namespace.yaml"

kubectl --namespace "$NAMESPACE" create secret generic "$SECRET_NAME" \
  --from-literal=postgres-username=sulla --from-literal=postgres-password="$SULLA_POSTGRES_PASSWORD" \
  --from-literal=postgres-database=sulla \
  --from-literal=database-url="postgresql://sulla:${SULLA_POSTGRES_PASSWORD}@postgres:5432/sulla" \
  --from-literal=jwt-secret="$SULLA_VAULT_JWT_SECRET" \
  --from-literal=bootstrap-token="$SULLA_VAULT_SERVER_BOOTSTRAP_TOKEN" \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null

rendered="$(mktemp)"; rendered_storage="$(mktemp)"; trap 'rm -f "$rendered" "$rendered_storage"' EXIT
sed "s|__SULLA_VAULT_IMAGE__|${SULLA_VAULT_IMAGE}|g" "$K8S_DIR/sulla-vault.yaml" >"$rendered"
sed -e "s|__SULLA_STORAGE_CLASS__|${SULLA_STORAGE_CLASS}|g" -e "s|__SULLA_STORAGE_SIZE__|${SULLA_STORAGE_SIZE}|g" "$K8S_DIR/storage.yaml" >"$rendered_storage"
kubectl apply -f "$rendered_storage"
kubectl apply -f "$K8S_DIR/postgres.yaml"
kubectl apply -f "$rendered"
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
      http: {paths: [{path: /, pathType: Prefix, backend: {service: {name: sulla-vault, port: {name: http}}}}]}
EOF
  kubectl apply -f "$ingress"; rm -f "$ingress"
fi
kubectl --namespace "$NAMESPACE" rollout status deployment --all --timeout=5m

printf '\nSulla services are ready:\n'
kubectl --namespace "$NAMESPACE" get pods,pvc,services -o wide
