#!/usr/bin/env bash
# Sulla Desktop · https://sulladesktop.com
# Copyright (c) 2025-2026 Merchant Protocol LLC.
# SPDX-License-Identifier: GPL-2.0-or-later
# "Sulla" is a trademark. See TRADEMARK.md.
# Runs inside the Desktop VM. Data is restricted to one per-run QA folder under the
# detected personal Files collection; crash tests intentionally restart its services.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ $# -lt 1 ]]; then
  echo "usage: files-soak.sh <bulk|append|ops|crash|load|cloud|all|cleanup> [--with-app-restart]" >&2
  exit 2
fi

PHASE=""
WITH_APP_RESTART="false"
for arg in "$@"; do
  case "$arg" in
    --with-app-restart) WITH_APP_RESTART="true" ;;
    bulk|append|ops|crash|load|cloud|all|cleanup) PHASE="$arg" ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done
if [[ -z "$PHASE" ]]; then echo "usage: files-soak.sh <phase|all|cleanup> [--with-app-restart]" >&2; exit 2; fi

exec python3 -I - "$PHASE" "$WITH_APP_RESTART" <<'PYTHON'
# Sulla Desktop · https://sulladesktop.com
# Copyright (c) 2025-2026 Merchant Protocol LLC.
# SPDX-License-Identifier: GPL-2.0-or-later
# "Sulla" is a trademark. See TRADEMARK.md.
"""Files durability soak runner. Standard library only; intended for the Sulla VM."""
import datetime
import hashlib
import json
import multiprocessing
import os
import random
import re
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

MOUNT = Path("/mnt/sulla-files")
STATE_DIR = Path.home() / "sulla-twodev" / "soak"
RESULTS = STATE_DIR / "results.jsonl"
STATE = STATE_DIR / "state.json"
COMMAND_TIMEOUT = 20
FILE_TIMEOUT = 45
CRASH_FILE_BYTES = 64 * 1024
CRASH_INTERVAL = 0.5


class CheckFailure(Exception):
    pass


class FilesSoak:
    def __init__(self, phase, with_app_restart):
        self.phase = phase
        self.requested_phase = phase
        self.with_app_restart = with_app_restart
        self.failures = 0
        self.checks = 0
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        self.root = self._get_run_root()

    def _personal_collection(self):
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

    @staticmethod
    def _alarm(_signum, _frame):
        raise TimeoutError("operation exceeded its time limit")

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

    def emit(self, check, ok, detail, started):
        record = {"phase": self.phase, "check": check, "ok": bool(ok),
                  "detail": str(detail), "ms": round((time.monotonic() - started) * 1000)}
        line = json.dumps(record, sort_keys=True, separators=(",", ":"))
        print(line, flush=True)
        with RESULTS.open("a", encoding="utf-8") as log:
            log.write(line + "\n")
        self.checks += 1
        if not ok:
            self.failures += 1

    def check(self, name, work):
        started = time.monotonic()
        try:
            detail = work()
            self.emit(name, True, detail, started)
        except Exception as exc:  # A failed operation is evidence; continue with the remaining checks.
            self.emit(name, False, "%s: %s" % (type(exc).__name__, str(exc)[:180]), started)

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

    @staticmethod
    def _crash_writer(folder, success_log, stop_event):
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
            except Exception:
                pass
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
            self.emit(name + "-mount-recovery", True, "seconds=%.3f cap=300" % seconds, started)
        except Exception as exc:
            self.emit(name + "-mount-recovery", False, "%s: %s" % (type(exc).__name__, str(exc)[:160]), started)

    def crash(self):
        folder = self.root / "crash"
        folder.mkdir(exist_ok=True)
        success_log = STATE_DIR / "crash-success.log"
        success_log.touch(exist_ok=True)
        stop_event = multiprocessing.Event()
        writer = multiprocessing.Process(target=self._crash_writer, args=(str(folder), str(success_log), stop_event), daemon=True)
        writer.start()
        time.sleep(2)
        self._restart_action("restart-files-container", ["docker", "restart", "--time", "10", "sulla_files"], 40)
        # entrypoint.sh starts the FUSE daemon as python3 .../sulla-files-fuse.py and
        # restarts it itself; terminate only that child, not PID 1/the container.
        self._restart_action("kill-files-fuse-daemon", ["docker", "exec", "sulla_files_fuse", "pkill", "-f", "^python3 /usr/local/libexec/sulla-files-fuse.py"], 15)
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
        if writer.is_alive():
            writer.terminate()
            writer.join(timeout=5)
        self.check("crash-successful-write-integrity", lambda: self._verify_success_writes(folder, success_log))

    def load(self):
        try:
            minutes = max(1, min(int(os.environ.get("SOAK_MINUTES", "30")), 1440))
        except ValueError:
            minutes = 30
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
        missed = 0
        while time.monotonic() < deadline:
            expected = hashlib.sha256(("load-%d" % sequence).encode()).digest() * 2048
            try:
                with target.open("wb") as handle:
                    handle.write(expected)
                    handle.flush()
                    os.fsync(handle.fileno())
                if target.read_bytes() != expected:
                    errors += 1
            except Exception:
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
                  "duration_s=%d writes=%d readwrite_errors=%d mount_drops=%d %s" % (duration, sequence, errors, drops, log_state), started_at)

    def cloud(self):
        # sync_state in /v1/files is the local hydration/conflict state; cloud-head rows are
        # server-side internals, not a per-file guest API. Don't report hydration as cloud-synced.
        started = time.monotonic()
        self.emit("per-file-cloud-sync", True,
                  "skipped: Files exposes cloud heads internally, but no supported guest endpoint reports per-file cloud commit state", started)

    def cleanup(self):
        parent = self.root.parent.resolve()
        root = self.root.resolve()
        if root.parent != parent or not root.name.startswith("files-soak-"):
            raise CheckFailure("refusing cleanup outside the selected soak folder")
        shutil.rmtree(root)
        for path in (STATE, STATE_DIR / "manifest.jsonl", STATE_DIR / "crash-success.log"):
            try:
                path.unlink()
            except FileNotFoundError:
                pass
        return "removed=true"

    def run(self):
        if self.phase == "cleanup":
            started = time.monotonic()
            try:
                detail = self.cleanup()
                self.emit("cleanup-soak-folder", True, detail, started)
            except Exception as exc:
                self.emit("cleanup-soak-folder", False, "%s: %s" % (type(exc).__name__, str(exc)[:180]), started)
        else:
            phases = ("bulk", "append", "ops", "crash", "load", "cloud") if self.phase == "all" else (self.phase,)
            for phase in phases:
                self.phase = phase
                getattr(self, phase)()
        print("SOAK SUMMARY phase=%s checks=%d failed=%d results=%s" %
              (self.requested_phase, self.checks, self.failures, RESULTS), flush=True)
        return 1 if self.failures else 0


def main():
    if len(sys.argv) != 3 or sys.argv[1] not in {"bulk", "append", "ops", "crash", "load", "cloud", "all", "cleanup"}:
        print("usage: files-soak.sh <phase|all|cleanup> [--with-app-restart]", file=sys.stderr)
        return 2
    try:
        return FilesSoak(sys.argv[1], sys.argv[2] == "true").run()
    except Exception as exc:
        record = {"phase": sys.argv[1], "check": "preflight", "ok": False,
                  "detail": "%s: %s" % (type(exc).__name__, str(exc)[:180]), "ms": 0}
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
