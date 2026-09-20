"""Duration cannot be manufactured from text, billing or incomplete delivery."""

from types import SimpleNamespace

import pytest

from core import models
from core.factories import UserFactory
from core.services.record_media_timing import media_timing, provider_audio_duration
from core.tests.services.test_meeting_record_speakers import capture_with_speakers
from core.tests.services.test_meeting_records import audio_note, client_for


@pytest.mark.parametrize(
    "value", [None, True, -1, 0, 1.5, float("inf"), "5000", 43_200_001]
)
def test_provider_rejects_invalid_duration(value):
    assert (
        provider_audio_duration(
            {"properties": {"original_duration_in_milliseconds": value}}, []
        )
        is None
    )


def test_provider_uses_original_duration_with_trailing_silence_not_billing():
    result = {
        "properties": {"original_duration_in_milliseconds": 5000},
        "billed_seconds": 1,
    }
    assert provider_audio_duration(result, [{"end_ms": 1000}]) == 5000
    assert provider_audio_duration(result, [{"end_ms": 5001}]) is None
    assert provider_audio_duration({"billed_seconds": 9}, [{"end_ms": 1000}]) is None


@pytest.mark.parametrize("kind,expected", [("audio", 5000), ("video", None)])
def test_audio_track_does_not_claim_video_duration(kind, expected):
    record = SimpleNamespace(
        source_type="upload",
        uploaded_recording=SimpleNamespace(
            configuration={
                "_file": {"media_type": kind},
                "_original_audio_duration_ms": 5000,
            }
        ),
    )
    assert media_timing(record)["duration_ms"] == expected


@pytest.mark.parametrize(
    "changes",
    [
        {"gaps": [{"start_ms": 1, "end_ms": 2}]},
        {"missing_sequences": [2]},
        {"client_interrupted": True},
        {"outcome": "incomplete"},
    ],
)
def test_partial_capture_reports_saved_length_but_no_full_duration(changes):
    manifest = {
        "duration_ms": 5000,
        "outcome": "saved",
        "client_interrupted": False,
        "missing_sequences": [],
        "gaps": [],
    }
    manifest.update(changes)
    record = SimpleNamespace(
        source_type="audio_recording",
        library_captures=[
            SimpleNamespace(
                status="stopped", audio_manifest=SimpleNamespace(**manifest)
            )
        ],
    )
    assert media_timing(record) == {
        "duration_ms": None,
        "saved_duration_ms": 5000,
        "basis": "partial_audio",
    }


def test_complete_capture_and_ambiguous_clocks():
    capture = SimpleNamespace(
        status="stopped",
        audio_manifest=SimpleNamespace(
            duration_ms=5000,
            outcome="saved",
            client_interrupted=False,
            missing_sequences=[],
            gaps=[],
        ),
    )
    record = SimpleNamespace(source_type="audio_recording", library_captures=[capture])
    assert media_timing(record)["duration_ms"] == 5000
    record.library_captures = [capture, capture]
    assert media_timing(record)["duration_ms"] is None
    record.library_captures = [capture]
    capture.status = "recording"
    assert media_timing(record)["duration_ms"] is None


@pytest.mark.django_db
def test_record_api_old_record_is_unknown_and_access_is_preserved(settings):
    settings.MEETING_RECORDS_ENABLED = True
    record = audio_note()
    path = f"/api/v1.0/meeting-records/{record.pk}/"
    response = client_for(record.owner).get(path)
    assert response.status_code == 200
    assert response.json()["media_timing"] == {
        "duration_ms": None,
        "saved_duration_ms": None,
        "basis": "unknown",
    }
    assert client_for(UserFactory()).get(path).status_code == 404


@pytest.mark.django_db
def test_capture_duration_is_read_from_prefetched_manifest(settings):
    settings.MEETING_RECORDS_ENABLED = True
    record = audio_note()
    capture, _ = capture_with_speakers(record)
    capture.status = "stopped"
    capture.save()
    models.CaptureAudioManifest.objects.create(
        capture=capture, final_sequence=1, outcome="saved", duration_ms=5000
    )
    client = client_for(record.owner)
    detail = client.get(f"/api/v1.0/meeting-records/{record.pk}/").json()
    listing = client.get("/api/v1.0/meeting-records/").json()
    assert detail["media_timing"]["duration_ms"] == 5000
    assert listing["results"][0]["media_timing"] == detail["media_timing"]
