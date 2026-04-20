# Sulla Desktop Threat Proxy

This directory bundles the mitmproxy addons and blocklist data that get synced
into the Lima VM at `/opt/sulla-proxy/` during startup.

## Layout

- `addons/common.py` — shared utilities (logging, verdict cache, config loader).
- `addons/url_filter.py` — URL reputation scanner (URLhaus → Safe Browsing → VirusTotal).
- `addons/prompt_injection.py` — response body scanner for prompt-injection heuristics.
- `blocklist/` — filled in at runtime (URLhaus domain list, etc). Empty in the repo.

## Runtime layout inside the VM

Addons and config are copied by `LimaBackend.installThreatProxy()` to:

- `/opt/sulla-proxy/addons/*.py` — the Python addon modules.
- `/opt/sulla-proxy/blocklist/urlhaus.txt` — domain blocklist (refreshed every 6h).
- `/opt/sulla-proxy/mitm/` — mitmproxy confdir (CA cert + state).
- `/opt/sulla-proxy/cache/verdicts.sqlite` — verdict cache DB.
- `/etc/sulla-proxy.env` — runtime config (API keys, settings).
- `/etc/init.d/sulla-threat-proxy` — OpenRC service script.
- `/var/log/sulla-threat-proxy.log` — addon + daemon logs.

## How it fits together

1. Quad9 DNS (9.9.9.9) is the zero-cost baseline — configured in `lima-config.yaml`.
2. mitmdump runs as an OpenRC service on `127.0.0.1:8888`.
3. `/etc/claude-env` exports `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` + CA bundle paths.
4. Claude Code + every npm/pip/curl request in the VM flows through the proxy.
5. URL filter rejects known-bad URLs before connecting (HTTP 451).
6. Prompt-injection scanner flags suspicious patterns in response bodies.

See `pkg/rancher-desktop/main/threat-proxy/` for the Electron-side lifecycle service.
