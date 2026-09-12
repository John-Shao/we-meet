"""Public summary requests: permissions, retries, atomic intent and broker recovery."""

import uuid
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from unittest.mock import patch

from django.core.management import call_command
from django.db import close_old_connections, transaction

import pytest

from core import models
from core.factories import UserFactory
from core.services.meeting_records import (
    record_capabilities,
    transition_job,
    visible_records,
)
from core.services.meeting_summary_requests import (
    dispatch_summary_request,
    request_summary,
)
from core.services.meeting_summary_versions import execute_summary_job
from core.tests.services.test_meeting_records import client_for, online_note
from core.tests.services.test_meeting_summary_versions import output

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def enabled(settings):
    settings.MEETING_RECORDS_ENABLED = True
    settings.MEETING_VERSIONED_SUMMARY_ENABLED = True
    settings.MEETING_SUMMARY_REQUESTS_ENABLED = True
    settings.CELERY_ENABLED = True
    settings.DASHSCOPE_API_KEY = "test-only"


@pytest.fixture
def broker():
    with patch("meet.celery_app.app.send_task") as send:
        yield send


def payload(record, job=None, operation="generate"):
    record.refresh_from_db()
    return {
        "operation": operation,
        "expected_revision": record.revision,
        "expected_job_id": str(job.pk) if job else None,
        "expected_attempt": job.attempt if job else None,
    }


def post(user, record, body, key=None):
    return client_for(user).post(
        f"/api/v1.0/meeting-records/{record.pk}/summary-requests/",
        body,
        format="json",
        HTTP_IDEMPOTENCY_KEY=str(key or uuid.uuid4()),
    )


def test_public_request_replay_dispatch_and_private_progress(
    broker, django_capture_on_commit_callbacks
):
    user, _, _, record = online_note()
    key = uuid.uuid4()
    body = payload(record)
    with django_capture_on_commit_callbacks(execute=True):
        first = post(user, record, body, key)
    with django_capture_on_commit_callbacks(execute=True):
        second = post(user, record, body, key)
    assert first.status_code == second.status_code == 202
    assert first.json()["request_id"] == second.json()["request_id"]
    assert second.json()["replayed"] is True
    assert models.MeetingProcessingJob.objects.count() == 1
    assert models.MeetingSummaryRequest.objects.count() == 1
    broker.assert_called_once()
    progress = client_for(user).get(
        f"/api/v1.0/meeting-records/{record.pk}/summary-job/"
    )
    assert progress.status_code == 200
    assert progress["Cache-Control"] == "private, no-store"
    assert "configuration" not in progress.json()["job"]
    assert progress.json()["job"]["dispatch_pending"] is False
    assert not models.MeetingSummaryVersion.objects.exists()


@pytest.mark.parametrize("role", ["member", "shared", "outsider"])
def test_read_access_does_not_grant_generation(role, broker):
    _, session, _, record = online_note()
    reader = UserFactory()
    if role == "member":
        models.ResourceAccess.objects.create(
            resource=session.room, user=reader, role="member"
        )
    elif role == "shared":
        models.MeetingRecordAccess.objects.create(
            record=record, user=reader, read_summary=True
        )
    response = post(reader, record, payload(record))
    assert response.status_code == (404 if role == "outsider" else 403)
    assert not models.MeetingProcessingJob.objects.exists()
    broker.assert_not_called()


def test_administrator_can_request_and_revocation_fences_worker(broker):
    _, session, _, record = online_note()
    admin = UserFactory()
    access = models.ResourceAccess.objects.create(
        resource=session.room, user=admin, role="administrator"
    )
    # Use the enum's actual wire value for this repository.
    access.role = models.RoleChoices.ADMIN
    access.save()
    assert post(admin, record, payload(record)).status_code == 202
    job = models.MeetingProcessingJob.objects.get()
    access.delete()
    assert post(admin, record, payload(record, job)).status_code == 404
    assert (
        dispatch_summary_request(models.MeetingSummaryRequest.objects.get().pk) is False
    )
    with patch("core.services.meeting_summary_versions.LLMClient") as llm:
        assert execute_summary_job(job.pk, job.attempt) is None
    llm.assert_not_called()
    job.refresh_from_db()
    assert job.status == "canceled" and job.error_code == "permission_revoked"


def test_revocation_during_provider_call_prevents_publication(broker):
    user, session, _, record = online_note()
    assert post(user, record, payload(record)).status_code == 202
    job = models.MeetingProcessingJob.objects.get()

    def result(**_):
        models.ResourceAccess.objects.filter(resource=session.room, user=user).delete()
        return output(job)

    with patch("core.services.meeting_summary_versions.LLMClient") as llm:
        llm.return_value.chat.side_effect = result
        assert execute_summary_job(job.pk, job.attempt) is None
    assert not models.MeetingSummaryVersion.objects.exists()


def test_changed_key_payload_stale_state_and_cross_record_are_conflicts(broker):
    user, _, _, record = online_note()
    _, _, _, other = online_note(user=user)
    key = uuid.uuid4()
    body = payload(record)
    assert post(user, record, body, key).status_code == 202
    assert (
        post(user, record, {**body, "operation": "regenerate"}, key).status_code == 409
    )
    assert post(user, record, body).status_code == 409
    assert post(user, other, payload(other), key).status_code == 409
    assert models.MeetingProcessingJob.objects.count() == 1


def test_retry_advances_attempt_once_and_regenerate_requires_terminal_job(broker):
    user, _, _, record = online_note()
    assert post(user, record, payload(record)).status_code == 202
    job = models.MeetingProcessingJob.objects.get()
    assert post(user, record, payload(record, job, "regenerate")).status_code == 409
    transition_job(job.pk, attempt=1, target="running")
    transition_job(
        job.pk,
        attempt=1,
        target="failed",
        error_code="provider_unavailable",
        retryable=True,
    )
    key = uuid.uuid4()
    body = payload(record, job, "retry")
    assert post(user, record, body, key).status_code == 202
    assert post(user, record, body, key).status_code == 202
    job.refresh_from_db()
    assert job.attempt == 2 and job.generation == 1
    transition_job(job.pk, attempt=2, target="running")
    transition_job(job.pk, attempt=2, target="partial")
    assert post(user, record, payload(record, job, "regenerate")).status_code == 202
    assert record.processing_jobs.count() == 2


def test_broker_failure_is_recoverable_without_new_generation(
    broker, django_capture_on_commit_callbacks
):
    user, _, _, record = online_note()
    broker.side_effect = RuntimeError("private broker credential")
    with django_capture_on_commit_callbacks(execute=True):
        response = post(user, record, payload(record))
    request = models.MeetingSummaryRequest.objects.get()
    assert response.status_code == 202
    assert (
        request.dispatch_state == "pending"
        and request.error_code == "dispatch_unavailable"
    )
    assert "private broker" not in str(response.json())
    broker.side_effect = None
    models.MeetingSummaryRequest.objects.filter(pk=request.pk).update(
        dispatch_attempted_at=None
    )
    call_command("dispatch_summary_requests", "--limit", "1")
    request.refresh_from_db()
    assert request.dispatch_state == "sent"
    assert models.MeetingProcessingJob.objects.get().attempt == 1


def test_rolled_back_intent_never_dispatches(
    broker, django_capture_on_commit_callbacks
):
    user, _, _, record = online_note()
    with django_capture_on_commit_callbacks(execute=True):
        with transaction.atomic():
            request_summary(record.pk, user, uuid.uuid4(), payload(record))
            transaction.set_rollback(True)
    assert not models.MeetingSummaryRequest.objects.exists()
    assert not models.MeetingProcessingJob.objects.exists()
    broker.assert_not_called()


def test_required_key_unknown_fields_and_rollout_gates(settings, broker):
    user, _, _, record = online_note()
    client = client_for(user)
    url = f"/api/v1.0/meeting-records/{record.pk}/summary-requests/"
    assert client.post(url, payload(record), format="json").status_code == 400
    assert post(user, record, {**payload(record), "model": "other"}).status_code == 400
    settings.CELERY_ENABLED = False
    assert post(user, record, payload(record)).status_code == 404
    settings.CELERY_ENABLED = True
    settings.MEETING_SUMMARY_REQUESTS_ENABLED = False
    assert post(user, record, payload(record)).status_code == 404
    assert not models.MeetingProcessingJob.objects.exists()


def test_room_filter_never_selects_another_room(broker):
    user, session, _, record = online_note()
    online_note(user=user)
    response = client_for(user).get(
        f"/api/v1.0/meeting-records/?room_id={session.room_id}"
    )
    assert [row["id"] for row in response.json()["results"]] == [str(record.pk)]
    assert response.json()["results"][0]["capabilities"]["generate_summary"] is True


def test_request_rate_limit_does_not_limit_progress_reads(broker):
    user, _, _, record = online_note()
    key = uuid.uuid4()
    body = payload(record)
    for _ in range(6):
        assert post(user, record, body, key).status_code == 202
    assert post(user, record, body, key).status_code == 429
    assert (
        client_for(user)
        .get(f"/api/v1.0/meeting-records/{record.pk}/summary-job/")
        .status_code
        == 200
    )


def test_generation_capability_has_no_per_record_queries(
    broker, django_assert_num_queries
):
    user, _, _, _ = online_note()
    online_note(user=user)
    with django_assert_num_queries(1):
        capabilities = [
            record_capabilities(record, user) for record in visible_records(user)
        ]
    assert all(item["generate_summary"] for item in capabilities)


def test_cross_origin_preflight_allows_idempotency_header(settings, broker):
    user, _, _, record = online_note()
    settings.CORS_ALLOWED_ORIGINS = ["https://frontend.test"]
    response = client_for(user).options(
        f"/api/v1.0/meeting-records/{record.pk}/summary-requests/",
        HTTP_ORIGIN="https://frontend.test",
        HTTP_ACCESS_CONTROL_REQUEST_METHOD="POST",
        HTTP_ACCESS_CONTROL_REQUEST_HEADERS="content-type,idempotency-key",
    )
    assert response.status_code == 200
    assert "idempotency-key" in response["Access-Control-Allow-Headers"]
    assert response["Access-Control-Allow-Origin"] == "https://frontend.test"


@pytest.mark.django_db(transaction=True)
def test_concurrent_same_key_commits_one_intent_and_one_dispatch(broker):
    user, _, _, record = online_note()
    key = uuid.uuid4()
    body = payload(record)
    barrier = Barrier(2)

    def invoke():
        close_old_connections()
        try:
            barrier.wait(timeout=5)
            result, _ = request_summary(record.pk, user, key, body)
            return result.pk
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: invoke(), range(2)))
    assert results[0] == results[1]
    assert models.MeetingProcessingJob.objects.count() == 1
    broker.assert_called_once()
