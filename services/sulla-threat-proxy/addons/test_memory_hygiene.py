import asyncio

import memory_hygiene


class FakeTrimmer:
    def __init__(self):
        self.calls = 0

    def _trim_heap(self):
        self.calls += 1


def make_hygiene(monkeypatch, **kwargs):
    hygiene = memory_hygiene.MemoryHygiene.__new__(memory_hygiene.MemoryHygiene)
    hygiene.interval_s = kwargs.get("interval_s", 15)
    hygiene.every_connections = kwargs.get("every_connections", 3)
    hygiene._closed = 0
    hygiene._last_run = 0
    hygiene._last_log = 0
    hygiene._task = None
    hygiene._trimmer = FakeTrimmer()
    monkeypatch.setattr(memory_hygiene, "log", lambda *args, **fields: None)
    monkeypatch.setattr(hygiene, "_rss_bytes", lambda: 123)
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
    assert hygiene._trimmer.calls == 2


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


def test_missing_malloc_trim_is_tolerated(monkeypatch):
    from prompt_injection import PromptInjectionScanner

    scanner = PromptInjectionScanner.__new__(PromptInjectionScanner)
    monkeypatch.setattr(memory_hygiene.time, "monotonic", lambda: 100.0)
    monkeypatch.setattr("prompt_injection._TRIMMED_AT", 0.0)
    monkeypatch.setattr("prompt_injection._LIBC_LOADED", True)
    monkeypatch.setattr("prompt_injection._LIBC", object())
    scanner._trim_heap()  # AttributeError from absent malloc_trim is swallowed.
