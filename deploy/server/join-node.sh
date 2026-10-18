#!/usr/bin/env bash
set -euo pipefail
set +x

readonly DEFAULT_K3S_VERSION="v1.36.4+k3s1"
INSTALL_K3S_VERSION="${INSTALL_K3S_VERSION:-$DEFAULT_K3S_VERSION}"
SERVER_URL="${1:-${K3S_URL:-}}"
NODE_TOKEN="${2:-${K3S_TOKEN:-}}"

fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

[[ ${EUID} -eq 0 ]] || fail "run this script as root (sudo $0 <server-url> <token>)"
[[ -r /etc/os-release ]] || fail "cannot identify this operating system"

# shellcheck disable=SC1091
. /etc/os-release
[[ ${ID:-} == "ubuntu" ]] || fail "this kit supports Ubuntu only (found ${ID:-unknown})"
[[ ${VERSION_ID:-} == "24.04" ]] || fail "Ubuntu 24.04 LTS is required (found ${VERSION_ID:-unknown})"
command -v curl >/dev/null 2>&1 || fail "curl is required; run: apt-get update && apt-get install -y curl"
command -v systemctl >/dev/null 2>&1 || fail "systemd is required"

[[ -n "$SERVER_URL" ]] || fail "server URL is required as argument 1 or K3S_URL"
[[ "$SERVER_URL" == https://*:6443 ]] || fail "server URL must look like https://192.168.1.10:6443"
if [[ -z "$NODE_TOKEN" ]]; then
  exec 3<>/dev/tty || fail "node token is required through a terminal or K3S_TOKEN"
  printf 'Node token: ' >&3; stty -echo <&3; IFS= read -r NODE_TOKEN <&3; stty echo <&3; printf '\n' >&3
fi
[[ -n "$NODE_TOKEN" ]] || fail "node token is required"

if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
  printf 'Warning: UFW is active. Confirm the cluster ports in README.md are allowed.\n' >&2
fi

printf 'Installing k3s agent %s and joining %s...\n' "$INSTALL_K3S_VERSION" "$SERVER_URL"
export INSTALL_K3S_VERSION
K3S_URL="$SERVER_URL" K3S_TOKEN="$NODE_TOKEN" curl -sfL https://get.k3s.io | \
  K3S_URL="$SERVER_URL" K3S_TOKEN="$NODE_TOKEN" sh -

unset NODE_TOKEN K3S_TOKEN
systemctl enable --now k3s-agent >/dev/null

printf '\nNode joined. On the first server, verify it with:\n'
printf '  sudo kubectl get nodes -o wide\n'
