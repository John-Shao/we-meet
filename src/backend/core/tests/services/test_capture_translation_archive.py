"""Confirmed capture translations retain exact recording provenance and current ACLs."""

import uuid

from django.core.exceptions import ValidationError

import pytest

from core import models
from core.factories import UserFactory
from core.services.meeting_captures import digest
from core.tests.services.test_capture_translation import enabled, payload, read, send
from core.tests.services.test_capture_translation_worker import (
    advance,
    agent,
    claimed,
    finish,
)
from core.tests.services.test_meeting_captures import ROOT, command
from core.tests.services.test_meeting_records import client_for

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def archive_enabled(settings):
    settings.MEETING_TRANSLATION_ARCHIVE_ENABLED = True


def retained():
    values = claimed(
        {
            "source_language": "zh",
            "target_language": "en",
            "mode": "push_to_talk",
            "audio": False,
            "save_translations": True,
        }
    )
    _, _, _, run, worker, _ = values
    assert advance(run, worker, "begin").status_code == 200
    assert advance(run, worker, "ready").status_code == 200
    return values


def append(capture, run, worker, **overrides):
    return agent(
        f"{run.pk}/segments/",
        {
            "worker_id": worker,
            "capture_id": str(capture.pk),
            "generation": run.generation,
            "direction": "forward",
            "response_id": "response",
            "item_id": "item",
            "text": "Hello",
            **overrides,
        },
    )


def test_retained_finals_are_replayable_separate_from_originals_and_have_real_source():
    _, _, capture, run, worker, _ = retained()
    first = append(capture, run, worker)
    assert first.status_code == 200, first.data
    again = append(capture, run, worker)
    assert again.data["id"] == first.data["id"] and again.data["replayed"]
    assert append(capture, run, worker, text="Changed").status_code == 409
    reverse = append(capture, run, worker, direction="reverse", text="你好")
    assert reverse.status_code == 200 and reverse.data["sequence"] == 2
    segment = models.MeetingTranslationSegment.objects.get(pk=first.data["id"])
    assert segment.source_capture_id == capture.pk
    assert (
        segment.source_participation_id is None and not segment.source_participant_sid
    )
    assert not models.MeetingOriginalSegment.objects.exists()
    assert not models.MeetingParticipation.objects.exists()
    assert finish(run, worker, segment_count=2).data["run"]["status"] == "stopped"
    archive = models.MeetingTranslationArchive.objects.get()
    assert archive.status == "complete" and archive.segment_count == 2


@pytest.mark.parametrize(
    "case", ["wrong_worker", "wrong_capture", "wrong_generation", "paused", "revoked"]
)
def test_writer_identity_and_current_authority(case):
    user, body, capture, run, worker, _ = retained()
    overrides = {}
    if case == "wrong_worker":
        worker = str(uuid.uuid4())
    elif case == "wrong_capture":
        overrides["capture_id"] = str(uuid.uuid4())
    elif case == "wrong_generation":
        overrides["generation"] = run.generation + 1
    elif case == "paused":
        command(user, body, capture, "pause")
    else:
        models.User.objects.filter(pk=user.pk).update(is_active=False)
    assert append(capture, run, worker, **overrides).status_code in (404, 409)
    assert not models.MeetingTranslationSegment.objects.exists()


def test_explicit_retention_is_required_before_reservation(settings):
    user, body, capture, run, worker, _ = claimed()
    advance(run, worker, "begin")
    assert append(capture, run, worker).status_code == 404
    assert not models.MeetingTranslationArchive.objects.exists()
    finish(run, worker)
    settings.MEETING_TRANSLATION_ARCHIVE_ENABLED = False
    config = {
        "source_language": "zh",
        "target_language": "en",
        "mode": "simultaneous",
        "audio": False,
        "save_translations": True,
    }
    response = send(
        user,
        body,
        capture,
        payload(capture, expected_run_id=str(run.pk), configuration=config),
    )
    assert response.status_code == 409
    assert models.CaptureTranslationRun.objects.count() == 1


def test_missing_or_deleted_item_never_claims_complete_archive():
    _, _, capture, run, worker, _ = retained()
    append(capture, run, worker)
    assert finish(run, worker, segment_count=2).data["run"]["status"] == "incomplete"
    assert models.MeetingTranslationArchive.objects.get().status == "incomplete"


def test_deleted_confirmed_text_invalidates_previously_complete_archive():
    _, _, capture, run, worker, _ = retained()
    append(capture, run, worker)
    finish(run, worker, segment_count=1)
    models.MeetingTranslationSegment.objects.get().delete()
    assert models.MeetingTranslationArchive.objects.get().status == "incomplete"


def test_readers_are_scoped_to_capture_owner_and_do_not_offer_fake_playback():
    user, _, capture, run, worker, _ = retained()
    append(capture, run, worker)
    finish(run, worker, segment_count=1)
    root = f"{ROOT}{capture.pk}/translation/archives/"
    listed = client_for(user).get(root)
    assert listed.status_code == 200, listed.data
    assert listed.data["capture_id"] == str(capture.pk)
    archive_id = listed.data["results"][0]["id"]
    detail = client_for(user).get(root + archive_id + "/")
    row = detail.data["results"][0]
    assert row["source_capture_id"] == str(capture.pk)
    assert row["timing_basis"] == "delivery" and row["original_id"] is None
    assert "source_participant_sid" not in row
    assert "no-store" in detail["Cache-Control"]
    assert client_for(UserFactory()).get(root + archive_id + "/").status_code == 404
    legacy = client_for(user).get(
        f"/api/v1.0/meeting-records/{capture.record_id}/translation-archives/"
    )
    assert legacy.status_code == 200 and not legacy.data["results"]
    models.User.objects.filter(pk=user.pk).update(is_active=False)
    assert client_for(user).get(root).status_code in (401, 403, 404)


def test_pause_marks_archive_incomplete_and_identity_cannot_be_changed():
    user, body, capture, run, worker, _ = retained()
    append(capture, run, worker)
    segment = models.MeetingTranslationSegment.objects.get()
    segment.source_participation_id = uuid.uuid4()
    with pytest.raises(ValidationError):
        segment.save()
    command(user, body, capture, "pause")
    read(user, capture)
    assert models.MeetingTranslationArchive.objects.get().status == "incomplete"


def test_deleting_live_translation_source_closes_its_surviving_archive():
    _, _, capture, run, worker, _ = retained()
    append(capture, run, worker)
    run.delete()
    archive = models.MeetingTranslationArchive.objects.get()
    assert archive.status == "incomplete" and archive.record_id == capture.record_id


def test_missing_archive_cannot_authorize_a_paid_begin():
    _, _, _, run, worker, _ = claimed(
        {
            "source_language": "zh",
            "target_language": "en",
            "mode": "simultaneous",
            "audio": False,
            "save_translations": True,
        }
    )
    models.MeetingTranslationArchive.objects.get().delete()
    assert advance(run, worker, "begin").status_code == 409
    run.refresh_from_db()
    assert run.begun_at is None


def test_legacy_finish_without_archive_count_preserves_original_hash():
    _, _, _, run, worker, _ = claimed()
    advance(run, worker, "begin")
    assert finish(run, worker).status_code == 200
    run.refresh_from_db()
    assert run.finish_hash == digest(
        {"complete": True, "input_tokens": 10, "output_tokens": 5, "audio_seconds": 2}
    )
    assert finish(run, worker).status_code == 200
