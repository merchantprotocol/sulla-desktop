"""
Sulla Threat Proxy — shared utilities.

Loaded by every addon. Provides:
  - log()        — append-only structured logger writing to /var/log/sulla-threat-proxy.log
  - load_env()   — reads /etc/sulla-proxy.env into a dict (shell key=value lines)
  - VerdictCache — SQLite-backed TTL cache for URL / host verdicts
  - is_allowlisted(host) — bypass for internal / development hosts
  - classify_verdict(flags) — collapses multi-source signals into an action

Config file: /etc/sulla-proxy.env — written by Electron side (LimaBackend).
"""

import json
import os
import sqlite3
import sys
import time
from typing import Any, Dict, Iterable, Optional

LOG_PATH = "/var/log/sulla-threat-proxy.log"
ENV_PATH = "/etc/sulla-proxy.env"
CACHE_DIR = "/opt/sulla-proxy/cache"
CACHE_DB = os.path.join(CACHE_DIR, "verdicts.sqlite")
BLOCKLIST_DIR = "/opt/sulla-proxy/blocklist"

# Sentinel flags returned by per-source scanners.
FLAG_CLEAN = "clean"
FLAG_BLOCK = "block"
FLAG_SUSPICIOUS = "suspicious"
FLAG_UNKNOWN = "unknown"
FLAG_ERROR = "error"


def log(component: str, level: str, msg: str, **fields: Any) -> None:
    """Structured log line. One JSON object per line — easy to tail + grep.

    Fields are merged into the payload. Never raises; logging failure is swallowed
    because losing a log line is always preferable to crashing the proxy request.
    """
    payload = {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "component": component,
        "level": level,
        "msg": msg,
    }
    payload.update(fields)
    try:
        with open(LOG_PATH, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(payload, default=str) + "\n")
    except Exception:
        # Last-resort — write to stderr so mitmdump captures something.
        try:
            sys.stderr.write(f"[sulla-threat-proxy:{component}] {msg}\n")
        except Exception:
            pass


def load_env() -> Dict[str, str]:
    """Read /etc/sulla-proxy.env into a flat dict. Shell-safe key=value lines.

    Unlike `source`, we don't execute anything — just parse KEY=VALUE (quoted or not).
    Missing file returns {} so the proxy degrades to URLhaus-only mode.
    """
    env: Dict[str, str] = {}
    try:
        with open(ENV_PATH, "r", encoding="utf-8") as fh:
            for raw in fh:
                line = raw.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                key = key.strip()
                value = value.strip().strip('"').strip("'")
                if key:
                    env[key] = value
    except FileNotFoundError:
        log("common", "warn", "env file missing, running with defaults", path=ENV_PATH)
    except Exception as ex:
        log("common", "error", "env parse failed", error=str(ex))
    return env


def is_allowlisted(host: str, extra: Optional[Iterable[str]] = None) -> bool:
    """Return True if `host` should bypass all scanners.

    The user explicitly accepted the privacy tradeoff (memory: sulla-desktop URL
    filter) so we keep this list minimal — only loopback, link-local, and RFC1918
    bypass by default. The user can extend via SULLA_PROXY_ALLOWLIST (comma-separated).
    """
    if not host:
        return True
    h = host.lower().split(":")[0]  # strip port
    base_allow = {
        "localhost", "127.0.0.1", "::1",
        "host.lima.internal", "host.docker.internal", "host.rancher-desktop.internal",
        "lima-rancher-desktop", "lima-0",
    }
    if h in base_allow:
        return True
    # RFC1918 / link-local / multicast — never scan.
    if h.startswith(("10.", "192.168.", "169.254.", "224.", "239.")):
        return True
    # 172.16.0.0/12
    if h.startswith("172."):
        try:
            second = int(h.split(".")[1])
            if 16 <= second <= 31:
                return True
        except (ValueError, IndexError):
            pass
    if extra:
        for entry in extra:
            entry = entry.strip().lower()
            if not entry:
                continue
            if h == entry or h.endswith("." + entry):
                return True
    return False


def classify_verdict(flags: Iterable[str]) -> str:
    """Collapse per-source flags into a single action: block / suspicious / clean.

    BLOCK wins if any source says block.
    SUSPICIOUS wins over CLEAN/UNKNOWN if any source is suspicious.
    Otherwise CLEAN if we got at least one clean signal, else UNKNOWN.
    """
    flags_set = set(flags)
    if FLAG_BLOCK in flags_set:
        return FLAG_BLOCK
    if FLAG_SUSPICIOUS in flags_set:
        return FLAG_SUSPICIOUS
    if FLAG_CLEAN in flags_set:
        return FLAG_CLEAN
    return FLAG_UNKNOWN


class VerdictCache:
    """SQLite-backed TTL cache. Shared across addon modules.

    Why SQLite: persists across mitmdump restarts, one-file, no extra daemon,
    and cheap enough that we can cache per-URL as well as per-host.
    """

    def __init__(self, path: str = CACHE_DB, default_ttl_secs: int = 6 * 3600) -> None:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        self.default_ttl = default_ttl_secs
        self.conn = sqlite3.connect(path, timeout=5, isolation_level=None, check_same_thread=False)
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute(
            """
            CREATE TABLE IF NOT EXISTS verdicts (
                key        TEXT PRIMARY KEY,
                verdict    TEXT NOT NULL,
                source     TEXT,
                detail     TEXT,
                expires_at INTEGER NOT NULL
            )
            """
        )
        self.conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_verdicts_expires ON verdicts(expires_at)"
        )

    def get(self, key: str) -> Optional[Dict[str, Any]]:
        now = int(time.time())
        row = self.conn.execute(
            "SELECT verdict, source, detail, expires_at FROM verdicts WHERE key=? AND expires_at>?",
            (key, now),
        ).fetchone()
        if not row:
            return None
        verdict, source, detail, expires_at = row
        return {
            "verdict": verdict,
            "source": source,
            "detail": detail,
            "expires_at": expires_at,
        }

    def put(
        self,
        key: str,
        verdict: str,
        source: str = "",
        detail: str = "",
        ttl_secs: Optional[int] = None,
    ) -> None:
        ttl = ttl_secs if ttl_secs is not None else self.default_ttl
        # Block verdicts persist longer — malicious infra rarely reforms.
        if verdict == FLAG_BLOCK and ttl_secs is None:
            ttl = 7 * 24 * 3600
        expires_at = int(time.time()) + ttl
        self.conn.execute(
            "INSERT OR REPLACE INTO verdicts(key, verdict, source, detail, expires_at) VALUES(?,?,?,?,?)",
            (key, verdict, source, detail, expires_at),
        )

    def purge_expired(self) -> int:
        now = int(time.time())
        cur = self.conn.execute("DELETE FROM verdicts WHERE expires_at<=?", (now,))
        return cur.rowcount or 0


# Module-level singleton so addons share one cache + one DB handle.
_CACHE: Optional[VerdictCache] = None


def get_cache() -> VerdictCache:
    global _CACHE
    if _CACHE is None:
        _CACHE = VerdictCache()
    return _CACHE
