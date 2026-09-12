"""Human edits never mutate AI output, source text, newer edits or another record."""

import copy
import uuid
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from unittest.mock import patch

from django.core.exceptions import ValidationError
from django.db import close_old_connections

import pytest

from core import models
from core.factories import UserFactory
from core.services import meeting_summary_review as service
from core.services.meeting_records import RecordConflict
from core.services.meeting_summary_versions import (
    execute_summary_job,
    prepare_summary_job,
)
from core.tests.services.test_meeting_records import client_for, online_note
from core.tests.services.test_meeting_summary_versions import output

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def enabled(settings):
    settings.MEETING_RECORDS_ENABLED = True
    settings.MEETING_VERSIONED_SUMMARY_ENABLED = True
    settings.MEETING_SUMMARY_REVIEW_ENABLED = True
    settings.DASHSCOPE_API_KEY = "test-provider-key"


def generated(record, *, regenerate=False):
    job = prepare_summary_job(record.pk, regenerate=regenerate)
    with patch("core.services.meeting_summary_versions.LLMClient") as client:
        client.return_value.chat.return_value = output(job)
        version = execute_summary_job(job.pk, 1)
    return models.MeetingSummaryVersion.objects.get(pk=version)


def fixture():
    user, _, transcript, record = online_note()
    return user, record, transcript, generated(record)


def payload(base, *, revision=0, replace=False):
    content = copy.deepcopy(base.content)
    content["overview"] = "Human correction"
    content["action_items"] = [
        {
            "text": "Human follow-up",
            "owner_text": "TBD",
            "due_text": "Unconfirmed",
            "source_refs": [],
        }
    ]
    return {
        "base_summary_id": str(base.pk),
        "expected_revision": revision,
        "replace_base": replace,
        "content": content,
    }


def test_edits_are_append_only_and_do_not_restart_ai_or_create_tasks():
    user, record, transcript, base = fixture()
    revision = record.revision
    original = copy.deepcopy(base.content)
    saved, _, replay = service.save_review(record.pk, user, uuid.uuid4(), payload(base))
    assert not replay and saved.revision == 1
    assert saved.content["overview"] == "Human correction"
    with pytest.raises(ValidationError):
        saved.save()
    base.refresh_from_db()
    record.refresh_from_db()
    transcript.refresh_from_db()
    assert base.content == original and record.revision == revision
    assert transcript.text == "first meeting"
    assert record.processing_jobs.count() == 1
    assert not models.Task.objects.exists()
    assert not models.ActionItem.objects.exists()
    later = generated(record, regenerate=True)
    assert later.pk != base.pk
    assert record.summary_reviews.first().pk == saved.pk


def test_replay_returns_original_and_current_but_stale_edit_conflicts():
    user, record, _, base = fixture()
    key = uuid.uuid4()
    first, _, _ = service.save_review(record.pk, user, key, payload(base))
    second, _, _ = service.save_review(
        record.pk, user, uuid.uuid4(), payload(base, revision=1)
    )
    original, current, replay = service.save_review(record.pk, user, key, payload(base))
    assert replay and original.pk == first.pk and current.pk == second.pk
    assert second.previous_id == first.pk
    with pytest.raises(RecordConflict):
        service.save_review(record.pk, user, uuid.uuid4(), payload(base))
    with pytest.raises(RecordConflict):
        service.save_review(record.pk, user, key, payload(base, revision=2))


def test_new_ai_source_requires_explicit_replacement():
    user, record, _, base = fixture()
    service.save_review(record.pk, user, uuid.uuid4(), payload(base))
    newer = generated(record, regenerate=True)
    with pytest.raises(RecordConflict):
        service.save_review(record.pk, user, uuid.uuid4(), payload(newer, revision=1))
    changed, _, _ = service.save_review(
        record.pk, user, uuid.uuid4(), payload(newer, revision=1, replace=True)
    )
    assert changed.base_summary_id == newer.pk


def test_foreign_base_citations_and_unconfirmed_assignments_are_rejected():
    user, record, _, base = fixture()
    _, foreign_record, _, foreign = fixture()
    assert foreign_record.pk != record.pk
    with pytest.raises(RecordConflict):
        service.save_review(record.pk, user, uuid.uuid4(), payload(foreign))
    bad = payload(base)
    bad["content"]["decisions"][0]["source_refs"][0]["segment_id"] = str(uuid.uuid4())
    with pytest.raises(ValueError):
        service.save_review(record.pk, user, uuid.uuid4(), bad)
    bad = payload(base)
    bad["content"]["action_items"][0]["assignee_id"] = str(user.pk)
    with pytest.raises(ValueError):
        service.save_review(record.pk, user, uuid.uuid4(), bad)
    assert not record.summary_reviews.exists()


def test_reader_can_view_but_not_edit_and_flag_off_keeps_history(settings):
    user, record, _, base = fixture()
    saved, _, _ = service.save_review(record.pk, user, uuid.uuid4(), payload(base))
    reader = UserFactory()
    models.MeetingRecordAccess.objects.create(
        record=record, user=reader, read_summary=True
    )
    url = f"/api/v1.0/meeting-records/{record.pk}/human-summary/"
    response = client_for(reader).get(url)
    assert response.status_code == 200 and response.json()["current"]["id"] == str(
        saved.pk
    )
    assert response.json()["can_edit"] is False
    assert (
        client_for(reader)
        .post(
            url, {"key": str(uuid.uuid4()), **payload(base, revision=1)}, format="json"
        )
        .status_code
        == 403
    )
    assert client_for(UserFactory()).get(url).status_code == 404
    settings.MEETING_SUMMARY_REVIEW_ENABLED = False
    response = client_for(user).get(url)
    assert response.status_code == 200 and not response.json()["can_edit"]
    assert response.json()["current"]["origin"] == "human"


def test_api_validates_and_revoked_manager_cannot_replay():
    user, record, _, base = fixture()
    url = f"/api/v1.0/meeting-records/{record.pk}/human-summary/"
    body = {"key": str(uuid.uuid4()), **payload(base)}
    client = client_for(user)
    assert client.post(url, body, format="json").status_code == 200
    assert client.post(url, body, format="json").json()["replayed"]
    assert (
        client.post(url, {**body, "unsupported": True}, format="json").status_code
        == 400
    )
    models.ResourceAccess.objects.filter(
        resource_id=record.meeting_session.room_id, user=user
    ).delete()
    assert client.post(url, body, format="json").status_code == 404


@pytest.mark.django_db(transaction=True)
def test_concurrent_edits_cannot_overwrite_each_other():
    user, record, _, base = fixture()
    barrier = Barrier(2)

    def save():
        close_old_connections()
        try:
            barrier.wait(timeout=5)
            service.save_review(record.pk, user, uuid.uuid4(), payload(base))
            return "saved"
        except RecordConflict:
            return "conflict"
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: save(), range(2)))
    assert sorted(results) == ["conflict", "saved"]
    assert record.summary_reviews.count() == 1


def test_history_is_bounded_read_only_and_record_scoped(settings):
    user, record, _, base = fixture()
    for revision in range(12):
        service.save_review(
            record.pk, user, uuid.uuid4(), payload(base, revision=revision)
        )
    client = client_for(user)
    url = f"/api/v1.0/meeting-records/{record.pk}/human-summary/history/"
    first = client.get(url).json()
    assert [row["revision"] for row in first["results"]] == list(range(12, 2, -1))
    assert first["next_before"] == 3
    assert "content" not in first["results"][0]
    second = client.get(url, {"before": 3}).json()
    assert [row["revision"] for row in second["results"]] == [2, 1]
    assert second["next_before"] is None
    review_id = second["results"][1]["id"]
    detail_url = f"{url}{review_id}/"
    settings.MEETING_SUMMARY_REVIEW_ENABLED = False
    detail = client.get(detail_url).json()
    assert detail["revision"] == 1 and detail["origin"] == "human"
    assert detail["input_snapshot_id"] == str(base.input_snapshot_id)
    assert client.post(detail_url, {}, format="json").status_code == 405
    assert client.get(url, {"before": "invalid"}).status_code == 400
    _, _, _, other_record = online_note(user=user, room=record.meeting_session.room)
    other_url = f"/api/v1.0/meeting-records/{other_record.pk}/human-summary/history/{review_id}/"
    assert client.get(other_url).status_code == 404
    models.ResourceAccess.objects.filter(
        resource_id=record.meeting_session.room_id, user=user
    ).delete()
    assert client.get(detail_url).status_code == 404
