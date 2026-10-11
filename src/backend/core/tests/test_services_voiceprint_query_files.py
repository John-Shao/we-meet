"""Synthetic crash leftovers, independent expiry and confined bounded deletion."""

import json
import os
import time
from pathlib import Path

import pytest

from core.services import voiceprint_query_files as service
from core.services.voiceprint_media_process import MediaError


@pytest.fixture
def root(tmp_path, monkeypatch):
    private = tmp_path / "private"
    private.mkdir()
    monkeypatch.setattr(service, "directory", private.resolve)
    return private


def test_independent_expiry_removes_audio_while_owner_is_waiting(root):
    expires = int(time.time()) + 3
    with service.leased_directory(expires) as directory:
        audio = Path(directory) / "source.media"
        audio.write_bytes(b"synthetic temporary audio")
        derivative = audio.parent / "diarization.wav"
        derivative.write_bytes(b"synthetic mono derivative")
        assert json.loads((audio.parent / "lease.json").read_bytes()) == {
            "schema": 1,
            "expires": expires,
        }
        time.sleep(max(0, expires - time.time()) + 0.2)
        assert not audio.exists()
        assert not derivative.exists()
    assert not audio.parent.exists()


def test_normal_and_exceptional_exit_remove_all_query_files(root):
    with pytest.raises(ValueError, match="synthetic failure"):
        with service.leased_directory(int(time.time()) + 30) as directory:
            (Path(directory) / "source.media").write_bytes(b"synthetic audio")
            raise ValueError("synthetic failure")
    assert not Path(directory).exists()


def test_busy_source_does_not_delay_deletion_of_its_derivative(root, monkeypatch):
    unlink = Path.unlink

    def busy(path, *args, **kwargs):
        if path.name == "source.media":
            raise OSError("synthetic shared native handle")
        return unlink(path, *args, **kwargs)

    monkeypatch.setattr(Path, "unlink", busy)
    expires = int(time.time()) + 3
    with service.leased_directory(expires) as directory:
        source = Path(directory) / "source.media"
        derivative = Path(directory) / "diarization.wav"
        source.write_bytes(b"synthetic source")
        derivative.write_bytes(b"synthetic mono")
        time.sleep(max(0, expires - time.time()) + 0.2)
        assert source.exists() and not derivative.exists()


@pytest.mark.parametrize("expires", [True, 0, -1, 0.5, 2**63])
def test_invalid_or_unbounded_leases_rejected(root, expires):
    with pytest.raises(MediaError):
        with service.leased_directory(expires):
            pytest.fail("Invalid lease must not create a directory")
    assert not list(root.iterdir())


def test_crash_recovery_respects_deadline_and_drain(root):
    path = root / "query-crashed"
    path.mkdir()
    (path / "source.media").write_bytes(b"synthetic abandoned audio")
    (path / "lease.json").write_text(json.dumps({"schema": 1, "expires": 1000}))
    assert service.purge(now=1044)["removed"] == 0
    assert service.purge(now=1045) == {"scanned": 1, "removed": 1, "failed": 0}
    assert not path.exists()


@pytest.mark.parametrize("kind", ["missing", "malformed", "oversized", "future"])
def test_invalid_leftover_lease_cannot_retain_audio_indefinitely(root, kind):
    path = root / "query-corrupt"
    path.mkdir()
    (path / "source.media").write_bytes(b"synthetic abandoned audio")
    lease = path / "lease.json"
    if kind == "malformed":
        lease.write_bytes(b"not JSON")
    elif kind == "oversized":
        lease.write_bytes(b"x" * 257)
    elif kind == "future":
        lease.write_text(json.dumps({"schema": 1, "expires": 2**63}))
    os.utime(path, (1000, 1000))
    assert service.purge(now=1944)["removed"] == 0
    assert service.purge(now=1945)["removed"] == 1


def test_unrelated_directories_and_symlinks_are_never_followed(root, tmp_path):
    unrelated = root / "ordinary-recording"
    unrelated.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "source.media").write_bytes(b"do not delete")
    try:
        (root / "query-link").symlink_to(outside, target_is_directory=True)
    except OSError:
        pass  # Windows without symlink privileges still verifies unrelated data.
    assert service.purge(now=2**40)["removed"] == 0
    assert unrelated.exists() and (outside / "source.media").exists()


def test_scan_is_bounded(root):
    for i in range(3):
        path = root / f"query-{i}"
        path.mkdir()
        (path / "lease.json").write_text(json.dumps({"schema": 1, "expires": 1000}))
    assert service.purge(now=1045, limit=1)["scanned"] == 1
    assert len(list(root.iterdir())) == 2
