#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
K8S_DIR="$SCRIPT_DIR/k8s"
NAMESPACE="sulla"
SECRET_NAME="sulla-credentials"

fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

command -v kubectl >/dev/null 2>&1 || fail "kubectl is required (it is installed with k3s)"
command -v openssl >/dev/null 2>&1 || fail "openssl is required; run: apt-get install -y openssl"

if [[ -z ${KUBECONFIG:-} && -r /etc/rancher/k3s/k3s.yaml ]]; then
  export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
fi

kubectl cluster-info >/dev/null 2>&1 || fail "kubectl cannot reach the cluster; run with sudo on the k3s server"
kubectl apply -f "$K8S_DIR/namespace.yaml"

if kubectl --namespace "$NAMESPACE" get secret "$SECRET_NAME" >/dev/null 2>&1; then
  printf 'Keeping existing %s/%s secret.\n' "$NAMESPACE" "$SECRET_NAME"
else
  postgres_password="$(openssl rand -hex 32)"
  kubectl --namespace "$NAMESPACE" create secret generic "$SECRET_NAME" \
    --from-literal=postgres-username=sulla \
    --from-literal=postgres-password="$postgres_password" \
    --from-literal=postgres-database=sulla >/dev/null
  unset postgres_password
  printf 'Created %s/%s with a random PostgreSQL password.\n' "$NAMESPACE" "$SECRET_NAME"
fi

kubectl apply -k "$K8S_DIR"
kubectl --namespace "$NAMESPACE" rollout status deployment --all --timeout=5m

printf '\nSulla services are ready:\n'
kubectl --namespace "$NAMESPACE" get pods,pvc,services -o wide
