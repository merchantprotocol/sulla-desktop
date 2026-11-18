#!/usr/bin/env bash
# Sulla Desktop · https://sulladesktop.com
# Copyright (c) 2025-2026 Merchant Protocol LLC.
# SPDX-License-Identifier: GPL-2.0-or-later
# "Sulla" is a trademark. See TRADEMARK.md.
# Runs inside the Desktop VM (as root, docker available). Data is restricted to one per-run
# QA folder under the detected personal Files collection; kill/outage tests intentionally
# stop, restart and kill Files services. Standard library only; no installs.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PHASES="bulk append ops crash load cloud restart-propagation outage outage-b handles token-empty lock-contention latency staleness eio-capture env-info fuse-identity integrity summary before-after-summary api-write all cleanup"
if [[ $# -lt 1 ]]; then
  echo "usage: files-soak.sh <$(echo $PHASES | tr ' ' '|')> [--with-app-restart] [phase arguments]" >&2
  exit 2
fi

PHASE=""
WITH_APP_RESTART="false"
EXTRA_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --with-app-restart) WITH_APP_RESTART="true" ;;
    *)
      if [[ -z "$PHASE" ]]; then
        if [[ " $PHASES " == *" $arg "* ]]; then PHASE="$arg"; else echo "unknown phase: $arg" >&2; exit 2; fi
      else
        EXTRA_ARGS+=("$arg")
      fi
      ;;
  esac
done
if [[ -z "$PHASE" ]]; then echo "usage: files-soak.sh <phase|all|cleanup> [--with-app-restart]" >&2; exit 2; fi

# Environment overrides (all optional):
#   SOAK_MOUNT              Files mount seen by the VM (default: /mnt/sulla/files if mounted, else /mnt/sulla-files)
#   SOAK_BIND_SPEC          src:dst:propagation bind used for test containers (default follows SOAK_MOUNT layout)
#   SOAK_FILES_CONTAINER / SOAK_FUSE_CONTAINER / SOAK_PG_CONTAINER / SOAK_PG_USER / SOAK_PG_DB
#   SOAK_FUSE_TOKEN_FILE / SOAK_FUSE_URL   adapter token file and Files base URL (in the FUSE container)
#   SOAK_INVALIDATE_WINDOW (s, default 5)  staleness window; SOAK_LOCK_SECONDS, SOAK_LATENCY_P95_MS
#   SOAK_OUTAGE_A_SECONDS (45), SOAK_OUTAGE_B_SECONDS (120), SOAK_TOKEN_TEST=1 (opt-in token-empty), SOAK_API_SAMPLE (40)
#   SOAK_MINUTES (load phase duration; `all` runs load only when set), SOAK_TEST_IMAGE, SOAK_RUN
exec python3 -I - "$PHASE" "$WITH_APP_RESTART" "${EXTRA_ARGS[@]}" <<'PYTHON'
# Sulla Desktop · https://sulladesktop.com
# Copyright (c) 2025-2026 Merchant Protocol LLC.
# SPDX-License-Identifier: GPL-2.0-or-later
# "Sulla" is a trademark. See TRADEMARK.md.
"""Files durability soak + kill-test harness. Standard library only; intended for the Sulla VM."""
import bisect
import collections
import concurrent.futures
import datetime
import errno
import hashlib
import json
import multiprocessing
import os
import random
import re
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

ENV = os.environ


def env_int(name, default, low, high):
    try:
        value = int(ENV.get(name, default))
    except ValueError:
        value = default
    return max(low, min(value, high))


def env_float(name, default, low, high):
    try:
        value = float(ENV.get(name, default))
    except ValueError:
        value = default
    return max(low, min(value, high))


def is_mountpoint(path):
    try:
        return subprocess.run(["mountpoint", "-q", path], timeout=10, check=False).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return os.path.ismount(path)


def new_layout():
    """New layout (PR #2610): FUSE mounts at /mnt/sulla/files and /mnt/sulla-files is a symlink to it."""
    return is_mountpoint("/mnt/sulla/files")


def detect_mount():
    """Current layout mounts FUSE at /mnt/sulla-files; the new layout mounts it at /mnt/sulla/files."""
    if ENV.get("SOAK_MOUNT"):
        return Path(ENV["SOAK_MOUNT"])
    return Path("/mnt/sulla/files") if new_layout() else Path("/mnt/sulla-files")


def bind_spec():
    """The bind agent containers use. The new layout binds the anchor's parent /mnt/sulla rslave."""
    if ENV.get("SOAK_BIND_SPEC"):
        return ENV["SOAK_BIND_SPEC"]
    return "/mnt/sulla:/mnt/sulla:rslave" if new_layout() else "/mnt/sulla-files:/mnt/sulla-files:rslave"


def errno_of_text(text):
    """Map an OS error string, as printed by the shell or Python, back to its errno name (or None)."""
    for code, name in errno.errorcode.items():
        if os.strerror(code) == text:
            return name
    return None


MOUNT = detect_mount()
MOUNT_WAIT_S = 120  # every phase starts only once the mount answers ls within this bound
STATE_DIR = Path.home() / "sulla-twodev" / "soak"
RESULTS = STATE_DIR / "results.jsonl"
STATE = STATE_DIR / "state.json"
LEDGER = STATE_DIR / "ledger.jsonl"
EIO_LOG = STATE_DIR / "eio-events.jsonl"  # append-only; cleanup never deletes it
OUTAGE_B_VARIANTS = ("paused", "stopped")
# Per-process EIO bookkeeping. Every EIO (any phase, any thread) goes through record_eio().
EIO_CONTEXT = {"run": "", "root": "", "phase": ""}
EIO_COUNTS = collections.Counter()  # EIO events per phase in this process
EIO_LOCK = threading.Lock()
EIO_CAPTURE_CAP = 500  # adapter-log captures per process; later EIOs are logged without them
EIO_CAPTURES = [0]
COMMAND_TIMEOUT = 20
FILE_TIMEOUT = 45
CRASH_FILE_BYTES = 64 * 1024
CRASH_INTERVAL = 0.5
OP_BOUND_S = 150  # an operation that is still running after this is a hang, not a clean error
SLACK_S = 10
CONTAINER_FILES = ENV.get("SOAK_FILES_CONTAINER", "sulla_files")
CONTAINER_FUSE = ENV.get("SOAK_FUSE_CONTAINER", "sulla_files_fuse")
CONTAINER_PG = ENV.get("SOAK_PG_CONTAINER", "sulla_postgres")
PG_USER = ENV.get("SOAK_PG_USER", "sulla")
PG_DB = ENV.get("SOAK_PG_DB", "sulla")
TOKEN_FILE = ENV.get("SOAK_FUSE_TOKEN_FILE", "/run/sulla-files-fuse/token")
FUSE_URL = ENV.get("SOAK_FUSE_URL", "https://sulla_files:8792")
INVALIDATE_WINDOW = env_float("SOAK_INVALIDATE_WINDOW", 5, 0, 600)
OUTAGE_A_S = env_int("SOAK_OUTAGE_A_SECONDS", 45, 5, 900)
OUTAGE_B_S = env_int("SOAK_OUTAGE_B_SECONDS", 120, 5, 900)
OUTAGE_WRITER_COUNT = 4  # retrying writers, started at evenly spaced points across the Files-down window
PLAIN_INTERVAL_S = 2  # single-attempt writer: one attempt every 2 s, no harness retry
PLAIN_POST_S = 10  # keep the plain writer running this long after Files is back, to see recovery
LATENCY_P95_MS = env_float("SOAK_LATENCY_P95_MS", 1000, 1, 600000)
LOCK_SECONDS = env_int("SOAK_LOCK_SECONDS", 30, 5, 900)
API_SAMPLE = env_int("SOAK_API_SAMPLE", 40, 0, 5000)
TEST_LABEL = "sulla-soak=1"

# In-container holders for the handles check. Only fds 0-9 are valid in POSIX sh / busybox ash,
# so neither script ever names an fd above 9. Each holder gets its own process with one fd (3).
# Python path: one process opens N files, writes, reads back and reports errno names.
HANDLES_PYTHON_SCRIPT = r'''
import errno, json, os, sys
folder, count = sys.argv[1], int(sys.argv[2])
handles, errors, readback_bad = [], {}, 0
for index in range(count):
    path = os.path.join(folder, "h%d" % index)
    try:
        handle = open(path, "w+b")
    except OSError as exc:
        name = errno.errorcode.get(exc.errno, str(exc.errno))
        errors[name] = errors.get(name, 0) + 1
        continue
    handles.append(handle)
    payload = b"v%d" % index
    try:
        handle.write(payload)
        handle.flush()
        handle.seek(0)
        if handle.read() != payload:
            readback_bad += 1
    except OSError as exc:
        name = errno.errorcode.get(exc.errno, str(exc.errno))
        errors[name] = errors.get(name, 0) + 1
summary = ",".join("%s:%d" % item for item in sorted(errors.items())) or "none"
print("mode=python opened=%d readback_bad=%d errors=%s" % (len(handles), readback_bad, summary), flush=True)
for handle in handles:
    handle.close()
'''

# Sh path (no python in the image): one backgrounded sh per file. Each child opens fd 3 on its file
# (redirection error goes to e<i>), writes v<i>, reads it back, records ok<i> or bad<i>, then holds fd 3.
HANDLES_SH_SCRIPT = (
    'd="$1"; n="$2"; s="$(mktemp -d 2>/dev/null || echo /tmp/handles-$$)"; mkdir -p "$s"; i=0\n'
    'while [ "$i" -lt "$n" ]; do\n'
    '  sh -c \'if printf "v%s" "$1" >&3 && [ "$(cat "$2")" = "v$1" ]; then : >"$3/ok$1"; else : >"$3/bad$1"; fi; sleep 25\' sh "$i" "$d/h$i" "$s" >/dev/null 2>"$s/e$i" 3>"$d/h$i" &\n'
    '  i=$((i+1))\n'
    'done\n'
    't=0\n'
    'while :; do\n'
    '  done_n=0\n'
    '  for f in "$s"/ok* "$s"/bad*; do [ -e "$f" ] && done_n=$((done_n+1)); done\n'
    '  for f in "$s"/e*; do [ -s "$f" ] && done_n=$((done_n+1)); done\n'
    '  [ "$done_n" -ge "$n" ] && break\n'
    '  t=$((t+1)); [ "$t" -ge 60 ] && break\n'
    '  sleep 1\n'
    'done\n'
    'ok=0; bad=0; emfile=0; eacces=0; enospc=0; other=0\n'
    'for f in "$s"/ok*; do [ -e "$f" ] && ok=$((ok+1)); done\n'
    'for f in "$s"/bad*; do [ -e "$f" ] && bad=$((bad+1)); done\n'
    'for f in "$s"/e*; do [ -s "$f" ] || continue; case "$(cat "$f")" in\n'
    '  *"Too many open"*) emfile=$((emfile+1));; *"Permission denied"*) eacces=$((eacces+1));;\n'
    '  *"No space"*) enospc=$((enospc+1));; *) other=$((other+1));;\n'
    'esac; done\n'
    'echo "mode=sh opened=$ok readback_bad=$bad errors=EMFILE:$emfile,EACCES:$eacces,ENOSPC:$enospc,other:$other"\n'
)
ERRNO_TEXT = re.compile(r"[A-Za-z /-]+$")

# Runs inside sulla_files_fuse (python3 -I -c). The token is read there and never leaves it.
CONTAINER_API = r'''
import collections, hashlib, json, sys, time, urllib.parse, urllib3
urllib3.disable_warnings()
base, token_file = sys.argv[1], sys.argv[2]
http = urllib3.PoolManager(cert_reqs="CERT_NONE", timeout=urllib3.Timeout(connect=5, read=90), retries=False)
def token():
    with open(token_file, "rb") as handle:
        return handle.read().strip().decode("ascii")
def call_full(method, path, body=None, headers=None):
    head = {"Authorization": "Bearer " + token()}
    head.update(headers or {})
    response = http.request(method, base + path, body=body, headers=head)
    return response.status, response.data, response.headers
def call(method, path, body=None, headers=None):
    status, data, _headers = call_full(method, path, body, headers)
    return status, data
def sha256_hex(data):
    return hashlib.sha256(data).hexdigest()
def read_back(query):
    """sha256 of the content the server now holds at this path: what was actually written, read back."""
    status, data = call("GET", "/v1/fuse/entry?" + query)
    if status != 200:
        return None, "entry_http_%d" % status
    file_id = json.loads(data).get("id")
    if file_id is None:
        return None, "entry_without_id"
    status, content = call("GET", "/v1/fuse/files/%s/content" % urllib.parse.quote(str(file_id), safe=""))
    if status != 200:
        return None, "content_http_%d" % status
    return sha256_hex(content), None
def reason_of(data):
    try:
        body = json.loads(data)
    except ValueError:
        return ""
    text = body.get("message") or body.get("error") if isinstance(body, dict) else None
    return str(text)[:120] if text else ""
def find_id(node, name):
    if isinstance(node, dict):
        if node.get("name") == name and node.get("id") is not None:
            return node.get("id")
        for value in node.values():
            found = find_id(value, name)
            if found is not None:
                return found
    elif isinstance(node, list):
        for value in node:
            found = find_id(value, name)
            if found is not None:
                return found
    return None
request = json.loads(sys.stdin.read() or "{}")
action = request.get("action")
out = {"action": action}
if action == "metrics":
    seen = {}
    for path in ("/internal/metrics", "/metrics"):
        try:
            status, data = call("GET", path)
        except Exception as exc:
            seen[path] = type(exc).__name__
            continue
        seen[path] = status
        if status == 200:
            names = [line.split("{")[0].split(" ")[0] for line in data.decode("utf-8", "replace").splitlines() if line and not line.startswith("#")]
            out["metric_names"] = sorted({n for n in names if "pool" in n or "fsync" in n})[:30]
            break
    out["probed"] = seen
if action == "resolve":
    collection_id, via = None, None
    if request.get("name"):
        status, data = call("GET", "/v1/collections")
        out["collections_status"] = status
        if status == 200:
            collection_id = find_id(json.loads(data), request["name"])
            via = "collection-name" if collection_id is not None else None
    if collection_id is None:
        status, data = call("GET", "/v1/fuse/directory?" + urllib.parse.urlencode({"path": ""}))
        out["directory_status"] = status
        if status == 200:
            collection_id, via = json.loads(data).get("rootCollectionId"), "home"
    out.update({"collectionId": collection_id, "via": via})
elif action == "write":
    started = time.monotonic()
    content = request["content"].encode("utf-8")
    digest = hashlib.sha256(content).hexdigest()
    query = urllib.parse.urlencode({"collectionId": request["collectionId"], "path": request["path"]})
    status, data = call("GET", "/v1/fuse/entry?" + query)
    entry = json.loads(data) if status == 200 else {}
    if entry.get("kind") == "file" and entry.get("id") is not None:
        # Overwrite is version-checked. If-Match names the version we are replacing, and X-Sulla-Source-Hash must
        # be the sha256 of that BASE version (the server compares it to the stored base), not of the new content.
        # Read the base first so both values come from the same version.
        file_path = "/v1/fuse/files/%s/content" % urllib.parse.quote(str(entry["id"]), safe="")
        out["mode"] = "overwrite"
        base_status, base_data, base_headers = call_full("GET", file_path)
        out["base_status"] = base_status
        if base_status == 200:
            version = (base_headers.get("ETag") or "").strip() or ('"%s"' % entry.get("versionId", ""))
            headers = {"Content-Type": "application/octet-stream", "If-Match": version,
                       "X-Sulla-Source-Hash": sha256_hex(base_data), "X-Sulla-Content-Hash": digest}
            status, data = call("PUT", file_path, body=content, headers=headers)
        else:
            status, data = base_status, b""
    else:
        status, data = call("POST", "/v1/fuse/files?" + query, body=content, headers={"Content-Type": "application/octet-stream"})
        out["mode"] = "create"
    applied = 200 <= status < 300
    # Only a 2xx write counts. Its ledger hash is read back from the server afterwards, not taken from the request.
    written, readback_error = read_back(query) if applied else (None, None)
    out.update({"status": status, "ms": round((time.monotonic() - started) * 1000, 2), "sha256": digest,
                "written_sha256": written, "readback_error": readback_error, "reason": "" if applied else reason_of(data)})
elif action == "verify":
    counts = collections.Counter()
    for path, expected in request["items"]:
        query = urllib.parse.urlencode({"collectionId": request["collectionId"], "path": path})
        status, data = call("GET", "/v1/fuse/entry?" + query)
        if status != 200:
            counts["unresolved"] += 1
            counts["entry_http_%d" % status] += 1
            continue
        file_id = json.loads(data).get("id")
        if file_id is None:
            counts["unresolved"] += 1
            continue
        status, content = call("GET", "/v1/fuse/files/%s/content" % urllib.parse.quote(str(file_id), safe=""))
        if status != 200:
            counts["content_http_%d" % status] += 1
        elif hashlib.sha256(content).hexdigest() == expected:
            counts["matched"] += 1
        else:
            counts["mismatch"] += 1
    out["counts"] = dict(counts)
print(json.dumps(out))
'''

# Runs inside sulla_files (node). The local token comes from the container env and is never printed:
# only the HTTP status and the JSON body of GET /v1/local/files-metrics leave the container.
METRICS_PROBE = r'''
const https = require('https'), http = require('http');
const token = process.env.SULLA_FILES_LOCAL_TOKEN || '';
const port = process.env.SULLA_FILES_PORT || '8792';
if (!token) { console.log(JSON.stringify({ error: 'no_local_token' })); process.exit(0); }
function get(client, options) {
  return new Promise(resolve => {
    const req = client.request(options, res => { let body = ''; res.on('data', c => body += c); res.on('end', () => resolve({ status: res.statusCode, body })); });
    req.on('error', e => resolve({ error: e.code || e.name }));
    req.setTimeout(10000, () => { req.destroy(); resolve({ error: 'timeout' }); });
    req.end();
  });
}
const options = { host: '127.0.0.1', port, path: '/v1/local/files-metrics', method: 'GET', headers: { 'x-sulla-files-token': token }, rejectUnauthorized: false };
(async () => {
  let result = await get(https, options);
  if (result.error) result = await get(http, options);
  console.log(JSON.stringify(result));
})();
'''


class CheckFailure(Exception):
    pass


def err_name(exc):
    code = getattr(exc, "errno", None)
    if code:
        return "%s(%s)" % (errno.errorcode.get(code, str(code)), os.strerror(code))
    return type(exc).__name__


def err_key(exc):
    return err_name(exc).split("(")[0]


def short_err(text):
    """Last segment of a shell/OS error line: the errno text, without any path."""
    lines = [line for line in (text or "").strip().splitlines() if line.strip()]
    if not lines:
        return ""
    return lines[-1].split(": ")[-1].strip()[:80]


def pct(values, p):
    if not values:
        return None
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, int(round(p * (len(ordered) - 1)))))
    return round(ordered[index], 2)


def adapter_log_near(when):
    """The `files-request` lines the FUSE adapter logged within 5 s of `when`, from docker logs (last 10, shortened)."""
    since = datetime.datetime.fromtimestamp(max(0.0, when - 5), datetime.timezone.utc).isoformat()
    try:
        proc = subprocess.run(["docker", "logs", "-t", "--since", since, CONTAINER_FUSE], stdout=subprocess.PIPE,
                              stderr=subprocess.STDOUT, text=True, timeout=20)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return ["docker logs failed: %s" % type(exc).__name__]
    lines = []
    for line in proc.stdout.splitlines():
        stamp, _sep, body = line.partition(" ")
        moment = parse_rfc3339(stamp)
        if moment is None or abs(moment - when) > 5 or "files-request" not in body:
            continue
        lines.append(body[:300])
    return lines[-10:]


def record_eio(error, op, when=None):
    """Append one line to eio-events.jsonl for an EIO: time, phase, path, op, errno and the adapter's files-request lines."""
    if getattr(error, "errno", None) != errno.EIO or not EIO_CONTEXT["root"]:
        return
    when = time.time() if when is None else when
    with EIO_LOCK:
        EIO_COUNTS[EIO_CONTEXT["phase"]] += 1
        capture = EIO_CAPTURES[0] < EIO_CAPTURE_CAP
        EIO_CAPTURES[0] += 1
    adapter = adapter_log_near(when) if capture else ["not captured: per-process capture cap reached"]
    row = {"run": EIO_CONTEXT["run"], "root": EIO_CONTEXT["root"], "t": round(when, 3),
           "time": datetime.datetime.fromtimestamp(when, datetime.timezone.utc).isoformat(),
           "phase": EIO_CONTEXT["phase"], "path": str(getattr(error, "filename", None) or ""), "op": op,
           "errno": "EIO", "adapter_log": adapter}
    line = json.dumps(row, sort_keys=True, separators=(",", ":"))
    with EIO_LOCK:
        with EIO_LOG.open("a", encoding="utf-8") as log:
            log.write(line + "\n")


def parse_rfc3339(text):
    match = re.match(r"(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(\.\d+)?(Z|[+-]\d\d:\d\d)", text)
    if not match:
        return None
    fraction = (match.group(2) or ".0")[:7].ljust(7, "0")
    zone = match.group(3).replace("Z", "+00:00")
    try:
        when = datetime.datetime.fromisoformat(match.group(1) + zone)
    except ValueError:
        return None
    return when.timestamp() + float(fraction)


class ChurnWriter(threading.Thread):
    """Writes checksummed 256 KiB files. Each logical write is retried until it succeeds or `give_up` is set.

    A write that fails during an outage is not dropped: it keeps retrying, so a write started during the
    outage either completes after recovery (ok) or is still outstanding when `give_up` fires (failed).
    `pending` is the logical write in flight; a hung write leaves it set.
    """

    def __init__(self, folder, tag, give_up, pace=0.2, retry_pause=0.5):
        super().__init__(daemon=True)
        self.folder = folder
        self.tag = tag
        self.stop_event = threading.Event()  # set = start no new logical writes
        self.give_up = give_up  # set = abandon the logical write in flight
        self.pace = pace
        self.retry_pause = retry_pause
        self.rows = []  # (name, sha256) for logical writes that completed
        self.logical = []  # dicts: name, started, ended, ok, attempts, errors
        self.ops = []  # (started_monotonic, latency_ms, ok, error_key) per attempt
        self.pending = None
        self.index = 0

    def run(self):
        while not self.stop_event.is_set() and not self.give_up.is_set():
            name = "%s-%06d.bin" % (self.tag, self.index)
            self.index += 1
            data = hashlib.sha256(name.encode()).digest() * 8192
            sha = hashlib.sha256(data).hexdigest()
            record = {"name": name, "started": time.monotonic(), "ended": None, "ok": False, "attempts": 0, "errors": collections.Counter()}
            self.pending = record
            while not self.give_up.is_set():
                attempt_started = time.monotonic()
                record["attempts"] += 1
                try:
                    with (self.folder / name).open("wb") as handle:
                        handle.write(data)
                        handle.flush()
                        os.fsync(handle.fileno())
                    self.ops.append((attempt_started, (time.monotonic() - attempt_started) * 1000, True, ""))
                    record["ok"] = True
                    break
                except OSError as exc:
                    record_eio(exc, "write")
                    key = err_key(exc)
                    record["errors"][key] += 1
                    self.ops.append((attempt_started, (time.monotonic() - attempt_started) * 1000, False, key))
                    self.give_up.wait(self.retry_pause)
            record["ended"] = time.monotonic()
            self.logical.append(record)
            if record["ok"]:
                self.rows.append((name, sha))
            self.pending = None
            self.stop_event.wait(self.pace)


class PlainWriter(threading.Thread):
    """One SINGLE-ATTEMPT write every `interval` seconds, with no harness retry.

    The outcome is the mount's own: ok, or the errno it returned, plus latency. Under bounded waits a
    blocked attempt returns later with ok; under the old behaviour it returned EIO at once. An attempt
    that never returns stays in `inflight` and the caller reports it as hung.
    """

    def __init__(self, folder, tag, stop_event, interval=PLAIN_INTERVAL_S):
        super().__init__(daemon=True)
        self.folder = folder
        self.tag = tag
        self.stop_event = stop_event
        self.interval = interval
        self.attempts = []  # dicts: started (monotonic), ms, ok, errno, name
        self.rows = []  # (name, sha256) for attempts that returned success
        self.inflight = None  # monotonic start of the attempt that has not returned yet
        self.index = 0

    def run(self):
        while not self.stop_event.is_set():
            tick = time.monotonic()
            name = "%s-%06d.bin" % (self.tag, self.index)
            self.index += 1
            data = hashlib.sha256(name.encode()).digest() * 4096
            self.inflight = tick
            try:
                with (self.folder / name).open("wb") as handle:
                    handle.write(data)
                    handle.flush()
                    os.fsync(handle.fileno())
                self.attempts.append({"started": tick, "ms": (time.monotonic() - tick) * 1000, "ok": True, "errno": "", "name": name})
                self.rows.append((name, hashlib.sha256(data).hexdigest()))
            except OSError as exc:
                record_eio(exc, "write")
                self.attempts.append({"started": tick, "ms": (time.monotonic() - tick) * 1000, "ok": False, "errno": err_key(exc), "name": name})
            finally:
                self.inflight = None
            self.stop_event.wait(max(0.0, self.interval - (time.monotonic() - tick)))


class FilesSoak:
    def __init__(self, phase, with_app_restart, extra_args=()):
        self.phase = phase
        self.requested_phase = phase
        self.with_app_restart = with_app_restart
        self.extra_args = list(extra_args)
        self.run_id = ENV.get("SOAK_RUN") or datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        self.failures = 0
        self.checks = 0
        self.errors = collections.Counter()
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        self.root = self._get_run_root()
        EIO_CONTEXT.update(run=self.run_id, root=str(self.root), phase=phase)

    # ----- layout and state -------------------------------------------------------------

    def _personal_collection(self):
        override = ENV.get("SOAK_PARENT")
        if override:
            target = Path(override)
            if not target.is_dir():
                raise CheckFailure("SOAK_PARENT is not a directory")
            return target
        if not MOUNT.is_dir():
            raise CheckFailure("Files mount is unavailable")
        entries = sorted((p for p in MOUNT.iterdir() if p.is_dir() and not p.name.startswith(".")), key=lambda p: p.name.casefold())
        if not entries:
            raise CheckFailure("no collection directories are visible at the Files mount")
        preferred = ("Files", "Personal", "My Files", "Personal Files")
        for name in preferred:
            match = next((p for p in entries if p.name.casefold() == name.casefold()), None)
            if match:
                return match
        non_org = [p for p in entries if p.name.casefold() not in {"organizations", "shared", "trash", "recently deleted"}]
        if len(non_org) == 1:
            return non_org[0]
        if len(non_org) > 1:
            # Never guess between multiple personal roots: that could put QA data in the wrong collection.
            raise CheckFailure("personal collection is ambiguous; expected Files, Personal, or one non-organization collection")
        raise CheckFailure("no personal collection directory found (only organization/system folders are visible)")

    def _get_run_root(self):
        if STATE.exists():
            try:
                saved = json.loads(STATE.read_text(encoding="utf-8"))
                root = Path(saved["root"]).resolve()
                parent = Path(saved["parent"]).resolve()
                if parent == self._personal_collection().resolve() and root.parent == parent and root.name.startswith("files-soak-"):
                    root.mkdir(parents=True, exist_ok=True)
                    return root
            except (OSError, ValueError, KeyError, TypeError):
                pass
            raise CheckFailure("saved soak state does not identify a safe child of the detected personal collection; inspect state before removing it")
        parent = self._personal_collection().resolve()
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        root = parent / ("files-soak-" + stamp)
        root.mkdir(mode=0o700)
        STATE.write_text(json.dumps({"root": str(root), "parent": str(parent), "stamp": stamp}), encoding="utf-8")
        return root

    # ----- process helpers --------------------------------------------------------------

    @staticmethod
    def _run(args, timeout=COMMAND_TIMEOUT, check=True, **kwargs):
        try:
            result = subprocess.run(args, timeout=timeout, check=False, stdout=subprocess.PIPE,
                                    stderr=subprocess.PIPE, text=True, **kwargs)
        except subprocess.TimeoutExpired as exc:
            raise CheckFailure("command timed out after %ss" % timeout) from exc
        if check and result.returncode:
            raise CheckFailure("command exited with status %d" % result.returncode)
        return result

    @classmethod
    def _docker(cls, args, timeout=COMMAND_TIMEOUT):
        return cls._run(["docker", *args], timeout=timeout, check=False)

    @staticmethod
    def _probe(argv, timeout=OP_BOUND_S):
        """Run one operation with a hard bound. A hung child is abandoned, never waited on."""
        started = time.monotonic()
        proc = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            out, err = proc.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            try:
                proc.kill()
            except OSError:
                pass
            return {"rc": None, "hung": True, "ms": (time.monotonic() - started) * 1000, "out": b"", "err": "timeout"}
        error_text = short_err(err.decode("utf-8", "replace"))
        if proc.returncode and error_text == os.strerror(errno.EIO):
            record_eio(OSError(errno.EIO, error_text, next((str(arg) for arg in argv if str(MOUNT) in str(arg)), "")), "probe")
        return {"rc": proc.returncode, "hung": False, "ms": (time.monotonic() - started) * 1000,
                "out": out, "err": error_text}

    def _ctr(self, name, script, *args, timeout=OP_BOUND_S):
        return self._probe(["docker", "exec", name, "sh", "-c", script, "sh", *args], timeout=timeout)

    @staticmethod
    def _sha(path):
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for block in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(block)
        return digest.hexdigest()

    @staticmethod
    def _write_bytes(path, size, seed):
        seed_bytes = seed.encode("utf-8")
        block = hashlib.sha256(seed_bytes).digest()
        with path.open("wb") as handle:
            remaining = size
            counter = 0
            while remaining:
                chunk = hashlib.sha256(block + counter.to_bytes(8, "big")).digest()
                chunk = (chunk * ((min(remaining, len(chunk)) + len(chunk) - 1) // len(chunk)))[:min(remaining, len(chunk))]
                handle.write(chunk)
                remaining -= len(chunk)
                counter += 1
            handle.flush()
            os.fsync(handle.fileno())

    def _probe_mount(self, timeout=5):
        self._run(["timeout", str(timeout), "ls", "-A", str(MOUNT)], timeout=timeout + 2)

    def _wait_mount(self, cap=MOUNT_WAIT_S):
        started = time.monotonic()
        deadline = started + cap
        while time.monotonic() < deadline:
            try:
                self._probe_mount()
                return round(time.monotonic() - started, 3)
            except Exception:
                time.sleep(1)
        raise CheckFailure("mount did not answer ls within %d seconds" % cap)

    def _container_running(self, name):
        result = self._docker(["inspect", "-f", "{{.State.Running}}", name], 15)
        return result.returncode == 0 and result.stdout.strip() == "true"

    def _wait_container_ready(self, name, cap=240):
        started = time.monotonic()
        while time.monotonic() - started < cap:
            result = self._docker(["inspect", "-f", "{{.State.Running}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}", name], 15)
            parts = result.stdout.split()
            if result.returncode == 0 and len(parts) == 2 and parts[0] == "true" and parts[1] in ("healthy", "none"):
                return round(time.monotonic() - started, 2)
            time.sleep(2)
        raise CheckFailure("%s not running and healthy within %ds" % (name, cap))

    def ensure_files_running(self):
        # Restore trap: a paused hold is released first (a no-op error when not paused), then a stopped container is started.
        self._docker(["unpause", CONTAINER_FILES], 30)
        if not self._container_running(CONTAINER_FILES):
            self._docker(["start", CONTAINER_FILES], 90)

    def files_state(self):
        """Docker's view of sulla_files: status, start/finish times and restart count. Desktop's heal shows up here."""
        result = self._docker(["inspect", "-f", "{{.State.Status}}|{{.State.StartedAt}}|{{.State.FinishedAt}}|{{.RestartCount}}", CONTAINER_FILES], 15)
        parts = result.stdout.strip().split("|")
        if result.returncode != 0 or len(parts) != 4:
            return {"status": "missing", "started_at": "", "finished_at": "", "restarts": None, "at": round(time.time(), 2)}
        return {"status": parts[0], "started_at": parts[1], "finished_at": parts[2],
                "restarts": int(parts[3]) if parts[3].isdigit() else None, "at": round(time.time(), 2)}

    @staticmethod
    def _down_seconds(finished_at, started_at):
        stopped, started = parse_rfc3339(finished_at or ""), parse_rfc3339(started_at or "")
        return round(started - stopped, 2) if stopped and started and started >= stopped else None

    def _soak_image(self):
        """First local image that really provides sh and sleep (the probe runs the tools, so a missing one is caught here)."""
        if getattr(self, "_image", None):
            return self._image
        images = self._docker(["images", "--format", "{{.Repository}}:{{.Tag}}"], 30).stdout.split()
        candidates = [ENV["SOAK_TEST_IMAGE"]] if ENV.get("SOAK_TEST_IMAGE") else []
        fuse = self._docker(["inspect", "-f", "{{.Config.Image}}", CONTAINER_FUSE], 15)
        if fuse.returncode == 0 and fuse.stdout.strip():
            candidates.append(fuse.stdout.strip())
        for prefix in ("alpine:", "busybox:"):
            candidates += [name for name in images if name.startswith(prefix)]
        # Prefer an image with python3 (one process holds all N files); keep an sh-only image as fallback.
        probe_script = ("command -v sh && command -v sleep && command -v printf >/dev/null && "
                        "{ command -v python3 >/dev/null && echo python || echo sh-only; }")
        rejected = []
        sh_only = None
        for image in dict.fromkeys(candidates):
            probe = self._docker(["run", "--rm", "--network", "none", "--entrypoint", "sh", image, "-c", probe_script], 90)
            if probe.returncode != 0:
                rejected.append("%s rc=%d" % (image, probe.returncode))
                continue
            if "python" in probe.stdout.split():
                self._image, self._image_python = image, True
                return image
            sh_only = sh_only or image
        if sh_only:
            self._image, self._image_python = sh_only, False
            return sh_only
        raise CheckFailure("no local image provides sh and sleep for a test container (%s)" % ("; ".join(rejected) or "no candidates"))

    def _start_test_container(self, name, image):
        self._run(["docker", "run", "-d", "--name", name, "--label", TEST_LABEL, "-v", bind_spec(),
                   "--entrypoint", "sleep", image, "1800"], timeout=90)

    def _remove_test_containers(self, names):
        for name in names:
            self._docker(["rm", "-f", name], 60)

    # ----- results ----------------------------------------------------------------------

    def emit(self, check, ok, evidence, started, metrics=None):
        record = {"run": self.run_id, "phase": self.phase, "check": check, "pass": bool(ok),
                  "metrics": metrics or {}, "evidence": str(evidence)[:400],
                  "ms": round((time.monotonic() - started) * 1000)}
        line = json.dumps(record, sort_keys=True, separators=(",", ":"), default=str)
        print(line, flush=True)
        with RESULTS.open("a", encoding="utf-8") as log:
            log.write(line + "\n")
        self.checks += 1
        if not ok:
            self.failures += 1

    def check(self, name, work):
        """work() returns evidence text, or (metrics dict, evidence text)."""
        started = time.monotonic()
        try:
            result = work()
            metrics, evidence = result if isinstance(result, tuple) else ({}, result)
            self.emit(name, True, evidence, started, metrics)
        except Exception as exc:  # A failed operation is evidence; continue with the remaining checks.
            if isinstance(exc, OSError):
                record_eio(exc, "check")
            self.emit(name, False, "%s: %s" % (type(exc).__name__, str(exc)[:180]), started)

    def note_error(self, exc, op="op"):
        key = err_key(exc) if isinstance(exc, OSError) else type(exc).__name__
        self.errors[key] += 1
        if isinstance(exc, OSError):
            record_eio(exc, op)
        return err_name(exc)

    def ledger_add(self, rows):
        with LEDGER.open("a", encoding="utf-8") as log:
            for rel, sha in rows:
                log.write(json.dumps({"root": str(self.root), "run": self.run_id, "rel": rel, "sha": sha}, separators=(",", ":")) + "\n")

    def ledger_rows(self):
        if not LEDGER.is_file():
            return []
        rows = []
        for line in LEDGER.read_text(encoding="utf-8").splitlines():
            try:
                row = json.loads(line)
            except ValueError:
                continue
            if row.get("root") == str(self.root):
                rows.append((row["rel"], row["sha"]))
        return rows

    def _verify_rows(self, folder, rows, cap=600):
        """Checksum each (rel, sha) through the mount with a bounded wait; hung reads count as unverified."""
        def verify(item):
            rel, expected = item
            path = folder / rel
            try:
                if not path.is_file():
                    return "missing"
                return "ok" if self._sha(path) == expected else "mismatch"
            except OSError as exc:
                self.note_error(exc, "read")
                return "error:" + err_key(exc)
        executor = concurrent.futures.ThreadPoolExecutor(max_workers=8)
        futures = [executor.submit(verify, row) for row in rows]
        done, pending = concurrent.futures.wait(futures, timeout=cap)
        executor.shutdown(wait=False, cancel_futures=True)
        counts = collections.Counter(
            "error:" + type(future.exception()).__name__ if future.exception() else future.result() for future in done)
        counts["unverified_timeout"] = len(pending)
        return counts

    # ----- existing phases (kept) -------------------------------------------------------

    def bulk(self):
        def work():
            folder = self.root / "bulk"
            folder.mkdir(exist_ok=True)
            manifest = []
            rng = random.Random(20261117)
            for index in range(2000):
                name = "small-%04d.bin" % index
                size = rng.randint(1024, 8192)
                path = folder / name
                self._write_bytes(path, size, name)
                manifest.append((name, size, self._sha(path)))
            for index in range(15):
                name = "large-%02d.bin" % index
                size = rng.randint(10, 20) * 1024 * 1024
                path = folder / name
                self._write_bytes(path, size, name)
                manifest.append((name, size, self._sha(path)))
            manifest_path = STATE_DIR / "manifest.jsonl"
            with manifest_path.open("w", encoding="utf-8") as output:
                for row in manifest:
                    output.write(json.dumps(row, separators=(",", ":")) + "\n")
            self.ledger_add([("bulk/" + name, sha) for name, _size, sha in manifest])
            digest = hashlib.sha256()
            for name, size, expected in manifest:
                path = folder / name
                if path.stat().st_size != size or self._sha(path) != expected:
                    raise CheckFailure("read-back mismatch in file id %s" % name)
                digest.update((name + ":" + expected + "\n").encode())
            return "files=%d bytes=%d manifest_sha256=%s" % (len(manifest), sum(row[1] for row in manifest), digest.hexdigest())
        self.check("write-read-sha256", work)

    @staticmethod
    def _append_writer(args):
        path, writer_id = args
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        try:
            for sequence in range(200):
                line = ("writer=%02d sequence=%03d\n" % (writer_id, sequence)).encode()
                # One append syscall per complete record; O_APPEND serializes its offset selection.
                os.write(fd, line)
        finally:
            os.close(fd)

    def append(self):
        def work():
            path = self.root / "append" / "parallel.log"
            path.parent.mkdir(exist_ok=True)
            path.write_bytes(b"")
            writers = [multiprocessing.Process(target=self._append_writer, args=((str(path), writer),)) for writer in range(8)]
            for writer in writers:
                writer.start()
            deadline = time.monotonic() + 60
            for writer in writers:
                writer.join(timeout=max(0, deadline - time.monotonic()))
            for writer in writers:
                if writer.is_alive():
                    writer.terminate()
                    writer.join(timeout=5)
                    raise CheckFailure("parallel append writer timed out")
                if writer.exitcode != 0:
                    raise CheckFailure("parallel append writer exited with status %s" % writer.exitcode)
            lines = path.read_text(encoding="utf-8").splitlines()
            expected = {"writer=%02d sequence=%03d" % (writer, seq) for writer in range(8) for seq in range(200)}
            if len(lines) != 1600 or len(set(lines)) != 1600 or set(lines) != expected:
                raise CheckFailure("append records mismatch: lines=%d unique=%d" % (len(lines), len(set(lines))))
            self.ledger_add([("append/parallel.log", self._sha(path))])
            return "writers=8 lines=1600 unique=1600"
        self.check("parallel-append-records", work)

    def ops(self):
        base = self.root / "ops"
        base.mkdir(exist_ok=True)
        file_path = base / "truncate-me.txt"

        def truncate():
            file_path.write_bytes(b"initial payload")
            with file_path.open("wb") as handle:
                handle.truncate(0)
                handle.flush()
                os.fsync(handle.fileno())
            if file_path.stat().st_size != 0:
                raise CheckFailure("file did not truncate to zero")
            return "size=0"
        self.check("truncate-to-zero", truncate)

        def rewrite():
            data = b"rewritten-after-truncate\n"
            file_path.write_bytes(data)
            if file_path.read_bytes() != data:
                raise CheckFailure("rewritten bytes differ")
            return "bytes=%d sha256=%s" % (len(data), hashlib.sha256(data).hexdigest())
        self.check("rewrite", rewrite)

        def rename():
            destination = base / "renamed.txt"
            file_path.rename(destination)
            if file_path.exists() or destination.read_bytes() != b"rewritten-after-truncate\n":
                raise CheckFailure("rename did not preserve data")
            return "renamed=true"
        self.check("rename", rename)

        def move():
            destination_dir = base / "moved"
            destination_dir.mkdir(exist_ok=True)
            source = base / "renamed.txt"
            destination = destination_dir / "renamed.txt"
            source.rename(destination)
            if source.exists() or destination.read_bytes() != b"rewritten-after-truncate\n":
                raise CheckFailure("move did not preserve data")
            return "moved=true"
        self.check("move-between-folders", move)

        def delete():
            path = base / "moved" / "renamed.txt"
            path.unlink()
            if path.exists():
                raise CheckFailure("deleted file still exists")
            return "deleted=true"
        self.check("delete", delete)
        self.emit("restore-from-trash", True, "skipped: no verified guest-side trash-restore API", time.monotonic())
        self.emit("restore-old-version", True, "skipped: no guest-side API credentials or stable version-id lookup", time.monotonic())

    def _crash_writer(self, folder, success_log, stop_event):
        index = 0
        folder = Path(folder)
        log_path = Path(success_log)
        while not stop_event.is_set():
            name = "write-%07d.bin" % index
            target = folder / name
            data = hashlib.sha256(name.encode()).digest() * (CRASH_FILE_BYTES // 32)
            try:
                with target.open("wb") as handle:
                    handle.write(data)
                    handle.flush()
                    os.fsync(handle.fileno())
                digest = hashlib.sha256(data).hexdigest()
                with log_path.open("a", encoding="ascii") as log:
                    log.write("%s %s\n" % (name, digest))
                    log.flush()
                    os.fsync(log.fileno())
            except Exception as exc:
                self.note_error(exc) if isinstance(exc, OSError) else None
            index += 1
            time.sleep(CRASH_INTERVAL)

    def _verify_success_writes(self, folder, success_log):
        if not success_log.exists():
            raise CheckFailure("successful-write log is missing")
        rows = [line.split() for line in success_log.read_text(encoding="ascii").splitlines() if line.strip()]
        verified = 0
        for row in rows:
            if len(row) != 2:
                raise CheckFailure("successful-write log contains a malformed record")
            name, expected = row
            path = folder / name
            if not path.is_file():
                raise CheckFailure("DATA LOSS: successful write missing, id=%s" % name)
            if self._sha(path) != expected:
                raise CheckFailure("DATA LOSS: successful write hash mismatch, id=%s" % name)
            verified += 1
        return "successful_writes=%d verified=%d" % (len(rows), verified)

    def _restart_action(self, name, command, timeout):
        started = time.monotonic()
        try:
            self._run(command, timeout=timeout)
            seconds = self._wait_mount(MOUNT_WAIT_S)
            self.emit(name + "-mount-recovery", True, "seconds=%.3f cap=%d" % (seconds, MOUNT_WAIT_S), started, {"recovery_s": seconds})
        except Exception as exc:
            self.emit(name + "-mount-recovery", False, "%s: %s" % (type(exc).__name__, str(exc)[:160]), started)

    def crash(self):
        folder = self.root / "crash"
        folder.mkdir(exist_ok=True)
        success_log = STATE_DIR / "crash-success.log"
        success_log.touch(exist_ok=True)
        before_rows = len(success_log.read_text(encoding="ascii").splitlines())
        stop_event = threading.Event()
        writer = threading.Thread(target=self._crash_writer, args=(str(folder), str(success_log), stop_event), daemon=True)
        writer.start()
        time.sleep(2)
        self._restart_action("restart-files-container", ["docker", "restart", "--time", "10", CONTAINER_FILES], 40)
        # entrypoint.sh starts the FUSE daemon as python3 .../sulla-files-fuse.py and
        # restarts it itself; terminate only that child, not PID 1/the container.
        self._restart_action("kill-files-fuse-daemon", ["docker", "exec", CONTAINER_FUSE, "pkill", "-f", "^python3 /usr/local/libexec/sulla-files-fuse.py"], 15)
        if self.with_app_restart:
            start = time.monotonic()
            if shutil.which("osascript") and shutil.which("open"):
                try:
                    self._run(["osascript", "-e", 'tell application "Sulla Desktop" to quit'], timeout=30, check=False)
                    self._run(["open", "-g", "-a", "Sulla Desktop"], timeout=30)
                    seconds = self._wait_mount(MOUNT_WAIT_S)
                    self.emit("app-restart-mount-recovery", True, "seconds=%.3f cap=%d" % (seconds, MOUNT_WAIT_S), start)
                except Exception as exc:
                    self.emit("app-restart-mount-recovery", False, "%s: %s" % (type(exc).__name__, str(exc)[:160]), start)
            else:
                self.emit("app-restart-mount-recovery", True, "skipped: osascript/open are not available inside this VM", start)
        stop_event.set()
        writer.join(timeout=10)
        self.check("crash-successful-write-integrity", lambda: self._verify_success_writes(folder, success_log))
        lines = success_log.read_text(encoding="ascii").splitlines()[before_rows:]
        self.ledger_add([("crash/" + line.split()[0], line.split()[1]) for line in lines if len(line.split()) == 2])

    def load(self):
        minutes = env_int("SOAK_MINUTES", 30, 1, 1440)
        duration = minutes * 60
        target = self.root / "load" / "continuous.bin"
        target.parent.mkdir(exist_ok=True)
        background = Path.home() / "Library" / "Logs" / "sulla-desktop" / "background.log"
        initial_size = background.stat().st_size if background.is_file() else None
        started_at = time.monotonic()
        deadline = started_at + duration
        sequence = 0
        drops = 0
        errors = 0
        while time.monotonic() < deadline:
            expected = hashlib.sha256(("load-%d" % sequence).encode()).digest() * 2048
            try:
                with target.open("wb") as handle:
                    handle.write(expected)
                    handle.flush()
                    os.fsync(handle.fileno())
                if target.read_bytes() != expected:
                    errors += 1
            except Exception as exc:
                self.note_error(exc) if isinstance(exc, OSError) else None
                errors += 1
            try:
                self._probe_mount()
            except Exception:
                drops += 1
            sequence += 1
            next_probe = started_at + sequence * 10
            if time.monotonic() < next_probe:
                time.sleep(next_probe - time.monotonic())
        if background.is_file() and initial_size is not None:
            try:
                with background.open("rb") as handle:
                    handle.seek(initial_size)
                    text = handle.read().decode("utf-8", "replace")
                restarts = len(re.findall(r"sulla_files is unhealthy; restarting", text, re.IGNORECASE))
                log_state = "supervisor_restarts=%d" % restarts
            except Exception:
                log_state = "supervisor_restarts=unavailable"
        else:
            log_state = "supervisor_restarts=unavailable (background.log not visible in VM)"
        self.emit("continuous-read-write-probes", errors == 0 and drops == 0,
                  "duration_s=%d writes=%d readwrite_errors=%d mount_drops=%d %s" % (duration, sequence, errors, drops, log_state), started_at,
                  {"duration_s": duration, "writes": sequence, "readwrite_errors": errors, "mount_drops": drops})

    def cloud(self):
        # sync_state in /v1/files is the local hydration/conflict state; cloud-head rows are
        # server-side internals, not a per-file guest API. Don't report hydration as cloud-synced.
        started = time.monotonic()
        self.emit("per-file-cloud-sync", True,
                  "skipped: Files exposes cloud heads internally, but no supported guest endpoint reports per-file cloud commit state", started)

    # ----- kill / measurement phases ----------------------------------------------------

    def fuse_identity(self):
        started = time.monotonic()
        result = self._docker(["inspect", CONTAINER_FUSE], 20)
        if result.returncode != 0:
            self.emit("fuse-identity", False, "container %s not found" % CONTAINER_FUSE, started)
            return
        info = json.loads(result.stdout)[0]
        metrics = {
            "id": info.get("Id", "")[:12],
            "created": info.get("Created"),
            "started_at": info.get("State", {}).get("StartedAt"),
            "image": info.get("Config", {}).get("Image"),
            "image_id": (info.get("Image") or "")[:19],
            "restart_count": info.get("RestartCount"),
            "mount": str(MOUNT),
            "bind_spec": bind_spec(),
        }
        self.emit("fuse-identity", True, "id=%s started_at=%s" % (metrics["id"], metrics["started_at"]), started, metrics)

    def restart_propagation(self):
        folder = self.root / "restart-propagation"
        folder.mkdir(exist_ok=True)
        name = "fusesoak-" + datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d%H%M%S")
        started = time.monotonic()
        metrics = {"bind_spec": bind_spec()}
        try:
            self._start_test_container(name, self._soak_image())
            pre = self._ctr(name, 'printf %s "$2" > "$1" && cat "$1"', str(folder / "before.txt"), "pre-" + self.run_id)
            metrics["pre_write_ok"] = pre["rc"] == 0 and pre["out"].decode("utf-8", "replace") == "pre-" + self.run_id
            if not metrics["pre_write_ok"]:
                raise CheckFailure("pre-restart write/read failed: %s" % pre["err"])
            self._run(["docker", "restart", "--time", "10", CONTAINER_FUSE], timeout=120)
            metrics["mount_recovery_s"] = self._wait_mount(MOUNT_WAIT_S)
            ls = self._ctr(name, 'ls "$1" >/dev/null', str(folder))
            write = self._ctr(name, 'printf %s "$2" > "$1" && cat "$1"', str(folder / "after.txt"), "post-" + self.run_id)
            old = self._ctr(name, 'cat "$1" >/dev/null', str(folder / "before.txt"))
            metrics.update({"post_ls_ok": ls["rc"] == 0, "post_write_read_ok": write["rc"] == 0 and write["out"].decode("utf-8", "replace") == "post-" + self.run_id,
                            "pre_file_read_ok": old["rc"] == 0, "post_ls_errno": errno_of_text(ls["err"]) if ls["rc"] else None,
                            "post_write_errno": errno_of_text(write["err"]) if write["rc"] else None})
            evidence = "ls_err=%s write_err=%s" % (ls["err"] or "none", write["err"] or "none")
            if write["rc"] == 0:
                self.ledger_add([("restart-propagation/after.txt", hashlib.sha256(("post-" + self.run_id).encode()).hexdigest())])
            passed = metrics["post_ls_ok"] and metrics["post_write_read_ok"]
            self.emit("restart-propagation", passed, evidence, started, metrics)
        except Exception as exc:
            self.emit("restart-propagation", False, "%s: %s" % (type(exc).__name__, str(exc)[:200]), started, metrics)
        finally:
            self._remove_test_containers([name])

    def outage(self):
        folder = self.root / "outage"
        folder.mkdir(exist_ok=True)
        give_up = threading.Event()
        plain_stop = threading.Event()
        # Retrying writers (data-integrity proof). They start at evenly spaced points across the Files-down window,
        # so writes begin at the outage start, a quarter in, half way and three quarters in.
        writers = [ChurnWriter(folder, "wr%d" % index, give_up) for index in range(OUTAGE_WRITER_COUNT)]
        # One plain writer: single attempts, no retry. Its per-attempt outcome is the before/after signal.
        plain = PlainWriter(folder, "plain", plain_stop)
        plain.start()
        probes = []
        try:
            time.sleep(3)
            # Sub-test A: Files down OUTAGE_A_S seconds. Every write started in that window must eventually succeed.
            a_from = time.monotonic()
            stopped = self._docker(["stop", "-t", "10", CONTAINER_FILES], 90)
            down_from = time.monotonic()
            a_stop = self.files_state()
            for index, writer in enumerate(writers):
                time.sleep(max(0.0, down_from + OUTAGE_A_S * index / len(writers) - time.monotonic()))
                writer.start()
            time.sleep(max(0.0, down_from + OUTAGE_A_S - time.monotonic()))
            a_window_end = self.files_state()  # before the restart: Desktop's heal would show here as a new StartedAt
            self._docker(["start", CONTAINER_FILES], 90)
            up_at = time.monotonic()
            ready_s = self._wait_container_ready(CONTAINER_FILES, 240)
            a_to = time.monotonic()
            a_up = self.files_state()
            time.sleep(PLAIN_POST_S)
            drain_deadline = time.monotonic() + OP_BOUND_S
            while time.monotonic() < drain_deadline and any(w.pending is not None for w in writers):
                time.sleep(1)
            plain_stop.set()
            for writer in writers:
                writer.stop_event.set()
            give_up.set()
            for writer in writers:
                if writer.ident is not None:
                    writer.join(timeout=30)
            plain.join(timeout=10)
            a_records = [rec for w in writers for rec in w.logical if a_from <= rec["started"] <= a_to]
            a_ok = [rec for rec in a_records if rec["ok"]]
            a_failed = [rec for rec in a_records if not rec["ok"]]
            sha_by_name = {name: sha for w in writers for name, sha in w.rows}
            a_counts = self._verify_rows(folder, [(rec["name"], sha_by_name[rec["name"]]) for rec in a_ok]) if a_ok else collections.Counter()
            durations = [(rec["ended"] - rec["started"]) * 1000 for rec in a_ok]
            a_errors = collections.Counter()
            for rec in a_records:
                a_errors.update(rec["errors"])
            plain_attempts = [{"t_s": round(att["started"] - a_from, 2), "phase": self._outage_phase(att["started"], down_from, up_at),
                               "ok": att["ok"], "errno": att["errno"] or None, "ms": round(att["ms"], 1)} for att in plain.attempts]
            plain_by_phase = {}
            for phase_name in ("before", "down", "after"):
                rows_in = [row for row in plain_attempts if row["phase"] == phase_name]
                plain_by_phase[phase_name] = {"attempts": len(rows_in), "ok": sum(1 for row in rows_in if row["ok"]),
                                              "errno": dict(collections.Counter(row["errno"] for row in rows_in if not row["ok"])),
                                              "max_ms": round(max((row["ms"] for row in rows_in), default=0), 1)}
            plain_inflight_s = None if plain.inflight is None else round(time.monotonic() - plain.inflight, 1)
            a_valid = a_window_end["status"] == "exited" and a_window_end["started_at"] == a_stop["started_at"]
            a_prefix = "" if a_valid else "INVALID (Files was not held down for the window; Desktop restarted it) "
            a_down_s = self._down_seconds(a_stop["finished_at"], a_up["started_at"])
            a_metrics = {"stop_rc": stopped.returncode, "down_s": OUTAGE_A_S, "actual_down_s": a_down_s, "valid": a_valid,
                         "state_after_stop": a_stop, "state_window_end": a_window_end, "state_after_ready": a_up,
                         "writes_started": len(a_records), "writes_ok": len(a_ok),
                         "writes_failed": len(a_failed), "attempt_errors": dict(a_errors), "p50_ms": pct(durations, 0.5),
                         "p95_ms": pct(durations, 0.95), "max_ms": round(max(durations, default=0), 1), "ready_s": ready_s,
                         "verified": a_counts.get("ok", 0), "mismatch": a_counts.get("mismatch", 0), "missing": a_counts.get("missing", 0),
                         "unverified": a_counts.get("unverified_timeout", 0), "retrying_writers": len(writers),
                         "plain_by_phase": plain_by_phase, "plain_inflight_s": plain_inflight_s, "plain_attempts": plain_attempts}
            a_pass = (a_valid and stopped.returncode == 0 and len(a_records) > 0 and not a_failed and a_counts.get("ok", 0) == len(a_ok)
                      and not a_counts.get("mismatch") and not a_counts.get("missing") and not a_counts.get("unverified_timeout"))
            self.emit("outage-a-restart", a_pass,
                      "%sdown=%ds actual_down=%ss retrying_writers=%d started=%d ok=%d failed=%d verified=%d/%d attempt_errors=%s plain=%s" %
                      (a_prefix, OUTAGE_A_S, a_down_s, len(writers), len(a_records), len(a_ok), len(a_failed), a_counts.get("ok", 0), len(a_ok),
                       json.dumps(dict(a_errors), sort_keys=True), json.dumps(plain_by_phase, sort_keys=True)),
                      a_from, a_metrics)

            # Sub-test B: Files held down OUTAGE_B_S seconds (variant: paused = requests hang, stopped = requests refused).
            self.outage_b_window(self.outage_b_variant())
            self.outage_recovery()
        except Exception as exc:
            self.emit("outage", False, "%s: %s" % (type(exc).__name__, str(exc)[:200]), time.monotonic())
        finally:
            give_up.set()
            plain_stop.set()
            for writer in writers:
                writer.stop_event.set()
            for writer in writers:
                if writer.ident is not None:
                    writer.join(timeout=30)
            plain.join(timeout=10)
            self.ensure_files_running()
        # Only writes that returned success are ledgered (a retried write only once it completed; a plain attempt only if it returned ok).
        rows = [row for writer in writers for row in writer.rows] + list(plain.rows)
        self.ledger_add([("outage/" + name, sha) for name, sha in rows])
        counts = self._verify_rows(folder, rows)
        self.emit("outage-successful-write-integrity",
                  len(rows) > 0 and counts.get("ok", 0) == len(rows) and not counts.get("unverified_timeout"),
                  "successful_writes=%d verified=%d mismatch=%d missing=%d unverified=%d" % (len(rows), counts.get("ok", 0), counts.get("mismatch", 0),
                                                                                         counts.get("missing", 0), counts.get("unverified_timeout", 0)),
                  time.monotonic(), {"successful_writes": len(rows), "verified": counts.get("ok", 0), "mismatch": counts.get("mismatch", 0),
                                     "missing": counts.get("missing", 0), "unverified": counts.get("unverified_timeout", 0)})

    def outage_b_variant(self):
        variant = self.extra_args[0] if self.extra_args else "paused"
        if variant not in OUTAGE_B_VARIANTS:
            raise CheckFailure("outage-b variant must be one of %s, got %s" % ("/".join(OUTAGE_B_VARIANTS), variant))
        return variant

    def outage_b(self):
        """Phase `outage-b [paused|stopped]`: Files held down on its own (no writers), then recovered."""
        self.outage_b_window(self.outage_b_variant())
        self.outage_recovery()

    def outage_b_window(self, variant):
        """Hold Files down for OUTAGE_B_S with `variant`, probing every 10 s, and check docker's state the whole time.

        paused:  `docker pause` (the Files process is frozen; requests hang until the adapter's deadline, then EIO).
                 Desktop's heal does not act on it: the watcher counts a paused container as present and healthy,
                 and reconcile starts only a missing or non-running one (sullaContainerHealth.ts, ManagedContainerHealthWatcher.ts).
        stopped: `docker stop` (requests are refused). Desktop's watcher calls an exited container missing within about a
                 minute and reconcile starts it again, so this variant can be INVALID by design; the state samples prove it.
        The window is valid only if Files stayed in the expected state with the same StartedAt and RestartCount for the whole window.
        """
        folder = self.root / "outage"
        folder.mkdir(exist_ok=True)
        check = "outage-b-" + variant
        expected = "paused" if variant == "paused" else "exited"
        started = time.monotonic()
        before = self.files_state()
        samples = []
        probes = []
        held = window_end = None
        try:
            if variant == "paused":
                self._docker(["pause", CONTAINER_FILES], 90)
            else:
                self._docker(["stop", "-t", "10", CONTAINER_FILES], 90)
            b_started = time.monotonic()
            held = self.files_state()
            while time.monotonic() - b_started < OUTAGE_B_S:
                tick = time.monotonic()
                probes.append(self._probe(["sh", "-c", 'printf %s "$2" > "$1"', "sh", str(folder / "probe.txt"), "x"], OP_BOUND_S))
                samples.append(self.files_state())
                time.sleep(max(0.0, 10 - (time.monotonic() - tick)))
            window_end = self.files_state()
        finally:
            self.ensure_files_running()  # restore trap: unpauses first, then starts a stopped container
        after = self.files_state()
        states = [s for s in samples + [window_end] if s is not None]
        first_back = next((round(s["at"] - held["at"], 1) for s in states if held and s["status"] != expected), None)
        valid = bool(held) and held["status"] == expected and first_back is None and all(
            s["status"] == expected and s["started_at"] == held["started_at"] and s["restarts"] == held["restarts"] for s in states)
        hung = [p for p in probes if p["hung"]]
        b_max = max((p["ms"] for p in probes), default=0)
        b_errors = dict(collections.Counter(p["err"] for p in probes if p["rc"] not in (0, None)))
        b_unclean = sorted(e for e in b_errors if errno_of_text(e) is None)
        b_ok_while_down = sum(1 for p in probes if p["rc"] == 0)
        passed = (valid and bool(probes) and not hung and b_max <= (OP_BOUND_S + SLACK_S) * 1000 and not b_unclean and b_ok_while_down == 0)
        if valid:
            prefix = ""
        elif first_back is not None:
            prefix = "INVALID (Files was not held %s for the window: seen back at +%ss) " % (expected, first_back)
        else:
            prefix = "INVALID (Files StartedAt or RestartCount changed inside the window) "
        metrics = {"variant": variant, "down_s": OUTAGE_B_S, "valid": valid, "probes": len(probes), "hung": len(hung),
                   "max_ms": round(b_max, 1), "errors": b_errors, "unclean_errors": b_unclean, "ok_while_down": b_ok_while_down,
                   "bound_s": OP_BOUND_S, "first_back_s": first_back, "state_before": before, "state_held": held,
                   "state_window_end": window_end, "state_after_restore": after, "samples": len(samples)}
        self.emit(check, passed,
                  "%sdown=%ds probes=%d hung=%d max_ms=%.0f ok_while_down=%d errnos=%s unclean=%s state_end=%s restored=%s" %
                  (prefix, OUTAGE_B_S, len(probes), len(hung), b_max, b_ok_while_down,
                   json.dumps(sorted(errno_of_text(e) or e for e in b_errors)), b_unclean,
                   (window_end or {}).get("status"), after["status"]),
                  started, metrics)
        return metrics

    def outage_recovery(self):
        """Start Files and prove a fresh write and read work."""
        folder = self.root / "outage"
        folder.mkdir(exist_ok=True)
        self._docker(["start", CONTAINER_FILES], 90)
        recovery_ready = self._wait_container_ready(CONTAINER_FILES, 240)
        payload = "recovery-" + self.run_id
        rec_path = folder / "recovery.txt"
        write = self._probe(["sh", "-c", 'printf %s "$2" > "$1"', "sh", str(rec_path), payload])
        read = self._probe(["sh", "-c", 'cat "$1"', "sh", str(rec_path)])
        recovered = write["rc"] == 0 and read["rc"] == 0 and read["out"].decode("utf-8", "replace") == payload
        self.emit("outage-recovery", recovered, "ready_s=%s write_err=%s read_err=%s" % (recovery_ready, write["err"] or "none", read["err"] or "none"),
                  time.monotonic(), {"ready_s": recovery_ready, "write_ms": round(write["ms"], 1), "read_ms": round(read["ms"], 1)})
        if recovered:
            self.ledger_add([("outage/recovery.txt", hashlib.sha256(payload.encode()).hexdigest())])

    @staticmethod
    def _outage_phase(when, down_from, up_at):
        if when < down_from:
            return "before"
        return "down" if when < up_at else "after"

    def handles(self):
        folder = self.root / "handles"
        folder.mkdir(exist_ok=True)
        started = time.monotonic()
        metrics = {}
        names = []
        try:
            import resource
            soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
            resource.setrlimit(resource.RLIMIT_NOFILE, (min(max(soft, 4096), hard if hard > 0 else 4096), hard))
        except (ImportError, ValueError, OSError):
            pass
        held = []
        vm_errors = collections.Counter()
        for index in range(100):
            path = folder / ("vm-%03d.txt" % index)
            try:
                handle = path.open("w+b")
                held.append(handle)
                payload = b"vm-%03d" % index
                handle.write(payload)
                handle.flush()
                handle.seek(0)
                if handle.read() != payload:
                    raise CheckFailure("read-back mismatch while holding handles")
            except OSError as exc:
                vm_errors[self.note_error(exc, "vm-open")] += 1
        metrics["vm_open_ok"] = len(held)
        for handle in held:
            handle.close()
        names_containers = []
        container_results = []
        try:
            image = self._soak_image()
            for index in range(2):
                name = "fusesoak-h%d-%s" % (index, datetime.datetime.now(datetime.timezone.utc).strftime("%H%M%S"))
                names_containers.append(name)
                self._start_test_container(name, image)
                if self._image_python:
                    command = ["python3", "-I", "-c", HANDLES_PYTHON_SCRIPT, str(folder), "100"]
                else:
                    command = ["sh", "-c", HANDLES_SH_SCRIPT, "sh", str(folder), "100"]
                result = self._probe(["docker", "exec", name, *command], 120)
                text = result["out"].decode("utf-8", "replace")
                report = re.search(r"mode=(\w+) opened=(\d+) readback_bad=(\d+) errors=(\S+)", text)
                if report:
                    opened = int(report.group(2))
                    container_results.append({"mode": report.group(1), "opened": opened,
                                              "readback_bad": int(report.group(3)), "errors": report.group(4),
                                              "opened_100": opened == 100 and int(report.group(3)) == 0,
                                              "rc": result["rc"]})
                else:
                    container_results.append({"mode": "python" if self._image_python else "sh", "opened": 0,
                                              "opened_100": False, "rc": result["rc"],
                                              "err": (result["err"] or "none")[:200]})
        except Exception as exc:
            container_results.append({"error": "%s: %s" % (type(exc).__name__, str(exc)[:120])})
        finally:
            self._remove_test_containers(names_containers)
        metrics["vm_errors"] = dict(vm_errors)
        metrics["containers"] = container_results
        passed = metrics["vm_open_ok"] == 100 and all(item.get("opened_100") for item in container_results) and len(container_results) == 2
        self.emit("handles-100-concurrent", passed,
                  "vm_ok=%d/100 container_results=%s" % (metrics["vm_open_ok"], json.dumps(container_results)), started, metrics)

    def token_empty(self):
        started = time.monotonic()
        if ENV.get("SOAK_TOKEN_TEST") != "1":
            self.emit("token-empty", True, "skipped: opt-in only (SOAK_TOKEN_TEST=1); restarts the adapter with an empty token file for a bounded window", started)
            return
        backup = TOKEN_FILE + ".soak-bak"
        restored = False
        metrics = {}
        marker = datetime.datetime.now(datetime.timezone.utc).isoformat()
        try:
            present = self._docker(["exec", CONTAINER_FUSE, "sh", "-c", 'test -s "$1" && cp -p "$1" "$2" && echo ok', "sh", TOKEN_FILE, backup], 20)
            if present.returncode != 0 or present.stdout.strip() != "ok":
                self.emit("token-empty", True, "skipped: adapter token file not present or not backed up inside the FUSE container", started)
                return
            self._docker(["exec", CONTAINER_FUSE, "sh", "-c", ': > "$1"', "sh", TOKEN_FILE], 20)
            self._docker(["restart", "--time", "10", CONTAINER_FUSE], 120)
            empty_probe = self._probe(["timeout", "20", "ls", "-A", str(MOUNT)], 30)
            time.sleep(env_int("SOAK_TOKEN_SECONDS", 20, 1, 600))
            logs = self._docker(["logs", "--since", marker, CONTAINER_FUSE], 60)
            text = (logs.stdout + logs.stderr)
            metrics["eacces_lines"] = len(re.findall(r"EACCES", text))
            metrics["retry_lines"] = len(re.findall(r"retry", text, re.IGNORECASE))
            metrics["empty_window_ls_rc"] = empty_probe["rc"]
        finally:
            back = self._docker(["exec", CONTAINER_FUSE, "sh", "-c", 'test -s "$1" && mv -f "$1" "$2" && echo ok', "sh", backup, TOKEN_FILE], 20)
            restored = back.returncode == 0 and back.stdout.strip() == "ok"
        recovery_started = time.monotonic()
        try:
            recovery_s = self._wait_mount(120)
        except CheckFailure:
            recovery_s = None
        metrics["restored"] = restored
        metrics["recovery_s"] = recovery_s
        passed = restored and recovery_s is not None
        self.emit("token-empty", passed, "restored=%s recovery_s=%s eacces_lines=%s retry_lines=%s" %
                  (restored, recovery_s, metrics.get("eacces_lines"), metrics.get("retry_lines")), recovery_started, metrics)

    def lock_contention(self):
        folder = self.root / "lock"
        folder.mkdir(exist_ok=True)
        targets = [folder / ("target-%02d.txt" % index) for index in range(20)]
        for target in targets:
            target.write_bytes(b"seed")
        sink = []
        sink_lock = threading.Lock()
        stop = threading.Event()

        def timed(kind, action):
            started = time.monotonic()
            try:
                action()
                outcome = (kind, (time.monotonic() - started) * 1000, time.time(), None, None)
            except OSError as exc:
                outcome = (kind, (time.monotonic() - started) * 1000, time.time(), err_key(exc), getattr(exc, "errno", None))
            with sink_lock:
                sink.append(outcome)

        def creator(tid):
            index = 0
            while not stop.is_set():
                path = folder / ("new-%d-%06d.txt" % (tid, index))
                timed("create", lambda p=path: p.write_bytes(b"c" * 1024))
                index += 1

        def mover(tid):
            index = 0
            while not stop.is_set():
                source = folder / ("src-%d-%06d.txt" % (tid, index))
                target = targets[(tid * 7 + index) % len(targets)]
                def action(s=source, t=target):
                    s.write_bytes(b"m" * 512)
                    os.replace(str(s), str(t))  # mv over an EXISTING file
                timed("mv-over-existing", action)
                index += 1

        def dirs(tid):
            index = 0
            while not stop.is_set():
                path = folder / ("dir-%d-%06d" % (tid, index))
                timed("mkdir", lambda p=path: os.mkdir(p))
                timed("rmdir", lambda p=path: os.rmdir(p))
                index += 1

        threads = [threading.Thread(target=creator, args=(i,), daemon=True) for i in range(4)]
        threads += [threading.Thread(target=mover, args=(i,), daemon=True) for i in range(3)]
        threads += [threading.Thread(target=dirs, args=(i,), daemon=True) for i in range(2)]
        started = time.monotonic()
        for thread in threads:
            thread.start()
        time.sleep(LOCK_SECONDS)
        stop.set()
        for thread in threads:
            thread.join(timeout=OP_BOUND_S)
        hung = sum(1 for thread in threads if thread.is_alive())
        with sink_lock:
            outcomes = list(sink)
        for kind, _ms, when, name, code in outcomes:
            if code == errno.EIO:  # the outcome kept only the errno, so the path is the lock folder
                record_eio(OSError(errno.EIO, os.strerror(errno.EIO), str(folder)), "lock-" + kind, when=when)
        eio = sum(1 for o in outcomes if o[4] == errno.EIO)
        other = collections.Counter(o[3] for o in outcomes if o[3] and o[4] != errno.EIO)
        metrics = {"seconds": LOCK_SECONDS, "hung_threads": hung, "eio": eio, "other_errors": dict(other)}
        for kind in ("create", "mv-over-existing", "mkdir", "rmdir"):
            lat = [o[1] for o in outcomes if o[0] == kind and o[3] is None]
            metrics[kind] = {"ok": len(lat), "p50_ms": pct(lat, 0.5), "p95_ms": pct(lat, 0.95), "max_ms": round(max(lat), 1) if lat else None}
        passed = eio == 0 and not other and hung == 0 and len(outcomes) > 0
        self.emit("lock-contention", passed, "seconds=%d ops=%d eio=%d other=%s hung_threads=%d" %
                  (LOCK_SECONDS, len(outcomes), eio, json.dumps(dict(other)), hung), started, metrics)

    def latency(self):
        folder = self.root / "latency"
        folder.mkdir(exist_ok=True)
        started = time.monotonic()
        files = []
        for directory in range(10):
            sub = folder / ("d%02d" % directory)
            sub.mkdir(exist_ok=True)
            for index in range(50):
                path = sub / ("f%02d.bin" % index)
                if not path.exists():
                    self._write_bytes(path, 4096, path.name)
                files.append(path)
        errors = collections.Counter()

        def stat_pass(paths):
            samples = []
            for path in paths:
                tick = time.perf_counter()
                try:
                    os.stat(path)
                    samples.append((time.perf_counter() - tick) * 1000)
                except OSError as exc:
                    errors[self.note_error(exc, "stat")] += 1
            return samples

        cold = stat_pass(files)  # first pass: the adapter's caches are cold for these paths
        warm = stat_pass(files)  # second pass: same paths, now warm
        idle = cold + warm  # combined, reported only as an extra field
        stop = threading.Event()
        load_errors = collections.Counter()

        def load():
            index = 0
            previous = None
            while not stop.is_set():
                path = folder / ("load-%06d.bin" % index)
                try:
                    self._write_bytes(path, 10 * 1024 * 1024, path.name)
                    if previous:
                        previous.unlink()
                    previous = path
                except OSError as exc:
                    load_errors[self.note_error(exc, "write")] += 1
                index += 1

        loader = threading.Thread(target=load, daemon=True)
        loader.start()
        loaded = []
        load_until = time.monotonic() + env_int("SOAK_LATENCY_LOAD_SECONDS", 20, 5, 600)
        while time.monotonic() < load_until:
            loaded += stat_pass(files)
        stop.set()
        loader.join(timeout=OP_BOUND_S)
        for path in folder.glob("load-*.bin"):
            try:
                path.unlink()
            except OSError:
                pass
        sample = files[:20]
        first_reads, repeat_reads = [], []
        for path in sample:
            tick = time.perf_counter()
            path.read_bytes()
            first_reads.append((time.perf_counter() - tick) * 1000)
        for _round in range(5):
            for path in sample:
                tick = time.perf_counter()
                path.read_bytes()
                repeat_reads.append((time.perf_counter() - tick) * 1000)
        metrics = {"files": len(files), "stat_idle_cold_p50_ms": pct(cold, 0.5), "stat_idle_cold_p95_ms": pct(cold, 0.95),
                   "stat_idle_warm_p50_ms": pct(warm, 0.5), "stat_idle_warm_p95_ms": pct(warm, 0.95),
                   "stat_idle_combined_p50_ms": pct(idle, 0.5), "stat_idle_combined_p95_ms": pct(idle, 0.95), "stat_idle_p99_ms": pct(idle, 0.99),
                   "stat_load_p50_ms": pct(loaded, 0.5), "stat_load_p95_ms": pct(loaded, 0.95), "stat_load_p99_ms": pct(loaded, 0.99),
                   "read_first_p50_ms": pct(first_reads, 0.5), "read_repeat_p50_ms": pct(repeat_reads, 0.5),
                   "errors": dict(errors), "load_errors": dict(load_errors)}
        passed = not errors and not load_errors and (metrics["stat_load_p95_ms"] or 0) <= LATENCY_P95_MS
        self.emit("latency-stat-lookup", passed, "idle cold p50=%s p95=%s warm p50=%s p95=%s load p50=%s p95=%s p99=%s read first=%s repeat=%s" %
                  (metrics["stat_idle_cold_p50_ms"], metrics["stat_idle_cold_p95_ms"], metrics["stat_idle_warm_p50_ms"], metrics["stat_idle_warm_p95_ms"],
                   metrics["stat_load_p50_ms"],
                   metrics["stat_load_p95_ms"], metrics["stat_load_p99_ms"], metrics["read_first_p50_ms"], metrics["read_repeat_p50_ms"]),
                  started, metrics)

    def _fuse_api(self, payload, timeout=180):
        # The token is read inside the FUSE container; only the JSON request crosses stdin.
        try:
            proc = subprocess.run(["docker", "exec", "-i", CONTAINER_FUSE, "python3", "-I", "-c", CONTAINER_API, FUSE_URL, TOKEN_FILE],
                                  input=json.dumps(payload), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=timeout)
        except subprocess.TimeoutExpired as exc:
            raise CheckFailure("Files API call timed out after %ss" % timeout) from exc
        lines = [line for line in proc.stdout.splitlines() if line.startswith("{")]
        if proc.returncode != 0 or not lines:
            raise CheckFailure("Files API helper failed: %s" % short_err(proc.stderr))
        return json.loads(lines[-1])

    def _api_scope(self):
        """(collectionId, base) for Files API paths. `base` is the soak path relative to that collection's root.

        With SOAK_PARENT the mount root is the personal collection itself, so the collection is home and the soak
        path is relative to the mount. Otherwise the first component under the mount names the collection.
        """
        if getattr(self, "_scope_cache", None):
            return self._scope_cache
        try:
            parts = self.root.resolve().relative_to(MOUNT.resolve()).parts
        except ValueError as exc:
            raise CheckFailure("soak root is not under the Files mount") from exc
        if ENV.get("SOAK_PARENT"):
            name, rel = None, parts
        else:
            if len(parts) < 2:
                raise CheckFailure("soak root has no collection component")
            name, rel = parts[0], parts[1:]
        resolved = self._fuse_api({"action": "resolve", "name": name})
        if not resolved.get("collectionId"):
            raise CheckFailure("collection id not resolvable through the Files API (collections_status %s, directory_status %s)" %
                               (resolved.get("collections_status"), resolved.get("directory_status")))
        self._scope_cache = (resolved["collectionId"], "/".join(rel))
        return self._scope_cache

    def _api_put(self, rel, content):
        """Create or overwrite a file through the Files HTTP API (inside the FUSE container). `rel` is soak-relative."""
        if rel.startswith("/") or ".." in Path(rel).parts:
            raise CheckFailure("api path must be relative and stay inside the soak root")
        collection_id, base = self._api_scope()
        return self._fuse_api({"action": "write", "collectionId": collection_id, "path": "/".join(filter(None, [base, rel])), "content": content})

    @staticmethod
    def _put_applied(result):
        """True only when the server answered 2xx AND the stored content was read back and hashed."""
        return result.get("status") in (200, 201) and bool(result.get("written_sha256"))

    @staticmethod
    def _put_evidence(label, result):
        if FilesSoak._put_applied(result):
            return "%s applied (status %s, mode %s)" % (label, result.get("status"), result.get("mode"))
        if result.get("status") in (200, 201):
            return "%s did not apply (status %s, read-back failed: %s)" % (label, result.get("status"), result.get("readback_error"))
        extra = (" " + result["reason"]) if result.get("reason") else ""
        return "%s did not apply (status %s%s)" % (label, result.get("status"), extra)

    def api_write(self):
        """Sub-command: files-soak.sh api-write <relative path> <content>. Records the checksum in the ledger."""
        started = time.monotonic()
        if len(self.extra_args) != 2:
            raise CheckFailure("usage: files-soak.sh api-write <relative path> <content>")
        rel, content = self.extra_args
        result = self._api_put(rel, content)
        ok = self._put_applied(result)
        if ok:
            self.ledger_add([(rel, result["written_sha256"])])
        self.emit("api-write:" + rel, ok, self._put_evidence("write", result),
                  started, {"status": result.get("status"), "mode": result.get("mode"), "ms": result.get("ms")})

    def staleness(self):
        folder = self.root / "staleness"
        folder.mkdir(exist_ok=True)
        started = time.monotonic()
        existing = folder / "existing.txt"
        old = b"old-" + self.run_id.encode()
        existing.write_bytes(old)
        new_payload = "new-" + self.run_id + "-" + str(time.time_ns())
        t_api = time.monotonic()
        put_new = self._api_put("staleness/new.txt", new_payload)
        if not self._put_applied(put_new):
            # Nothing was written, so there is nothing to watch for staleness. Fail now, with the reason.
            self.emit("staleness-visibility-and-invalidation", False, self._put_evidence("create", put_new), started,
                      {"new_put_status": put_new.get("status"), "new_put_mode": put_new.get("mode"), "new_put_reason": put_new.get("reason")})
            return
        self.ledger_add([("staleness/new.txt", put_new["written_sha256"])])
        new_visible = None
        while time.monotonic() - t_api < 120:
            read = self._probe(["sh", "-c", 'cat "$1"', "sh", str(folder / "new.txt")], 60)
            if read["rc"] == 0 and read["out"].decode("utf-8", "replace") == new_payload:
                new_visible = round(time.monotonic() - t_api, 3)
                break
            time.sleep(0.25)
        updated = "upd-" + self.run_id + "-" + str(time.time_ns())
        t_mod = time.monotonic()
        put_existing = self._api_put("staleness/existing.txt", updated)
        if not self._put_applied(put_existing):
            # The modify never reached the file, so every read of the old text would be a false "stale read".
            # Fail fast with the write's own status instead of counting them.
            self.emit("staleness-visibility-and-invalidation", False,
                      "modify did not apply (status %s)%s" % (put_existing.get("status"),
                                                              (" " + put_existing["reason"]) if put_existing.get("reason") else ""), started,
                      {"new_visible_s": new_visible, "new_put_status": put_new.get("status"), "modify_put_status": put_existing.get("status"),
                       "modify_put_mode": put_existing.get("mode"), "modify_put_reason": put_existing.get("reason"),
                       "modify_readback_error": put_existing.get("readback_error"), "stale_reads_seen": 0, "stale_reads_after_window": 0})
            return
        stale_after_window = 0
        stale_reads = 0
        modified_visible = None
        bound = INVALIDATE_WINDOW + SLACK_S
        while time.monotonic() - t_mod < 120:
            read = self._probe(["sh", "-c", 'cat "$1"', "sh", str(existing)], 60)
            elapsed = time.monotonic() - t_mod
            current = read["out"].decode("utf-8", "replace") if read["rc"] == 0 else None
            if current == updated:
                modified_visible = round(elapsed, 3)
                break
            stale_reads += 1 if current == old.decode() else 0
            if elapsed > bound:
                stale_after_window += 1
            time.sleep(0.25)
        metrics = {"new_visible_s": new_visible, "new_put_status": put_new.get("status"), "new_put_mode": put_new.get("mode"),
                   "modify_visible_s": modified_visible, "modify_put_status": put_existing.get("status"), "modify_put_mode": put_existing.get("mode"),
                   "window_s": INVALIDATE_WINDOW, "slack_s": SLACK_S, "stale_reads_seen": stale_reads, "stale_reads_after_window": stale_after_window}
        passed = (new_visible is not None and modified_visible is not None and modified_visible <= bound and stale_after_window == 0)
        self.ledger_add([("staleness/existing.txt", put_existing["written_sha256"])])
        self.emit("staleness-visibility-and-invalidation", passed,
                  "new_visible_s=%s modify_visible_s=%s bound_s=%.1f stale_after_window=%d" % (new_visible, modified_visible, bound, stale_after_window),
                  started, metrics)

    def eio_rows(self):
        """Every EIO line recorded for this soak root (eio-events.jsonl is kept across runs and cleanup)."""
        if not EIO_LOG.is_file():
            return []
        rows = []
        for line in EIO_LOG.read_text(encoding="utf-8").splitlines():
            try:
                row = json.loads(line)
            except ValueError:
                continue
            if row.get("root") == str(self.root) and isinstance(row.get("t"), (int, float)):
                rows.append(row)
        return sorted(rows, key=lambda row: row["t"])

    def eio_events(self):
        return [float(row["t"]) for row in self.eio_rows()]

    @staticmethod
    def _summarize_log_line(container, body):
        fields = {}
        if body.startswith("{"):
            try:
                obj = json.loads(body)
                for key in ("event", "status", "code", "errno", "errorCode", "error_code", "httpStatus", "reason"):
                    if key in obj:
                        value = str(obj[key])[:40]
                        if "/" not in value:
                            fields[key] = value
            except ValueError:
                pass
        else:
            status = re.search(r"status[=: ]+(\d{3})", body)
            code = re.search(r"code[=: ]+([A-Z_]{3,40})", body)
            if status:
                fields["status"] = status.group(1)
            if code:
                fields["code"] = code.group(1)
        return "%s %s" % (container, json.dumps(fields, sort_keys=True))

    def eio_capture(self):
        started = time.monotonic()
        events = self.eio_events()
        if not events:
            self.emit("eio-capture", True, "no EIO recorded for this soak root", started, {"eio_events": 0})
            return
        since = int(events[0]) - 3
        matched = collections.Counter()
        matched_lines = 0
        read_ok = True
        for container in (CONTAINER_FILES, CONTAINER_FUSE):
            logs = self._docker(["logs", "-t", "--since", str(since), container], 60)
            read_ok = read_ok and logs.returncode == 0
            for line in (logs.stdout + logs.stderr).splitlines():
                stamp, _sep, body = line.partition(" ")
                when = parse_rfc3339(stamp)
                if when is None:
                    continue
                index = bisect.bisect_left(events, when)
                near = any(abs(when - events[i]) <= 2 for i in (index - 1, index) if 0 <= i < len(events))
                if near:
                    matched_lines += 1
                    matched[self._summarize_log_line(container, body)] += 1
        top = [{"key": key, "count": count} for key, count in matched.most_common(10)]
        rows = self.eio_rows()
        by_phase = collections.Counter("%s/%s" % (row.get("phase"), row.get("op")) for row in rows)
        captured = sum(len(row.get("adapter_log") or []) for row in rows)
        metrics = {"eio_events": len(events), "by_phase_op": dict(by_phase), "adapter_lines_captured_live": captured,
                   "matched_lines": matched_lines, "top_status_codes": top, "logs_readable": read_ok}
        self.emit("eio-capture", read_ok, "eio_events=%d by_phase_op=%s adapter_lines_live=%d matched_log_lines=%d top=%s" %
                  (len(events), json.dumps(dict(by_phase), sort_keys=True), captured, matched_lines, json.dumps(top)), started, metrics)

    def env_info(self):
        started = time.monotonic()
        metrics = {"mount": str(MOUNT), "bind_spec": bind_spec()}
        present = []
        for container in (CONTAINER_FILES, CONTAINER_FUSE):
            result = self._docker(["inspect", "-f", '{{.Config.Image}}|{{.Image}}|{{.Created}}|{{index .Config.Labels "org.opencontainers.image.version"}}', container], 20)
            if result.returncode != 0:
                metrics[container] = "not found"
                continue
            image, image_id, created, version = (result.stdout.strip().split("|") + ["", "", "", ""])[:4]
            digests = self._docker(["image", "inspect", "-f", "{{range .RepoDigests}}{{.}} {{end}}", image_id], 20).stdout.strip()
            metrics[container] = {"image": image, "image_id": image_id[:19], "created": created, "version_label": version or None,
                                  "repo_digests": digests[:200] or None}
            present.append(container)
        metrics["desktop_version"] = ENV.get("SOAK_DESKTOP_VERSION") or "unknown (set SOAK_DESKTOP_VERSION)"
        self.emit("env-images", len(present) == 2, "containers=%s" % ",".join(present), started, metrics)

        started = time.monotonic()
        sql = ("SELECT version, applied_at FROM files_schema_migrations "
               "WHERE version LIKE '067%' OR version LIKE '068%' ORDER BY version")
        result = self._docker(["exec", CONTAINER_PG, "psql", "-U", PG_USER, "-d", PG_DB, "-At", "-F", "|", "-c", sql], 30)
        if result.returncode != 0:
            self.emit("env-migrations-067-068", False, "psql unavailable or ledger missing: %s" % short_err(result.stderr), started, {"database": PG_DB})
            return
        rows = [line.split("|")[0] for line in result.stdout.splitlines() if line.strip()]
        applied_067 = any(row.startswith("067") for row in rows)
        applied_068 = any(row.startswith("068") for row in rows)
        self.emit("env-migrations-067-068", applied_067 and applied_068, "applied=%s" % (",".join(rows) or "none"),
                  started, {"applied": rows, "067": applied_067, "068": applied_068, "database": PG_DB})

        started = time.monotonic()
        probe = self._files_metrics()
        numbers = probe.get("numbers", {})
        passed = probe.get("status") == 200 and bool(numbers)
        self.emit("env-files-metrics", passed,
                  "status=%s numeric_fields=%d error=%s" % (probe.get("status"), len(numbers), probe.get("error", "none")),
                  started, {"status": probe.get("status"), "numbers": numbers, "error": probe.get("error")})

    @staticmethod
    def _numeric_leaves(node, prefix=""):
        """Flatten a metrics JSON body to its numeric leaves only (no names, paths or text values)."""
        found = {}
        if isinstance(node, bool):
            return found
        if isinstance(node, (int, float)):
            return {prefix: node} if prefix else {}
        if isinstance(node, dict):
            for key, value in node.items():
                found.update(FilesSoak._numeric_leaves(value, prefix + "." + key if prefix else key))
        elif isinstance(node, list):
            for index, value in enumerate(node[:50]):
                found.update(FilesSoak._numeric_leaves(value, "%s[%d]" % (prefix, index)))
        return found

    def _files_metrics(self):
        """GET /v1/local/files-metrics inside sulla_files with its local token. The token never leaves that container."""
        result = self._docker(["exec", CONTAINER_FILES, "node", "-e", METRICS_PROBE], 40)
        line = next((ln for ln in result.stdout.splitlines() if ln.startswith("{")), "")
        if result.returncode != 0 or not line:
            return {"error": short_err(result.stderr) or "no response"}
        try:
            wrapper = json.loads(line)
        except ValueError:
            return {"error": "unparseable response"}
        if wrapper.get("error"):
            return {"error": wrapper["error"]}
        try:
            body = json.loads(wrapper.get("body") or "null")
        except ValueError:
            body = None
        return {"status": wrapper.get("status"), "numbers": self._numeric_leaves(body)}

    def integrity(self):
        started = time.monotonic()
        rows = self.ledger_rows()
        if not rows:
            self.emit("integrity-mount", True, "no ledger rows for this soak root", started)
            return
        counts = self._verify_rows(self.root, rows, cap=900)
        verified = counts.get("ok", 0)
        eio = EIO_COUNTS[self.phase]  # every EIO this phase saw, from any thread; eio-events.jsonl has the detail
        self.emit("integrity-mount", verified == len(rows) and not counts.get("unverified_timeout") and eio == 0,
                  "ledger=%d verified=%d mismatch=%d missing=%d unverified=%d eio=%d" % (len(rows), verified, counts.get("mismatch", 0),
                                                                                         counts.get("missing", 0), counts.get("unverified_timeout", 0), eio),
                  started, {"ledger_rows": len(rows), "verified": verified, "mismatch": counts.get("mismatch", 0),
                            "missing": counts.get("missing", 0), "eio": eio, "errors": {k: v for k, v in counts.items() if k.startswith("error")}})
        self.emit("integrity-eio", eio == 0, "EIO events during integrity=%d (eio-events.jsonl phase=integrity)" % eio, started, {"eio": eio})
        started = time.monotonic()
        if not rows or API_SAMPLE == 0:
            return
        try:
            collection_id, base = self._api_scope()
        except CheckFailure as exc:
            self.emit("integrity-api", False, str(exc)[:180], started)
            return
        rng = random.Random(self.run_id)
        sample = rng.sample(rows, min(API_SAMPLE, len(rows)))
        items = [["/".join(filter(None, [base, rel])), sha] for rel, sha in sample]
        verdict = self._fuse_api({"action": "verify", "collectionId": collection_id, "items": items})
        counts = verdict.get("counts", {})
        passed = counts.get("matched", 0) == len(items) and EIO_COUNTS[self.phase] == 0
        self.emit("integrity-api", passed, "sample=%d matched=%d mismatch=%d unresolved=%d eio=%d" %
                  (len(items), counts.get("matched", 0), counts.get("mismatch", 0), counts.get("unresolved", 0), EIO_COUNTS[self.phase]),
                  started, {"sample": len(items), **counts})

    def summary(self):
        if not RESULTS.is_file():
            print("no results yet at %s" % RESULTS)
            return
        records = [json.loads(line) for line in RESULTS.read_text(encoding="utf-8").splitlines() if line.strip()]
        run = ENV.get("SOAK_RUN") or (records[-1].get("run") if records else None)
        rows = [r for r in records if r.get("run") == run]
        print("SOAK SUMMARY run=%s checks=%d failed=%d" % (run, len(rows), sum(1 for r in rows if not r.get("pass"))))
        print("%-38s %-5s %s" % ("check", "pass", "key metrics"))
        for record in rows:
            metrics = record.get("metrics") or {}
            keys = ["p50_ms", "p95_ms", "max_ms", "p95_ms", "stat_load_p95_ms", "mount_recovery_s", "ready_s", "writes_ok", "writes_failed",
                    "successful_writes", "verified", "eio", "hung", "vm_open_ok", "new_visible_s", "modify_visible_s", "stale_reads_after_window"]
            brief = " ".join("%s=%s" % (k, metrics[k]) for k in keys if k in metrics and not isinstance(metrics[k], (dict, list)))
            print("%-38s %-5s %s" % (record.get("check", "?")[:38], "PASS" if record.get("pass") else "FAIL", brief[:110] or record.get("evidence", "")[:110]))

    def before_after_summary(self):
        """Prints one compact JSON object for one run label (argument, else SOAK_RUN, else the latest run)."""
        records = []
        if RESULTS.is_file():
            for line in RESULTS.read_text(encoding="utf-8").splitlines():
                try:
                    records.append(json.loads(line))
                except ValueError:
                    continue
        label = self.extra_args[0] if self.extra_args else (ENV.get("SOAK_RUN") or (records[-1].get("run") if records else None))
        rows = [r for r in records if r.get("run") == label]
        latest = {}
        for row in rows:
            latest[row.get("check")] = row  # a re-run inside the same label replaces the earlier record

        def metrics(check):
            return (latest.get(check) or {}).get("metrics") or {}

        def passed(check):
            return (latest.get(check) or {}).get("pass")

        def pick(source, keys):
            return {key: source.get(key) for key in keys}

        lock = metrics("lock-contention")
        handles = metrics("handles-100-concurrent")
        vm_errors = handles.get("vm_errors") or {}
        outage_a = metrics("outage-a-restart")
        outage_b = metrics("outage-b-paused") or metrics("outage-b-stopped") or metrics("outage-b-stop")
        restart = metrics("restart-propagation")
        summary = {
            "run": label,
            "checks": len(rows),
            "failed": sorted(r.get("check") for r in latest.values() if not r.get("pass")),
            "stat": pick(metrics("latency-stat-lookup"), ["stat_idle_cold_p50_ms", "stat_idle_cold_p95_ms", "stat_idle_warm_p50_ms", "stat_idle_warm_p95_ms",
                                                          "stat_load_p50_ms", "stat_load_p95_ms",
                                                          "read_first_p50_ms", "read_repeat_p50_ms"]),
            "lock": {"per_op": {kind: pick(lock.get(kind) or {}, ["p50_ms", "p95_ms"]) for kind in ("create", "mv-over-existing", "mkdir", "rmdir")},
                     "eio": lock.get("eio"), "hung_threads": lock.get("hung_threads"), "pass": passed("lock-contention")},
            "handles": {"pass": passed("handles-100-concurrent"), "vm_ok": handles.get("vm_open_ok"),
                        "vm_emfile": sum(v for k, v in vm_errors.items() if k.startswith("EMFILE")),
                        "containers_opened_100": [c.get("opened_100") for c in handles.get("containers") or []]},
            "outage": {"a": {**pick(outage_a, ["writes_started", "writes_ok", "writes_failed", "down_s", "actual_down_s", "p95_ms", "max_ms", "ready_s", "valid"]), "pass": passed("outage-a-restart")},
                       "b": {**pick(outage_b, ["variant", "down_s", "valid", "probes", "hung", "max_ms", "unclean_errors", "ok_while_down"]),
                             "pass": passed("outage-b-paused") or passed("outage-b-stopped") or passed("outage-b-stop")}},
            "restart_propagation": {**pick(restart, ["mount_recovery_s", "post_ls_errno", "post_write_errno"]), "pass": passed("restart-propagation")},
            "staleness": {**pick(metrics("staleness-visibility-and-invalidation"), ["new_visible_s", "modify_visible_s", "stale_reads_after_window"]),
                          "pass": passed("staleness-visibility-and-invalidation")},
            "integrity": {"mount": pick(metrics("integrity-mount"), ["ledger_rows", "verified", "mismatch", "missing"]),
                          "api": pick(metrics("integrity-api"), ["sample", "matched", "mismatch", "unresolved"]),
                          "eio": pick(metrics("integrity-mount"), ["eio"]).get("eio")},
        }
        print(json.dumps(summary, sort_keys=True, separators=(",", ":")), flush=True)

    def ensure_mount_ready(self, phase):
        """Later phases start only after the mount answers ls; a recovery is recorded with its time."""
        started = time.monotonic()
        try:
            self._probe_mount(5)
            return
        except Exception:
            pass
        try:
            self._wait_mount(MOUNT_WAIT_S)
            seconds = round(time.monotonic() - started, 3)
            self.emit("mount-recovery-before-" + phase, True, "mount answered after %.3fs cap=%ds" % (seconds, MOUNT_WAIT_S), started, {"recovery_s": seconds})
        except CheckFailure as exc:
            self.emit("mount-recovery-before-" + phase, False, str(exc)[:160], started, {"recovery_s": None})

    def cleanup(self):
        parent = self.root.parent.resolve()
        root = self.root.resolve()
        if root.parent != parent or not root.name.startswith("files-soak-"):
            raise CheckFailure("refusing cleanup outside the selected soak folder")
        shutil.rmtree(root)
        for path in (STATE, STATE_DIR / "manifest.jsonl", STATE_DIR / "crash-success.log", LEDGER):  # eio-events.jsonl is kept
            try:
                path.unlink()
            except FileNotFoundError:
                pass
        listed = self._docker(["ps", "-a", "--filter", "label=" + TEST_LABEL, "--format", "{{.Names}}"], 30)
        removed = [n for n in listed.stdout.split() if n.startswith("fusesoak-")]
        self._remove_test_containers(removed)
        return "removed=true test_containers=%d" % len(removed)

    def run(self):
        if self.phase == "cleanup":
            started = time.monotonic()
            try:
                detail = self.cleanup()
                self.emit("cleanup-soak-folder", True, detail, started)
            except Exception as exc:
                self.emit("cleanup-soak-folder", False, "%s: %s" % (type(exc).__name__, str(exc)[:180]), started)
        elif self.phase == "summary":
            self.summary()
            return 0
        elif self.phase == "before-after-summary":
            self.before_after_summary()
            return 0
        else:
            if self.phase == "all":
                phases = ["fuse-identity", "env-info", "restart-propagation", "bulk", "append", "ops", "handles", "lock-contention",
                          "latency", "staleness", "outage", "crash", "token-empty"]
                if "SOAK_MINUTES" in ENV:
                    phases.append("load")
                phases += ["integrity", "eio-capture", "fuse-identity"]
            else:
                phases = (self.phase,)
            for phase in phases:
                self.phase = phase
                if phase not in ("fuse-identity", "env-info", "eio-capture", "summary", "cleanup"):
                    self.ensure_mount_ready(phase)
                EIO_CONTEXT["phase"] = phase
                try:
                    getattr(self, phase.replace("-", "_"))()
                except Exception as exc:
                    if isinstance(exc, OSError):
                        record_eio(exc, "phase")
                    self.emit(phase + "-phase", False, "%s: %s" % (type(exc).__name__, str(exc)[:180]), time.monotonic())
                finally:
                    if phase not in ("fuse-identity", "env-info", "eio-capture", "integrity", "summary"):
                        self.ensure_files_running()
        print("SOAK SUMMARY phase=%s run=%s checks=%d failed=%d results=%s" %
              (self.requested_phase, self.run_id, self.checks, self.failures, RESULTS), flush=True)
        return 1 if self.failures else 0


def main():
    phases = {"bulk", "append", "ops", "crash", "load", "cloud", "restart-propagation", "outage", "outage-b", "handles", "token-empty",
              "lock-contention", "latency", "staleness", "eio-capture", "env-info", "fuse-identity", "integrity", "summary",
              "before-after-summary", "api-write", "all", "cleanup"}
    if len(sys.argv) < 3 or sys.argv[1] not in phases:
        print("usage: files-soak.sh <phase|all|cleanup> [--with-app-restart] [phase arguments]", file=sys.stderr)
        return 2
    try:
        return FilesSoak(sys.argv[1], sys.argv[2] == "true", sys.argv[3:]).run()
    except Exception as exc:
        record = {"phase": sys.argv[1], "check": "preflight", "pass": False, "metrics": {}, "evidence": "%s: %s" % (type(exc).__name__, str(exc)[:180]), "ms": 0}
        line = json.dumps(record, sort_keys=True, separators=(",", ":"))
        print(line, flush=True)
        try:
            STATE_DIR.mkdir(parents=True, exist_ok=True)
            with RESULTS.open("a", encoding="utf-8") as log:
                log.write(line + "\n")
        except OSError:
            pass
        return 1


if __name__ == "__main__":
    sys.exit(main())
PYTHON
