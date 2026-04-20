"""
Sulla Threat Proxy — URL filter addon.

Pipeline (in order, short-circuits on first definitive hit):
  1. Allowlist  — internal / RFC1918 / user-configured domains bypass everything.
  2. Verdict cache — SQLite cache from common.VerdictCache (6h clean / 7d block TTL).
  3. URLhaus bloom — local hostname blocklist from abuse.ch (zero latency).
  4. Google Safe Browsing v4 — if GOOGLE_SAFE_BROWSING_API_KEY is set.
  5. VirusTotal v3 — only for hosts flagged suspicious by (2) or (3), if VT_API_KEY set.

Blocked requests get an HTTP 451 with a JSON body describing the threat source.
All decisions are cached and logged.
"""

import base64
import json
import os
import threading
import time
import urllib.parse
import urllib.request
from typing import Dict, List, Optional, Set, Tuple

from mitmproxy import http

from common import (
    BLOCKLIST_DIR,
    FLAG_BLOCK,
    FLAG_CLEAN,
    FLAG_ERROR,
    FLAG_SUSPICIOUS,
    FLAG_UNKNOWN,
    classify_verdict,
    get_cache,
    is_allowlisted,
    load_env,
    log,
)

URLHAUS_FEED_URL = "https://urlhaus.abuse.ch/downloads/hostfile/"
URLHAUS_PATH = os.path.join(BLOCKLIST_DIR, "urlhaus.txt")

SAFE_BROWSING_ENDPOINT = "https://safebrowsing.googleapis.com/v4/threatMatches:find"
VT_ENDPOINT = "https://www.virustotal.com/api/v3/urls/{id}"

# How often to refresh URLhaus blocklist from disk (it's updated externally).
URLHAUS_RELOAD_SECS = 300

# External API budgets — enforced with a simple token bucket.
# Safe Browsing free tier: 10k/day ≈ 6.9/min. We cap at 6/min to stay well under.
SAFE_BROWSING_BUDGET_PER_MINUTE = 6
# VirusTotal free tier: 4 req/min, 500/day.
VT_BUDGET_PER_MINUTE = 3


class _TokenBucket:
    """Simple per-minute rate limiter — drops requests over budget rather than blocking."""

    def __init__(self, limit_per_minute: int) -> None:
        self.limit = limit_per_minute
        self.tokens = limit_per_minute
        self.window_start = time.time()
        self.lock = threading.Lock()

    def take(self) -> bool:
        with self.lock:
            now = time.time()
            if now - self.window_start >= 60.0:
                self.tokens = self.limit
                self.window_start = now
            if self.tokens <= 0:
                return False
            self.tokens -= 1
            return True


class URLFilter:
    """mitmproxy addon. Runs on every request; decides block/pass."""

    def __init__(self) -> None:
        self.env = load_env()
        self.cache = get_cache()
        self.sb_bucket = _TokenBucket(SAFE_BROWSING_BUDGET_PER_MINUTE)
        self.vt_bucket = _TokenBucket(VT_BUDGET_PER_MINUTE)
        self._urlhaus_hosts: Set[str] = set()
        self._urlhaus_loaded_at: float = 0.0
        self._urlhaus_lock = threading.Lock()

        self.sb_key = self.env.get("GOOGLE_SAFE_BROWSING_API_KEY", "").strip()
        self.vt_key = self.env.get("VT_API_KEY", "").strip()
        self.user_allowlist = [
            x.strip() for x in self.env.get("SULLA_PROXY_ALLOWLIST", "").split(",") if x.strip()
        ]
        self.block_mode = self.env.get("SULLA_PROXY_BLOCK_MODE", "block").lower()
        # block_mode options:
        #   block   — return 451 on threats (default)
        #   warn    — let through but log + add X-Sulla-Threat header
        #   off     — pass everything (scanners still log, useful for debugging)

        self._reload_urlhaus()

        log(
            "url_filter",
            "info",
            "URLFilter initialized",
            sb_enabled=bool(self.sb_key),
            vt_enabled=bool(self.vt_key),
            block_mode=self.block_mode,
            allowlist_size=len(self.user_allowlist),
            urlhaus_hosts=len(self._urlhaus_hosts),
        )

    # ────────────────────────────────────────────────────────────────
    # URLhaus local blocklist
    # ────────────────────────────────────────────────────────────────
    def _reload_urlhaus(self) -> None:
        """Load URLhaus hostnames from disk. Format: one hostname per line, comments start with #.

        Called lazily — file is refreshed out-of-band by the blocklist updater.
        """
        with self._urlhaus_lock:
            if time.time() - self._urlhaus_loaded_at < URLHAUS_RELOAD_SECS and self._urlhaus_hosts:
                return
            hosts: Set[str] = set()
            try:
                with open(URLHAUS_PATH, "r", encoding="utf-8", errors="ignore") as fh:
                    for line in fh:
                        line = line.strip()
                        if not line or line.startswith("#"):
                            continue
                        # Hostfile format can be "0.0.0.0 badhost.com" or just "badhost.com".
                        parts = line.split()
                        host = parts[-1].lower()
                        if host and "." in host:
                            hosts.add(host)
                self._urlhaus_hosts = hosts
                self._urlhaus_loaded_at = time.time()
                log(
                    "url_filter",
                    "info",
                    "URLhaus blocklist loaded",
                    host_count=len(hosts),
                    path=URLHAUS_PATH,
                )
            except FileNotFoundError:
                log(
                    "url_filter",
                    "warn",
                    "URLhaus blocklist missing — skipping local blocking",
                    path=URLHAUS_PATH,
                )
            except Exception as ex:
                log("url_filter", "error", "URLhaus load failed", error=str(ex))

    def _check_urlhaus(self, host: str) -> Tuple[str, str]:
        self._reload_urlhaus()
        # Exact match on the FQDN, plus check parent domain (malware often uses subdomains).
        if host in self._urlhaus_hosts:
            return FLAG_BLOCK, "urlhaus:exact"
        parts = host.split(".")
        for i in range(1, len(parts) - 1):
            parent = ".".join(parts[i:])
            if parent in self._urlhaus_hosts:
                return FLAG_BLOCK, f"urlhaus:parent:{parent}"
        return FLAG_UNKNOWN, ""

    # ────────────────────────────────────────────────────────────────
    # Google Safe Browsing
    # ────────────────────────────────────────────────────────────────
    def _check_safe_browsing(self, url: str) -> Tuple[str, str]:
        if not self.sb_key:
            return FLAG_UNKNOWN, "safe_browsing:disabled"
        if not self.sb_bucket.take():
            log("url_filter", "warn", "Safe Browsing budget exhausted — skipping", url=url)
            return FLAG_UNKNOWN, "safe_browsing:rate_limited"

        body = {
            "client": {"clientId": "sulla-desktop", "clientVersion": "1.0"},
            "threatInfo": {
                "threatTypes": [
                    "MALWARE",
                    "SOCIAL_ENGINEERING",
                    "UNWANTED_SOFTWARE",
                    "POTENTIALLY_HARMFUL_APPLICATION",
                ],
                "platformTypes": ["ANY_PLATFORM"],
                "threatEntryTypes": ["URL"],
                "threatEntries": [{"url": url}],
            },
        }
        try:
            req = urllib.request.Request(
                f"{SAFE_BROWSING_ENDPOINT}?key={urllib.parse.quote(self.sb_key)}",
                data=json.dumps(body).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=3.0) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            matches = data.get("matches", [])
            if matches:
                kinds = ",".join(sorted({m.get("threatType", "?") for m in matches}))
                return FLAG_BLOCK, f"safe_browsing:{kinds}"
            return FLAG_CLEAN, "safe_browsing:clean"
        except Exception as ex:
            log("url_filter", "error", "Safe Browsing lookup failed", url=url, error=str(ex))
            return FLAG_ERROR, "safe_browsing:error"

    # ────────────────────────────────────────────────────────────────
    # VirusTotal (fallback for suspicious unknowns)
    # ────────────────────────────────────────────────────────────────
    def _check_virustotal(self, url: str) -> Tuple[str, str]:
        if not self.vt_key:
            return FLAG_UNKNOWN, "vt:disabled"
        if not self.vt_bucket.take():
            log("url_filter", "warn", "VirusTotal budget exhausted — skipping", url=url)
            return FLAG_UNKNOWN, "vt:rate_limited"

        url_id = base64.urlsafe_b64encode(url.encode("utf-8")).rstrip(b"=").decode("ascii")
        try:
            req = urllib.request.Request(
                VT_ENDPOINT.format(id=url_id),
                headers={"x-apikey": self.vt_key, "Accept": "application/json"},
            )
            with urllib.request.urlopen(req, timeout=3.0) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            stats = (data.get("data") or {}).get("attributes", {}).get("last_analysis_stats", {})
            malicious = int(stats.get("malicious", 0))
            suspicious = int(stats.get("suspicious", 0))
            # Threshold: 2+ engines flag = block; 1 = suspicious.
            if malicious >= 2:
                return FLAG_BLOCK, f"vt:malicious:{malicious}"
            if malicious >= 1 or suspicious >= 2:
                return FLAG_SUSPICIOUS, f"vt:malicious:{malicious}/suspicious:{suspicious}"
            return FLAG_CLEAN, "vt:clean"
        except urllib.error.HTTPError as ex:
            if ex.code == 404:
                # URL not seen by VT before — not a verdict, just unknown.
                return FLAG_UNKNOWN, "vt:not_found"
            log("url_filter", "error", "VT HTTP error", url=url, code=ex.code)
            return FLAG_ERROR, f"vt:http_{ex.code}"
        except Exception as ex:
            log("url_filter", "error", "VT lookup failed", url=url, error=str(ex))
            return FLAG_ERROR, "vt:error"

    # ────────────────────────────────────────────────────────────────
    # Pipeline
    # ────────────────────────────────────────────────────────────────
    def _scan(self, url: str, host: str) -> Tuple[str, List[str]]:
        """Run scanners in escalation order. Returns (verdict, details).

        URLhaus runs before the cache — the blocklist updates every 6h, and a
        domain the blocklist now flags should block even if we previously cached
        it as clean. URLhaus is local + zero-cost so the ordering is free.
        """
        details: List[str] = []

        # Layer 1 — URLhaus (zero-cost, local; always authoritative for blocks)
        flag, detail = self._check_urlhaus(host)
        details.append(detail or f"urlhaus:{flag}")
        if flag == FLAG_BLOCK:
            self.cache.put(url, FLAG_BLOCK, source="urlhaus", detail=detail)
            return FLAG_BLOCK, details

        # Layer 2 — cached verdict from previous SB/VT lookup
        cached = self.cache.get(url)
        if cached:
            details.append(f"cache:{cached['source']}")
            return cached["verdict"], details

        # Layer 3 — Safe Browsing
        sb_flag, sb_detail = self._check_safe_browsing(url)
        details.append(sb_detail)
        if sb_flag == FLAG_BLOCK:
            self.cache.put(url, FLAG_BLOCK, source="safe_browsing", detail=sb_detail)
            return FLAG_BLOCK, details

        # Layer 4 — VirusTotal (only if we have reason to escalate)
        # Trigger: URLhaus unknown + SB clean → probably fine, skip VT.
        # Trigger: URLhaus unknown + SB error/unknown → escalate to VT when available.
        should_escalate = self.vt_key and sb_flag in (FLAG_UNKNOWN, FLAG_ERROR)
        if should_escalate:
            vt_flag, vt_detail = self._check_virustotal(url)
            details.append(vt_detail)
            if vt_flag == FLAG_BLOCK:
                self.cache.put(url, FLAG_BLOCK, source="vt", detail=vt_detail)
                return FLAG_BLOCK, details
            final = classify_verdict([sb_flag, vt_flag])
        else:
            final = classify_verdict([sb_flag])

        # Cache whatever we concluded (clean/suspicious/unknown). Shorter TTL for unknowns.
        ttl = None if final == FLAG_CLEAN else 30 * 60
        self.cache.put(url, final, source="pipeline", detail="|".join(details), ttl_secs=ttl)
        return final, details

    # ────────────────────────────────────────────────────────────────
    # mitmproxy hook
    # ────────────────────────────────────────────────────────────────
    def request(self, flow: http.HTTPFlow) -> None:
        if self.block_mode == "off":
            return
        url = flow.request.pretty_url
        host = flow.request.pretty_host or ""

        if is_allowlisted(host, self.user_allowlist):
            log("url_filter", "debug", "allowlisted", host=host, url=url)
            return

        verdict, details = self._scan(url, host)
        log(
            "url_filter",
            "info",
            "scan complete",
            host=host,
            url=url,
            verdict=verdict,
            details=details,
        )

        if verdict == FLAG_BLOCK:
            if self.block_mode == "warn":
                flow.request.headers["X-Sulla-Threat"] = "|".join(details)
                return
            self._emit_block(flow, url, details)

    def _emit_block(self, flow: http.HTTPFlow, url: str, details: List[str]) -> None:
        body = json.dumps(
            {
                "blocked_by": "sulla-threat-proxy",
                "url": url,
                "reason": "threat_detected",
                "detectors": details,
                "action": "Request blocked. If this is a false positive, adjust SULLA_PROXY_ALLOWLIST or disable the proxy in Sulla Desktop settings.",
            },
            indent=2,
        )
        flow.response = http.Response.make(
            451,  # Unavailable For Legal Reasons — best-fit status for policy block
            body,
            {"Content-Type": "application/json", "X-Sulla-Threat": "|".join(details)},
        )


# mitmproxy discovers `addons` at module load time.
addons = [URLFilter()]
