"""Single-use claims, provider begin fences and conservative late completion."""

import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Barrier
from unittest.mock import patch

from django.db import close_old_connections
from django.utils import timezone

import pytest
from rest_framework.test import APIClient

from core import models
from core.tests.services.test_capture_audio import recording
from core.tests.services.test_capture_translation import (
    enabled,
    payload,
    read,
    send,
)
from core.tests.services.test_meeting_captures import ROOT, command
from core.tests.services.test_meeting_records import client_for

pytestmark = pytest.mark.django_db
INTERNAL = "/api/agent/capture-translations/"


def agent(path, data, token="isolated-agent"):
    return APIClient().post(
        INTERNAL + path, data, format="json", HTTP_X_AGENT_TOKEN=token
    )


def reserve():
    user, body, capture = recording()
    result = send(user, body, capture, payload(capture))
    assert result.status_code == 202
    run = models.CaptureTranslationRun.objects.get(
        pk=result.data["command"]["result"]["id"]
    )
    ticket = client_for(user).post(
        f"{ROOT}{capture.pk}/translation/ticket/",
        {
            "device_id": body["device_id"],
            "run_id": str(run.pk),
            "generation": run.generation,
        },
        format="json",
        HTTP_X_CAPTURE_LEASE=body["lease_key"],
    )
    assert ticket.status_code == 200, ticket.data
    return user, body, capture, run, ticket.data["ticket"]


def claimed():
    user, body, capture, run, ticket = reserve()
    worker = str(uuid.uuid4())
    result = agent("claim/", {"ticket": ticket, "worker_id": worker})
    assert result.status_code == 200, result.data
    return user, body, capture, run, worker, ticket


def advance(run, worker, op):
    return agent(f"{run.pk}/control/", {"worker_id": worker, "operation": op})


def finish(run, worker, **overrides):
    return agent(
        f"{run.pk}/finish/",
        {
            "worker_id": worker,
            "complete": True,
            "input_tokens": 10,
            "output_tokens": 5,
            "audio_seconds": 2,
            **overrides,
        },
    )


def test_ticket_claim_and_begin_are_single_use():
    _, _, _, run, worker, ticket = claimed()
    assert agent("claim/", {"ticket": ticket, "worker_id": worker}).status_code == 200
    assert (
        agent("claim/", {"ticket": ticket, "worker_id": str(uuid.uuid4())}).status_code
        == 409
    )
    begin = advance(run, worker, "begin")
    assert begin.status_code == 200 and begin.data["execute"]
    assert begin.data["run"]["status"] == "starting"
    replay = advance(run, worker, "begin")
    assert replay.status_code == 200 and not replay.data["execute"]
    assert agent("claim/", {"ticket": ticket, "worker_id": worker}).status_code == 409
    assert advance(run, worker, "ready").data["run"]["status"] == "translating"
    assert advance(run, worker, "heartbeat").data["action"] == "stream"


@pytest.mark.parametrize("kind", ["tampered", "expired", "unsigned", "wrong_agent"])
def test_ticket_authentication_and_expiry(kind):
    _, _, _, _, ticket = reserve()
    data = {"ticket": ticket, "worker_id": str(uuid.uuid4())}
    if kind == "tampered":
        data["ticket"] += "x"
    elif kind == "unsigned":
        data["ticket"] = "{}"
    if kind == "expired":
        with patch(
            "django.core.signing.time.time",
            return_value=timezone.now().timestamp() + 31,
        ):
            result = agent("claim/", data)
    else:
        result = agent(
            "claim/", data, token="wrong" if kind == "wrong_agent" else "isolated-agent"
        )
    assert result.status_code in (403, 404)
    assert models.CaptureTranslationRun.objects.get().worker_id is None


def test_stop_before_claim_never_allows_connection():
    user, body, capture, run, ticket = reserve()
    assert (
        send(
            user,
            body,
            capture,
            payload(
                capture,
                operation="stop",
                expected_run_id=str(run.pk),
                configuration=None,
            ),
        ).status_code
        == 202
    )
    assert (
        agent("claim/", {"ticket": ticket, "worker_id": str(uuid.uuid4())}).status_code
        == 409
    )


@pytest.mark.parametrize("change", ["pause_resume", "lease", "account", "flag"])
def test_begin_rechecks_source_and_rollout(change, settings):
    user, body, capture, run, worker, _ = claimed()
    if change == "pause_resume":
        command(user, body, capture, "pause")
        command(user, body, capture, "resume")
    elif change == "lease":
        models.CaptureSession.objects.filter(pk=capture.pk).update(lease_hash="a" * 64)
    elif change == "account":
        models.User.objects.filter(pk=user.pk).update(is_active=False)
    else:
        settings.MEETING_CAPTURE_TRANSLATION_ENABLED = False
    assert advance(run, worker, "begin").status_code in (404, 409)
    run.refresh_from_db()
    assert run.begun_at is None


def test_worker_cannot_renew_before_begin_or_after_expiry():
    _, _, _, run, worker, _ = claimed()
    assert advance(run, worker, "heartbeat").status_code == 409
    assert advance(run, str(uuid.uuid4()), "begin").status_code == 404
    assert advance(run, worker, "begin").status_code == 200
    models.CaptureTranslationRun.objects.filter(pk=run.pk).update(
        deadline=timezone.now() - timedelta(seconds=1)
    )
    assert advance(run, worker, "heartbeat").status_code == 409
    assert finish(run, worker).data["run"]["status"] == "incomplete"


def test_disabled_rollout_drains_but_does_not_extend_stop_lease(settings):
    _, _, _, run, worker, _ = claimed()
    advance(run, worker, "begin")
    advance(run, worker, "ready")
    settings.MEETING_CAPTURE_TRANSLATION_ENABLED = False
    first = advance(run, worker, "heartbeat")
    assert first.status_code == 200 and first.data["action"] == "stop"
    again = advance(run, worker, "heartbeat")
    assert again.data["run"]["deadline"] == first.data["run"]["deadline"]


def test_finish_is_idempotent_and_records_usage_once():
    _, _, _, run, worker, _ = claimed()
    advance(run, worker, "begin")
    advance(run, worker, "ready")
    first = finish(run, worker)
    assert first.status_code == 200 and first.data["run"]["status"] == "stopped"
    assert finish(run, worker).data == first.data
    assert finish(run, worker, audio_seconds=3).status_code == 409
    usage = models.AIUsageRecord.objects.get(ref_id=str(run.pk))
    assert usage.audio_seconds == 2
    assert usage.model_code == "qwen3.5-livetranslate-flash-realtime"
    assert advance(run, worker, "heartbeat").status_code == 409


def test_late_finish_cannot_replace_new_attempt_or_restore_revoked_success():
    user, body, capture, run, worker, _ = claimed()
    advance(run, worker, "begin")
    models.CaptureTranslationRun.objects.filter(pk=run.pk).update(
        deadline=timezone.now() - timedelta(seconds=1)
    )
    read(user, capture)
    replacement = send(
        user, body, capture, payload(capture, expected_run_id=str(run.pk))
    )
    assert replacement.status_code == 202
    models.User.objects.filter(pk=user.pk).update(is_active=False)
    assert finish(run, worker).data["run"]["status"] == "incomplete"
    newest = models.CaptureTranslationRun.objects.get(
        pk=replacement.data["command"]["result"]["id"]
    )
    assert newest.status == "starting" and newest.worker_id is None


@pytest.mark.django_db(transaction=True)
def test_concurrent_claims_have_one_worker():
    _, _, _, run, ticket = reserve()
    barrier = Barrier(2)

    def claim(worker):
        close_old_connections()
        try:
            barrier.wait(timeout=10)
            return agent("claim/", {"ticket": ticket, "worker_id": worker}).status_code
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(claim, [str(uuid.uuid4()), str(uuid.uuid4())]))
    assert sorted(results) == [200, 409]
    run.refresh_from_db()
    assert run.worker_id and run.begun_at is None
