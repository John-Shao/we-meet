"""Probe cleanup boundaries, run with the backend's Django pytest settings."""

import importlib.util
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from core.services import capture_audio_cleanup, capture_storage

spec = importlib.util.spec_from_file_location(
    "purge_probe", Path(__file__).with_name("record_purge_probe.py")
)
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class FakeStorage:
    file_overwrite = True

    def __init__(self):
        self.objects = {}
        self.removed = []
        self.lose_response = False

    def exists(self, key):
        return key in self.objects

    def save(self, key, content):
        self.objects[key] = content.read()
        if self.lose_response:
            raise TimeoutError("private provider details")
        return key

    def url(self, key):
        return f"https://storage.invalid/{key}?signature=private"

    def delete(self, key):
        self.removed.append(key)
        self.objects.pop(key, None)


@pytest.fixture
def fixture(monkeypatch):
    storage = FakeStorage()
    monkeypatch.setattr(capture_storage, "text_storage_error", lambda _: "")
    monkeypatch.setattr(
        capture_audio_cleanup, "_delete_verified", lambda st, key: st.delete(key) or ""
    )
    response = MagicMock()
    response.__enter__.return_value.status_code = 403
    get = MagicMock(return_value=response)
    monkeypatch.setattr("requests.get", get)
    return storage, get, response


def test_two_prefixes_are_private_and_every_created_object_is_removed(fixture):
    storage, get, _ = fixture
    results = probe.storage_canary(storage)
    assert [item["prefix"] for item in results] == ["record-uploads", "capture-audio"]
    assert not storage.objects
    assert len(storage.removed) == 2
    assert all("?" not in call.args[0] for call in get.call_args_list)


def test_versioned_storage_is_rejected_before_any_write(fixture, monkeypatch):
    storage, get, _ = fixture
    monkeypatch.setattr(
        capture_storage,
        "text_storage_error",
        lambda _: "versioned_storage_requires_purge",
    )
    with pytest.raises(probe.PreflightError, match="storage_not_unversioned"):
        probe.storage_canary(storage)
    assert not storage.objects and not storage.removed
    get.assert_not_called()


def test_collision_never_overwrites_or_deletes_existing_object(fixture, monkeypatch):
    storage, _, _ = fixture
    monkeypatch.setattr(storage, "exists", lambda _: True)
    with pytest.raises(probe.PreflightError, match="canary_collision"):
        probe.storage_canary(storage)
    assert not storage.objects and not storage.removed


def test_lost_write_response_still_cleans_only_attempted_canary(fixture):
    storage, _, _ = fixture
    storage.lose_response = True
    with pytest.raises(TimeoutError):
        probe.storage_canary(storage)
    assert not storage.objects
    assert len(storage.removed) == 1


def test_public_canary_blocks_and_is_cleaned(fixture):
    storage, _, response = fixture
    response.__enter__.return_value.status_code = 200
    with pytest.raises(probe.PreflightError, match="canary_not_confirmed_private"):
        probe.storage_canary(storage)
    assert not storage.objects
    assert len(storage.removed) == 1


def test_failed_delete_is_never_reported_as_pass(fixture, monkeypatch, capsys):
    storage, _, _ = fixture
    monkeypatch.setattr(
        capture_audio_cleanup,
        "_delete_verified",
        lambda *_: "storage_delete_unconfirmed",
    )
    with pytest.raises(probe.PreflightError, match="canary_cleanup_failed"):
        probe.storage_canary(storage)
    assert len(storage.objects) == 1
    assert "orphan_canary" in capsys.readouterr().out


def test_delete_exception_does_not_print_provider_details(fixture, monkeypatch, capsys):
    storage, _, _ = fixture

    def failed(*_):
        raise RuntimeError("secret provider URL")

    monkeypatch.setattr(capture_audio_cleanup, "_delete_verified", failed)
    with pytest.raises(probe.PreflightError, match="canary_cleanup_failed"):
        probe.storage_canary(storage)
    output = capsys.readouterr().out
    assert "orphan_canary" in output
    assert "secret provider URL" not in output
