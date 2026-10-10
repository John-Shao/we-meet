"""Identity notices are live metadata over immutable summary evidence."""

import copy
import uuid
from unittest.mock import patch

import pytest

from core import models
from core.factories import UserFactory
from core.services import (
    meeting_summary_exports,
    meeting_summary_review,
    meeting_summary_tasks,
    speaker_identity_decisions,
    transcript_corrections,
)
from core.services.meeting_records import bump_record_source
from core.tests.services.test_capture_summary import enabled, published
from core.tests.services.test_meeting_records import client_for
from core.tests.services.test_meeting_summary_review import generated, payload

pytestmark = pytest.mark.django_db


def source():
    owner, capture, _ = published()
    original = capture.record.original_segments.get()
    # Seed a diarized fixture; publication/integrity of the ASR text remains real.
    models.MeetingSpeaker.objects.filter(pk=original.speaker_id).update(
        identity_type="diarized"
    )
    speaker = models.MeetingSpeaker.objects.get(pk=original.speaker_id)
    return owner, capture.record, original, speaker


def versions(user, record, version=None):
    response = client_for(user).get(
        f"/api/v1.0/meeting-records/{record.pk}/summary-versions/",
        {"version_id": str(version.pk)} if version else {},
    )
    assert response.status_code == 200, response.data
    return response.data["results"]


@pytest.mark.parametrize("action", ["set_label", "select_contact", "clear"])
def test_identity_change_preserves_minutes_and_citations_until_explicit_regeneration(
    action,
):
    owner, record, original, speaker = source()
    if action == "clear":
        speaker_identity_decisions.decide(
            record, speaker.pk, owner, action="set_label", label="原姓名"
        )
    old = generated(record)
    old_content = copy.deepcopy(old.content)
    old_segments = copy.deepcopy(old.input_snapshot.segments)
    assert not versions(owner, record, old)[0]["identity_updated"]
    payload = (
        {"label": "新姓名"}
        if action == "set_label"
        else {"contact_ref": f"member:{owner.pk}"}
        if action == "select_contact"
        else {}
    )
    if action == "select_contact":
        owner.full_name = "已确认成员"
        owner.save(update_fields=["full_name"])
    with patch("core.services.meeting_summary_versions.LLMClient") as provider:
        speaker_identity_decisions.decide(
            record, speaker.pk, owner, action=action, **payload
        )
        provider.assert_not_called()
    row = versions(owner, record, old)[0]
    assert row["identity_updated"] and not row["is_current"]
    assert row["content"] == old_content
    snapshot = client_for(owner).get(
        f"/api/v1.0/meeting-records/{record.pk}/transcript-versions/{old.input_snapshot_id}/"
    )
    assert snapshot.data["segments"] == old_segments
    original.refresh_from_db()
    assert original.text == old_segments[0]["text"]
    assert record.summary_versions.count() == 1
    newer = generated(record, regenerate=True)
    speaker.refresh_from_db()
    assert newer.input_snapshot.segments[0]["speaker_name"] == speaker.display_name
    assert not versions(owner, record, newer)[0]["identity_updated"]
    assert versions(owner, record, old)[0]["identity_updated"]
    old.refresh_from_db()
    old.input_snapshot.refresh_from_db()
    assert old.content == old_content and old.input_snapshot.segments == old_segments


def test_correction_and_rejected_suggestion_do_not_claim_identity_changed():
    owner, record, original, speaker = source()
    old = generated(record)
    transcript_corrections.correct(record, original.pk, owner, text="正文修订")
    record.refresh_from_db()
    bump_record_source(record)
    models.SpeakerIdentityDecision.objects.create(
        record=record,
        speaker=speaker,
        actor=owner,
        action="reject_suggestion",
        previous_kind="none",
        selected_kind="none",
        record_revision=record.revision,
    )
    row = versions(owner, record, old)[0]
    assert not row["is_current"] and not row["identity_updated"]


def test_member_name_change_is_detected_without_new_identity_decision():
    owner, record, _, speaker = source()
    owner.full_name = "旧成员姓名"
    owner.save(update_fields=["full_name"])
    speaker_identity_decisions.decide(
        record,
        speaker.pk,
        owner,
        action="select_contact",
        contact_ref=f"member:{owner.pk}",
    )
    old = generated(record)
    owner.full_name = "新成员姓名"
    owner.save(update_fields=["full_name"])
    row = versions(owner, record, old)[0]
    assert row["identity_updated"] and not row["is_current"]
    assert old.input_snapshot.segments[0]["speaker_name"] == "旧成员姓名"


def test_summary_only_notice_does_not_disclose_updated_identity_or_snapshot():
    owner, record, _, speaker = source()
    old = generated(record)
    speaker_identity_decisions.decide(
        record, speaker.pk, owner, action="set_label", label="私有新姓名"
    )
    reader = UserFactory()
    grant = models.MeetingRecordAccess.objects.create(
        record=record, user=reader, read_summary=True
    )
    row = versions(reader, record, old)[0]
    assert row["identity_updated"] and "私有新姓名" not in str(row)
    assert "segments" not in row
    path = f"/api/v1.0/meeting-records/{record.pk}/transcript-versions/{old.input_snapshot_id}/"
    assert client_for(reader).get(path).status_code == 403
    grant.delete()
    assert (
        client_for(reader)
        .get(f"/api/v1.0/meeting-records/{record.pk}/summary-versions/")
        .status_code
        == 404
    )


def test_identity_change_keeps_document_receipt_payload_and_confirmed_task_assignee(
    settings,
):
    settings.MEETING_SUMMARY_REVIEW_ENABLED = True
    settings.MEETING_SUMMARY_TASKS_ENABLED = True
    settings.MEETING_SUMMARY_EXPORT_ENABLED = True
    settings.DOCS_CONFIGURATION = {
        "api_url": "https://docs.invalid",
        "server_to_server_token": "fixture",
    }
    owner, record, _, speaker = source()
    old = generated(record)
    review, _, _ = meeting_summary_review.save_review(
        record.pk, owner, uuid.uuid4(), payload(old)
    )
    link, created = meeting_summary_tasks.convert(
        record.pk,
        owner,
        uuid.uuid4(),
        {
            "review_id": str(review.pk),
            "action_index": 0,
            "title": "已确认任务",
            "assignee_id": str(owner.pk),
            "due_date": "2026-10-01",
        },
    )
    assert created
    selection = {"source_kind": "human", "source_id": str(review.pk), "language": "zh"}
    _, _, rendered = meeting_summary_exports.render_payload(record, owner, selection)
    with patch.object(meeting_summary_exports, "_dispatch", return_value=False):
        export, _ = meeting_summary_exports.request_export(
            record.pk,
            owner,
            uuid.uuid4(),
            selection,
            meeting_summary_exports.digest(rendered),
        )
    # Simulate a completed external receipt without contacting a document service.
    export.status, export.document_id = "ready", uuid.uuid4()
    export.save(update_fields=["status", "document_id"])
    frozen = copy.deepcopy(export.payload), export.payload_hash, export.document_id
    confirmed = copy.deepcopy(link.confirmed)
    speaker_identity_decisions.decide(
        record, speaker.pk, owner, action="set_label", label="更正姓名"
    )
    export.refresh_from_db()
    link.refresh_from_db()
    link.task.refresh_from_db()
    review.refresh_from_db()
    assert (export.payload, export.payload_hash, export.document_id) == frozen
    assert export.status == "ready" and record.document_exports.count() == 1
    assert link.confirmed == confirmed and link.task.assignee_id == owner.pk
    assert models.Task.objects.count() == 1
    assert versions(owner, record, old)[0]["identity_updated"]


def test_identity_notice_survives_current_source_becoming_unavailable(settings):
    owner, record, _, speaker = source()
    old = generated(record)
    speaker_identity_decisions.decide(
        record, speaker.pk, owner, action="set_label", label="更正姓名"
    )
    settings.MEETING_CAPTURE_SUMMARY_ENABLED = False
    row = versions(owner, record, old)[0]
    assert row["identity_updated"] and not row["is_current"]
    assert row["content"] == old.content
