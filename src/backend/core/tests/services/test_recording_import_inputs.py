"""Durable PUT receipts, cleanup fencing and exact-version erasure."""

import hashlib
import io
import json
import time
import wave
from datetime import timedelta
from types import SimpleNamespace
from unittest import mock
from uuid import uuid4

from django.utils import timezone

import pytest

from core import models
from core.services import recording_import_inputs as service
from core.services import uploaded_recordings as uploads
from core.services import voiceprint_import_upload as worker
from core.services.voiceprint_media import MediaFile, MediaInfo
from core.services.voiceprint_media_process import MediaError
from core.services.voiceprint_source_objects import ObjectReceipt
from core.services.voiceprint_source_storage import StorageConfiguration
from core.tests.services.test_recording_identity_preflight import (
    import_enabled,
    job_for,
    ready,
)
from core.tests.services.test_voiceprint_candidates import matching_enabled
from core.tests.services.test_voiceprint_consent import enabled

pytestmark = pytest.mark.django_db


def mono_wav():
    output = io.BytesIO()
    with wave.open(output, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(24000)
        audio.writeframes(b"\0\0" * 240)
    return output.getvalue()


@pytest.fixture
def case():
    job, _ = job_for()
    lease = uploads.claim(job.pk)
    parent = uploads.preflight.parent_source(lease)
    row = service.reserve(lease, parent)
    return SimpleNamespace(job=lease, row=row, parent=parent)


def completed(case):
    row = case.row
    row.duration_ms, row.sha256, row.status = 10, "a" * 64, "ready"
    row.receipt = ObjectReceipt(
        "s3_object", service.name(row), 524, etag='"fixed"', version_id="v-fixed"
    ).payload()
    row.save()
    ready(case.job, row)
    return row


def configuration():
    return StorageConfiguration(
        "private-bucket",
        "prefix",
        None,
        "http://127.0.0.1:12345",
        "synthetic-access-key",
        "synthetic-secret-key",
        addressing_style="path",
    ).validate()


def prepared_file(tmp_path):
    path = tmp_path / "diarization.wav"
    path.write_bytes(mono_wav())
    source = MediaFile(str(path), str(tmp_path))
    return SimpleNamespace(
        source=source, info=MediaInfo(10, 0, 1, 24000, source.stat())
    )


def test_reservation_is_durable_before_remote_put_and_fences_stale_worker(case):
    stored = models.RecordingImportInput.objects.get(pk=case.row.pk)
    assert stored.status == "preparing" and stored.receipt == {}
    assert stored.lease_token == case.job.lease_id
    assert stored.write_until > case.job.lease_until
    models.UploadedRecording.objects.filter(pk=case.job.pk).update(lease_id=uuid4())
    with pytest.raises(MediaError, match="authorization_revoked"):
        service.reserve(case.job, case.parent)


@pytest.mark.parametrize("field", ["lease_until", "deadline"])
def test_reservation_rejects_expired_write_authority(case, field):
    models.UploadedRecording.objects.filter(pk=case.job.pk).update(
        **{field: timezone.now()}
    )
    with pytest.raises(MediaError, match="authorization_revoked"):
        service.reserve(case.job, case.parent)


def test_killable_put_result_is_adopted_only_for_reserved_key(case, tmp_path):
    prepared = prepared_file(tmp_path)
    receipt = ObjectReceipt(
        "s3_object", service.name(case.row), 524, etag='"fixed"', version_id="v-fixed"
    )
    result = json.dumps({"receipt": receipt.payload(), "sha256": "a" * 64}).encode()
    with mock.patch.object(service, "invoke", return_value=result) as invoke:
        stored = service.upload(
            case.row,
            prepared,
            config=configuration(),
            expires=int(time.time()) + 60,
            authorized=lambda: True,
        )
    assert invoke.call_args.kwargs["purpose"] == "import_upload"
    assert invoke.call_args.args[0]["input_id"] == str(case.row.pk)
    assert stored.status == "ready" and stored.receipt == receipt.payload()
    assert stored.sha256 == "a" * 64 and stored.duration_ms == 10


@pytest.mark.parametrize("damage", ["key", "version", "size", "digest", "revoked"])
def test_put_failure_keeps_cleanup_record_and_never_adopts_invalid_input(
    case, tmp_path, damage
):
    receipt = ObjectReceipt(
        "s3_object", service.name(case.row), 524, etag='"fixed"', version_id="v-fixed"
    ).payload()
    if damage == "key":
        receipt["key"] = f"record-uploads/identity-input-{uuid4()}.wav"
    elif damage == "version":
        receipt["version_id"] = None
    elif damage == "size":
        receipt["size"] = 523
    result = json.dumps(
        {"receipt": receipt, "sha256": "bad" if damage == "digest" else "a" * 64}
    ).encode()
    with (
        mock.patch.object(service, "invoke", return_value=result),
        pytest.raises(MediaError),
    ):
        service.upload(
            case.row,
            prepared_file(tmp_path),
            config=configuration(),
            expires=int(time.time()) + 60,
            authorized=lambda: damage != "revoked",
        )
    case.row.refresh_from_db()
    assert case.row.status == "preparing" and case.row.receipt == {}


@pytest.mark.parametrize(
    "damage",
    ["attempt", "parent", "expired", "duration", "deleted", "missing", "digest"],
)
def test_selected_input_never_falls_back_to_mutable_original(case, damage):
    row = completed(case)
    if damage == "attempt":
        models.RecordingImportInput.objects.filter(pk=row.pk).update(attempt=2)
    elif damage == "parent":
        models.RecordingImportInput.objects.filter(pk=row.pk).update(
            source_digest="f" * 64
        )
    elif damage == "expired":
        models.RecordingImportInput.objects.filter(pk=row.pk).update(
            expires_at=timezone.now()
        )
    elif damage == "duration":
        models.RecordingImportInput.objects.filter(pk=row.pk).update(duration_ms=11)
    elif damage == "deleted":
        models.RecordingImportInput.objects.filter(pk=row.pk).update(status="deleted")
    elif damage == "missing":
        row.delete()
    else:
        models.RecordingImportInput.objects.filter(pk=row.pk).update(sha256="broken")
    with pytest.raises(MediaError, match="source_integrity_unavailable"):
        service.selected(case.job)


def test_old_worker_abandon_cannot_expire_new_lease_input(case):
    models.UploadedRecording.objects.filter(pk=case.job.pk).update(lease_id=uuid4())
    newer = models.UploadedRecording.objects.get(pk=case.job.pk)
    new_row = service.reserve(newer, case.parent)
    service.abandon(case.job)
    case.row.refresh_from_db()
    new_row.refresh_from_db()
    assert case.row.expires_at <= timezone.now()
    assert new_row.expires_at > timezone.now()


@pytest.mark.parametrize("damage", ["proof", "field", "null"])
def test_missing_derivative_pointer_cannot_become_original_source(case, damage):
    completed(case)
    if damage == "proof":
        case.job.configuration.pop("_preflight")
    elif damage == "field":
        case.job.configuration["_preflight"].pop("input_id")
    else:
        case.job.configuration["_preflight"]["input_id"] = None
    with pytest.raises(MediaError, match="source_integrity_unavailable"):
        service.selected(case.job)


def cleanup_storage():
    return SimpleNamespace(
        bucket_name="private-bucket", location="prefix", connection=mock.Mock()
    )


def eligible(case):
    row = completed(case)
    now = timezone.now()
    models.RecordingImportInput.objects.filter(pk=row.pk).update(
        expires_at=now,
        write_until=now,
        next_cleanup_at=now,
    )
    return row


def test_cleanup_erases_exact_key_versions_and_markers_only(case):
    row = eligible(case)
    storage = cleanup_storage()
    key = "prefix/" + service.name(row)
    client = storage.connection.meta.client
    client.list_object_versions.side_effect = [
        {
            "IsTruncated": False,
            "Versions": [
                {"Key": key, "VersionId": "v1"},
                {"Key": key + ".other", "VersionId": "keep"},
            ],
            "DeleteMarkers": [{"Key": key, "VersionId": "marker"}],
        },
        {
            "IsTruncated": False,
            "Versions": [{"Key": key + ".other", "VersionId": "keep"}],
        },
    ]
    client.delete_objects.return_value = {}
    result = service.purge(row.pk, storage)
    assert result.status == "deleted" and result.deleted_at is not None
    assert client.delete_objects.call_args.kwargs["Delete"]["Objects"] == [
        {"Key": key, "VersionId": "v1"},
        {"Key": key, "VersionId": "marker"},
    ]
    assert row.pk not in service.due()


@pytest.mark.parametrize(
    "response",
    [
        {},
        {"IsTruncated": True},
        {"IsTruncated": "false"},
        {"IsTruncated": False, "Versions": "invalid"},
        {"IsTruncated": False, "Versions": [{"Key": "private", "VersionId": ""}]},
    ],
)
def test_unknown_or_truncated_storage_metadata_is_not_physical_deletion(case, response):
    row = eligible(case)
    storage = cleanup_storage()
    storage.connection.meta.client.list_object_versions.return_value = response
    result = service.purge(row.pk, storage)
    assert result.status == "deleting" and result.deleted_at is None
    assert result.next_cleanup_at > timezone.now()


def test_sdk_delete_errors_cannot_be_reported_as_deleted(case):
    row = eligible(case)
    storage = cleanup_storage()
    key = "prefix/" + service.name(row)
    client = storage.connection.meta.client
    client.list_object_versions.return_value = {
        "IsTruncated": False,
        "Versions": [{"Key": key, "VersionId": "v1"}],
    }
    client.delete_objects.return_value = {"Errors": [{"Code": "AccessDenied"}]}
    result = service.purge(row.pk, storage)
    assert (
        result.status == "deleting" and result.error_code == "input_cleanup_unavailable"
    )
    assert result.deleted_at is None


@pytest.mark.parametrize("hold", ["live_input", "writer", "backoff"])
def test_cleanup_respects_use_writer_and_retry_boundaries(case, hold):
    row = eligible(case)
    field = {
        "live_input": "expires_at",
        "writer": "write_until",
        "backoff": "next_cleanup_at",
    }[hold]
    models.RecordingImportInput.objects.filter(pk=row.pk).update(
        **{field: timezone.now() + timedelta(minutes=5)}
    )
    storage = cleanup_storage()
    assert row.pk not in service.due()
    assert service.purge(row.pk, storage).status == "ready"
    storage.connection.meta.client.list_object_versions.assert_not_called()


@pytest.mark.parametrize("removal", ["soft", "hard"])
def test_cleanup_survives_upload_removal_and_runs_with_matching_disabled(
    case, removal, settings
):
    row = completed(case)
    models.RecordingImportInput.objects.filter(pk=row.pk).update(
        write_until=timezone.now()
    )
    if removal == "hard":
        case.job.delete()
        row.refresh_from_db()
        assert row.upload_id is None
    else:
        models.MeetingRecord.objects.filter(pk=case.job.record_id).update(
            deleted_at=timezone.now()
        )
    settings.MEETING_VOICEPRINT_MATCHING_ENABLED = False
    assert row.pk in service.due()
    storage = cleanup_storage()
    storage.connection.meta.client.list_object_versions.return_value = {
        "IsTruncated": False
    }
    result = service.purge(row.pk, storage)
    assert result.status == "deleted" and result.record_uuid == case.job.record_id


def test_native_worker_put_uses_explicit_credentials_and_fixed_version(tmp_path):
    prepared = prepared_file(tmp_path)
    client = mock.Mock()
    observed = {}
    identifier = uuid4()

    def put(**kwargs):
        observed.update(kwargs)
        assert kwargs["Body"].read() == mono_wav()
        return {"VersionId": "v-pinned"}

    client.put_object.side_effect = put
    client.head_object.return_value = {
        "ContentLength": 524,
        "ETag": '"fixed"',
        "VersionId": "v-pinned",
        "Metadata": {
            "identity-input": str(identifier),
            "sha256": hashlib.sha256(mono_wav()).hexdigest(),
        },
    }
    with mock.patch.object(worker.boto3, "client", return_value=client) as factory:
        result = worker.execute(
            {
                "source": prepared.source.payload(),
                "config": configuration().payload(),
                "expires": int(time.time()) + 60,
                "input_id": str(identifier),
            }
        )
    assert observed["Key"] == f"prefix/record-uploads/identity-input-{identifier}.wav"
    assert observed["ContentLength"] == 524
    assert result["receipt"]["version_id"] == "v-pinned"
    assert result["sha256"] == hashlib.sha256(mono_wav()).hexdigest()
    assert client.head_object.call_args.kwargs["VersionId"] == "v-pinned"
    assert factory.call_args.kwargs["aws_access_key_id"] == "synthetic-access-key"
    assert factory.call_args.kwargs["config"].proxies == {}
    client.close.assert_called_once()


@pytest.mark.parametrize(
    "damage", ["unversioned", "wrong_version", "wrong_metadata", "mutated"]
)
def test_native_worker_rejects_unproven_put_without_adopting(tmp_path, damage):
    prepared = prepared_file(tmp_path)
    identifier = uuid4()
    client = mock.Mock()
    client.put_object.return_value = {
        "VersionId": None if damage == "unversioned" else "v-pinned"
    }

    def head(**kwargs):
        if damage == "mutated":
            with open(prepared.source.path, "ab") as output:
                output.write(b"changed")
        return {
            "ContentLength": 524,
            "ETag": '"fixed"',
            "VersionId": "changed" if damage == "wrong_version" else "v-pinned",
            "Metadata": {
                "identity-input": str(uuid4())
                if damage == "wrong_metadata"
                else str(identifier),
                "sha256": hashlib.sha256(mono_wav()).hexdigest(),
            },
        }

    client.head_object.side_effect = head
    with (
        mock.patch.object(worker.boto3, "client", return_value=client),
        pytest.raises(ValueError),
    ):
        worker.execute(
            {
                "source": prepared.source.payload(),
                "config": configuration().payload(),
                "expires": int(time.time()) + 60,
                "input_id": str(identifier),
            }
        )
    client.close.assert_called_once()
