"""Regression for handle ownership across simultaneous timeout and cleanup."""

import threading
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

from voiceprint.process_lifetime import ParentDeathJob


def test_concurrent_job_close_takes_handle_exactly_once():
    job = object.__new__(ParentDeathJob)
    calls = []
    job.handle = 42
    job.lock = threading.Lock()
    job.kernel = SimpleNamespace(CloseHandle=calls.append)
    with ThreadPoolExecutor(max_workers=8) as executor:
        list(executor.map(lambda _index: job.close(), range(32)))
    assert calls == [42]
    assert job.handle is None
