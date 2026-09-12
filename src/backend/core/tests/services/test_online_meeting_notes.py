"""Exact live source resolution, latest-first text and legacy pipeline exclusion."""

from datetime import timedelta
from unittest.mock import patch

import pytest

from core import models
from core.factories import MeetingParticipationFactory
from core.services.meeting_summary_versions import prepare_summary_job
from core.tasks.summary import generate_meeting_summary
from core.tests.services.test_meeting_records import client_for, online_note

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def enabled(settings):
    settings.MEETING_RECORDS_ENABLED = True
    settings.MEETING_VERSIONED_SUMMARY_ENABLED = True


def test_live_sid_pair_never_falls_back_to_newest_session_or_another_room():
    user, first, _, record = online_note()
    _, second, _, newer = online_note(user=user, room=first.room)
    client = client_for(user)
    url = "/api/v1.0/meeting-records/resolve/"
    response = client.get(
        url, {"room_id": first.room_id, "livekit_room_sid": first.livekit_room_sid}
    )
    assert response.status_code == 200 and response.json()["id"] == str(record.pk)
    assert response.json()["id"] != str(newer.pk)
    assert (
        client.get(
            url, {"room_id": first.room_id, "livekit_room_sid": "RM_missing"}
        ).status_code
        == 404
    )
    _, unrelated, _, _ = online_note(user=user)
    assert (
        client.get(
            url,
            {"room_id": unrelated.room_id, "livekit_room_sid": second.livekit_room_sid},
        ).status_code
        == 404
    )
    for selector in [
        {"livekit_room_sid": first.livekit_room_sid},
        {
            "room_id": first.room_id,
            "livekit_room_sid": first.livekit_room_sid,
            "meeting_session_id": first.pk,
        },
        {"room_id": first.room_id, "livekit_room_sid": "invalid"},
    ]:
        assert client.get(url, selector).status_code == 400


def test_latest_first_text_pages_keep_acl_and_exact_source():
    user, session, first, record = online_note()
    models.Transcript.objects.bulk_create(
        [
            models.Transcript(
                room=session.room,
                session=session,
                speaker_identity="speaker",
                text=f"Sentence {i}",
                started_at=session.started_at + timedelta(seconds=i),
            )
            for i in range(1, 40)
        ]
    )
    _, _, _, other = online_note(user=user, room=session.room, text="Foreign session")
    url = f"/api/v1.0/meeting-records/{record.pk}/transcripts/"
    client = client_for(user)
    response = client.get(url, {"order": "latest"})
    assert response.status_code == 200 and len(response.json()["results"]) == 30
    assert response.json()["results"][0]["text"] == "Sentence 39"
    assert all(
        row["session_id"] == str(session.pk) for row in response.json()["results"]
    )
    older = client.get(
        url, {"order": "latest", "cursor": response.json()["next_cursor"]}
    ).json()
    assert len(older["results"]) == 10 and older["results"][-1]["id"] == str(first.pk)
    assert older["next_cursor"] is None
    assert client.get(url, {"order": "invalid"}).status_code == 400
    assert (
        client.get(f"/api/v1.0/meeting-records/{other.pk}/transcripts/").json()[
            "results"
        ][0]["text"]
        == "Foreign session"
    )
    models.ResourceAccess.objects.filter(resource=session.room, user=user).delete()
    assert client.get(url, {"order": "latest"}).status_code == 404


@pytest.mark.parametrize("intent", ["job", "enabled", "disabled"])
def test_versioned_intent_excludes_legacy_automatic_generation_even_when_rollout_is_off(
    intent, settings
):
    user, session, transcript, record = online_note()
    MeetingParticipationFactory(
        session=session, identity=transcript.speaker_identity, kind="standard"
    )
    if intent == "job":
        prepare_summary_job(record.pk)
    else:
        models.MeetingSummaryAutomation.objects.create(
            record=record, requested_by=user, enabled=intent == "enabled"
        )
    settings.MEETING_VERSIONED_SUMMARY_ENABLED = False
    settings.MEETING_RECORDS_ENABLED = False
    with patch("core.tasks.summary.MeetingSummaryService") as legacy:
        assert generate_meeting_summary(str(session.pk)) is None
        legacy.assert_not_called()


def test_untouched_legacy_sessions_keep_the_existing_automatic_pipeline():
    _, session, transcript, _ = online_note()
    MeetingParticipationFactory(
        session=session, identity=transcript.speaker_identity, kind="standard"
    )
    summary = models.Summary.objects.create(
        room=session.room, session=session, status="failed"
    )
    with patch("core.tasks.summary.MeetingSummaryService") as legacy:
        legacy.return_value.generate.return_value = summary
        assert generate_meeting_summary(str(session.pk)) == str(summary.pk)
        legacy.return_value.generate.assert_called_once_with(session)
