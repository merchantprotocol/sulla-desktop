// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Enforced egress scanning for agent containers on the Sulla runtime guest.
 *
 * Packet path (enforce on):
 *
 *   agent container (network `sulla-agents`, bridge `br-sulla-agents`)
 *     └─ TCP 80/443 to a public address
 *          nat PREROUTING ─▶ SULLA-EGRESS-NAT ─▶ REDIRECT :8890
 *          filter INPUT  ─▶ SULLA-PROXY-IN (only redirected flows reach the port)
 *          mitmdump (container `sulla_threat_proxy`, host network, transparent mode)
 *            └─ URL filter / prompt-injection scan, then its own upstream connection
 *               from the guest network namespace (OUTPUT chain: never redirected, no loop)
 *     └─ anything else forwarded off the bridge
 *          filter FORWARD ─▶ DOCKER-USER ─▶ SULLA-EGRESS-FWD
 *            private destinations, DNS: allowed
 *            TCP 80/443 that escaped the redirect: reset (fail closed)
 *            all other UDP (QUIC included): rejected
 *            other TCP ports: allowed (not scanned)
 *
 * If the proxy is down, the redirected connection is refused by the guest
 * kernel: agent web traffic fails closed instead of going direct.
 *
 * Everything here is pure (strings and argv); callers run it in the guest.
 */

export const AGENT_NETWORK = 'sulla-agents';
/** Fixed Linux bridge name so the rules never depend on a Docker network ID. Max 15 characters. */
export const AGENT_BRIDGE = 'br-sulla-agents';
/** Transparent listener of the threat proxy in the guest network namespace. */
export const THREAT_PROXY_PORT = 8890;
/** UID/GID of the proxy process in services/sulla-threat-proxy/Dockerfile. */
export const THREAT_PROXY_UID = 10010;
export const THREAT_PROXY_CONTAINER = 'sulla_threat_proxy';
/** Proxy state on the data disk: CA (private), verdict cache, config, blocklist, public CA. */
export const THREAT_PROXY_STATE_DIR = '/mnt/data/var/lib/sulla/threat-proxy';
export const THREAT_PROXY_CONTAINER_STATE_DIR = '/var/lib/sulla-threat-proxy';
export const THREAT_PROXY_CONFIG_PATH = `${ THREAT_PROXY_STATE_DIR }/config/proxy.json`;
export const THREAT_PROXY_BLOCKLIST_PATH = `${ THREAT_PROXY_STATE_DIR }/blocklist/urlhaus.txt`;
/** Public CA material only; the private key stays in `mitm/`. */
export const THREAT_PROXY_PUBLIC_DIR = `${ THREAT_PROXY_STATE_DIR }/public`;
export const AGENT_CA_MOUNT = '/run/sulla-threat-proxy-ca';

/** Destinations that are never redirected (Sulla services, the Mac, the guest). */
export const UNSCANNED_DESTINATIONS = [
  '10.0.0.0/8', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.168.0.0/16',
] as const;

export const EGRESS_CHAINS = {
  nat:    'SULLA-EGRESS-NAT',
  filter: 'SULLA-EGRESS-FWD',
  input:  'SULLA-PROXY-IN',
} as const;

/** Rules for `iptables-restore --noflush`: declaring a chain flushes it, and each table commits atomically. */
export function renderEgressRestore(bridge = AGENT_BRIDGE, port = THREAT_PROXY_PORT): string {
  const { nat, filter, input } = EGRESS_CHAINS;
  const unscanned = (chain: string) => UNSCANNED_DESTINATIONS.map(cidr => `-A ${ chain } -d ${ cidr } -j RETURN`);

  return [
    '*nat',
    `:${ nat } - [0:0]`,
    ...unscanned(nat),
    `-A ${ nat } -p tcp -m multiport --dports 80,443 -j REDIRECT --to-ports ${ port }`,
    'COMMIT',
    '*filter',
    `:${ filter } - [0:0]`,
    `:${ input } - [0:0]`,
    ...unscanned(filter),
    `-A ${ filter } -p udp --dport 53 -j RETURN`,
    `-A ${ filter } -p tcp --dport 53 -j RETURN`,
    `-A ${ filter } -p tcp -m multiport --dports 80,443 -j REJECT --reject-with tcp-reset`,
    `-A ${ filter } -p udp -j REJECT --reject-with icmp-port-unreachable`,
    `-A ${ input } -i lo -j RETURN`,
    `-A ${ input } -i ${ bridge } -m conntrack --ctstate DNAT -j RETURN`,
    `-A ${ input } -p tcp -j REJECT --reject-with tcp-reset`,
    'COMMIT',
    '',
  ].join('\n');
}

/**
 * Idempotent guest script. `$1` is the iptables-restore input. With enforce on
 * it (re)loads the chains and makes sure each jump exists exactly once; with
 * enforce off it removes jumps and chains. Safe to run on every boot, after a
 * Docker restart and before every agent launch.
 */
export function egressPolicyScript(enforce: boolean, bridge = AGENT_BRIDGE, port = THREAT_PROXY_PORT): string {
  const { nat, filter, input } = EGRESS_CHAINS;

  if (!enforce) {
    return `set -eu
while iptables -t nat -D PREROUTING -i ${ bridge } -j ${ nat } 2>/dev/null; do :; done
for fwd in DOCKER-USER FORWARD; do
  while iptables -t filter -D "$fwd" -i ${ bridge } -j ${ filter } 2>/dev/null; do :; done
  while ip6tables -t filter -D "$fwd" -i ${ bridge } ! -o ${ bridge } -j REJECT 2>/dev/null; do :; done
done
while iptables -t filter -D INPUT -p tcp --dport ${ port } -j ${ input } 2>/dev/null; do :; done
iptables -t nat -F ${ nat } 2>/dev/null || true
iptables -t nat -X ${ nat } 2>/dev/null || true
for chain in ${ filter } ${ input }; do
  iptables -t filter -F "$chain" 2>/dev/null || true
  iptables -t filter -X "$chain" 2>/dev/null || true
done
`;
  }

  return `set -eu
# Docker evaluates DOCKER-USER first in FORWARD; use FORWARD itself only before Docker created it.
if iptables -t filter -n -L DOCKER-USER >/dev/null 2>&1; then fwd=DOCKER-USER; else fwd=FORWARD; fi
printf '%s' "$1" | iptables-restore --noflush
iptables -t nat -C PREROUTING -i ${ bridge } -j ${ nat } 2>/dev/null ||
  iptables -t nat -I PREROUTING 1 -i ${ bridge } -j ${ nat }
iptables -t filter -C "$fwd" -i ${ bridge } -j ${ filter } 2>/dev/null ||
  iptables -t filter -I "$fwd" 1 -i ${ bridge } -j ${ filter }
iptables -t filter -C INPUT -p tcp --dport ${ port } -j ${ input } 2>/dev/null ||
  iptables -t filter -I INPUT 1 -p tcp --dport ${ port } -j ${ input }
# No IPv6 egress from agents: nothing would scan it. Best effort: IPv6 may be off in the guest.
if command -v ip6tables >/dev/null 2>&1; then
  if ip6tables -t filter -n -L DOCKER-USER >/dev/null 2>&1; then fwd6=DOCKER-USER; else fwd6=FORWARD; fi
  ip6tables -t filter -C "$fwd6" -i ${ bridge } ! -o ${ bridge } -j REJECT 2>/dev/null ||
    ip6tables -t filter -I "$fwd6" 1 -i ${ bridge } ! -o ${ bridge } -j REJECT 2>/dev/null || true
fi
`;
}

/** argv that applies (or removes) the egress policy in the guest, as root. */
export function egressPolicyCommand(enforce: boolean): string[] {
  return ['sh', '-c', egressPolicyScript(enforce), 'sulla-egress', renderEgressRestore()];
}

/**
 * Creates the agent network with the fixed bridge name. A network left by an
 * older build (random bridge name) is replaced; its containers (the host relay
 * and finished agents) are removed first and recreated on demand.
 */
export const ENSURE_AGENT_NETWORK_SCRIPT = `set -eu
net=$1; bridge=$2
current() { docker network inspect --format '{{index .Options "com.docker.network.bridge.name"}}' "$net" 2>/dev/null || echo __missing__; }
state=$(current)
[ "$state" = "$bridge" ] && exit 0
if [ "$state" != "__missing__" ]; then
  for id in $(docker network inspect --format '{{range $id, $c := .Containers}}{{$id}} {{end}}' "$net"); do
    docker rm --force "$id" >/dev/null 2>&1 || docker network disconnect --force "$net" "$id" || true
  done
  docker network rm "$net" >/dev/null
fi
docker network create --driver bridge --label com.sulla.network=agents \\
  --opt com.docker.network.bridge.name="$bridge" "$net" >/dev/null || [ "$(current)" = "$bridge" ]
`;

export function ensureAgentNetworkCommand(): string[] {
  return ['sh', '-c', ENSURE_AGENT_NETWORK_SCRIPT, 'sulla-agent-network', AGENT_NETWORK, AGENT_BRIDGE];
}

/**
 * Agents also join `sulla_default` to reach Sulla services by name. The
 * default route must stay on `sulla-agents`, where the egress rules apply, so
 * the second network gets the lowest gateway priority.
 */
export function connectServiceNetworkCommand(network: string, container: string): string[] {
  return ['docker', 'network', 'connect', '--gw-priority=-1', network, container];
}

/** Creates the state directories with the owners and modes the proxy expects. Runs as root in the guest. */
export const PROVISION_THREAT_PROXY_STATE_SCRIPT = `set -eu
root=$1; uid=$2
for path in "$root" "$root/mitm" "$root/cache" "$root/config" "$root/blocklist" "$root/public"; do
  [ ! -L "$path" ] || { echo "threat proxy state path must not be a symlink: $path" >&2; exit 1; }
done
install -d -m 0755 -o 0 -g 0 "$root"
chown 0:0 "$root"; chmod 0755 "$root"
for dir in mitm cache config; do
  install -d -m 0700 -o "$uid" -g "$uid" "$root/$dir"
  chown "$uid:$uid" "$root/$dir"; chmod 0700 "$root/$dir"
done
for dir in blocklist public; do
  install -d -m 0755 -o "$uid" -g "$uid" "$root/$dir"
  chown "$uid:$uid" "$root/$dir"; chmod 0755 "$root/$dir"
done
`;

export function provisionStateCommand(): string[] {
  return ['sh', '-c', PROVISION_THREAT_PROXY_STATE_SCRIPT, 'sulla-threat-proxy-state', THREAT_PROXY_STATE_DIR, String(THREAT_PROXY_UID)];
}

/** Moves a staged file into place, owned by the proxy user. Arguments: <staged> <final> <mode>. */
export function installStagedFileCommand(staged: string, final: string, mode: string): string[] {
  return ['sh', '-c', 'set -eu; chown "$4:$4" "$1"; chmod "$3" "$1"; mv -f "$1" "$2"', 'sulla-threat-proxy-install', staged, final, mode, String(THREAT_PROXY_UID)];
}

/** Compose service for the proxy. `image` is the resolved image fields (image or build). */
export function threatProxyComposeService(image: Record<string, unknown>): Record<string, unknown> {
  const state = THREAT_PROXY_STATE_DIR;
  const target = THREAT_PROXY_CONTAINER_STATE_DIR;
  const bind = (sub: string, readOnly: boolean) => ({
    type: 'bind', source: `${ state }/${ sub }`, target: `${ target }/${ sub }`, read_only: readOnly, bind: { create_host_path: false },
  });

  return {
    ...image,
    container_name: THREAT_PROXY_CONTAINER,
    // Host network: REDIRECT delivers agent flows to the guest's own port and
    // the proxy's upstream connections leave from the guest (never redirected).
    network_mode:   'host',
    user:           `${ THREAT_PROXY_UID }:${ THREAT_PROXY_UID }`,
    environment:    {
      SULLA_PROXY_STATE_DIR:   target,
      SULLA_PROXY_LISTEN_PORT: String(THREAT_PROXY_PORT),
      SULLA_PROXY_MODE:        'transparent',
    },
    volumes: [
      bind('mitm', false), bind('cache', false), bind('public', false),
      bind('config', true), bind('blocklist', true),
    ],
    read_only:    true,
    tmpfs:        ['/tmp'],
    cap_drop:     ['ALL'],
    security_opt: ['no-new-privileges:true'],
    restart:      'unless-stopped',
    mem_limit:    '512m',
    healthcheck:  {
      test:     ['CMD', 'python3', '-c', `import socket; socket.create_connection(('127.0.0.1', ${ THREAT_PROXY_PORT }), 2).close()`],
      interval:       '5s',
      timeout:        '3s',
      retries:        10,
      // Started on demand by the agent launcher, which waits for healthy.
      start_period:   '30s',
      start_interval: '1s',
    },
  };
}

/**
 * Mount + environment that make an agent container trust the proxy CA. Only
 * the public directory is mounted. NODE_EXTRA_CA_CERTS extends Node's store;
 * the others replace their client's store, so they get the full bundle.
 * Provider CLIs start through `docker exec`, which inherits container env but
 * not anything the entrypoint exports, so this must be container env.
 */
export function agentCaTrust(): { bind: string; env: Record<string, string> } {
  const bundle = `${ AGENT_CA_MOUNT }/ca-bundle.pem`;

  return {
    bind: `${ THREAT_PROXY_PUBLIC_DIR }:${ AGENT_CA_MOUNT }:ro`,
    env:  {
      NODE_EXTRA_CA_CERTS: `${ AGENT_CA_MOUNT }/ca.crt`,
      SSL_CERT_FILE:       bundle,
      REQUESTS_CA_BUNDLE:  bundle,
      CURL_CA_BUNDLE:      bundle,
      GIT_SSL_CAINFO:      bundle,
      PIP_CERT:            bundle,
    },
  };
}
