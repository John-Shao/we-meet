"""Durable diagnostics cannot grant a worker execution or disclose another record."""

import uuid
from datetime import timedelta

from django.utils import timezone

import pytest
from rest_framework.test import APIClient

from core import models
from core.factories import UserFactory
from core.services import capture_diagnostics as diagnostics
from core.services import capture_transcription as service
from core.tests.services.test_capture_transcription import (
    AGENT,
    ROOT,
    agent,
    enabled,
    finish,
    running,
)
from core.tests.services.test_meeting_records import client_for

pytestmark = pytest.mark.django_db


def event(stage="transcription_poll", code="failed", elapsed=123):
    return {"stage": stage, "code": code, "elapsed_ms": elapsed}


def post(job, worker, events=None, **extra):
    return agent(
        f"{job['id']}/diagnostics/",
        {
            "worker_id": str(worker),
            "events": events or [event()],
            **extra,
        },
    )


def test_claimed_worker_history_survives_reload_and_duplicate_report():
    user, capture, worker, job = running()
    assert job["supports_diagnostics"] is True
    assert post(job, worker).status_code == 200
    assert post(job, worker, [event(elapsed=999)]).data["count"] == 1
    # Fresh DB read and API instance simulate replacement of a stateless Pod.
    saved = models.CaptureTranscriptionJob.objects.get(pk=job["id"])
    assert saved.diagnostics == [event()]
    visible = client_for(user).get(f"{ROOT}{capture.pk}/transcription/").data
    assert visible["results"][0]["diagnostics"] == [event()]


def test_authentication_worker_identity_and_other_account_are_fenced():
    user, capture, worker, job = running()
    assert APIClient().post(
        f"{AGENT}{job['id']}/diagnostics/", {}, format="json"
    ).status_code in (401, 403)
    assert post(job, uuid.uuid4()).status_code == 409
    assert post(job, worker).status_code == 200
    assert client_for(UserFactory()).get(
        f"{ROOT}{capture.pk}/transcription/"
    ).status_code in (403, 404)
    assert client_for(user).post(
        f"{AGENT}{job['id']}/diagnostics/", {}, format="json"
    ).status_code in (401, 403)


@pytest.mark.parametrize(
    "events,extra",
    [
        ([{**event(), "message": "PRIVATE"}], {}),
        ([event(stage="PRIVATE")], {}),
        ([event(code="PRIVATE")], {}),
        ([event(elapsed=-1)], {}),
        ([event(elapsed=172800001)], {}),
        ([event()] * 21, {}),
        ([event()], {"message": "PRIVATE"}),
    ],
)
def test_unknown_content_and_unbounded_payloads_are_rejected(events, extra):
    _, _, worker, job = running()
    assert post(job, worker, events, **extra).status_code == 400
    assert models.CaptureTranscriptionJob.objects.get(pk=job["id"]).diagnostics == []


def test_late_diagnostics_preserve_cancellation_lease_and_finish_receipt():
    user, _, worker, job = running()
    service.cancel(job["id"], user)
    assert finish(job["id"], worker, success=False, count=0).status_code == 200
    before = models.CaptureTranscriptionJob.objects.get(pk=job["id"])
    assert post(job, worker, [event("delivery"), event("finish")]).status_code == 200
    after = models.CaptureTranscriptionJob.objects.get(pk=job["id"])
    for field in (
        "status",
        "error_code",
        "lease_until",
        "finish_hash",
        "report",
        "updated_at",
    ):
        assert getattr(after, field) == getattr(before, field)
    assert after.status == "canceled"
    assert len(after.diagnostics) == 2


def test_distinct_events_are_capped_and_expiry_cannot_be_extended():
    _, _, worker, job = running()
    events = [
        event(s, c)
        for s in sorted(diagnostics.STAGES)
        for c in sorted(diagnostics.CODES)
    ]
    assert post(job, worker, events[:20]).data["count"] == 20
    assert post(job, worker, events[20:40]).data["count"] == 20
    models.CaptureTranscriptionJob.objects.filter(pk=job["id"]).update(
        created_at=timezone.now() - timedelta(days=31)
    )
    assert post(job, worker).data == {"stored": False, "reason": "expired"}
    old = models.CaptureTranscriptionJob.objects.get(pk=job["id"])
    assert diagnostics.visible(old) == []
    service.tick_transcriptions()
    old.refresh_from_db()
    assert old.diagnostics == []


def test_read_projection_filters_stored_unknown_fields_and_bad_types():
    _, _, _, job = running()
    saved = models.CaptureTranscriptionJob.objects.get(pk=job["id"])
    saved.diagnostics = [
        {**event(), "message": "PRIVATE"},
        "PRIVATE",
        event(stage=[]),
        event(elapsed=True),
    ]
    assert diagnostics.visible(saved) == [event()]
