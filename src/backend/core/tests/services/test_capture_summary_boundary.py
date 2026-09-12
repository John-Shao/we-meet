"""Recording stop is distinct from meeting end and from a later recording run."""

import uuid
from unittest.mock import patch

from django.utils import timezone

import pytest
from livekit.api import AccessToken, VideoGrants
from rest_framework.test import APIClient

from core import models
from core.services.meeting_records import RecordConflict
from core.services.meeting_summary_automation import control_automation, tick_automation
from core.services.meeting_summary_versions import (
    execute_summary_job,
    prepare_summary_job,
    summary_readiness,
)
from core.tests.services.test_online_capture import (
    claim,
    enabled,
    meeting,
    source,
    start,
    stop,
)
from core.tests.services.test_staged_summaries import complete
from core.tests.services.test_transcript_delivery import finish
from core.tests.test_api_agent_internal import _payload, _post

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def summary_enabled(settings, enabled):
    settings.MEETING_VERSIONED_SUMMARY_ENABLED = True
    settings.MEETING_STAGED_SUMMARY_ENABLED = True
    settings.MEETING_SUMMARY_REQUESTS_ENABLED = True
    settings.MEETING_SUMMARY_AUTOMATION_ENABLED = True
    settings.DASHSCOPE_API_KEY = "isolated-test-only"
    with patch("meet.celery_app.app.send_task"):
        yield


def recorded(settings):
    user, session = meeting()
    _, run, _ = start(user, session)
    client, identity = claim(settings, session, run)
    assert (
        _post(
            client,
            _payload(
                session.room,
                **identity,
                sequence=1,
                text="We agreed on the release plan. " * 20,
            ),
        ).status_code
        == 201
    )
    return user, session, run, client, identity


def test_quick_during_stop_and_final_after_tail_without_ending_meeting(settings):
    user, session, run, client, identity = recorded(settings)
    record = run.record
    with pytest.raises(RecordConflict):
        prepare_summary_job(record.pk, stage="quick")
    stop(user, session, run)
    assert summary_readiness(record)["ready_stages"] == ["quick"]
    quick = prepare_summary_job(record.pk, stage="quick")
    assert complete(quick)
    with pytest.raises(RecordConflict):
        prepare_summary_job(record.pk, stage="final")
    assert finish(client, identity, 1).status_code == 200
    final = prepare_summary_job(record.pk, stage="final")
    assert complete(final)
    assert final.configuration["capture_run_id"] == str(run.pk)
    session.refresh_from_db()
    assert session.status == "active"
    assert set(record.summary_versions.values_list("stage", flat=True)) == {
        "quick",
        "final",
    }


def test_new_start_cancels_old_draft_and_old_process_cannot_publish(settings):
    user, session, run, client, identity = recorded(settings)
    quick = prepare_summary_job(run.record_id, stage="realtime")
    assert finish(client, identity, 1).status_code == 200
    _, new, _ = start(user, session, expected=run.pk)
    assert new.record_id == run.record_id
    quick.refresh_from_db()
    assert quick.status == "canceled" and quick.error_code == "capture_changed"
    with patch("core.services.meeting_summary_versions.LLMClient") as llm:
        assert execute_summary_job(quick.pk, quick.attempt) is None
        llm.assert_not_called()


def test_automation_produces_quick_for_each_explicit_recording_window(settings):
    user, session, run, client, identity = recorded(settings)
    _, automation, _ = control_automation(
        run.record_id, user, uuid.uuid4(), {"enabled": True, "expected_revision": 0}
    )
    current_run, current_identity = run, identity
    for round_index in range(2):
        if round_index:
            _, current_run, _ = start(user, session, expected=run.pk)
            client, current_identity = claim(settings, session, current_run)
            assert (
                _post(
                    client,
                    _payload(
                        session.room,
                        **current_identity,
                        sequence=1,
                        text="Second discussion ended with a new decision.",
                    ),
                ).status_code
                == 201
            )
        stop(user, session, current_run)
        assert tick_automation(automation.pk)
        quick = current_run.record.processing_jobs.order_by("-generation").first()
        assert quick.configuration["stage"] == "quick"
        assert quick.configuration["capture_run_id"] == str(current_run.pk)
        assert complete(quick)
        assert finish(client, current_identity, 1).status_code == 200
        assert tick_automation(automation.pk)
        final = current_run.record.processing_jobs.order_by("-generation").first()
        assert final.configuration["stage"] == "final"
        assert complete(final)
        assert not tick_automation(automation.pk)
    assert run.record.summary_versions.filter(stage="quick").count() == 2


def test_disabling_staged_ui_does_not_allow_final_before_managed_tail(settings):
    user, session, run, client, identity = recorded(settings)
    stop(user, session, run)
    settings.MEETING_STAGED_SUMMARY_ENABLED = False
    assert summary_readiness(run.record)["ready_stages"] == []
    with pytest.raises(RecordConflict):
        prepare_summary_job(run.record_id)
    finish(client, identity, 1, "incomplete")
    final = prepare_summary_job(run.record_id)
    assert final.input_snapshot.delivery["status"] == "incomplete"


def join_token(settings, room_id, *, can_join=True):
    return (
        AccessToken(
            api_key=settings.LIVEKIT_CONFIGURATION["api_key"],
            api_secret=settings.LIVEKIT_CONFIGURATION["api_secret"],
        )
        .with_identity(str(uuid.uuid4()))
        .with_grants(VideoGrants(room=str(room_id), room_join=can_join))
        .to_jwt()
    )


def test_anonymous_joiner_sees_only_current_capture_status(settings):
    user, session = meeting()
    _, run, _ = start(user, session)
    client = APIClient()
    client.credentials(
        HTTP_AUTHORIZATION=f"Bearer {join_token(settings, session.room_id)}"
    )
    url = "/api/v1.0/meeting-capture-status/"
    assert client.get(url, source(session)).json() == {"state": "starting"}
    client.credentials()  # A status read must not establish a user session.
    assert client.get(f"/api/v1.0/meeting-records/{run.record_id}/").status_code in (
        401,
        403,
    )
    assert client.post(
        "/api/v1.0/online-captures/control/",
        {
            **source(session),
            "operation": "stop",
            "expected_run_id": str(run.pk),
            "key": str(uuid.uuid4()),
        },
        format="json",
    ).status_code in (401, 403)
    client.credentials(
        HTTP_AUTHORIZATION=f"Bearer {join_token(settings, uuid.uuid4())}"
    )
    assert client.get(url, source(session)).status_code == 403
    client.credentials(
        HTTP_AUTHORIZATION=f"Bearer {join_token(settings, session.room_id, can_join=False)}"
    )
    assert client.get(url, source(session)).status_code == 403
    client.credentials()
    assert client.get(url, source(session)).status_code == 403


def test_current_join_token_cannot_read_historic_capture_status(settings):
    _, session = meeting()
    client = APIClient()
    client.credentials(
        HTTP_AUTHORIZATION=f"Bearer {join_token(settings, session.room_id)}"
    )
    assert (
        client.get(
            "/api/v1.0/meeting-capture-status/",
            {**source(session), "livekit_room_sid": "RM_wrong"},
        ).status_code
        == 404
    )
    models.MeetingSession.objects.filter(pk=session.pk).update(
        status="ended", ended_at=timezone.now(), end_reason="room_finished"
    )
    assert (
        client.get("/api/v1.0/meeting-capture-status/", source(session)).status_code
        == 404
    )
