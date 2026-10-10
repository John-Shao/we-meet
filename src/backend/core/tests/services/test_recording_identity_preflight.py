"""Pre-paid gates and explicit recovery using synthetic files/templates only."""

import json
import sys
from contextlib import contextmanager
from datetime import timedelta
from types import SimpleNamespace
from unittest import mock
from uuid import uuid4

from django.core.files.uploadedfile import SimpleUploadedFile
from django.utils import timezone

import pytest

from core import models
from core.factories import MembershipFactory, UserFactory
from core.services import recording_identity_preflight as service
from core.services import recording_import_inputs as inputs
from core.services import uploaded_recordings as uploads
from core.services import voiceprint_candidates as candidates
from core.services import voiceprint_sources as sources
from core.services.meeting_records import RecordConflict
from core.services.voiceprint_consent import VoiceprintError
from core.services.voiceprint_media import MediaFile, MediaInfo
from core.services.voiceprint_media_process import MediaError
from core.services.voiceprint_source_objects import ObjectReceipt
from core.tests.services.test_direct_uploads import FakeStorage
from core.tests.services.test_meeting_records import client_for
from core.tests.services.test_uploaded_recordings import wav_bytes
from core.tests.services.test_voiceprint_candidates import matching_enabled, register
from core.tests.services.test_voiceprint_consent import enabled, org_for

pytestmark = pytest.mark.django_db
ROOT = "/api/v1.0/recording-uploads/"


@pytest.fixture(autouse=True)
def import_enabled(settings, tmp_path, matching_enabled):
    settings.MEETING_FILE_ASR_ENABLED = True
    settings.MEETING_FILE_DIRECT_UPLOAD_ENABLED = True
    settings.CELERY_ENABLED = True
    settings.DASHSCOPE_API_KEY = "test-only"
    settings.STORAGES = {
        "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"}
    }
    settings.MEDIA_ROOT = str(tmp_path)
    config = tmp_path / "media.json"
    # Admission validates local paths. Native media decoding has separate real
    # FFmpeg integration tests; this module never executes these fixture paths.
    config.write_text(json.dumps({"ffmpeg": sys.executable, "ffprobe": sys.executable}))
    settings.MEETING_VOICEPRINT_MEDIA_CONFIG_FILE = str(config)
    with mock.patch.object(uploads, "available", return_value=True):
        yield


def options(owner, organization=None, users=None):
    return {
        "diarization": True,
        "identity": {
            "organization_id": str(organization.pk) if organization else None,
            "candidate_user_ids": [str(user.pk) for user in users or [owner]],
        },
    }


def job_for(owner=None, *, enrolled=True):
    owner = owner or UserFactory()
    profile = register(owner) if enrolled else None
    job = uploads.create(
        owner,
        uuid4(),
        SimpleUploadedFile("synthetic.wav", wav_bytes(), "audio/wav"),
        options(owner),
    )
    return job, profile


def ready(job, artifact=None):
    pool, policy = service.context(job)
    job.identity_state = "ready"
    job.configuration["_preflight"] = {
        "schema": 1,
        "input_id": str(artifact.pk) if artifact else None,
        "duration_ms": artifact.duration_ms if artifact else 10,
        "original_duration_ms": artifact.duration_ms if artifact else 10,
        "time_offset_ms": 0,
        "channels": 1,
        "source_digest": sources.digest(service.parent_source(job).payload()),
        "candidate_digest": pool.fingerprint,
        "threshold_digest": policy.digest,
    }
    job.save()


def storage_for(job):
    storage = FakeStorage(stored_size=job.size)
    storage.connection.meta.client.generate_presigned_url.return_value = "unused"
    return storage


def awaiting(job):
    job.status, job.identity_state = "failed", "awaiting_choice"
    job.error_code = "identity_preflight_failed"
    job.identity_error = "media_audio_stream_unsupported"
    job.save()
    return ROOT + str(job.record_id) + "/identity-preflight/"


def publish(job):
    models.UploadedRecording.objects.filter(pk=job.pk).update(
        next_poll_at=timezone.now()
    )
    with mock.patch.object(
        uploads.provider,
        "poll",
        return_value={
            "properties": {"original_duration_in_milliseconds": 10},
            "transcripts": [
                {"sentences": [{"text": "Synthetic", "begin_time": 0, "end_time": 10}]}
            ],
        },
    ):
        uploads.process(job.pk)
    job.refresh_from_db()
    assert job.status == "succeeded"


@pytest.mark.parametrize("header", [None, "wrong-account"])
@pytest.mark.parametrize(
    "path", ["", "upload-url/", "upload-complete/", "multipart/begin/"]
)
def test_identity_upload_requires_account_binding_before_storage(header, path):
    owner = UserFactory()
    client = client_for(owner)
    if header is not None:
        client.credentials(HTTP_X_VOICEPRINT_OWNER=header)
    payload = {"key": str(uuid4()), **options(owner)}
    if path:
        payload.update(name="synthetic.wav", size=364, content_type="audio/wav")
        if path == "upload-complete/":
            payload["storage_name"] = "record-uploads/synthetic.wav"
    else:
        payload["audio"] = SimpleUploadedFile("synthetic.wav", wav_bytes(), "audio/wav")
        payload["identity"] = json.dumps(payload["identity"])
    with mock.patch.object(uploads, "audio_storage") as storage:
        response = client.post(
            ROOT + path, payload, format="json" if path else "multipart"
        )
    assert response.status_code == 401, response.data
    assert response.data == {"code": "voiceprint_account_changed"}
    storage.assert_not_called()
    assert not models.UploadedRecording.objects.exists()


def test_bound_upload_serializes_only_coarse_identity_progress():
    owner = UserFactory()
    client = client_for(owner)
    client.credentials(HTTP_X_VOICEPRINT_OWNER=str(owner.pk))
    response = client.post(
        ROOT,
        {
            "key": str(uuid4()),
            "diarization": "true",
            "identity": json.dumps(options(owner)["identity"]),
            "audio": SimpleUploadedFile("synthetic.wav", wav_bytes(), "audio/wav"),
        },
        format="multipart",
    )
    assert response.status_code == 202, response.data
    assert response.data["identity_preflight"] == {
        "status": "pending",
        "reason": "",
        "can_continue_without_identity": False,
    }
    assert (
        not {"configuration", "candidate_user_ids", "storage_name"}
        & response.data.keys()
    )


@pytest.mark.parametrize(
    "damage",
    [
        {"candidate_user_ids": []},
        {"candidate_user_ids": ["not-a-uuid"]},
        {"organization_id": ""},
        {"unexpected": True},
    ],
)
def test_declaration_rejects_ambiguous_scope_and_candidates(damage):
    owner = UserFactory()
    value = options(owner)
    value["identity"].update(damage)
    with pytest.raises(VoiceprintError):
        service.normalize(owner, value)


def test_declaration_requires_diarization_and_unique_in_scope_persons():
    owner, outsider = UserFactory(), UserFactory()
    with pytest.raises(VoiceprintError, match="diarization_required"):
        service.normalize(owner, {**options(owner), "diarization": False})
    with pytest.raises(VoiceprintError):
        service.normalize(owner, options(owner, users=[owner, owner]))
    with pytest.raises(VoiceprintError, match="candidate_scope_unavailable"):
        service.normalize(owner, options(owner, users=[outsider]))
    org, _ = org_for(owner)
    member = MembershipFactory(organization=org).user
    value = service.normalize(owner, options(owner, org, [member, owner]))
    assert value["identity"]["candidate_user_ids"] == sorted(
        [str(owner.pk), str(member.pk)]
    )
    with pytest.raises(VoiceprintError, match="candidate_scope_unavailable"):
        service.normalize(owner, options(owner, org, [outsider]))
    member.is_device = True
    member.save(update_fields=["is_device"])
    with pytest.raises(VoiceprintError, match="candidate_scope_unavailable"):
        service.normalize(owner, options(owner, org, [member]))


def test_adopting_declared_bytes_does_not_grant_matching_after_disable(settings):
    owner = UserFactory()
    settings.MEETING_VOICEPRINT_MATCHING_ENABLED = False
    with pytest.raises(VoiceprintError, match="matching_disabled"):
        service.normalize(owner, options(owner))
    assert service.normalize(owner, options(owner), admit=False) == options(owner)
    assert service.normalize(owner, {"diarization": False}) == {"diarization": False}


def test_selected_pool_respects_calibrated_candidate_budget(settings):
    owner = UserFactory()
    org, _ = org_for(owner)
    member = MembershipFactory(organization=org).user
    path = settings.MEETING_VOICEPRINT_THRESHOLD_CONFIG_FILE
    with open(path, encoding="utf8") as source:
        policy = json.load(source)
    policy["max_candidates"] = 1
    with open(path, "w", encoding="utf8") as target:
        json.dump(policy, target)
    with pytest.raises(VoiceprintError, match="candidates_invalid"):
        service.normalize(owner, options(owner, org, [owner, member]))


def test_preflight_fails_without_usable_pool_and_never_calls_paid_provider():
    job, _ = job_for(enrolled=False)
    with mock.patch.object(uploads.provider, "submit") as paid:
        uploads.process(job.pk)
        uploads.process(job.pk)
    paid.assert_not_called()
    job.refresh_from_db()
    assert job.status == "failed" and job.identity_state == "awaiting_choice"
    assert job.identity_error == "voiceprint_candidate_pool_unavailable"
    assert uploads.serialize(job)["retryable"] is False
    with pytest.raises(RecordConflict):
        uploads.retry(job.record_id, job.record.owner, job.attempt)


def test_successful_preflight_has_separate_delivery_before_paid_submission(tmp_path):
    job, _ = job_for()
    source_path = tmp_path / "source.media"
    source_path.write_bytes(wav_bytes())
    source = MediaFile(str(source_path), str(tmp_path))
    seen = []

    @contextmanager
    def download(parent, **kwargs):
        seen.append(parent)
        assert kwargs["authorized"]()
        yield SimpleNamespace(media=source)

    @contextmanager
    def prepare(media, **kwargs):
        assert media == source and kwargs["authorized"]()
        yield SimpleNamespace(
            source=source,
            info=MediaInfo(10, 0, 1, 16000, source.stat()),
            derived=False,
            original_duration_ms=10,
        )

    with (
        mock.patch.object(service.storage_service, "from_storage"),
        mock.patch.object(service.storage_service, "download", side_effect=download),
        mock.patch.object(service.preparation, "prepare", side_effect=prepare),
        mock.patch.object(uploads.provider, "submit", return_value="paid-task") as paid,
    ):
        uploads.process(job.pk)
        paid.assert_not_called()
        job.refresh_from_db()
        assert job.status == "queued" and job.identity_state == "ready"
        assert seen == [service.parent_source(job)]
        with mock.patch.object(uploads, "audio_storage", return_value=storage_for(job)):
            uploads.process(job.pk)
        assert paid.call_count == 1
    job.refresh_from_db()
    assert job.status == "running" and job.provider_task_id == "paid-task"


@pytest.mark.parametrize("during", ["head", "sign"])
@pytest.mark.parametrize("change", ["revoke", "lease", "source", "policy", "expiry"])
def test_changes_during_storage_gate_prevent_paid_submission(during, change, settings):
    job, profile = job_for()
    ready(job)
    storage = storage_for(job)

    def mutate(*args, **kwargs):
        if change == "revoke":
            profile.consent.allow_identification = False
            profile.consent.save(update_fields=["allow_identification"])
        elif change == "lease":
            models.UploadedRecording.objects.filter(pk=job.pk).update(lease_id=uuid4())
        elif change == "source":
            current = models.UploadedRecording.objects.get(pk=job.pk)
            current.configuration["_identity_source"]["sha256"] = "f" * 64
            current.save(update_fields=["configuration"])
        elif change == "policy":
            settings.MEETING_VOICEPRINT_MATCHING_ENABLED = False
        else:
            models.UploadedRecording.objects.filter(pk=job.pk).update(
                deadline=timezone.now()
            )
        return (
            {"ContentLength": job.size}
            if during == "head"
            else "https://invalid.test/pinned"
        )

    if during == "head":
        storage.connection.meta.client.head_object.side_effect = mutate
    else:
        storage.connection.meta.client.generate_presigned_url.side_effect = mutate
    with (
        mock.patch.object(uploads, "audio_storage", return_value=storage),
        mock.patch.object(uploads.provider, "submit") as paid,
    ):
        uploads.process(job.pk)
    paid.assert_not_called()
    job.refresh_from_db()
    if change != "lease":
        assert job.identity_state == "awaiting_choice"
    else:
        assert job.status == "submitting"  # Old worker cannot overwrite the new lease.


@pytest.mark.parametrize(
    "field,value",
    [
        ("schema", True),
        ("duration_ms", 0),
        ("time_offset_ms", 1),
        ("channels", 2),
        ("original_duration_ms", 100),
        ("candidate_digest", "f" * 64),
    ],
)
def test_invalid_preflight_proof_cannot_trigger_provider(field, value):
    job, _ = job_for()
    ready(job)
    job.configuration["_preflight"][field] = value
    job.save(update_fields=["configuration"])
    with mock.patch.object(uploads.provider, "submit") as paid:
        uploads.process(job.pk)
    paid.assert_not_called()
    job.refresh_from_db()
    assert job.identity_state == "awaiting_choice"


def test_explicit_continue_preserves_intent_but_disables_diarization_and_replay():
    job, _ = job_for()
    path = awaiting(job)
    client = client_for(job.record.owner)
    client.credentials(HTTP_X_VOICEPRINT_OWNER=str(job.record.owner_id))
    declared = job.configuration["identity"]
    decision = {"expected_attempt": 1, "action": "continue_without_identity"}
    first = client.post(path, decision, format="json")
    assert first.status_code == 202, first.data
    assert client.post(path, decision, format="json").data == first.data
    job.refresh_from_db()
    assert job.attempt == 2 and job.configuration["identity"] == declared
    assert job.identity_state == "disabled"
    with (
        mock.patch.object(uploads, "audio_storage", return_value=storage_for(job)),
        mock.patch.object(
            uploads.provider, "submit", return_value="ordinary-task"
        ) as paid,
        mock.patch.object(service, "run") as precheck,
    ):
        uploads.process(job.pk)
    precheck.assert_not_called()
    assert paid.call_args.args[1]["diarization"] is False
    assert (
        client.post(
            path, {**decision, "action": "retry_identity"}, format="json"
        ).status_code
        == 409
    )
    publish(job)
    with pytest.raises(VoiceprintError, match="source_unavailable"):
        sources.header(job.record_id, job.record.owner_id, job.record.revision)
    job.configuration.pop("_diarization_disabled")
    job.save(update_fields=["configuration"])
    assert (
        sources.header(job.record_id, job.record.owner_id, job.record.revision)[1].pk
        == job.pk
    )


@pytest.mark.parametrize("actor", ["missing_header", "wrong_header", "stranger"])
def test_decision_is_owner_bound(actor):
    job, _ = job_for()
    path = awaiting(job)
    user = UserFactory() if actor == "stranger" else job.record.owner
    client = client_for(user)
    if actor != "missing_header":
        client.credentials(
            HTTP_X_VOICEPRINT_OWNER="wrong" if actor == "wrong_header" else str(user.pk)
        )
    response = client.post(
        path, {"expected_attempt": 1, "action": "retry_identity"}, format="json"
    )
    assert response.status_code == (404 if actor == "stranger" else 401)
    job.refresh_from_db()
    assert job.attempt == 1 and job.status == "failed"


def test_identity_retry_rechecks_current_configuration_and_consent(settings):
    job, _ = job_for()
    awaiting(job)
    settings.MEETING_VOICEPRINT_MATCHING_ENABLED = False
    with pytest.raises(VoiceprintError, match="matching_disabled"):
        service.decide(
            job.record_id, job.record.owner, attempt=1, action="retry_identity"
        )
    job.refresh_from_db()
    assert job.attempt == 1
    settings.MEETING_VOICEPRINT_MATCHING_ENABLED = True
    retried = service.decide(
        job.record_id, job.record.owner, attempt=1, action="retry_identity"
    )
    assert retried.attempt == 2 and retried.identity_state == "pending"


@pytest.mark.parametrize(
    "damage",
    [
        {"expected_attempt": True},
        {"expected_attempt": "1"},
        {"expected_attempt": 0},
        {"_preflight": {}},
    ],
)
def test_decision_rejects_ambiguous_versions_and_private_fields(damage):
    job, _ = job_for()
    path = awaiting(job)
    client = client_for(job.record.owner)
    client.credentials(HTTP_X_VOICEPRINT_OWNER=str(job.record.owner_id))
    response = client.post(
        path,
        {
            "expected_attempt": 1,
            "action": "continue_without_identity",
            **damage,
        },
        format="json",
    )
    assert response.status_code == 400
    job.refresh_from_db()
    assert job.attempt == 1 and job.identity_state == "awaiting_choice"


def test_uncertain_paid_post_requires_review_and_does_not_replay():
    job, _ = job_for()
    ready(job)
    with (
        mock.patch.object(uploads, "audio_storage", return_value=storage_for(job)),
        mock.patch.object(uploads.provider, "submit", side_effect=TimeoutError) as paid,
    ):
        uploads.process(job.pk)
        uploads.process(job.pk)
    assert paid.call_count == 1
    job.refresh_from_db()
    assert job.status == "failed" and job.error_code == "submission_unknown"
    assert job.identity_state == "ready"


def test_failed_preflight_only_reports_allowlisted_reason():
    job, _ = job_for()
    lease = uploads.claim(job.pk)
    service.failure(lease, ValueError("secret credentials and private path"))
    job.refresh_from_db()
    assert job.identity_error == "identity_preflight_unavailable"


def test_common_derivative_pins_asr_and_keeps_playback_on_original():
    job, _ = job_for()
    lease = uploads.claim(job.pk)
    artifact = inputs.reserve(lease, service.parent_source(lease))
    artifact.duration_ms, artifact.sha256, artifact.status = 10, "a" * 64, "ready"
    receipt = ObjectReceipt(
        "s3_object", inputs.name(artifact), 524, etag='"fixed"', version_id="v-mono"
    )
    artifact.receipt = receipt.payload()
    artifact.expires_at = timezone.now() + timedelta(hours=1)
    artifact.save()
    job.refresh_from_db()
    job.lease_id = job.lease_until = None
    ready(job, artifact)
    storage = storage_for(job)
    storage.connection.meta.client.head_object.side_effect = lambda **_: {
        "ContentLength": 524,
        "ETag": '"fixed"',
        "VersionId": "v-mono",
    }
    with (
        mock.patch.object(uploads, "audio_storage", return_value=storage),
        mock.patch.object(uploads.provider, "submit", return_value="paid-task"),
    ):
        uploads.process(job.pk)
    job.refresh_from_db()
    assert job.status == "running"
    assert inputs.selected(job)[1] == receipt
    signed = storage.signed[-1]["params"]
    assert signed["Key"] == receipt.key and signed["VersionId"] == "v-mono"
    assert 3590 <= storage.signed[-1]["expires"] <= 3600
    assert uploads.source_read_params(job, storage)["Key"] == job.storage_name
    assert uploads.asr_read_params(job, storage) == signed
    publish(job)
    assert (
        sources.header(job.record_id, job.record.owner_id, job.record.revision)[2]
        == receipt
    )
