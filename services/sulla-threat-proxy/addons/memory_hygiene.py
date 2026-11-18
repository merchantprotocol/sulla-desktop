# Sulla Desktop · https://sulladesktop.com
# Copyright (c) 2025-2026 Merchant Protocol LLC.
# SPDX-License-Identifier: GPL-2.0-or-later

"""Bound cyclic-garbage and libc heap retention under proxy connection churn."""

import asyncio
import gc
import os
import time

from common import log
from prompt_injection import PromptInjectionScanner


class MemoryHygiene:
    def __init__(self) -> None:
        self.interval_s = max(1.0, float(os.getenv("SULLA_PROXY_GC_INTERVAL_S", "15")))
        self.every_connections = max(1, int(os.getenv("SULLA_PROXY_GC_EVERY_CONNECTIONS", "200")))
        self._closed = 0
        self._last_run = 0.0
        self._last_log = 0.0
        self._task = None
        # Reuse the prompt scanner's existing glibc-safe malloc_trim helper.
        self._trimmer = PromptInjectionScanner()

    def running(self) -> None:
        self._task = asyncio.create_task(self._interval_loop())

    def done(self) -> None:
        if self._task is not None:
            self._task.cancel()
            self._task = None

    def client_disconnected(self, client) -> None:
        self._closed += 1
        now = time.monotonic()
        if self._closed >= self.every_connections and now - self._last_run >= 2.0:
            self._collect()

    async def _interval_loop(self) -> None:
        try:
            while True:
                await asyncio.sleep(self.interval_s)
                self._collect()
        except asyncio.CancelledError:
            raise

    def _collect(self) -> None:
        started = time.monotonic()
        before = self._rss_bytes()
        collected = gc.collect()
        self._trimmer._trim_heap()
        after = self._rss_bytes()
        self._closed = 0
        self._last_run = time.monotonic()
        if self._last_run - self._last_log >= 60.0:
            log("memory_hygiene", "info", "periodic_gc", collected=collected,
                rss_before=before, rss_after=after,
                duration_ms=round((self._last_run - started) * 1000, 2))
            self._last_log = self._last_run

    @staticmethod
    def _rss_bytes() -> int:
        try:
            with open("/proc/self/statm", encoding="ascii") as statm:
                resident_pages = int(statm.read().split()[1])
            return resident_pages * os.sysconf("SC_PAGE_SIZE")
        except (OSError, ValueError, IndexError):
            return 0


addons = [MemoryHygiene()]
