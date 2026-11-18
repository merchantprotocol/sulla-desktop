import asyncio

import common
import memory_hygiene


def make_hygiene(monkeypatch, **kwargs):
    hygiene = memory_hygiene.MemoryHygiene.__new__(memory_hygiene.MemoryHygiene)
    hygiene.interval_s = kwargs.get("interval_s", 15)
    hygiene.every_connections = kwargs.get("every_connections", 3)
    hygiene._closed = 0
    hygiene._last_run = 0
    hygiene._last_log = 0
    hygiene._task = None
    monkeypatch.setattr(memory_hygiene, "log", lambda *args, **fields: None)
    monkeypatch.setattr(hygiene, "_rss_bytes", lambda: 123)
    trim_calls = []
    monkeypatch.setattr(memory_hygiene, "trim_heap", lambda: trim_calls.append("trim"))
    hygiene.trim_calls = trim_calls
    return hygiene


def test_interval_loop_collects_and_trims_at_interval(monkeypatch):
    hygiene = make_hygiene(monkeypatch)
    calls = []
    monkeypatch.setattr(memory_hygiene.gc, "collect", lambda: calls.append("gc") or 7)

    async def fake_sleep(seconds):
        calls.append(seconds)
        if calls.count(15) == 2:
            raise asyncio.CancelledError

    monkeypatch.setattr(memory_hygiene.asyncio, "sleep", fake_sleep)
    try:
        asyncio.run(hygiene._interval_loop())
    except asyncio.CancelledError:
        pass
    assert calls == [15, "gc", 15, "gc"]
    assert hygiene.trim_calls == ["trim", "trim"]


def test_interval_loop_continues_after_collect_exception(monkeypatch):
    hygiene = make_hygiene(monkeypatch)
    attempts = []
    warnings = []

    def collect():
        attempts.append("collect")
        if len(attempts) == 1:
            raise RuntimeError("transient")

    monkeypatch.setattr(hygiene, "_collect", collect)
    monkeypatch.setattr(memory_hygiene, "log", lambda *args, **fields: warnings.append((args, fields)))

    async def fake_sleep(_seconds):
        if len(attempts) == 2:
            raise asyncio.CancelledError

    monkeypatch.setattr(memory_hygiene.asyncio, "sleep", fake_sleep)
    try:
        asyncio.run(hygiene._interval_loop())
    except asyncio.CancelledError:
        pass

    assert attempts == ["collect", "collect"]
    assert warnings == [(('memory_hygiene', 'warn', 'periodic_gc_failed'), {'reason': 'RuntimeError'})]


def test_connection_trigger_fires_at_threshold_and_is_rate_limited(monkeypatch):
    hygiene = make_hygiene(monkeypatch)
    now = [10.0]
    monkeypatch.setattr(memory_hygiene.time, "monotonic", lambda: now[0])
    calls = []
    def collect():
        calls.append(now[0])
        hygiene._closed = 0
        hygiene._last_run = now[0]

    monkeypatch.setattr(hygiene, "_collect", collect)

    for _ in range(3):
        hygiene.client_disconnected(None)
    assert calls == [10.0]
    for _ in range(3):
        hygiene.client_disconnected(None)
    assert calls == [10.0]
    now[0] = 12.0
    for _ in range(3):
        hygiene.client_disconnected(None)
    assert calls == [10.0, 12.0]


def test_done_cancels_task(monkeypatch):
    hygiene = make_hygiene(monkeypatch)

    class Task:
        cancelled = False

        def cancel(self):
            self.cancelled = True

    task = Task()
    hygiene._task = task
    hygiene.done()
    assert task.cancelled
    assert hygiene._task is None


def test_trim_heap_is_rate_limited(monkeypatch):
    from types import SimpleNamespace

    now = [100.0]
    libc = SimpleNamespace(malloc_trim=lambda _arg: calls.append("trim"))
    calls = []
    monkeypatch.setattr(common.time, "monotonic", lambda: now[0])
    monkeypatch.setattr(common.ctypes, "CDLL", lambda _name: libc)
    monkeypatch.setattr(common, "_TRIMMED_AT", 0.0)
    monkeypatch.setattr(common, "_LIBC_LOADED", False)
    monkeypatch.setattr(common, "_LIBC", None)

    common.trim_heap()
    now[0] += 0.5
    common.trim_heap()
    assert calls == ["trim"]


def test_trim_heap_tolerates_missing_libc(monkeypatch):
    monkeypatch.setattr(common.time, "monotonic", lambda: 100.0)
    monkeypatch.setattr(common.ctypes, "CDLL", lambda _name: (_ for _ in ()).throw(OSError("missing")))
    monkeypatch.setattr(common, "_TRIMMED_AT", 0.0)
    monkeypatch.setattr(common, "_LIBC_LOADED", False)
    monkeypatch.setattr(common, "_LIBC", None)

    common.trim_heap()
