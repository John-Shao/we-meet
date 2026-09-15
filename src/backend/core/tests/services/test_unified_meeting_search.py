"""Qwen migration, current sources and live meeting access; no provider calls."""

import copy
import uuid
from datetime import timedelta
from unittest.mock import Mock, patch

import pytest
from rest_framework.exceptions import PermissionDenied

from core import models
from core.factories import UserFactory
from core.services.global_ask import GlobalAskService
from core.services.meeting_search import recall_records
from core.tests.services.test_capture_transcription import (
    enabled as enabled,
    running,
    final,
    acknowledge,
    finish,
)
from core.tests.services.test_meeting_records import online_note
from core.tests.services.test_meeting_summary_review import fixture
from core.tests.test_api_search_ask import _room_with_chunk, _fake_llm

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def summary_enabled(settings):
    settings.MEETING_VERSIONED_SUMMARY_ENABLED = True
    settings.MEETING_SUMMARY_REVIEW_ENABLED = True
    settings.DASHSCOPE_API_KEY = "test-provider"
    settings.JUSI_IM_CONFIGURATION = {}


def test_online_sources_use_record_permissions_and_date_range():
    owner, _, _, record = online_note(text="budget approved")
    reader = UserFactory()
    grant = models.MeetingRecordAccess.objects.create(
        record=record, user=reader, read_summary=True
    )
    assert recall_records(reader, ["budget"], []) == []
    grant.read_transcript = True
    grant.save()
    citations = []
    assert recall_records(reader, ["budget"], citations)
    assert citations[0]["record_id"] == str(record.pk)
    assert citations[0]["ability"] == "read_transcript"
    assert (
        recall_records(
            reader,
            ["budget"],
            [],
            date_from=record.origin_at.date() + timedelta(days=1),
        )
        == []
    )
    grant.delete()
    assert recall_records(reader, ["budget"], []) == []
    assert recall_records(owner, ["budget"], [])


def test_native_originals_only_recalled_after_publication():
    owner, capture, worker, job = running()
    assert final(job["id"], worker, text="release confirmed")[0].status_code == 201
    assert recall_records(owner, ["release"], []) == []
    acknowledge(job, worker)
    assert finish(job["id"], worker).data["status"] == "succeeded"
    citations = []
    assert recall_records(owner, ["release"], citations)
    assert citations[0]["record_id"] == str(capture.record_id)
    assert citations[0]["start_ms"] == 0


def test_review_replaces_old_ai_wording_in_search():
    owner, record, _, base = fixture()
    content = copy.deepcopy(base.content)
    content["overview"] = "corrected_unique_decision"
    review = models.MeetingSummaryReview.objects.create(
        record=record,
        base_summary=base,
        author=owner,
        revision=1,
        key=uuid.uuid4(),
        request_hash="a" * 64,
        content=content,
    )
    reader = UserFactory()
    models.MeetingRecordAccess.objects.create(
        record=record, user=reader, read_summary=True
    )
    citations = []
    assert recall_records(reader, ["corrected_unique_decision"], citations)
    assert citations[0]["ability"] == "read_summary"
    assert "人工纪要" in citations[0]["snippet"]
    replacement = copy.deepcopy(content)
    replacement["overview"] = "latest_unique_decision"
    models.MeetingSummaryReview.objects.create(
        record=record,
        base_summary=base,
        author=owner,
        revision=2,
        previous=review,
        key=uuid.uuid4(),
        request_hash="b" * 64,
        content=replacement,
    )
    assert recall_records(reader, ["corrected_unique_decision"], []) == []
    assert recall_records(reader, ["latest_unique_decision"], [])


def test_meeting_scope_does_not_query_im_or_calendar():
    owner, _, _, _ = online_note(text="budget approved")
    service = GlobalAskService(scope="meetings", llm=_fake_llm())
    with (
        patch.object(service, "_recall_im") as im,
        patch.object(service, "_recall_calendar") as calendar,
    ):
        result = service.ask(user=owner, question="budget")
    im.assert_not_called()
    calendar.assert_not_called()
    assert result["sources"]["records"] == "ok"
    assert all(c["kind"] == "meeting" for c in result["citations"])


def test_old_embeddings_keep_lexical_recall_without_qwen_vector_call():
    user = UserFactory()
    _room_with_chunk(user, text="budget approved")
    embed = Mock(model="text-embedding-v4")
    service = GlobalAskService(scope="meetings", embed=embed, llm=_fake_llm())
    with patch("core.services.global_ask.vector_rank") as vector:
        citations = []
        assert service._recall_transcripts(user, "budget", citations)
    embed.embed.assert_not_called()
    vector.assert_not_called()


@pytest.mark.parametrize("streaming", [False, True])
def test_revoke_during_generation_discards_answer(streaming):
    _, _, _, record = online_note(text="budget approved")
    reader = UserFactory()
    grant = models.MeetingRecordAccess.objects.create(
        record=record, user=reader, read_transcript=True
    )
    llm = _fake_llm()

    def revoke(**kwargs):
        grant.delete()
        return "secret answer"

    llm.chat.side_effect = revoke

    def stream(**kwargs):
        grant.delete()
        yield "secret answer"

    llm.chat_stream.side_effect = stream
    service = GlobalAskService(scope="meetings", llm=llm)
    if streaming:
        events = list(service.ask_stream(user=reader, question="budget"))
        assert events[-1]["type"] == "error"
        assert not any(event["type"] == "delta" for event in events)
    else:
        with pytest.raises(PermissionDenied):
            service.ask(user=reader, question="budget")


@pytest.mark.parametrize(
    "payload",
    [
        {"scope": "unknown"},
        {"date_from": "invalid"},
        {"date_from": "2026-09-15", "date_to": "2026-09-14"},
    ],
)
def test_filters_validate_before_search(payload):
    from core.api.search import GlobalAskSerializer

    assert not GlobalAskSerializer(data={"question": "budget", **payload}).is_valid()
