"""Delivery watermarks verify emitted text without claiming audio completeness."""

import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from datetime import timezone as dt_timezone
from threading import Barrier
from unittest.mock import patch

from django.db import close_old_connections
from django.utils import timezone

import pytest

from core import models
from core.factories import MeetingSessionFactory
from core.services.meeting_summary_versions import (
    execute_summary_job,
    prepare_summary_job,
)
from core.tests.services.test_meeting_summary_versions import output
from core.tests.test_api_agent_internal import TOKEN, _client, _payload, _post

pytestmark = pytest.mark.django_db
ENDPOINT = "/api/agent/transcript-deliveries/"


@pytest.fixture(autouse=True)
def enabled(settings):
    settings.MEETING_RECORDS_ENABLED = True
    settings.MEETING_TRANSCRIPT_DELIVERY_ENABLED = True
    settings.MEETING_VERSIONED_SUMMARY_ENABLED = True
    settings.DASHSCOPE_API_KEY = "test-provider-key"


def setup_delivery(settings):
    session = MeetingSessionFactory(started_at=timezone.now() - timedelta(minutes=2))
    client = _client(settings)
    identity = {
        "room_id": str(session.room_id),
        "livekit_room_sid": session.livekit_room_sid,
        "delivery_id": str(uuid.uuid4()),
    }
    assert control(client, identity, action="begin").status_code == 200
    payload = _payload(session.room, **identity, sequence=1)
    return client, session, identity, payload


def control(client, identity, **extra):
    return client.post(
        ENDPOINT, {**identity, **extra}, format="json", HTTP_X_AGENT_TOKEN=TOKEN
    )


def finish(client, identity, count, outcome="complete"):
    return control(
        client, identity, action="finish", final_sequence=count, outcome=outcome
    )


def end_session(session):
    session.status = "ended"
    session.ended_at = timezone.now()
    session.end_reason = models.MeetingSession.EndReason.ROOM_FINISHED
    session.save()
    return models.MeetingRecord.objects.get(meeting_session=session)


def test_out_of_order_gaps_replays_and_sealed_writes(settings):
    client, _, identity, first = setup_delivery(settings)
    second = {**first, "ingest_id": str(uuid.uuid4()), "sequence": 2, "text": "second"}
    assert _post(client, second).status_code == 201
    assert finish(client, identity, 2).status_code == 409
    assert _post(client, first).status_code == 201
    assert finish(client, identity, 2).status_code == 200
    assert finish(client, identity, 2).status_code == 200
    assert _post(client, first).status_code == 200
    assert _post(client, {**first, "text": "different"}).status_code == 409
    assert (
        _post(
            client, {**first, "sequence": 3, "ingest_id": str(uuid.uuid4())}
        ).status_code
        == 409
    )
    assert finish(client, identity, 3).status_code == 409
    assert models.Transcript.objects.count() == 2


def test_identity_cannot_cross_sessions_or_adopt_legacy_ingest(settings):
    client, session, identity, payload = setup_delivery(settings)
    other = MeetingSessionFactory()
    foreign = {
        **identity,
        "room_id": str(other.room_id),
        "livekit_room_sid": other.livekit_room_sid,
    }
    assert control(client, foreign, action="begin").status_code == 409
    assert _post(client, {**payload, **foreign}).status_code == 409
    legacy = {
        key: value
        for key, value in payload.items()
        if key not in ("sequence", "delivery_id")
    }
    assert _post(client, legacy).status_code == 201
    assert _post(client, payload).status_code == 409
    assert models.Transcript.objects.get().session_id == session.pk
    assert models.TranscriptReceipt.objects.count() == 0


def test_incomplete_manifest_cannot_be_promoted(settings):
    client, _, identity, payload = setup_delivery(settings)
    assert _post(client, {**payload, "sequence": 2}).status_code == 201
    assert finish(client, identity, 1, "incomplete").status_code == 409
    assert finish(client, identity, 2, "incomplete").status_code == 200
    assert finish(client, identity, 2).status_code == 409


@pytest.mark.parametrize("mutation", ["edit", "delete"])
def test_changed_or_deleted_text_invalidates_delivery(settings, mutation):
    client, session, identity, payload = setup_delivery(settings)
    assert _post(client, payload).status_code == 201
    assert finish(client, identity, 1).status_code == 200
    record = end_session(session)
    first = prepare_summary_job(record.pk)
    assert first.input_snapshot.delivery["status"] == "complete"
    row = models.Transcript.objects.get()
    if mutation == "edit":
        row.text = "edited"
        row.save()
        changed = prepare_summary_job(record.pk)
        assert changed.input_snapshot.delivery["status"] == "incomplete"
    else:
        row.delete()
        assert models.TranscriptReceipt.objects.get().transcript_id is None
    assert _post(client, payload).status_code == 409
    with patch("core.services.meeting_summary_versions.LLMClient") as llm:
        assert execute_summary_job(first.pk, first.attempt) is None
    llm.assert_not_called()


def test_completion_changes_snapshot_and_cancels_old_worker(settings):
    client, session, identity, payload = setup_delivery(settings)
    assert _post(client, payload).status_code == 201
    record = end_session(session)
    first = prepare_summary_job(record.pk)
    assert first.input_snapshot.delivery["status"] == "incomplete"

    def provider(**_):
        assert finish(client, identity, 1).status_code == 200
        return output(first)

    with patch("core.services.meeting_summary_versions.LLMClient") as llm:
        chat = llm.return_value.chat
        chat.side_effect = provider
        assert execute_summary_job(first.pk, first.attempt) is None
    first.refresh_from_db()
    assert chat.call_count == 1, (first.status, first.error_code)
    assert first.status == "canceled" and first.error_code == "source_changed"
    assert (
        models.TranscriptDelivery.objects.get(pk=identity["delivery_id"]).state
        == "complete"
    ), (first.status, first.error_code)
    second = prepare_summary_job(record.pk)
    assert second.input_snapshot.pk != first.input_snapshot.pk
    assert second.input_snapshot.delivery["status"] == "complete"
    with patch("core.services.meeting_summary_versions.LLMClient") as llm:
        llm.return_value.chat.return_value = output(second)
        assert execute_summary_job(second.pk, second.attempt)
    second.refresh_from_db()
    assert second.status == "partial"
    assert second.result == {
        "coverage_status": "unverified",
        "delivery_status": "complete",
    }


def test_untracked_text_and_extra_open_run_prevent_verified_delivery(settings):
    client, session, identity, payload = setup_delivery(settings)
    assert _post(client, payload).status_code == 201
    assert finish(client, identity, 1).status_code == 200
    extra = {**identity, "delivery_id": str(uuid.uuid4())}
    assert control(client, extra, action="begin").status_code == 200
    record = end_session(session)
    assert (
        prepare_summary_job(record.pk).input_snapshot.delivery["status"] == "incomplete"
    )
    assert finish(client, extra, 0).status_code == 200
    legacy = {
        key: value
        for key, value in payload.items()
        if key not in ("sequence", "delivery_id")
    }
    legacy["ingest_id"] = str(uuid.uuid4())
    assert _post(client, legacy).status_code == 201
    assert (
        prepare_summary_job(record.pk).input_snapshot.delivery["status"] == "unverified"
    )


def test_auth_flags_required_fields_and_unknown_session(settings):
    client, session, identity, payload = setup_delivery(settings)
    assert (
        client.post(
            ENDPOINT, {**identity, "action": "begin"}, format="json"
        ).status_code
        == 403
    )
    assert control(client, identity, action="finish").status_code == 400
    assert _post(client, {**payload, "ingest_id": None}).status_code == 400
    assert (
        control(
            client, {**identity, "livekit_room_sid": "missing"}, action="begin"
        ).status_code
        == 409
    )
    end_session_without_record = session
    end_session_without_record.status = "ended"
    end_session_without_record.ended_at = timezone.now()
    end_session_without_record.end_reason = (
        models.MeetingSession.EndReason.ROOM_FINISHED
    )
    end_session_without_record.save()
    assert (
        control(
            client, {**identity, "delivery_id": str(uuid.uuid4())}, action="begin"
        ).status_code
        == 409
    )
    settings.MEETING_TRANSCRIPT_DELIVERY_ENABLED = False
    assert _post(client, payload).status_code == 404
    assert control(client, identity, action="begin").status_code == 404
    assert models.Transcript.objects.count() == 0


def test_timezone_equivalent_retry(settings):
    client, _, identity, payload = setup_delivery(settings)
    assert _post(client, payload).status_code == 201
    retry = dict(payload)
    for key in ("started_at", "ended_at"):
        retry[key] = (
            datetime.fromisoformat(payload[key])
            .astimezone(dt_timezone(timedelta(hours=8)))
            .isoformat()
        )
    assert _post(client, retry).status_code == 200
    assert finish(client, identity, 1).status_code == 200


@pytest.mark.django_db(transaction=True)
def test_concurrent_delivery_retries_persist_once(settings):
    _, _, _, payload = setup_delivery(settings)
    barrier = Barrier(2)

    def write():
        close_old_connections()
        try:
            client = _client(settings)
            barrier.wait(timeout=5)
            return _post(client, payload).status_code
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(lambda _: write(), range(2)))
    assert sorted(outcomes) == [200, 201]
    assert (
        models.Transcript.objects.count()
        == models.TranscriptReceipt.objects.count()
        == 1
    )
