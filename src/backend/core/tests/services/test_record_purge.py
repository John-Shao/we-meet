"""Explicit erasure must survive IO failures, retries and old upload credentials."""

import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from unittest.mock import Mock

from django.core.files.base import ContentFile
from django.core.files.storage import default_storage
from django.db import close_old_connections, transaction
from django.utils import timezone

import pytest
from storages.backends.s3 import S3Storage

from core import models
from core.factories import MembershipFactory, OrganizationFactory, UserFactory
from core.services import record_lifecycle, uploaded_recordings
from core.services import record_purge as service
from core.services.meeting_records import RecordConflict
from core.services.meeting_summary_review import save_review
from core.tests.services.test_capture_summary import published
from core.tests.services.test_meeting_record_speakers import capture_with_speakers
from core.tests.services.test_meeting_records import audio_note, client_for, online_note
from core.tests.services.test_meeting_summary_review import generated, payload

pytestmark = pytest.mark.django_db
BASE = "/api/v1.0/meeting-records/"


@pytest.fixture(autouse=True)
def flags(settings, tmp_path):
    settings.MEETING_RECORDS_ENABLED = True
    settings.MEETING_RECORD_TRASH_ENABLED = True
    settings.MEETING_RECORD_PURGE_ENABLED = True
    settings.MEETING_CAPTURE_PROTOCOL_ENABLED = True
    settings.MEETING_CAPTURE_AUDIO_ENABLED = True
    settings.MEETING_CAPTURE_ASR_ENABLED = True
    settings.MEETING_CAPTURE_SUMMARY_ENABLED = True
    settings.AGENT_INTERNAL_API_TOKEN = "asr-test-only"
    settings.MEETING_VERSIONED_SUMMARY_ENABLED = True
    settings.MEETING_SUMMARY_REVIEW_ENABLED = True
    settings.DASHSCOPE_API_KEY = "test-provider-only"
    settings.MEETING_FILE_DIRECT_UPLOAD_TTL_SECONDS = 300
    settings.STORAGES = {
        "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"}
    }
    settings.MEDIA_ROOT = str(tmp_path)


def trashed(record=None):
    record = record or audio_note()
    record_lifecycle.transition(record.pk, record.owner, "trashed", 0)
    record.refresh_from_db()
    return record


def intent(record):
    return service.request(record.pk, record.owner, 1)


def due(job):
    models.MeetingRecordPurge.objects.filter(pk=job.pk).update(
        next_attempt_at=timezone.now() - timedelta(seconds=1)
    )


def upload_record(name=None):
    record = models.MeetingRecord.objects.create(
        owner=UserFactory(),
        source_type="upload",
        title="Upload",
        origin_at=timezone.now(),
        retention_mode="media",
    )
    capture, _ = capture_with_speakers(record)
    upload = models.UploadedRecording.objects.create(
        record=record,
        capture=capture,
        key=uuid.uuid4(),
        status="succeeded",
        storage_name=name or f"record-uploads/{uuid.uuid4()}.wav",
        checksum="a" * 64,
        size=100,
        configuration={"title": "private content"},
        deadline=timezone.now(),
        next_poll_at=timezone.now(),
    )
    return record, upload


def chunk(capture, sequence=1):
    pk = uuid.uuid4()
    key = f"capture-audio/{capture.record_id}/{capture.pk}/{pk}.wav"
    obj = models.CaptureAudioChunk.objects.create(
        pk=pk,
        capture=capture,
        sequence=sequence,
        start_ms=(sequence - 1) * 1000,
        duration_ms=1000,
        checksum="a" * 64,
        byte_size=5,
        object_key=key,
        stored=True,
    )
    assert default_storage.save(key, ContentFile(b"audio")) == key
    return obj


def post(record, user=None, revision=1, **extra):
    return client_for(user or record.owner).post(
        f"{BASE}{record.pk}/purge/",
        {"expected_revision": revision, **extra},
        format="json",
    )


def test_only_owner_of_trashed_standalone_record_can_request():
    record = audio_note()
    assert post(record, revision=0).status_code == 409
    trashed(record)
    assert post(record, UserFactory()).status_code == 404
    assert post(record, revision=0).status_code == 409
    assert post(record, storage_name="anywhere").status_code == 400
    owner, _, _, online = online_note()
    assert post(online, user=owner, revision=0).status_code == 404
    assert not models.MeetingRecordPurge.objects.exists()
    result = post(record)
    assert result.status_code == 202
    assert result.json()["expected_revision"] == 1
    listing = client_for(record.owner).get(f"{BASE}trash/").json()
    assert listing["purge_available"]
    assert listing["results"][0]["purge"] == result.json()


def test_feature_off_stops_admission_and_worker_but_not_receipt_or_restore_fence(
    settings,
):
    record = trashed()
    job = intent(record)
    settings.MEETING_RECORD_PURGE_ENABLED = False
    assert post(record).status_code == 404
    assert service.tick() == 0
    assert service.step(job.pk).state == "pending"
    assert client_for(record.owner).get(f"{BASE}{record.pk}/purge/").status_code == 200
    with pytest.raises(RecordConflict):
        record_lifecycle.transition(record.pk, record.owner, "active", 2)


def test_same_intent_is_idempotent_before_and_after_erasure():
    record = trashed()
    record_id = record.pk
    job = intent(record)
    assert intent(record).pk == job.pk
    assert service.step(job.pk).state == "complete"
    assert not models.MeetingRecord.objects.filter(pk=record_id).exists()
    assert intent(record).pk == job.pk
    assert post(record).status_code == 200
    assert post(record, revision=2).status_code == 409
    receipt = client_for(record.owner).get(f"{BASE}{record_id}/purge/").json()
    assert receipt["state"] == "complete"
    assert set(receipt) == {
        "id",
        "state",
        "expected_revision",
        "not_before",
        "completed_at",
        "can_retry",
    }
    assert client_for(UserFactory()).get(f"{BASE}{record_id}/purge/").status_code == 404


def test_status_rechecks_current_owner_and_organization_membership():
    organization = OrganizationFactory()
    record = audio_note(organization=organization)
    membership = MembershipFactory(user=record.owner, organization=organization)
    trashed(record)
    job = intent(record)
    service.step(job.pk)
    membership.delete()
    with pytest.raises(models.MeetingRecordPurge.DoesNotExist):
        service.receipt(record.pk, record.owner)
    MembershipFactory(user=record.owner, organization=organization)
    assert service.receipt(record.pk, record.owner).pk == job.pk
    models.User.objects.filter(pk=record.owner_id).update(is_active=False)
    with pytest.raises(models.MeetingRecordPurge.DoesNotExist):
        service.receipt(record.pk, record.owner)


def test_nonempty_history_erased_only_after_all_media_and_external_task_survives(
    monkeypatch,
):
    _, capture, _ = published()
    record = capture.record
    first, second = capture.audio_chunks.get(), chunk(capture, 2)
    models.MeetingMediaSegment.objects.create(
        record=record, capture_session=capture, sequence=1, record_start_ms=0
    )
    summary = generated(record)
    review, _, _ = save_review(record.pk, record.owner, uuid.uuid4(), payload(summary))
    later, _, _ = save_review(
        record.pk, record.owner, uuid.uuid4(), payload(summary, revision=1)
    )
    task = models.Task.objects.create(title="Exported work", creator=record.owner)
    link = models.MeetingSummaryTaskLink.objects.create(
        record=record,
        review=later,
        action_index=0,
        action_hash="b" * 64,
        task=task,
        author=record.owner,
        key=uuid.uuid4(),
        request_hash="c" * 64,
        confirmed={"title": task.title},
    )
    export = record.document_exports.create(
        requested_by=record.owner,
        summary=summary,
        review=review,
        source_kind="human",
        source_id=review.pk,
        language="en",
        api_url="https://docs.invalid",
        payload={"content": "private summary"},
        payload_hash="d" * 64,
        status="ready",
        document_id=uuid.uuid4(),
    )
    outbound = Mock(
        side_effect=AssertionError("Deletion must never contact Docs or IM")
    )
    monkeypatch.setattr("requests.sessions.Session.request", outbound)
    job = intent(trashed(record))
    assert service.step(job.pk).state == "pending"
    assert models.MeetingRecord.objects.filter(pk=record.pk).exists()
    assert models.MeetingSummaryReview.objects.filter(pk=review.pk).exists()
    assert service.step(job.pk).state == "pending"
    assert not default_storage.exists(first.object_key) and not default_storage.exists(
        second.object_key
    )
    assert service.step(job.pk).state == "complete"
    assert models.Task.objects.get(pk=task.pk).title == "Exported work"
    for model, pk in [
        (models.CaptureSession, capture.pk),
        (models.MeetingSummaryVersion, summary.pk),
        (models.MeetingSummaryReview, later.pk),
        (models.MeetingSummaryExport, export.pk),
        (models.MeetingSummaryTaskLink, link.pk),
    ]:
        assert not model.objects.filter(pk=pk).exists()
    assert not models.MeetingOriginalSegment.objects.filter(
        record_id=record.pk
    ).exists()
    assert not models.MeetingTranscriptVersion.objects.filter(
        record_id=record.pk
    ).exists()
    outbound.assert_not_called()


@pytest.mark.parametrize(
    "failure", ["exception", "unconfirmed", "Enabled", "Suspended"]
)
def test_storage_failure_never_claims_completion_and_same_intent_retries(
    monkeypatch, failure
):
    record = audio_note()
    capture, _ = capture_with_speakers(record)
    item = chunk(capture)
    job = intent(trashed(record))
    storage = Mock(spec=S3Storage) if failure in {"Enabled", "Suspended"} else Mock()
    if failure == "exception":
        storage.delete.side_effect = OSError("secret provider path")
    elif failure == "unconfirmed":
        storage.exists.return_value = True
    else:
        storage.bucket_name = "fixture-only"
        storage.connection.meta.client.get_bucket_versioning.return_value = {
            "Status": failure
        }
    monkeypatch.setattr(service, "audio_storage", lambda: storage)
    failed = service.step(job.pk)
    assert failed.state == "failed" and failed.completed_at is None
    assert service.serialize(failed)["can_retry"]
    assert "secret" not in str(service.serialize(failed))
    assert models.MeetingRecord.objects.filter(pk=record.pk).exists()
    with pytest.raises(RecordConflict):
        record_lifecycle.transition(record.pk, record.owner, "active", 2)
    monkeypatch.setattr(service, "audio_storage", lambda: default_storage)
    assert intent(record).pk == job.pk
    service.step(job.pk)
    assert not default_storage.exists(item.object_key)
    assert service.step(job.pk).state == "complete"


def test_uploaded_bytes_wait_for_signature_expiry_and_old_identity_is_never_adopted(
    settings,
):
    record, upload = upload_record()
    default_storage.save(upload.storage_name, ContentFile(b"audio"))
    job = intent(trashed(record))
    assert job.not_before > timezone.now() + timedelta(seconds=290)
    assert service.step(job.pk).state == "pending"
    assert default_storage.exists(upload.storage_name)
    due(job)
    service.step(job.pk)
    assert service.step(job.pk).state == "complete"
    settings.MEETING_RECORD_PURGE_ENABLED = False
    with pytest.raises(RecordConflict):
        uploaded_recordings._replay_guard(
            record.owner, upload.key, upload.checksum, upload.configuration
        )
    with transaction.atomic(), pytest.raises(RecordConflict):
        service.guard_adoption(upload.storage_name, uuid.uuid4())
    with transaction.atomic(), pytest.raises(RecordConflict):
        service.guard_adoption(f"record-uploads/{uuid.uuid4()}.wav", upload.key)


def test_late_inflight_upload_is_removed_without_recreating_record():
    record, upload = upload_record()
    job = intent(trashed(record))
    due(job)
    service.step(job.pk)  # Missing objects are already erased.
    assert service.step(job.pk).state == "complete"
    default_storage.save(upload.storage_name, ContentFile(b"late upload"))
    due(job)
    assert service.tick() == 2
    assert not default_storage.exists(upload.storage_name)
    job.refresh_from_db()
    assert service.serialize(job)["state"] == "complete"
    assert not models.MeetingRecord.objects.filter(pk=record.pk).exists()
    assert service.tick() == 0


@pytest.mark.parametrize("bad", ["identity", "alias"])
def test_foreign_or_shared_object_fails_before_deleting_anything(bad):
    record, upload = upload_record("other/private.wav" if bad == "identity" else None)
    if bad == "alias":
        upload_record(upload.storage_name)
    default_storage.save(upload.storage_name, ContentFile(b"keep"))
    with pytest.raises(RecordConflict):
        intent(trashed(record))
    assert default_storage.exists(upload.storage_name)
    assert not models.MeetingRecordPurge.objects.exists()


def test_background_worker_never_enrolls_old_trash():
    record = trashed()
    models.MeetingRecord.objects.filter(pk=record.pk).update(
        deleted_at=timezone.now() - timedelta(days=365)
    )
    assert service.tick() == 0
    assert models.MeetingRecord.objects.filter(pk=record.pk).exists()
    from core import tasks  # noqa: PLC0415

    assert tasks._record_purge.purge_requested_records() == 0


def test_database_dependency_failure_preserves_intent_and_retry(monkeypatch):
    record = trashed()
    job = intent(record)
    original = models.MeetingRecord.delete

    def reject(*args, **kwargs):
        raise service.ProtectedError("fixture dependency", [])

    monkeypatch.setattr(models.MeetingRecord, "delete", reject)
    assert service.step(job.pk).error_code == "record_dependencies"
    assert models.MeetingRecord.objects.filter(pk=record.pk).exists()
    monkeypatch.setattr(models.MeetingRecord, "delete", original)
    assert intent(record).pk == job.pk
    assert service.step(job.pk).state == "complete"


def test_missing_native_object_is_safe_and_completed_native_job_is_not_reswept():
    record = audio_note()
    capture, _ = capture_with_speakers(record)
    item = chunk(capture)
    job = intent(trashed(record))
    default_storage.delete(item.object_key)
    assert service.tick() == 2
    due(job)
    assert service.tick() == 0


def test_active_processing_blocks_admission_even_after_trash():
    record = trashed()
    record.processing_jobs.create(kind="summary", generation=1, input_revision=1)
    assert post(record).status_code == 409
    assert not models.MeetingRecordPurge.objects.exists()


def test_capture_media_identity_cannot_escape_its_record():
    record = audio_note()
    capture, _ = capture_with_speakers(record)
    item = chunk(capture)
    models.CaptureAudioChunk.objects.filter(pk=item.pk).update(
        object_key="other/private.wav"
    )
    with pytest.raises(RecordConflict):
        intent(trashed(record))
    assert default_storage.exists(item.object_key)


@pytest.mark.django_db(transaction=True)
def test_concurrent_duplicate_intents_create_only_one_job():
    record = trashed()

    def run(_):
        close_old_connections()
        try:
            return intent(record).pk
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as pool:
        ids = list(pool.map(run, range(2)))
    assert ids[0] == ids[1]
    record.refresh_from_db()
    assert record.lifecycle_revision == 2
