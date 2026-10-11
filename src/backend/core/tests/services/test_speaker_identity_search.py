"""Search current confirmed names while preserving source and access boundaries."""

import uuid

import pytest

from core import models
from core.factories import MembershipFactory, UserFactory
from core.services.meeting_search import CONTEXT_CHARS, recall_records
from core.tests.services.test_meeting_records import client_for, online_note
from core.tests.services.test_speaker_attribution import org_record
from core.tests.services.test_speaker_identity_decisions import decide

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def enabled(settings):
    settings.MEETING_RECORDS_ENABLED = True
    settings.MEETING_CAPTURE_PROTOCOL_ENABLED = True
    settings.CELERY_ENABLED = False


def assert_search(owner, record, name, *, found=True):
    citations = []
    entries = recall_records(owner, [name], citations)
    path = f"/api/v1.0/meeting-records/{record.pk}/original-segments/"
    response = client_for(owner).get(path, {"q": name})
    assert response.status_code == 200, response.data
    assert bool(entries) is found
    assert bool(response.data["results"]) is found
    if found:
        assert entries[0].split("》", 1)[1].startswith(f"{name}：")
        assert citations[0]["snippet"].startswith(f"{name}：")
        assert response.data["results"][0]["speaker_label"] == name


@pytest.mark.parametrize("contact", [False, True])
def test_identity_edit_and_clear_immediately_refresh_both_search_paths(contact):
    owner, record, speaker, organization = org_record()
    old_revision = record.revision
    name = "张敏" if contact else "访谈嘉宾"
    if contact:
        member = MembershipFactory(organization=organization, user__full_name=name).user
        response = decide(
            owner, record, speaker, "select_contact", contact_ref=f"member:{member.pk}"
        )
    else:
        response = decide(owner, record, speaker, "set_label", label=name)
    assert response.status_code == 200, response.data
    assert_search(owner, record, name)
    assert_search(owner, record, "Speaker 1", found=False)
    path = f"/api/v1.0/meeting-records/{record.pk}/original-segments/"
    assert (
        client_for(owner)
        .get(path, {"q": name, "expected_revision": old_revision})
        .status_code
        == 409
    )

    assert (
        decide(owner, record, speaker, "set_label", label="新标签").status_code == 200
    )
    assert_search(owner, record, name, found=False)
    assert_search(owner, record, "新标签")
    assert decide(owner, record, speaker, "clear").status_code == 200
    assert_search(owner, record, "新标签", found=False)
    assert_search(owner, record, "Speaker 1")
    speaker.refresh_from_db()
    assert speaker.label == "Speaker 1"
    assert record.original_segments.get().text == "We shipped it."


def test_account_contact_details_are_not_searchable_speaker_names():
    owner, record, speaker, organization = org_record()
    member = MembershipFactory(
        organization=organization, user__full_name="", user__short_name=""
    ).user
    assert (
        decide(
            owner, record, speaker, "select_contact", contact_ref=f"member:{member.pk}"
        ).status_code
        == 200
    )
    assert_search(owner, record, member.email, found=False)
    assert_search(owner, record, "Speaker 1")


@pytest.mark.parametrize("summary_only", [False, True])
def test_confirmed_names_do_not_widen_transcript_access(summary_only):
    owner, record, speaker, _ = org_record()
    assert (
        decide(owner, record, speaker, "set_label", label="访谈嘉宾").status_code == 200
    )
    outsider = UserFactory()
    path = f"/api/v1.0/meeting-records/{record.pk}/original-segments/"
    assert recall_records(outsider, ["访谈嘉宾"], []) == []
    assert client_for(outsider).get(path, {"q": "访谈嘉宾"}).status_code == 404
    membership = MembershipFactory(organization=record.organization)
    reader = membership.user
    if summary_only:
        models.MeetingRecordAccess.objects.create(
            record=record, user=reader, read_summary=True
        )
    assert recall_records(reader, ["访谈嘉宾"], []) == []
    assert client_for(reader).get(path, {"q": "访谈嘉宾"}).status_code == (
        403 if summary_only else 404
    )
    grant = (
        models.MeetingRecordAccess.objects.create(
            record=record, user=reader, read_transcript=True
        )
        if not summary_only
        else models.MeetingRecordAccess.objects.get(record=record, user=reader)
    )
    grant.read_transcript = True
    grant.save()
    assert_search(reader, record, "访谈嘉宾")
    membership.status = models.MembershipStatusChoices.LEFT
    membership.save(update_fields=["status"])
    assert recall_records(reader, ["访谈嘉宾"], []) == []
    assert client_for(reader).get(path, {"q": "访谈嘉宾"}).status_code == 404
    membership.status = models.MembershipStatusChoices.ACTIVE
    membership.save(update_fields=["status"])
    grant.delete()
    assert recall_records(reader, ["访谈嘉宾"], []) == []


def test_same_words_from_distinct_confirmed_speakers_keep_both_attributions():
    owner, record, speaker, _ = org_record()
    assert (
        decide(owner, record, speaker, "set_label", label="嘉宾甲").status_code == 200
    )
    original = record.original_segments.get()
    other = models.MeetingSpeaker.objects.create(
        record=record,
        capture_session=original.capture_session,
        source_track_id="second-track",
        source_key="1",
        label="Speaker 2",
        identity_type="diarized",
    )
    models.MeetingOriginalSegment.objects.create(
        record=record,
        capture_session=original.capture_session,
        speaker=other,
        ingest_id=uuid.uuid4(),
        source_track_id="second-track",
        source_sequence=1,
        start_ms=1000,
        end_ms=2000,
        text=original.text,
        payload_hash="1" * 64,
    )
    assert decide(owner, record, other, "set_label", label="嘉宾乙").status_code == 200
    citations = []
    entries = recall_records(owner, ["shipped"], citations)
    assert len(entries) == 2
    assert {c["snippet"].split("：", 1)[0] for c in citations} == {"嘉宾甲", "嘉宾乙"}
    assert {c["start_ms"] for c in citations} == {0, 1000}


def test_long_evidence_keeps_name_match_clock_and_context_budget():
    owner, _, transcript, record = online_note(
        text="Preamble. " * 150 + "retention is 7 days"
    )
    transcript.speaker_name = "具名参会者"
    transcript.save(update_fields=["speaker_name"])
    citations = []
    entries = recall_records(owner, ["retention"], citations)
    body = entries[0].split("》", 1)[1]
    assert body.startswith("具名参会者：") and "retention is 7 days" in body
    assert len(body) <= CONTEXT_CHARS and citations[0]["start_ms"] == 0
    assert recall_records(owner, ["具名参会者"], [])
    path = f"/api/v1.0/meeting-records/{record.pk}/transcripts/"
    assert [
        row["id"]
        for row in client_for(owner).get(path, {"q": "具名参会者"}).data["results"]
    ] == [str(transcript.pk)]
