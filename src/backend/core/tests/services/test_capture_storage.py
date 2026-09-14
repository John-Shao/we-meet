"""Private S3 reuse must stay bounded without caching permissions or retention."""

from concurrent.futures import ThreadPoolExecutor
from unittest.mock import Mock

from django.core.files.storage import storages
from django.test import override_settings

from botocore.config import Config
from storages.backends.s3 import S3Storage

from core.services import capture_storage


def configuration(bucket="audio-fixture"):
    """Explicit dummy credentials prevent metadata or provider network access."""
    return {
        "default": {
            "BACKEND": "storages.backends.s3.S3Storage",
            "OPTIONS": {
                "access_key": "fixture-only",
                "secret_key": "fixture-only",
                "bucket_name": bucket,
                "region_name": "us-east-1",
                "endpoint_url": "https://storage.invalid",
                "default_acl": "public-read",
                "object_parameters": {"CacheControl": "private", "ACL": "public-read"},
                "gzip": True,
                "client_config": Config(
                    signature_version="s3v4",
                    s3={"addressing_style": "virtual"},
                    request_checksum_calculation="when_required",
                    response_checksum_validation="when_required",
                ),
            },
        }
    }


def test_hundreds_of_chunks_reuse_one_session_without_changing_default_storage(
    monkeypatch,
):
    session = Mock()
    create = Mock(return_value=session)
    monkeypatch.setattr(S3Storage, "_create_session", create)
    with override_settings(STORAGES=configuration()):
        source = storages["default"]
        first = capture_storage.audio_storage()
        for _ in range(302):
            storage = capture_storage.audio_storage()
            assert storage is first
            assert storage.connection is session.resource.return_value
        create.assert_called_once()
        assert first is not source
        assert first.default_acl == first.object_parameters["ACL"] == "private"
        assert first.object_parameters["CacheControl"] == "private"
        assert source.default_acl == source.object_parameters["ACL"] == "public-read"
        assert not first.gzip and source.gzip
        assert first.client_config.connect_timeout == 3
        assert first.client_config.read_timeout == 10
        assert first.client_config.retries == {"total_max_attempts": 1}
        assert first.client_config.signature_version == "s3v4"
        assert first.client_config.s3["addressing_style"] == "virtual"
        assert first.client_config.request_checksum_calculation == "when_required"
        assert first.client_config.response_checksum_validation == "when_required"
        assert not first.transfer_config.use_threads
        assert first.transfer_config.num_download_attempts == 1


def test_storage_replacement_and_fork_do_not_reuse_old_clients(monkeypatch):
    with override_settings(STORAGES=configuration()):
        first = capture_storage.audio_storage()
        with override_settings(STORAGES=configuration("replacement-fixture")):
            replacement = capture_storage.audio_storage()
            assert replacement is not first
            assert replacement.bucket_name == "replacement-fixture"
        restored = capture_storage.audio_storage()
        assert restored is not replacement
        assert restored.bucket_name == "audio-fixture"
        pid = capture_storage.os.getpid()
        monkeypatch.setattr(capture_storage.os, "getpid", lambda: pid + 1)
        assert capture_storage.audio_storage() is not restored


def test_client_reuse_is_thread_local():
    with override_settings(STORAGES=configuration()):
        first = capture_storage.audio_storage()
        with ThreadPoolExecutor(max_workers=1) as executor:
            other = executor.submit(capture_storage.audio_storage).result()
            assert executor.submit(capture_storage.audio_storage).result() is other
            assert other is not first
        assert capture_storage.audio_storage() is first


def test_versioning_is_rechecked_even_when_storage_client_is_reused(monkeypatch):
    session = Mock()
    monkeypatch.setattr(S3Storage, "_create_session", Mock(return_value=session))
    client = session.resource.return_value.meta.client
    client.get_bucket_versioning.side_effect = [{}, {"Status": "Enabled"}]
    with override_settings(STORAGES=configuration()):
        assert capture_storage.text_storage_error(capture_storage.audio_storage()) == ""
        assert (
            capture_storage.text_storage_error(capture_storage.audio_storage())
            == "versioned_storage_requires_purge"
        )
    assert client.get_bucket_versioning.call_count == 2


def test_non_s3_storage_is_not_wrapped(tmp_path):
    with override_settings(
        STORAGES={
            "default": {
                "BACKEND": "django.core.files.storage.FileSystemStorage",
                "OPTIONS": {"location": str(tmp_path)},
            }
        }
    ):
        assert capture_storage.audio_storage() is storages["default"]
