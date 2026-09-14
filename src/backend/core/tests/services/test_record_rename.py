"""Record names persist independently of source revisions and sharing rights."""

import pytest

from core import models
from core.factories import UserFactory
from core.tests.services.test_meeting_record_library import capture
from core.tests.services.test_meeting_records import audio_note, client_for, online_note

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def enabled(settings):
    settings.MEETING_RECORDS_ENABLED = True


def test_owner_rename_persists_in_detail_and_history_without_changing_source():
    record = audio_note()
    capture(record, stopped=True)
    client = client_for(record.owner)
    path = f"/api/v1.0/meeting-records/{record.pk}/"
    assert client.get(path).json()["capabilities"]["rename"] is True
    result = client.patch(path + "title/", {"title": "  Design review  ", "expected_title": record.title}, format="json")
    assert result.status_code == 200
    assert result.json()["title"] == "Design review"
    assert result.json()["revision"] == record.revision
    assert client.get(path).json()["title"] == "Design review"
    history = client.get("/api/v1.0/meeting-records/", {"scope": "owned", "is_ongoing": "false"}).json()
    assert history["results"][0]["title"] == "Design review"
    stale = client.patch(path + "title/", {"title": "Stale edit", "expected_title": record.title}, format="json")
    assert stale.status_code == 409
    record.refresh_from_db()
    assert record.title == "Design review"


def test_shared_reader_and_unrelated_user_cannot_rename():
    record = audio_note()
    capture(record, stopped=True)
    reader = UserFactory()
    models.MeetingRecordAccess.objects.create(record=record, user=reader, read_transcript=True)
    path = f"/api/v1.0/meeting-records/{record.pk}/"
    assert client_for(reader).get(path).json()["capabilities"]["rename"] is False
    for user, status in [(reader, 403), (UserFactory(), 404)]:
        assert client_for(user).patch(path + "title/", {"title": "Other name", "expected_title": record.title}, format="json").status_code == status


def test_active_recording_and_meeting_are_not_renameable():
    record = audio_note()
    capture(record)
    meeting_owner, _, _, meeting = online_note()
    for item, owner in [(record, record.owner), (meeting, meeting_owner)]:
        path = f"/api/v1.0/meeting-records/{item.pk}/"
        client = client_for(owner)
        assert client.get(path).json()["capabilities"]["rename"] is False
        assert client.patch(path + "title/", {"title": "Name", "expected_title": item.title}, format="json").status_code == 403


@pytest.mark.parametrize("body", [
    {"title": ""}, {"title": "   "}, {"title": "x" * 501},
    {"title": "Name", "owner": "other"}, {"expected_title": "Offline interview"},
])
def test_invalid_names_and_unrelated_fields_are_rejected(body):
    record = audio_note()
    body.setdefault("expected_title", record.title)
    response = client_for(record.owner).patch(f"/api/v1.0/meeting-records/{record.pk}/title/", body, format="json")
    assert response.status_code == 400
    record.refresh_from_db()
    assert record.title == "Offline interview"
