#!/usr/bin/env bash
# ============================================================================
# Sulla Server — one-line installer (Ubuntu 24.04 LTS)
# ============================================================================
# First server (installs k3s + Sulla services):
#   curl -fsSL https://raw.githubusercontent.com/merchantprotocol/sulla-desktop/main/deploy/server/install.sh | sudo bash
#
# Each additional server (joins the cluster as a node):
#   curl -fsSL https://raw.githubusercontent.com/merchantprotocol/sulla-desktop/main/deploy/server/install.sh | sudo K3S_URL=https://FIRST_SERVER_IP:6443 K3S_TOKEN=<token> bash
#
# The first server prints the exact join line when it finishes.
# Options (env): SULLA_REF=<branch|tag|sha> (default main), SULLA_DIR (default /opt/sulla/server)
# ============================================================================
set -euo pipefail

# Everything runs inside main() so bash reads the whole script before any
# child process can consume the piped stdin.
main() {
  SULLA_REF="${SULLA_REF:-main}"
  SULLA_DIR="${SULLA_DIR:-/opt/sulla/server}"
  RAW="https://raw.githubusercontent.com/merchantprotocol/sulla-desktop/${SULLA_REF}/deploy/server"
  FILES=(
    install-server.sh join-node.sh deploy-sulla.sh
    k8s/kustomization.yaml k8s/namespace.yaml k8s/storage.yaml
    k8s/postgres.yaml k8s/redis.yaml k8s/runtimes.yaml
  )

  log()  { printf '\033[0;32m[sulla]\033[0m %s\n' "$*"; }
  fail() { printf '\033[0;31m[sulla]\033[0m %s\n' "$*" >&2; exit 1; }

  [[ ${EUID} -eq 0 ]] || fail "run as root: curl -fsSL <url> | sudo bash"
  command -v curl >/dev/null 2>&1 || fail "curl is required: apt-get install -y curl"

  log "Downloading the Sulla server kit (${SULLA_REF}) to ${SULLA_DIR}..."
  mkdir -p "${SULLA_DIR}/k8s"
  for f in "${FILES[@]}"; do
    curl -fsSL "${RAW}/${f}" -o "${SULLA_DIR}/${f}.tmp" || fail "download failed: ${f}"
    mv "${SULLA_DIR}/${f}.tmp" "${SULLA_DIR}/${f}"
  done
  chmod +x "${SULLA_DIR}"/*.sh
  cd "${SULLA_DIR}"

  if [[ -n "${K3S_URL:-}" || -n "${K3S_TOKEN:-}" ]]; then
    [[ -n "${K3S_URL:-}" && -n "${K3S_TOKEN:-}" ]] || fail "set both K3S_URL and K3S_TOKEN to join a cluster"
    log "Joining this server to ${K3S_URL}..."
    ./join-node.sh </dev/null
    log "Done. This server is now a node in the cluster."
    return 0
  fi

  log "Installing k3s on this server..."
  ./install-server.sh </dev/null
  log "Deploying Sulla services..."
  ./deploy-sulla.sh </dev/null

  ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i <= NF; i++) if ($i == "src") { print $(i + 1); exit }}')"
  token="$(cat /var/lib/rancher/k3s/server/node-token)"
  printf '\n'
  log "Sulla server is up. To add another server, run this on it (keep it private, it contains the join token):"
  printf '\n  curl -fsSL %s/install.sh | sudo K3S_URL=https://%s:6443 K3S_TOKEN=%s bash\n\n' "${RAW}" "${ip:-THIS_SERVER_IP}" "${token}"
}

main "$@"
