#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Optional harness-only tracemalloc and allocator diagnostics for mitmdump."""
import gc
import json
import os
import threading
import time
from itertools import islice
import tracemalloc
import ctypes


class MemoryDiagnostics:
    INTERESTING = ("Connection", "Layer", "Flow", "SSL", "Context", "Transport", "Task")
    SCAN_LIMIT = 250_000

    def __init__(self, interval=60):
        self.interval = interval
        self.stopped = threading.Event()
        tracemalloc.start(1)
        self.thread = threading.Thread(target=self._sample_loop, name="harness-memdiag", daemon=True)
        self.thread.start()

    def _object_counts(self):
        counts = {}
        for obj in islice(gc.get_objects(), self.SCAN_LIMIT):
            name = type(obj).__name__
            if any(term in name for term in self.INTERESTING):
                counts[name] = counts.get(name, 0) + 1
        return counts

    def snapshot(self):
        current, peak = tracemalloc.get_traced_memory()
        stats = tracemalloc.take_snapshot().statistics("lineno")[:10]
        try:
            with open("/proc/self/status") as status:
                rss = next((int(line.split()[1]) for line in status if line.startswith("VmRSS:")), None)
        except OSError:
            rss = None
        try:
            fd_count = len(os.listdir("/proc/self/fd"))
        except OSError:
            fd_count = None
        return {
            "type": "memdiag", "timestamp": time.time(), "tracemalloc_current": current,
            "tracemalloc_peak": peak, "top": [{"line": str(item.traceback[0]), "size": item.size,
            "count": item.count} for item in stats], "gc_counts": gc.get_count(),
            "gc_objects": len(gc.get_objects()), "selected_live_objects": self._object_counts(),
            "open_fds": fd_count, "vmrss_kib": rss,
        }

    def emit(self, extra=None):
        data = self.snapshot()
        if extra:
            data.update(extra)
        print("MEMDIAG " + json.dumps(data, separators=(",", ":")), flush=True)

    def _sample_loop(self):
        while not self.stopped.wait(self.interval):
            self.emit()

    def done(self):
        self.stopped.set()
        before = self.snapshot().get("vmrss_kib")
        gc.collect()
        trim_return = None
        try:
            trim_return = ctypes.CDLL(None).malloc_trim(0)
        except (AttributeError, OSError):
            pass
        after = self.snapshot().get("vmrss_kib")
        self.emit({"phase": "done", "rss_before_gc_trim_kib": before,
                   "rss_after_gc_trim_kib": after,
                   "rss_trim_delta_kib": None if before is None or after is None else after - before,
                   "malloc_trim_return": trim_return})


addons = [MemoryDiagnostics()]


def done():
    addons[0].done()
