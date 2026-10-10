"""Same-UID local crash recovery with fixed aggregate output only."""

import json
import signal
import time

import pytest

from core.services import voiceprint_query_files as files
from core.services import voiceprint_query_janitor as janitor
from core.services.voiceprint_media_process import MediaError


def test_sweep_removes_expired_crash_leftover_and_keeps_live_files(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(files, "directory", tmp_path.resolve)
    for name, expires in (("expired", 1000), ("live", int(time.time()) + 120)):
        root = tmp_path / ("query-" + name)
        root.mkdir()
        (root / "source.media").write_bytes(b"synthetic fixture")
        (root / "lease.json").write_text(json.dumps({"schema": 1, "expires": expires}))
    assert janitor.sweep() == {
        "status": "ready",
        "scanned": 2,
        "removed": 1,
        "failed": 0,
    }
    assert not (tmp_path / "query-expired").exists()
    assert (tmp_path / "query-live/source.media").exists()


@pytest.mark.parametrize("error", [OSError, MediaError])
def test_filesystem_failure_is_redacted_and_does_not_kill_janitor(error, monkeypatch):
    def unavailable(**_kwargs):
        raise error("private-directory-and-recording")

    monkeypatch.setattr(janitor, "purge", unavailable)
    assert janitor.sweep() == {"status": "unavailable"}


def test_signal_interrupts_idle_wait_and_output_has_only_aggregate_counts(
    monkeypatch, capsys
):
    handlers = {}
    monkeypatch.setattr(
        janitor.signal,
        "signal",
        handlers.setdefault,
    )
    monkeypatch.setattr(
        janitor,
        "sweep",
        lambda: (
            handlers[signal.SIGTERM](signal.SIGTERM, None)
            or {"status": "ready", "scanned": 0, "removed": 0, "failed": 0}
        ),
    )
    started = time.monotonic()
    janitor.main()
    assert time.monotonic() - started < 1
    assert json.loads(capsys.readouterr().out) == {
        "status": "ready",
        "scanned": 0,
        "removed": 0,
        "failed": 0,
    }
