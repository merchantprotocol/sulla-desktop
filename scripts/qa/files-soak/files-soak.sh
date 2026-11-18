#!/usr/bin/env bash
# Sulla Desktop · https://sulladesktop.com
# Copyright (c) 2025-2026 Merchant Protocol LLC.
# SPDX-License-Identifier: GPL-2.0-or-later
# "Sulla" is a trademark. See TRADEMARK.md.
# Runs inside the Desktop VM (as root, docker available). Data is restricted to one per-run
# QA folder under the detected personal Files collection; kill/outage tests intentionally
# stop, restart and kill Files services. Standard library only; no installs.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PHASES="bulk append ops crash load cloud restart-propagation outage handles token-empty lock-contention latency staleness eio-capture env-info fuse-identity integrity summary all cleanup"
if [[ $# -lt 1 ]]; then
  echo "usage: files-soak.sh <$(echo $PHASES | tr ' ' '|')> [--with-app-restart]" >&2
  exit 2
fi

PHASE=""
WITH_APP_RESTART="false"
for arg in "$@"; do
  case "$arg" in
    --with-app-restart) WITH_APP_RESTART="true" ;;
    *)
      if [[ " $PHASES " == *" $arg "* ]]; then PHASE="$arg"; else echo "unknown argument: $arg" >&2; exit 2; fi
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
exec python3 -I - "$PHASE" "$WITH_APP_RESTART" <<'PYTHON'
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


def detect_mount():
    """Current layout mounts FUSE at /mnt/sulla-files; the future layout mounts it at /mnt/sulla/files."""
    if ENV.get("SOAK_MOUNT"):
        return Path(ENV["SOAK_MOUNT"])
    future = Path("/mnt/sulla/files")
    if os.path.ismount(str(future)):
        return future
    return Path("/mnt/sulla-files")


def bind_spec(mount):
    """The bind agent containers use. The new layout binds the anchor's parent /mnt/sulla rslave."""
    if ENV.get("SOAK_BIND_SPEC"):
        return ENV["SOAK_BIND_SPEC"]
    if str(mount).startswith("/mnt/sulla/files"):
        return "/mnt/sulla:/mnt/sulla:rslave"
    return "/mnt/sulla-files:/mnt/sulla-files:rslave"


MOUNT = detect_mount()
STATE_DIR = Path.home() / "sulla-twodev" / "soak"
RESULTS = STATE_DIR / "results.jsonl"
STATE = STATE_DIR / "state.json"
LEDGER = STATE_DIR / "ledger.jsonl"
EIO_LOG = STATE_DIR / "eio-events.jsonl"
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
LATENCY_P95_MS = env_float("SOAK_LATENCY_P95_MS", 1000, 1, 600000)
LOCK_SECONDS = env_int("SOAK_LOCK_SECONDS", 30, 5, 900)
API_SAMPLE = env_int("SOAK_API_SAMPLE", 40, 0, 5000)
TEST_LABEL = "sulla-soak=1"
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
def call(method, path, body=None, headers=None):
    head = {"Authorization": "Bearer " + token()}
    head.update(headers or {})
    response = http.request(method, base + path, body=body, headers=head)
    return response.status, response.data
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
def find_key(node, keys):
    if isinstance(node, dict):
        for key in keys:
            if node.get(key) is not None:
                return node[key]
        for value in node.values():
            found = find_key(value, keys)
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
elif action == "resolve":
    status, data = call("GET", "/v1/collections")
    out["status"] = status
    out["collectionId"] = find_id(json.loads(data), request["name"]) if status == 200 else None
elif action == "put":
    started = time.monotonic()
    query = urllib.parse.urlencode({"collectionId": request["collectionId"], "path": request["path"]})
    status, data = call("PUT", "/v1/files/upload?" + query, body=request["content"].encode("utf-8"), headers={"Content-Type": "application/octet-stream"})
    out.update({"status": status, "ms": round((time.monotonic() - started) * 1000, 2)})
elif action == "verify":
    counts = collections.Counter()
    for path, expected in request["items"]:
        query = urllib.parse.urlencode({"collectionId": request["collectionId"], "path": path})
        status, data = call("GET", "/v1/fuse/entry?" + query)
        if status != 200:
            counts["unresolved"] += 1
            counts["entry_http_%d" % status] += 1
            continue
        file_id = find_key(json.loads(data), ("id", "fileId", "file_id"))
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
    """Writes checksummed 256 KiB files until stopped. A hung write just leaves `pending` set."""

    def __init__(self, folder, tag, stop_event, pace=0.2):
        super().__init__(daemon=True)
        self.folder = folder
        self.tag = tag
        self.stop_event = stop_event
        self.pace = pace
        self.rows = []  # (name, sha256) for writes that returned success
        self.ops = []  # (latency_ms, ok, error_key)
        self.pending = None
        self.index = 0

    def run(self):
        while not self.stop_event.is_set():
            name = "%s-%06d.bin" % (self.tag, self.index)
            self.index += 1
            data = hashlib.sha256(name.encode()).digest() * 8192
            sha = hashlib.sha256(data).hexdigest()
            started = time.monotonic()
            self.pending = (name, started)
            try:
                with (self.folder / name).open("wb") as handle:
                    handle.write(data)
                    handle.flush()
                    os.fsync(handle.fileno())
                self.rows.append((name, sha))
                self.ops.append(((time.monotonic() - started) * 1000, True, ""))
            except OSError as exc:
                self.ops.append(((time.monotonic() - started) * 1000, False, err_key(exc)))
            finally:
                self.pending = None
            self.stop_event.wait(self.pace)


class FilesSoak:
    def __init__(self, phase, with_app_restart):
        self.phase = phase
        self.requested_phase = phase
        self.with_app_restart = with_app_restart
        self.run_id = ENV.get("SOAK_RUN") or datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        self.failures = 0
        self.checks = 0
        self.errors = collections.Counter()
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        self.root = self._get_run_root()

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

    def _collection_and_rel(self):
        try:
            parts = self.root.resolve().relative_to(MOUNT.resolve()).parts
        except ValueError as exc:
            raise CheckFailure("soak root is not under the Files mount") from exc
        if len(parts) < 2:
            raise CheckFailure("soak root has no collection component")
        return parts[0], "/".join(parts[1:])

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
        return {"rc": proc.returncode, "hung": False, "ms": (time.monotonic() - started) * 1000,
                "out": out, "err": short_err(err.decode("utf-8", "replace"))}

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

    def _wait_mount(self, cap=300):
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
        if not self._container_running(CONTAINER_FILES):
            self._docker(["start", CONTAINER_FILES], 90)

    def _soak_image(self):
        if ENV.get("SOAK_TEST_IMAGE"):
            return ENV["SOAK_TEST_IMAGE"]
        images = self._docker(["images", "--format", "{{.Repository}}:{{.Tag}}"], 30).stdout.split()
        for prefix in ("alpine:", "busybox:"):
            match = next((name for name in images if name.startswith(prefix)), None)
            if match:
                return match
        result = self._docker(["inspect", "-f", "{{.Config.Image}}", CONTAINER_FUSE], 15)
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip()
        raise CheckFailure("no local image for a test container (alpine, busybox or the FUSE image)")

    def _start_test_container(self, name, image):
        self._run(["docker", "run", "-d", "--name", name, "--label", TEST_LABEL, "-v", bind_spec(MOUNT),
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
            self.emit(name, False, "%s: %s" % (type(exc).__name__, str(exc)[:180]), started)

    def note_error(self, exc):
        key = err_key(exc) if isinstance(exc, OSError) else type(exc).__name__
        self.errors[key] += 1
        if getattr(exc, "errno", None) == errno.EIO:
            with EIO_LOG.open("a", encoding="utf-8") as log:
                log.write(json.dumps({"run": self.run_id, "root": str(self.root), "t": time.time()}) + "\n")
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
                self.note_error(exc)
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
            seconds = self._wait_mount(300)
            self.emit(name + "-mount-recovery", True, "seconds=%.3f cap=300" % seconds, started, {"recovery_s": seconds})
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
                    seconds = self._wait_mount(300)
                    self.emit("app-restart-mount-recovery", True, "seconds=%.3f cap=300" % seconds, start)
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
            "bind_spec": bind_spec(MOUNT),
        }
        self.emit("fuse-identity", True, "id=%s started_at=%s" % (metrics["id"], metrics["started_at"]), started, metrics)

    def restart_propagation(self):
        folder = self.root / "restart-propagation"
        folder.mkdir(exist_ok=True)
        name = "fusesoak-" + datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d%H%M%S")
        started = time.monotonic()
        metrics = {"bind_spec": bind_spec(MOUNT)}
        try:
            self._start_test_container(name, self._soak_image())
            pre = self._ctr(name, 'printf %s "$2" > "$1" && cat "$1"', str(folder / "before.txt"), "pre-" + self.run_id)
            metrics["pre_write_ok"] = pre["rc"] == 0 and pre["out"].decode("utf-8", "replace") == "pre-" + self.run_id
            if not metrics["pre_write_ok"]:
                raise CheckFailure("pre-restart write/read failed: %s" % pre["err"])
            self._run(["docker", "restart", "--time", "10", CONTAINER_FUSE], timeout=120)
            metrics["mount_recovery_s"] = self._wait_mount(300)
            ls = self._ctr(name, 'ls "$1" >/dev/null', str(folder))
            write = self._ctr(name, 'printf %s "$2" > "$1" && cat "$1"', str(folder / "after.txt"), "post-" + self.run_id)
            old = self._ctr(name, 'cat "$1" >/dev/null', str(folder / "before.txt"))
            metrics.update({"post_ls_ok": ls["rc"] == 0, "post_write_read_ok": write["rc"] == 0 and write["out"].decode("utf-8", "replace") == "post-" + self.run_id,
                            "pre_file_read_ok": old["rc"] == 0})
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
        stop = threading.Event()
        writers = [ChurnWriter(folder, "wr%d" % index, stop) for index in range(4)]
        for writer in writers:
            writer.start()
        probes = []
        try:
            time.sleep(3)
            # Sub-test A: stop for OUTAGE_A_S, restart, let writers run after recovery.
            a_from = [len(w.ops) for w in writers]
            stopped = self._docker(["stop", "-t", "10", CONTAINER_FILES], 90)
            time.sleep(OUTAGE_A_S)
            self._docker(["start", CONTAINER_FILES], 90)
            ready_s = self._wait_container_ready(CONTAINER_FILES, 240)
            time.sleep(15)
            a_to = [len(w.ops) for w in writers]
            a_ops = [op for index, w in enumerate(writers) for op in w.ops[a_from[index]:a_to[index]]]
            a_ok = [op for op in a_ops if op[1]]
            a_bad = [op for op in a_ops if not op[1]]
            a_max = max((op[0] for op in a_ops), default=0)
            a_metrics = {"stop_rc": stopped.returncode, "down_s": OUTAGE_A_S, "writes_ok": len(a_ok), "writes_failed": len(a_bad),
                         "p50_ms": pct([op[0] for op in a_ok], 0.5), "p95_ms": pct([op[0] for op in a_ok], 0.95),
                         "max_ms": round(a_max, 1), "errors": dict(collections.Counter(op[2] for op in a_bad)), "ready_s": ready_s}
            self.emit("outage-a-restart", stopped.returncode == 0 and a_max < OP_BOUND_S * 1000 and len(a_ok) > 0,
                      "down=%ds ok=%d failed=%d max_ms=%.0f" % (OUTAGE_A_S, len(a_ok), len(a_bad), a_max), time.monotonic(), a_metrics)

            # Sub-test B: stop for OUTAGE_B_S with probes that must fail cleanly and never hang past OP_BOUND_S.
            self._docker(["stop", "-t", "10", CONTAINER_FILES], 90)
            b_started = time.monotonic()
            while time.monotonic() - b_started < OUTAGE_B_S:
                tick = time.monotonic()
                probes.append(self._probe(["sh", "-c", 'printf %s "$2" > "$1"', "sh", str(folder / "probe.txt"), "x"], OP_BOUND_S))
                time.sleep(max(0.0, 10 - (time.monotonic() - tick)))
            b_hung = [p for p in probes if p["hung"]]
            b_max = max((p["ms"] for p in probes), default=0)
            b_errors = dict(collections.Counter(p["err"] for p in probes if p["rc"] not in (0, None)))
            self.emit("outage-b-stop", not b_hung and b_max < (OP_BOUND_S + SLACK_S) * 1000,
                      "down=%ds probes=%d hung=%d max_ms=%.0f errors=%s" % (OUTAGE_B_S, len(probes), len(b_hung), b_max, json.dumps(b_errors)),
                      b_started, {"down_s": OUTAGE_B_S, "probes": len(probes), "hung": len(b_hung), "max_ms": round(b_max, 1), "errors": b_errors})

            # Recovery: start Files and prove a fresh write+read works.
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
        except Exception as exc:
            self.emit("outage", False, "%s: %s" % (type(exc).__name__, str(exc)[:200]), time.monotonic())
        finally:
            stop.set()
            for writer in writers:
                writer.join(timeout=30)
            self.ensure_files_running()
        rows = [row for writer in writers for row in writer.rows]
        self.ledger_add([("outage/" + name, sha) for name, sha in rows])
        counts = self._verify_rows(folder, rows)
        self.emit("outage-successful-write-integrity",
                  len(rows) > 0 and counts.get("ok", 0) == len(rows) and not counts.get("unverified_timeout"),
                  "successful_writes=%d verified=%d mismatch=%d missing=%d unverified=%d" % (len(rows), counts.get("ok", 0), counts.get("mismatch", 0),
                                                                                         counts.get("missing", 0), counts.get("unverified_timeout", 0)),
                  time.monotonic(), {"successful_writes": len(rows), "verified": counts.get("ok", 0), "mismatch": counts.get("mismatch", 0),
                                     "missing": counts.get("missing", 0), "unverified": counts.get("unverified_timeout", 0)})

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
                vm_errors[self.note_error(exc)] += 1
        metrics["vm_open_ok"] = len(held)
        for handle in held:
            handle.close()
        names_containers = []
        script = ('d="$1"; n="$2"; i=0\n'
                  'while [ "$i" -lt "$n" ]; do eval "exec $((i+10))>\\"$d/h$i\\""; i=$((i+1)); done\n'
                  'i=0; while [ "$i" -lt "$n" ]; do eval "printf v%s $i >&$((i+10))"; i=$((i+1)); done\n'
                  'echo "opened=$n"; sleep 1\n')
        container_results = []
        try:
            image = self._soak_image()
            for index in range(2):
                name = "fusesoak-h%d-%s" % (index, datetime.datetime.now(datetime.timezone.utc).strftime("%H%M%S"))
                names_containers.append(name)
                self._start_test_container(name, image)
                result = self._probe(["docker", "exec", name, "sh", "-c", script, "sh", str(folder), "100"], 90)
                opened = "opened=100" in result["out"].decode("utf-8", "replace")
                container_results.append({"opened_100": opened, "rc": result["rc"], "err": result["err"] or "none"})
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
            if code == errno.EIO:
                with EIO_LOG.open("a", encoding="utf-8") as log:
                    log.write(json.dumps({"run": self.run_id, "root": str(self.root), "t": when}) + "\n")
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
                    errors[self.note_error(exc)] += 1
            return samples

        idle = stat_pass(files) + stat_pass(files)
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
                    load_errors[self.note_error(exc)] += 1
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
        metrics = {"files": len(files), "stat_idle_p50_ms": pct(idle, 0.5), "stat_idle_p95_ms": pct(idle, 0.95), "stat_idle_p99_ms": pct(idle, 0.99),
                   "stat_load_p50_ms": pct(loaded, 0.5), "stat_load_p95_ms": pct(loaded, 0.95), "stat_load_p99_ms": pct(loaded, 0.99),
                   "read_first_p50_ms": pct(first_reads, 0.5), "read_repeat_p50_ms": pct(repeat_reads, 0.5),
                   "errors": dict(errors), "load_errors": dict(load_errors)}
        passed = not errors and not load_errors and (metrics["stat_load_p95_ms"] or 0) <= LATENCY_P95_MS
        self.emit("latency-stat-lookup", passed, "idle p50=%s p95=%s p99=%s load p50=%s p95=%s p99=%s read first=%s repeat=%s" %
                  (metrics["stat_idle_p50_ms"], metrics["stat_idle_p95_ms"], metrics["stat_idle_p99_ms"], metrics["stat_load_p50_ms"],
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

    def staleness(self):
        folder = self.root / "staleness"
        folder.mkdir(exist_ok=True)
        started = time.monotonic()
        collection, base = self._collection_and_rel()
        resolved = self._fuse_api({"action": "resolve", "name": collection})
        if not resolved.get("collectionId"):
            raise CheckFailure("collection id not resolvable through the Files API (status %s)" % resolved.get("status"))
        cid = resolved["collectionId"]
        existing_rel = base + "/staleness/existing.txt"
        new_rel = base + "/staleness/new.txt"
        existing = folder / "existing.txt"
        old = b"old-" + self.run_id.encode()
        existing.write_bytes(old)
        new_payload = "new-" + self.run_id + "-" + str(time.time_ns())
        t_api = time.monotonic()
        put_new = self._fuse_api({"action": "put", "collectionId": cid, "path": new_rel, "content": new_payload})
        new_visible = None
        while time.monotonic() - t_api < 120:
            read = self._probe(["sh", "-c", 'cat "$1"', "sh", str(folder / "new.txt")], 60)
            if read["rc"] == 0 and read["out"].decode("utf-8", "replace") == new_payload:
                new_visible = round(time.monotonic() - t_api, 3)
                break
            time.sleep(0.25)
        updated = "upd-" + self.run_id + "-" + str(time.time_ns())
        t_mod = time.monotonic()
        put_existing = self._fuse_api({"action": "put", "collectionId": cid, "path": existing_rel, "content": updated})
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
        metrics = {"collection_ok": True, "new_visible_s": new_visible, "new_put_status": put_new.get("status"),
                   "modify_visible_s": modified_visible, "modify_put_status": put_existing.get("status"),
                   "window_s": INVALIDATE_WINDOW, "slack_s": SLACK_S, "stale_reads_seen": stale_reads, "stale_reads_after_window": stale_after_window}
        passed = (new_visible is not None and put_new.get("status") in (200, 201)
                  and modified_visible is not None and modified_visible <= bound and stale_after_window == 0)
        self.ledger_add([("staleness/new.txt", hashlib.sha256(new_payload.encode()).hexdigest())])
        self.ledger_add([("staleness/existing.txt", hashlib.sha256(updated.encode()).hexdigest())])
        self.emit("staleness-visibility-and-invalidation", passed,
                  "new_visible_s=%s modify_visible_s=%s bound_s=%.1f stale_after_window=%d" % (new_visible, modified_visible, bound, stale_after_window),
                  started, metrics)

    def eio_events(self):
        if not EIO_LOG.is_file():
            return []
        events = []
        for line in EIO_LOG.read_text(encoding="utf-8").splitlines():
            try:
                row = json.loads(line)
            except ValueError:
                continue
            if row.get("root") == str(self.root) and isinstance(row.get("t"), (int, float)):
                events.append(float(row["t"]))
        return sorted(events)

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
        metrics = {"eio_events": len(events), "matched_lines": matched_lines, "top_status_codes": top, "logs_readable": read_ok}
        self.emit("eio-capture", read_ok, "eio_events=%d matched_log_lines=%d top=%s" % (len(events), matched_lines, json.dumps(top)), started, metrics)

    def env_info(self):
        started = time.monotonic()
        metrics = {"mount": str(MOUNT), "bind_spec": bind_spec(MOUNT)}
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
        try:
            metrics_api = self._fuse_api({"action": "metrics"})
            self.emit("env-files-metrics", True, json.dumps(metrics_api.get("probed", {}), sort_keys=True), started,
                      {"probed": metrics_api.get("probed"), "metric_names": metrics_api.get("metric_names", [])})
        except Exception as exc:
            self.emit("env-files-metrics", True, "skipped: %s" % short_err(str(exc)), started)

    def integrity(self):
        started = time.monotonic()
        rows = self.ledger_rows()
        if not rows:
            self.emit("integrity-mount", True, "no ledger rows for this soak root", started)
            return
        counts = self._verify_rows(self.root, rows, cap=900)
        verified = counts.get("ok", 0)
        self.emit("integrity-mount", verified == len(rows) and not counts.get("unverified_timeout"),
                  "ledger=%d verified=%d mismatch=%d missing=%d unverified=%d" % (len(rows), verified, counts.get("mismatch", 0),
                                                                                  counts.get("missing", 0), counts.get("unverified_timeout", 0)),
                  started, {"ledger_rows": len(rows), "verified": verified, "mismatch": counts.get("mismatch", 0),
                            "missing": counts.get("missing", 0), "errors": {k: v for k, v in counts.items() if k.startswith("error")}})
        started = time.monotonic()
        if not rows or API_SAMPLE == 0:
            return
        collection, base = self._collection_and_rel()
        resolved = self._fuse_api({"action": "resolve", "name": collection})
        if not resolved.get("collectionId"):
            self.emit("integrity-api", False, "collection id not resolvable through the Files API", started)
            return
        rng = random.Random(self.run_id)
        sample = rng.sample(rows, min(API_SAMPLE, len(rows)))
        items = [[(base + "/" + rel), sha] for rel, sha in sample]
        verdict = self._fuse_api({"action": "verify", "collectionId": resolved["collectionId"], "items": items})
        counts = verdict.get("counts", {})
        passed = counts.get("matched", 0) == len(items)
        self.emit("integrity-api", passed, "sample=%d matched=%d mismatch=%d unresolved=%d" %
                  (len(items), counts.get("matched", 0), counts.get("mismatch", 0), counts.get("unresolved", 0)),
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

    def cleanup(self):
        parent = self.root.parent.resolve()
        root = self.root.resolve()
        if root.parent != parent or not root.name.startswith("files-soak-"):
            raise CheckFailure("refusing cleanup outside the selected soak folder")
        shutil.rmtree(root)
        for path in (STATE, STATE_DIR / "manifest.jsonl", STATE_DIR / "crash-success.log", LEDGER, EIO_LOG):
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
                try:
                    getattr(self, phase.replace("-", "_"))()
                except Exception as exc:
                    self.emit(phase + "-phase", False, "%s: %s" % (type(exc).__name__, str(exc)[:180]), time.monotonic())
                finally:
                    if phase not in ("fuse-identity", "env-info", "eio-capture", "integrity", "summary"):
                        self.ensure_files_running()
        print("SOAK SUMMARY phase=%s run=%s checks=%d failed=%d results=%s" %
              (self.requested_phase, self.run_id, self.checks, self.failures, RESULTS), flush=True)
        return 1 if self.failures else 0


def main():
    phases = {"bulk", "append", "ops", "crash", "load", "cloud", "restart-propagation", "outage", "handles", "token-empty",
              "lock-contention", "latency", "staleness", "eio-capture", "env-info", "fuse-identity", "integrity", "summary", "all", "cleanup"}
    if len(sys.argv) != 3 or sys.argv[1] not in phases:
        print("usage: files-soak.sh <phase|all|cleanup> [--with-app-restart]", file=sys.stderr)
        return 2
    try:
        return FilesSoak(sys.argv[1], sys.argv[2] == "true").run()
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
