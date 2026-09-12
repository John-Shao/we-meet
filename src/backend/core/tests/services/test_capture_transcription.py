"""ASR request/worker fencing, immutable source generations and delivery publication."""

import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta

from django.db import close_old_connections
from django.utils import timezone

import pytest
from rest_framework.test import APIClient

from core import models
from core.factories import MembershipFactory, UserFactory
from core.tests.services.test_capture_audio import recording, seal, upload, wav
from core.tests.services.test_meeting_captures import ROOT, command
from core.tests.services.test_meeting_records import client_for

pytestmark = pytest.mark.django_db
AGENT = "/api/agent/capture-transcriptions/"


@pytest.fixture(autouse=True)
def enabled(settings, tmp_path):
    settings.MEETING_RECORDS_ENABLED = True
    settings.MEETING_CAPTURE_PROTOCOL_ENABLED = True
    settings.MEETING_CAPTURE_AUDIO_ENABLED = True
    settings.MEETING_CAPTURE_ASR_ENABLED = True
    settings.AGENT_INTERNAL_API_TOKEN = "asr-test-only"
    settings.STORAGES = {
        "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"}
    }
    settings.MEDIA_ROOT = str(tmp_path)


def request_job(user, capture, *, expected=None, key=None, allow=False):
    return client_for(user).post(
        f"{ROOT}{capture.pk}/transcription/",
        {
            "expected_job_id": str(expected) if expected else None,
            "allow_incomplete": allow,
        },
        format="json",
        HTTP_IDEMPOTENCY_KEY=str(key or uuid.uuid4()),
    )


def saved(*, gaps=False):
    user, body, capture = recording()
    assert upload(user, body, capture).status_code == 200
    if gaps:
        assert upload(user, body, capture, sequence=3, start_ms=2000).status_code == 200
    assert command(user, body, capture, "stop").status_code == 200
    assert seal(user, body, capture, 3 if gaps else 1).status_code == 200
    assert command(user, body, capture, "finalize").status_code == 200
    return user, capture


def agent(path, body):
    return APIClient().post(
        f"{AGENT}{path}", body, format="json", HTTP_X_AGENT_TOKEN="asr-test-only"
    )


def claim(worker=None):
    worker = worker or uuid.uuid4()
    result = agent(
        "claim/",
        {
            "worker_id": str(worker),
            "model": "qwen-audio-3.0-asr-flash-streaming",
            "region": "cn-beijing",
        },
    )
    assert result.status_code == 200, result.data
    return worker, result.data["job"]


def control(job, worker, operation, **payload):
    return agent(
        f"{job}/control/", {"worker_id": str(worker), "operation": operation, **payload}
    )


def final(job, worker, **overrides):
    payload = {
        "worker_id": str(worker),
        "ingest_id": str(uuid.uuid4()),
        "sequence": 1,
        "start_ms": 0,
        "end_ms": 1000,
        "text": "Confirm the release date.",
        "language": "en",
        **overrides,
    }
    return agent(f"{job}/originals/", payload), payload


def finish(job, worker, *, success=True, count=1, task=None):
    return agent(
        f"{job}/finish/",
        {
            "worker_id": str(worker),
            "provider_finished": success,
            "final_sequence": count,
            "tasks": [
                {
                    "task_id": str(task or uuid.uuid4()),
                    "finished": success,
                    "input_samples": 16000,
                    "billed_seconds": 1,
                }
            ],
        },
    )


def running():
    user, capture = saved()
    result = request_job(user, capture)
    assert result.status_code == 201, result.data
    worker, job = claim()
    assert control(job["id"], worker, "begin").status_code == 200
    return user, capture, worker, job


def acknowledge(job, worker):
    source = job["inputs"]["chunks"][0]
    assert (
        control(
            job["id"], worker, "ack_input", index=1, checksum=source["checksum"]
        ).status_code
        == 200
    )


def originals(user, capture):
    return (
        client_for(user)
        .get(f"/api/v1.0/meeting-records/{capture.record_id}/original-segments/")
        .data["results"]
    )


def test_public_request_replay_scope_and_generation_cas():
    user, capture = saved()
    key = uuid.uuid4()
    first = request_job(user, capture, key=key)
    assert first.status_code == 201
    assert (
        request_job(user, capture, key=key).data["job"]["id"] == first.data["job"]["id"]
    )
    assert request_job(user, capture, key=key, allow=True).status_code == 409
    assert request_job(user, capture).status_code == 409
    assert request_job(UserFactory(), capture).status_code == 404
    assert "inputs" not in first.data["job"] and "worker_id" not in first.data["job"]
    assert models.CaptureTranscriptionJob.objects.count() == 1


def test_provider_begin_is_one_shot_and_private_audio_is_worker_scoped():
    user, capture = saved()
    assert request_job(user, capture).status_code == 201
    worker, job = claim()
    assert claim(worker)[1]["id"] == job["id"]
    assert claim()[1] is None
    url = f"{AGENT}{job['id']}/audio/1/"
    assert APIClient().get(url).status_code in (401, 403)
    response = APIClient().get(
        url, HTTP_X_AGENT_TOKEN="asr-test-only", HTTP_X_WORKER_ID=str(worker)
    )
    assert response.content == wav()
    assert response["Cache-Control"] == "private, no-store"
    assert control(job["id"], uuid.uuid4(), "begin").status_code == 409
    assert control(job["id"], worker, "begin").status_code == 200
    assert control(job["id"], worker, "begin").status_code == 409
    assert claim(worker)[1]["started"]


def test_only_complete_delivery_publishes_originals_and_billing_once():
    user, capture, worker, job = running()
    response, payload = final(job["id"], worker)
    assert response.status_code == 201, response.data
    assert agent(f"{job['id']}/originals/", payload).status_code == 200
    assert not originals(user, capture)
    acknowledge(job, worker)
    task = uuid.uuid4()
    assert finish(job["id"], worker, task=task).data["status"] == "succeeded"
    assert finish(job["id"], worker, task=task).status_code == 200
    assert len(originals(user, capture)) == 1
    assert (
        models.AIUsageRecord.objects.filter(ref_type="capture_transcription").count()
        == 1
    )
    assert final(job["id"], worker, sequence=2)[0].status_code == 409
    assert models.MeetingSpeaker.objects.get().identity_type == "unknown"


def test_missing_input_or_final_receipt_never_publishes():
    user, capture, worker, job = running()
    assert final(job["id"], worker)[0].status_code == 201
    assert finish(job["id"], worker).data["status"] == "incomplete"
    assert not originals(user, capture)
    capture.refresh_from_db()
    assert capture.active_transcription_id is None


def test_retry_retains_previous_published_generation_until_success():
    user, capture, worker, job = running()
    assert final(job["id"], worker)[0].status_code == 201
    acknowledge(job, worker)
    assert finish(job["id"], worker).data["status"] == "succeeded"
    original = originals(user, capture)
    assert request_job(user, capture, expected=job["id"]).status_code == 201
    worker2, job2 = claim()
    assert control(job2["id"], worker2, "begin").status_code == 200
    assert final(job2["id"], worker2, text="Revised ASR result")[0].status_code == 201
    assert originals(user, capture) == original
    acknowledge(job2, worker2)
    assert finish(job2["id"], worker2).data["status"] == "succeeded"
    assert [row["text"] for row in originals(user, capture)] == ["Revised ASR result"]
    assert models.MeetingOriginalSegment.objects.count() == 2
    # Source-pinned pagination stays stable after publishing a newer generation.
    path = f"/api/v1.0/meeting-records/{capture.record_id}/original-segments/"
    assert (
        client_for(user).get(path, {"transcription_job_id": job["id"]}).data["results"]
        == original
    )
    assert (
        client_for(user).get(path, {"transcription_job_id": uuid.uuid4()}).status_code
        == 404
    )


def test_expired_or_revoked_execution_cannot_upgrade_late_results(settings):
    user, capture, worker, job = running()
    assert final(job["id"], worker)[0].status_code == 201
    acknowledge(job, worker)
    models.CaptureTranscriptionJob.objects.filter(pk=job["id"]).update(
        lease_until=timezone.now() - timedelta(seconds=1)
    )
    assert finish(job["id"], worker).data["status"] == "incomplete"
    assert not originals(user, capture)
    assert request_job(user, capture, expected=job["id"]).status_code == 201
    worker2, job2 = claim()
    assert control(job2["id"], worker2, "begin").status_code == 200
    settings.MEETING_CAPTURE_ASR_ENABLED = False
    state = client_for(user).get(f"{ROOT}{capture.pk}/transcription/")
    assert state.data["results"][0]["status"] == "canceled"
    assert final(job2["id"], worker2)[0].status_code == 409
    assert finish(job2["id"], worker2).data["status"] == "canceled"


def test_incomplete_audio_requires_consent_and_finals_cannot_cross_gaps():
    user, capture = saved(gaps=True)
    assert request_job(user, capture).status_code == 409
    assert request_job(user, capture, allow=True).status_code == 201
    worker, job = claim()
    assert job["inputs"]["runs"] == 2
    assert control(job["id"], worker, "begin").status_code == 200
    assert final(job["id"], worker, start_ms=500, end_ms=2500)[0].status_code == 409
    assert final(job["id"], worker, start_ms=2000, end_ms=2500)[0].status_code == 201
    assert (
        control(
            job["id"],
            worker,
            "ack_input",
            index=2,
            checksum=job["inputs"]["chunks"][1]["checksum"],
        ).status_code
        == 409
    )


def test_personal_record_cost_does_not_move_to_a_later_membership():
    user, capture, worker, job = running()
    MembershipFactory(user=user, is_primary=True)
    acknowledge(job, worker)
    assert finish(job["id"], worker, count=0).data["status"] == "succeeded"
    assert (
        models.AIUsageRecord.objects.get(
            ref_type="capture_transcription"
        ).organization_id
        is None
    )


def test_cancel_is_owner_scoped_and_still_available_after_rollout_disabled(settings):
    user, capture, worker, job = running()
    path = f"{ROOT}{capture.pk}/transcription/{job['id']}/cancel/"
    assert client_for(UserFactory()).post(path, {}, format="json").status_code == 404
    settings.MEETING_CAPTURE_ASR_ENABLED = False
    assert client_for(user).post(path, {}, format="json").data["status"] == "canceled"
    assert client_for(user).post(path, {}, format="json").status_code == 200
    assert control(job["id"], worker, "heartbeat").status_code == 409


def test_nested_unknown_fields_and_invalid_time_are_rejected_without_side_effects():
    _, _, worker, job = running()
    response = agent(
        f"{job['id']}/finish/",
        {
            "worker_id": str(worker),
            "provider_finished": True,
            "final_sequence": 0,
            "tasks": [
                {
                    "task_id": str(uuid.uuid4()),
                    "finished": True,
                    "input_samples": 16000,
                    "billed_seconds": None,
                    "extra": True,
                }
            ],
        },
    )
    assert response.status_code == 400
    assert final(job["id"], worker, start_ms=500, end_ms=200)[0].status_code == 409
    assert not models.MeetingOriginalSegment.objects.exists()
    heartbeat = control(job["id"], worker, "heartbeat")
    assert heartbeat.status_code == 200 and "inputs" not in heartbeat.data


def test_billing_preserves_fractional_observations_and_rejects_nan():
    _, _, worker, job = running()
    acknowledge(job, worker)
    payload = {
        "worker_id": str(worker),
        "provider_finished": True,
        "final_sequence": 0,
        "tasks": [
            {
                "task_id": str(uuid.uuid4()),
                "finished": True,
                "input_samples": 16000,
                "billed_seconds": "NaN",
            }
        ],
    }
    assert agent(f"{job['id']}/finish/", payload).status_code == 400
    payload["tasks"][0]["billed_seconds"] = 0.75
    response = agent(f"{job['id']}/finish/", payload)
    assert response.status_code == 200 and response.data["status"] == "succeeded"
    assert (
        models.CaptureTranscriptionJob.objects.get(pk=job["id"]).report["tasks"][0][
            "billed_seconds"
        ]
        == 0.75
    )
    assert (
        models.AIUsageRecord.objects.get(ref_type="capture_transcription").audio_seconds
        == 1
    )


@pytest.mark.django_db(transaction=True)
def test_concurrent_workers_cannot_claim_the_same_audio():
    user, capture = saved()
    assert request_job(user, capture).status_code == 201

    def attempt(_):
        close_old_connections()
        try:
            return claim()[1]
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(attempt, range(2)))
    assert sum(result is not None for result in results) == 1
