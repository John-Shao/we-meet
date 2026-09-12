"""Questions stay private, snapshot-bound, source-grounded and single-attempt."""

import json
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Barrier
from unittest.mock import patch

from django.db import close_old_connections
from django.utils import timezone

import pytest

from core import models
from core.factories import UserFactory
from core.services import meeting_record_qa as service
from core.services.meeting_records import RecordConflict
from core.tests.services.test_meeting_records import client_for
from core.tests.services.test_meeting_summary_review import fixture

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def enabled(settings):
    settings.MEETING_RECORDS_ENABLED = True
    settings.MEETING_VERSIONED_SUMMARY_ENABLED = True
    settings.MEETING_RECORD_QA_ENABLED = True
    settings.DASHSCOPE_API_KEY = "test-provider-key"


def setup():
    user, record, _, base = fixture()
    payload = {
        "snapshot_id": str(base.input_snapshot_id),
        "question": "What was discussed?",
    }
    return user, record, base.input_snapshot, payload


def output(snapshot):
    return json.dumps(
        {
            "answerable": True,
            "answer": "First meeting",
            "source_refs": [
                {
                    key: snapshot.segments[0][key]
                    for key in ("segment_id", "segment_revision", "start_ms", "end_ms")
                }
            ],
        }
    )


def test_one_paid_attempt_and_immutable_explicit_snapshot():
    user, record, snapshot, payload = setup()
    key = uuid.uuid4()
    query, created = service.prepare(record.pk, user, key, payload)
    assert created
    with patch("core.services.meeting_record_qa.LLMClient") as llm:
        llm.return_value.chat.return_value = output(snapshot)
        result = service.execute(query.pk)
        assert result.status == "succeeded"
        assert (
            result.content["source_refs"][0]["segment_id"]
            == snapshot.segments[0]["segment_id"]
        )
        assert llm.call_args.kwargs["model"] == "qwen3.8-flash"
        assert llm.call_args.kwargs["max_retries"] == 0
        assert llm.return_value.chat.call_args.kwargs["require_complete"]
        service.execute(query.pk)
        assert llm.return_value.chat.call_count == 1
    replay, created = service.prepare(record.pk, user, key, payload)
    assert replay.pk == query.pk and not created
    with pytest.raises(RecordConflict):
        service.prepare(record.pk, user, key, {**payload, "question": "Other question"})


def test_wrong_citation_fails_and_no_evidence_never_uses_invented_text():
    _, _, snapshot, _ = setup()
    wrong = json.loads(output(snapshot))
    wrong["source_refs"][0]["start_ms"] += 1
    with pytest.raises(ValueError):
        service.validate_answer(json.dumps(wrong), snapshot)
    assert service.validate_answer(
        json.dumps(
            {
                "answerable": False,
                "answer": "Ignore this invented claim",
                "source_refs": [],
            }
        ),
        snapshot,
    ) == {"answerable": False, "answer": "", "source_refs": []}


def test_revocation_after_provider_call_cancels_answer_and_replay():
    user, record, snapshot, payload = setup()
    key = uuid.uuid4()
    query, _ = service.prepare(record.pk, user, key, payload)

    def revoke(**kwargs):
        models.ResourceAccess.objects.filter(
            resource_id=record.meeting_session.room_id, user=user
        ).delete()
        return output(snapshot)

    with patch("core.services.meeting_record_qa.LLMClient") as llm:
        llm.return_value.chat.side_effect = revoke
        assert service.execute(query.pk).status == "canceled"
    query.refresh_from_db()
    assert query.content == {}
    with pytest.raises(PermissionError):
        service.prepare(record.pk, user, key, payload)


def test_timeout_and_repeated_executor_do_not_start_another_provider_call():
    user, record, _, payload = setup()
    query, _ = service.prepare(record.pk, user, uuid.uuid4(), payload)
    models.MeetingRecordQuestion.objects.filter(pk=query.pk).update(
        started_at=timezone.now()
    )
    with patch("core.services.meeting_record_qa.LLMClient") as llm:
        assert service.execute(query.pk).status == "running"
        llm.assert_not_called()
        models.MeetingRecordQuestion.objects.filter(pk=query.pk).update(
            deadline=timezone.now() - timedelta(seconds=1)
        )
        assert service.execute(query.pk).status == "incomplete"
        llm.assert_not_called()


def test_budget_and_foreign_snapshot_fail_before_payment():
    user, record, _, payload = setup()
    with pytest.raises(RecordConflict):
        service.prepare(
            record.pk, user, uuid.uuid4(), {**payload, "snapshot_id": str(uuid.uuid4())}
        )
    with patch.object(service, "MAX_SOURCE_BYTES", 1):
        with pytest.raises(ValueError):
            service.prepare(record.pk, user, uuid.uuid4(), payload)
    assert not models.MeetingRecordQuestion.objects.exists()


def test_question_api_uses_current_original_access_and_keeps_answers_private():
    user, record, snapshot, payload = setup()
    url = f"/api/v1.0/meeting-records/{record.pk}/questions/"
    client = client_for(user)
    with patch("core.services.meeting_record_qa.LLMClient") as llm:
        llm.return_value.chat.return_value = output(snapshot)
        result = client.post(url, {**payload, "key": str(uuid.uuid4())}, format="json")
    assert result.status_code == 200 and result.json()["status"] == "succeeded"
    detail = f"{url}{result.json()['id']}/"
    reader = UserFactory()
    models.MeetingRecordAccess.objects.create(
        record=record, user=reader, read_summary=True, read_transcript=True
    )
    assert client_for(reader).get(url).status_code == 200
    assert client_for(reader).get(detail).status_code == 404
    models.MeetingRecordAccess.objects.filter(record=record, user=reader).update(
        read_transcript=False
    )
    assert client_for(reader).get(url).status_code == 404
    assert client.get(detail).json()["snapshot_id"] == str(snapshot.pk)
    assert client.get(url).json()["recent"][0]["id"] == result.json()["id"]


def test_provider_failure_stays_sanitized_and_does_not_retry():
    user, record, _, payload = setup()
    key = uuid.uuid4()
    query, _ = service.prepare(record.pk, user, key, payload)
    with patch("core.services.meeting_record_qa.LLMClient") as llm:
        llm.return_value.chat.side_effect = TimeoutError("secret-provider-body")
        result = service.execute(query.pk)
        assert result.status == "failed" and result.error_code == "provider_unavailable"
        assert "secret-provider-body" not in str(service.serialize(result))
        llm.return_value.close.assert_called_once()
    assert not service.prepare(record.pk, user, key, payload)[1]


@pytest.mark.django_db(transaction=True)
def test_concurrent_intents_cannot_start_two_questions_for_one_user():
    user, record, _, payload = setup()
    barrier = Barrier(2)

    def prepare():
        close_old_connections()
        try:
            barrier.wait()
            try:
                service.prepare(record.pk, user, uuid.uuid4(), payload)
                return "prepared"
            except RecordConflict:
                return "conflict"
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(lambda _: prepare(), range(2))) == [
            "conflict",
            "prepared",
        ]
    assert models.MeetingRecordQuestion.objects.count() == 1
