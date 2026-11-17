# Sulla threat proxy

`ghcr.io/merchantprotocol/sulla-threat-proxy` scans the web traffic of agent
containers on the Sulla runtime: mitmdump in transparent mode with two addons.

- `addons/url_filter.py`: URL reputation (URLhaus blocklist, then Google Safe
  Browsing, then VirusTotal). A blocked request gets HTTP 451 with a JSON body;
  the upstream connection is never opened (`connection_strategy=lazy`).
- `addons/prompt_injection.py`: flags prompt-injection patterns in response bodies.
- `addons/common.py`: logging (JSON lines on stdout), config, verdict cache, allowlist.

## How traffic reaches it

The guest firewall does it, so a model cannot opt out by unsetting `HTTPS_PROXY`.
Rules and the agent network are generated in
`pkg/sulla-desktop/backend/threatProxyEgress.ts`:

```
agent container  (network sulla-agents, bridge br-sulla-agents)
  TCP 80/443 to a public address
    nat PREROUTING -> SULLA-EGRESS-NAT -> REDIRECT :8890
    filter INPUT   -> SULLA-PROXY-IN  (only redirected flows may reach :8890)
    sulla_threat_proxy (host network) scans, then connects upstream itself
  anything else leaving the bridge
    filter DOCKER-USER -> SULLA-EGRESS-FWD
      private destinations and DNS: allowed
      TCP 80/443 that was not redirected: reset
      other UDP (QUIC included): rejected
      other TCP ports: allowed, not scanned
```

If the proxy is not running, redirected connections are refused: agent web
traffic fails closed. The user can switch scanning off in Sulla Desktop, which
removes the rules.

## URLhaus blocklist sources

Desktop downloads URLhaus data only from Sulla Cloud
(`CLOUD_API_BASE/threat-intel/urlhaus.txt`). Cloud refreshes its copy daily,
serves a new list only after it verifies it, and keeps the previous list as a
backup. Responses that are not a hosts file are rejected, and the last
delivered list stays in place.

The image also ships `blocklist/urlhaus-default.txt`, a validated URLhaus
hosts-file snapshot refreshed with `scripts/update-urlhaus-default.sh`. It is
installed read-only at `/opt/sulla-threat-proxy/blocklist/urlhaus-default.txt`,
outside the writable state directory. On first start, or whenever the
Desktop-delivered `/var/lib/sulla-threat-proxy/blocklist/urlhaus.txt` is
missing or empty, the proxy loads this snapshot. It rechecks the delivered
file every five minutes and switches to it once a non-empty list arrives, so
first-run protection works even while offline.

## State

Bind-mounted from `/mnt/data/var/lib/sulla/threat-proxy` on the runtime data
disk to `/var/lib/sulla-threat-proxy`; Desktop creates the directories for UID
10010.

| Path         | Mode | Owner   | Contents |
|--------------|------|---------|----------|
| `mitm/`      | 0700 | proxy   | mitmproxy confdir; the CA private key never leaves it |
| `cache/`     | 0700 | proxy   | `verdicts.sqlite` |
| `config/`    | 0700 | proxy   | `proxy.json` from Desktop: settings + API keys (read-only mount) |
| `blocklist/` | 0755 | proxy   | `urlhaus.txt`, refreshed by Desktop every 6h (read-only mount) |
| `public/`    | 0755 | proxy   | `ca.crt` and `ca-bundle.pem` (system roots + CA); the only part agents mount |

The addons re-read `proxy.json` and `urlhaus.txt` when they change, so new
settings, API keys and blocklists take effect without a restart.

## Tests

The image build runs `tests/` (stdlib `unittest`) in a `test` stage; a failing
test fails the build. Locally:

```sh
docker build -f services/sulla-threat-proxy/Dockerfile -t sulla-threat-proxy:local .
```
