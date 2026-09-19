"""The advertised playback action needs retained media and current ownership."""

import pytest

from core import models
from core.factories import UserFactory
from core.tests.services.test_capture_transcription import enabled, saved
from core.tests.services.test_meeting_records import client_for

pytestmark = pytest.mark.django_db


def test_saved_capture_can_play_but_text_reader_and_deleted_bytes_cannot():
    owner, capture = saved()
    path = f"/api/v1.0/meeting-records/{capture.record_id}/"
    assert client_for(owner).get(path).data["capabilities"]["play_media"] is True
    reader = UserFactory()
    models.MeetingRecordAccess.objects.create(
        record=capture.record, user=reader, read_transcript=True
    )
    assert client_for(reader).get(path).data["capabilities"]["play_media"] is False
    capture.record.retention_mode = "text"
    capture.record.save(update_fields=["retention_mode"])
    assert client_for(owner).get(path).data["capabilities"]["play_media"] is False
    capture.record.retention_mode = "media"
    capture.record.save(update_fields=["retention_mode"])
    capture.audio_chunks.update(stored=False)
    assert client_for(owner).get(path).data["capabilities"]["play_media"] is False
