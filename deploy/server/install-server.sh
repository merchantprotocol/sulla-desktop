#!/usr/bin/env bash
set -euo pipefail

readonly DEFAULT_K3S_VERSION="v1.36.4+k3s1"
INSTALL_K3S_VERSION="${INSTALL_K3S_VERSION:-$DEFAULT_K3S_VERSION}"
SERVER_IP="${1:-${K3S_SERVER_IP:-}}"

fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

[[ ${EUID} -eq 0 ]] || fail "run this script as root (sudo $0 [server-ip])"
[[ -r /etc/os-release ]] || fail "cannot identify this operating system"

# shellcheck disable=SC1091
. /etc/os-release
[[ ${ID:-} == "ubuntu" ]] || fail "this kit supports Ubuntu only (found ${ID:-unknown})"
[[ ${VERSION_ID:-} == "24.04" ]] || fail "Ubuntu 24.04 LTS is required (found ${VERSION_ID:-unknown})"
command -v curl >/dev/null 2>&1 || fail "curl is required; run: apt-get update && apt-get install -y curl"
command -v systemctl >/dev/null 2>&1 || fail "systemd is required"

if [[ -z "$SERVER_IP" ]]; then
  SERVER_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{ for (i = 1; i <= NF; i++) if ($i == "src") { print $(i + 1); exit } }')"
fi
[[ -n "$SERVER_IP" ]] || fail "could not detect the server IP; pass it as the first argument or set K3S_SERVER_IP"

if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
  printf 'Warning: UFW is active. Confirm the cluster ports in README.md are allowed before joining nodes.\n' >&2
fi

current_version=""
if command -v k3s >/dev/null 2>&1; then
  current_version="$(k3s --version 2>/dev/null | awk 'NR == 1 { print $3 }')"
fi

if [[ "$current_version" == "$INSTALL_K3S_VERSION" ]] && systemctl is-active --quiet k3s; then
  printf 'k3s %s is already installed and running.\n' "$INSTALL_K3S_VERSION"
else
  printf 'Installing k3s %s on %s...\n' "$INSTALL_K3S_VERSION" "$SERVER_IP"
  export INSTALL_K3S_VERSION
  curl -sfL https://get.k3s.io | sh -s - server \
    --write-kubeconfig-mode 0640 \
    --tls-san "$SERVER_IP"
fi

systemctl enable --now k3s >/dev/null

printf '\nServer ready. Next steps:\n'
printf '  1. Verify it: sudo kubectl get nodes -o wide\n'
printf '  2. Read the join token (keep it secret): sudo cat /var/lib/rancher/k3s/server/node-token\n'
printf '  3. On each additional server, run join-node.sh with https://%s:6443 and that token.\n' "$SERVER_IP"
printf '  4. Deploy Sulla from this directory: sudo ./deploy-sulla.sh\n'
