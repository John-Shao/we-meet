"""Pre-upload directory privacy and durable independent post-ASR requests."""

import json
from datetime import timedelta
from unittest import mock
from uuid import uuid4

from django.utils import timezone

import pytest

from core import models
from core.factories import MembershipFactory, UserFactory
from core.services import recording_identity_directory as directory
from core.services import recording_identity_dispatch as delivery
from core.services import uploaded_recordings as uploads
from core.services.voiceprint_consent import VoiceprintError
from core.tasks import uploaded_recordings as tasks
from core.tests.services.test_meeting_records import client_for
from core.tests.services.test_recording_identity_preflight import (
    import_enabled,
    job_for,
    ready,
)
from core.tests.services.test_voiceprint_candidates import matching_enabled
from core.tests.services.test_voiceprint_consent import enabled, org_for

pytestmark = pytest.mark.django_db
URL = "/api/v1.0/recording-uploads/identity-candidates/"


def client(actor):
    result = client_for(actor)
    result.credentials(HTTP_X_VOICEPRINT_OWNER=str(actor.pk))
    return result


def publish(job, *, diarized=True):
    ready(job)
    models.UploadedRecording.objects.filter(pk=job.pk).update(
        status="running",
        provider_task_id="synthetic-paid-task",
        next_poll_at=timezone.now(),
    )
    row = {"text": "Synthetic", "begin_time": 0, "end_time": 10}
    if diarized:
        row["speaker_id"] = 0
    with mock.patch.object(
        uploads.provider,
        "poll",
        return_value={
            "properties": {"original_duration_in_milliseconds": 10},
            "transcripts": [{"sentences": [row]}],
        },
    ):
        uploads.process(job.pk)
    job.refresh_from_db()
    assert job.status == "succeeded"
    return job.identity_dispatch


def test_directory_shows_scoped_people_without_registration_status():
    actor, outsider = UserFactory(), UserFactory()
    org, _ = org_for(actor)
    member = MembershipFactory(organization=org).user
    inactive = MembershipFactory(organization=org).user
    inactive.is_active = False
    inactive.save(update_fields=["is_active"])
    device = MembershipFactory(organization=org).user
    device.is_device = True
    device.save(update_fields=["is_device"])
    response = client(actor).get(URL, {"organization_id": str(org.pk)})
    assert response.status_code == 200, response.data
    assert {row["id"] for row in response.data["results"]} == {
        str(actor.pk),
        str(member.pk),
    }
    assert all(set(row) == {"id", "name"} for row in response.data["results"])
    assert str(outsider.pk) not in json.dumps(response.data)
    personal = client(actor).get(URL, {"organization_id": "personal"})
    assert [row["id"] for row in personal.data["results"]] == [str(actor.pk)]
    assert not models.VoiceprintProfile.objects.exists()


@pytest.mark.parametrize("header", [None, "different-account"])
def test_directory_requires_explicit_account_binding(header):
    actor = UserFactory()
    request = client_for(actor)
    if header:
        request.credentials(HTTP_X_VOICEPRINT_OWNER=header)
    response = request.get(URL, {"organization_id": "personal"})
    assert response.status_code == 401 and response.data == {
        "code": "voiceprint_account_changed"
    }


def test_directory_denies_foreign_disabled_and_revoked_organization():
    actor, other = UserFactory(), UserFactory()
    org, membership = org_for(actor)
    foreign, _ = org_for(other)
    assert (
        client(actor).get(URL, {"organization_id": str(foreign.pk)}).status_code == 404
    )
    org.settings = {"voiceprint": {"enabled": False, "version": 2}}
    org.save(update_fields=["settings"])
    assert client(actor).get(URL, {"organization_id": str(org.pk)}).status_code == 403
    org.settings = {"voiceprint": {"enabled": True, "version": 3}}
    org.save(update_fields=["settings"])
    membership.delete()
    assert client(actor).get(URL, {"organization_id": str(org.pk)}).status_code == 404


def test_directory_paginates_search_without_adding_outside_members():
    actor = UserFactory(full_name="Other")
    org, _ = org_for(actor)
    for index in range(26):
        MembershipFactory(
            user=UserFactory(full_name=f"Target {index:02d}"), organization=org
        )
    first = directory.lookup(actor, organization_id=org.pk, query="Target")
    second = directory.lookup(actor, organization_id=org.pk, query="Target", offset=25)
    assert len(first["results"]) == 25 and first["next_offset"] == 25
    assert len(second["results"]) == 1 and second["next_offset"] is None
    assert not {row["id"] for row in first["results"]} & {
        row["id"] for row in second["results"]
    }


@pytest.mark.parametrize("change", ["feature", "media", "policy", "device"])
def test_capability_and_directory_close_when_admission_is_unavailable(change, settings):
    actor = UserFactory()
    assert directory.capability(actor)["available"]
    if change == "feature":
        settings.MEETING_VOICEPRINT_MATCHING_ENABLED = False
    elif change == "media":
        settings.MEETING_VOICEPRINT_MEDIA_CONFIG_FILE = ""
    elif change == "policy":
        settings.MEETING_VOICEPRINT_THRESHOLD_CONFIG_FILE = ""
    else:
        actor.is_device = True
        actor.save(update_fields=["is_device"])
    assert directory.capability(actor)["available"] is False
    with pytest.raises(VoiceprintError):
        directory.lookup(actor, organization_id=None)


def test_publication_enqueues_one_private_request_without_changing_source_configuration():
    job, _ = job_for()
    row = publish(job)
    original = json.dumps(job.configuration, sort_keys=True)
    with mock.patch.object(uploads.provider, "submit") as paid:
        delivery.process(row.pk)
        delivery.process(row.pk)
    paid.assert_not_called()
    row.refresh_from_db()
    assert row.status == "submitted" and row.attempts == 1
    batch = models.SpeakerIdentityRequest.objects.get(record=job.record)
    assert (
        batch.request_key == row.request_key
        and batch.requested_users == job.configuration["identity"]["candidate_user_ids"]
    )
    assert batch.jobs.count() == 1
    assert job.record.speakers.get().attribution_kind == "none"
    job.refresh_from_db()
    assert json.dumps(job.configuration, sort_keys=True) == original
    assert uploads.serialize(job)["identity_request"]["status"] == "submitted"


@pytest.mark.parametrize(
    "change", ["revoke", "scope", "source", "expiry", "manual", "unknown"]
)
def test_identity_unavailability_does_not_change_completed_transcription(
    change, settings
):
    job, profile = job_for()
    row = publish(job, diarized=change != "unknown")
    if change == "revoke":
        profile.consent.allow_identification = False
        profile.consent.save(update_fields=["allow_identification"])
    elif change == "scope":
        settings.MEETING_VOICEPRINT_MATCHING_ENABLED = False
    elif change == "source":
        job.configuration["_identity_source"]["sha256"] = "f" * 64
        job.save(update_fields=["configuration"])
    elif change == "expiry":
        models.RecordingIdentityDispatch.objects.filter(pk=row.pk).update(
            expires_at=timezone.now()
        )
    elif change == "manual":
        models.MeetingRecord.objects.filter(pk=job.record_id).update(
            revision=job.record.revision + 1
        )
    with mock.patch.object(uploads.provider, "submit") as paid:
        delivery.process(row.pk)
    paid.assert_not_called()
    row.refresh_from_db()
    job.refresh_from_db()
    assert row.status == "unavailable" and job.status == "succeeded"
    assert job.record.original_segments.count() == 1
    assert not models.SpeakerIdentityRequest.objects.exists()


def test_enqueue_failure_rolls_back_batch_and_retries_only_the_independent_queue():
    job, _ = job_for()
    row = publish(job)
    original = delivery.identification.submit

    def interrupted(*args, **kwargs):
        original(*args, **kwargs)
        raise OSError("private failure")

    with mock.patch.object(delivery.identification, "submit", side_effect=interrupted):
        delivery.process(row.pk)
    assert not models.SpeakerIdentityRequest.objects.exists()
    row.refresh_from_db()
    assert row.status == "queued" and row.attempts == 1
    assert row.error_code == "identity_dispatch_unavailable"
    models.RecordingIdentityDispatch.objects.filter(pk=row.pk).update(
        next_attempt_at=timezone.now()
    )
    delivery.process(row.pk)
    row.refresh_from_db()
    assert (
        row.status == "submitted" and models.SpeakerIdentityRequest.objects.count() == 1
    )


def test_stale_lease_cannot_create_or_overwrite_an_identity_request():
    job, _ = job_for()
    row = publish(job)
    lease = delivery.claim(row.pk)
    replacement = uuid4()
    models.RecordingIdentityDispatch.objects.filter(pk=row.pk).update(
        lease_id=replacement
    )
    delivery.submit_claim(lease)
    assert not models.SpeakerIdentityRequest.objects.exists()
    row.refresh_from_db()
    assert row.lease_id == replacement and row.status == "running"


def test_worker_recovery_has_three_attempt_limit_and_never_retries_asr():
    job, _ = job_for()
    row = publish(job)
    with (
        mock.patch.object(delivery, "submit_claim", side_effect=OSError),
        mock.patch.object(uploads.provider, "submit") as paid,
    ):
        for _ in range(4):
            models.RecordingIdentityDispatch.objects.filter(pk=row.pk).update(
                next_attempt_at=timezone.now(),
                lease_until=timezone.now() - timedelta(seconds=1),
            )
            delivery.process(row.pk)
    paid.assert_not_called()
    row.refresh_from_db()
    job.refresh_from_db()
    assert (
        row.status == "unavailable" and row.attempts == 3 and job.status == "succeeded"
    )


def test_expired_worker_lease_is_recovered_without_duplicate_batches():
    job, _ = job_for()
    row = publish(job)
    old = delivery.claim(row.pk)
    assert row.pk not in delivery.due()
    models.RecordingIdentityDispatch.objects.filter(pk=row.pk).update(
        lease_until=timezone.now() - timedelta(seconds=1)
    )
    assert row.pk in delivery.due()
    delivery.process(row.pk)
    delivery.submit_claim(old)
    row.refresh_from_db()
    assert row.status == "submitted" and row.attempts == 2
    assert models.SpeakerIdentityRequest.objects.count() == 1


def test_scheduler_recovers_identity_work_even_without_pending_asr():
    job, _ = job_for()
    row = publish(job)
    with (
        mock.patch.object(tasks.process_uploaded_recording, "delay") as asr,
        mock.patch.object(
            tasks.process_recording_identity_dispatch, "delay"
        ) as identity,
    ):
        tasks.tick_uploaded_recordings()
    asr.assert_not_called()
    identity.assert_called_once_with(str(row.pk))


@pytest.mark.parametrize("choice", ["ordinary", "disabled"])
def test_ordinary_and_explicitly_disabled_imports_do_not_enqueue_identity(choice):
    job, _ = job_for()
    ready(job)
    if choice == "ordinary":
        job.configuration.pop("identity")
    else:
        job.configuration["_identity_disabled"] = True
        job.configuration["_diarization_disabled"] = True
    job.save(update_fields=["configuration"])
    models.UploadedRecording.objects.filter(pk=job.pk).update(
        status="running", provider_task_id="synthetic-task"
    )
    lease = uploads.claim(job.pk)
    uploads.finish(
        lease,
        [
            {
                "speaker": "unknown",
                "text": "Synthetic",
                "start_ms": 0,
                "end_ms": 10,
                "language": "zh",
            }
        ],
        original_audio_duration_ms=10,
    )
    job.refresh_from_db()
    assert job.status == "succeeded" and job.record.original_segments.count() == 1
    assert not models.RecordingIdentityDispatch.objects.exists()
    assert "identity_request" not in uploads.serialize(job)
