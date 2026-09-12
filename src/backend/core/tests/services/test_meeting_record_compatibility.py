"""Legacy links and migration audits must preserve source and access boundaries."""

import io
import json

from django.core.management import call_command
from django.core.management.base import CommandError

import pytest

from core import models
from core.factories import (
    MeetingParticipationFactory,
    MeetingSessionFactory,
    OrganizationFactory,
    RecordingFactory,
    RoomFactory,
    UserFactory,
    UserRecordingAccessFactory,
)
from core.tests.services.test_meeting_records import audio_note, client_for, online_note

pytestmark = pytest.mark.django_db
BASE = "/api/v1.0/meeting-records/"


@pytest.fixture(autouse=True)
def enable_records(settings):
    """Exercise the opt-in API without modifying the default rollout flag."""
    settings.MEETING_RECORDS_ENABLED = True


def audit(*args):
    """Capture JSON even when strict verification rejects unresolved differences."""
    output = io.StringIO()
    error = None
    try:
        call_command("backfill_meeting_records", *args, stdout=output)
    except CommandError as exc:
        error = exc
    return json.loads(output.getvalue()), error


def test_resolve_single_session_without_writing():
    user, session, _, record = online_note()
    before = models.MeetingRecord.objects.count()
    response = client_for(user).get(
        BASE + "resolve/", {"room_id": str(session.room_id)}
    )
    assert response.status_code == 200
    assert response.json()["id"] == str(record.pk)
    assert response["Cache-Control"] == "private, no-store"
    assert models.MeetingRecord.objects.count() == before


def test_reused_room_is_ambiguous_even_when_new_session_has_no_material():
    user, session, _, record = online_note()
    second = MeetingSessionFactory(room=session.room)
    client = client_for(user)
    response = client.get(BASE + "resolve/", {"room_id": str(session.room_id)})
    assert response.status_code == 409
    assert response.json()["code"] == "ambiguous_source"
    exact = client.get(
        BASE + "resolve/",
        {"room_id": str(session.room_id), "meeting_session_id": str(session.pk)},
    )
    assert exact.json()["id"] == str(record.pk)
    assert (
        client.get(
            BASE + "resolve/", {"meeting_session_id": str(second.pk)}
        ).status_code
        == 404
    )
    assert models.MeetingRecord.objects.count() == 1


def test_resolve_does_not_reveal_other_users_ambiguous_room():
    _, session, _, _ = online_note()
    MeetingSessionFactory(room=session.room)
    response = client_for(UserFactory()).get(
        BASE + "resolve/", {"room_id": str(session.room_id)}
    )
    assert response.status_code == 404


def test_cross_room_session_pair_is_rejected():
    user, session, _, _ = online_note()
    response = client_for(user).get(
        BASE + "resolve/",
        {"room_id": str(RoomFactory().pk), "meeting_session_id": str(session.pk)},
    )
    assert response.status_code == 404


def test_missing_projection_is_not_created_by_get():
    user, session, _, record = online_note()
    record.delete()
    response = client_for(user).get(
        BASE + "resolve/", {"meeting_session_id": str(session.pk)}
    )
    assert response.status_code == 404
    assert not models.MeetingRecord.objects.exists()


def test_summary_link_requires_summary_permission_and_exact_source():
    _, session, _, record = online_note()
    summary = models.Summary.objects.create(
        room=session.room, session=session, content="private summary"
    )
    user = UserFactory()
    grant = models.MeetingRecordAccess.objects.create(
        record=record, user=user, read_transcript=True
    )
    client = client_for(user)
    params = {"summary_id": str(summary.pk)}
    assert client.get(BASE + "resolve/", params).status_code == 404
    grant.read_summary = True
    grant.save()
    assert client.get(BASE + "resolve/", params).json()["id"] == str(record.pk)
    models.Summary.objects.filter(pk=summary.pk).update(room=RoomFactory())
    assert client.get(BASE + "resolve/", params).status_code == 404


@pytest.mark.parametrize(
    "params",
    [
        {},
        {"room_id": "bad"},
        {"summary_id": "bad"},
        {"latest": "true"},
        {"room_id": "00000000-0000-0000-0000-000000000001", "q": "ignored?"},
        {
            "summary_id": "00000000-0000-0000-0000-000000000001",
            "meeting_session_id": "00000000-0000-0000-0000-000000000002",
        },
    ],
)
def test_invalid_source_selectors_are_rejected(params):
    assert client_for(UserFactory()).get(BASE + "resolve/", params).status_code == 400


def test_recording_only_grant_does_not_expand_to_entire_meeting():
    _, session, _, record = online_note()
    recording = RecordingFactory(room=session.room, session=session)
    user = UserFactory()
    UserRecordingAccessFactory(user=user, recording=recording, role="owner")
    client = client_for(user)
    assert client.get(BASE + f"{record.pk}/").status_code == 404
    assert (
        client.get(
            BASE + "resolve/", {"meeting_session_id": str(session.pk)}
        ).status_code
        == 404
    )
    assert models.MeetingRecordAccess.objects.filter(user=user).count() == 0


def test_scopes_narrow_authorized_records_and_do_not_promote_attendance():
    user, _, _, owned = online_note()
    audio = audio_note(user)
    _, joined, _, shared = online_note()
    _, hidden, _, _ = online_note()
    MeetingParticipationFactory(user=user, session=joined)
    MeetingParticipationFactory(user=user, session=joined)
    MeetingParticipationFactory(user=user, session=hidden)
    grant = models.MeetingRecordAccess.objects.create(
        record=shared, user=user, read_summary=True
    )
    client = client_for(user)

    def ids(scope):
        result = client.get(BASE, {"scope": scope})
        assert result.status_code == 200
        return [row["id"] for row in result.json()["results"]]

    assert set(ids("owned")) == {str(owned.pk), str(audio.pk)}
    assert ids("participated") == [str(shared.pk)]
    assert ids("shared") == [str(shared.pk)]
    assert set(ids("recent")) == {str(owned.pk), str(audio.pk), str(shared.pk)}
    grant.delete()
    assert ids("participated") == [] and ids("shared") == []
    assert client.get(BASE, {"scope": "anything"}).status_code == 400


def test_dry_run_and_apply_report_remaining_records_and_readiness():
    session = MeetingSessionFactory()
    RecordingFactory(room=session.room, session=session)
    report, error = audit("--strict")
    assert error and not report["ready"]
    assert report["remaining_sessions"] == 1
    assert report["samples"]["missing_session_ids"] == [str(session.pk)]
    assert not models.MeetingRecord.objects.exists()
    report, error = audit("--apply", "--strict")
    assert error is None and report["ready"] and report["created"] == 1
    report, error = audit("--apply", "--strict")
    assert error is None and report["created"] == 0


def test_audit_reports_unresolved_and_mismatched_ids_without_content():
    session = MeetingSessionFactory()
    recording = RecordingFactory(room=session.room, session=session)
    models.Recording.objects.filter(pk=recording.pk).update(room=RoomFactory())
    orphan = models.Transcript.objects.create(
        room=session.room,
        speaker_identity="private identity",
        text="secret meeting content",
        started_at=session.started_at,
    )
    report, error = audit("--strict", "--sample-limit=1")
    assert error
    assert report["mismatched_room"]["Recording"] == 1
    assert report["samples"]["mismatched_Recording_ids"] == [str(recording.pk)]
    assert report["samples"]["unresolved_Transcript_ids"] == [str(orphan.pk)]
    assert "secret meeting" not in json.dumps(report)
    report, _ = audit("--sample-limit=0")
    assert all(value == [] for value in report["samples"].values())


def test_dry_run_detects_organization_drift_and_apply_does_not_reassign():
    _, session, _, record = online_note()
    models.Room.objects.filter(pk=session.room_id).update(
        organization=OrganizationFactory()
    )
    report, error = audit("--strict")
    assert error and report["conflicts"] == 1
    assert report["samples"]["conflict_record_ids"] == [str(record.pk)]
    report, error = audit("--apply")
    assert error and report["apply_conflicts"] == 1
    record.refresh_from_db()
    assert record.organization_id is None


def test_deleted_source_is_reported_without_reattachment():
    _, session, _, record = online_note()
    session.room.delete()
    report, error = audit("--strict")
    assert error and report["orphan_records"] == 1
    assert report["samples"]["orphan_record_ids"] == [str(record.pk)]
