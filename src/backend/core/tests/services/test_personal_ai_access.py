"""Personal AI must honor live record access even while a provider is running."""

from datetime import timedelta
from unittest import mock

from django.utils import timezone

import pytest
from rest_framework.exceptions import PermissionDenied

from core import models
from core.factories import (
    MembershipFactory,
    OrganizationFactory,
    RoomFactory,
    UserFactory,
)
from core.services.meeting_records import ensure_online_record, visible_records
from core.services.personal_ai import PersonalAIService

pytestmark = pytest.mark.django_db


@pytest.fixture
def material():
    org = OrganizationFactory()
    reader = UserFactory()
    membership = MembershipFactory(organization=org, user=reader)
    room = RoomFactory(organization=org)
    room.users.add(reader)
    session = models.MeetingSession.objects.create(
        room=room, livekit_room_sid="RM_personal_access", started_at=timezone.now()
    )
    summary = models.Summary.objects.create(
        room=room,
        session=session,
        status=models.Summary.Status.SUCCESS,
        content="summary",
        model_used="fixture",
        transcripts_count=1,
    )
    chunk = models.TranscriptChunk.objects.create(
        room=room,
        session=session,
        summary=summary,
        chunk_index=0,
        text="private budget decision",
        started_at=timezone.now(),
        embedding=[1.0, 0.0],
        embedding_model="fixture-embed",
    )
    record, _ = ensure_online_record(session)
    return reader, membership, room, record, chunk


def service():
    embed = mock.Mock(model="fixture-embed")
    embed.embed.return_value = [1.0, 0.0]
    llm = mock.Mock(model="fixture-llm")
    llm.chat.return_value = "private answer"
    llm.chat_stream.return_value = iter(["private answer"])
    return PersonalAIService(embed=embed, llm=llm), llm


def revoke(record, reader):
    models.MeetingCollaborator.objects.update_or_create(
        record=record, scope="record", user=reader, defaults={"role": "none"}
    )


@pytest.mark.parametrize("records_enabled", [False, True])
def test_record_revocation_overrides_retained_room_membership(
    material, settings, records_enabled
):
    settings.MEETING_RECORDS_ENABLED = records_enabled
    reader, _, room, record, _ = material
    revoke(record, reader)
    assert room.users.filter(pk=reader.pk).exists()
    assert (
        not visible_records(reader, ability="read_transcript")
        .filter(pk=record.pk)
        .exists()
    )
    ai, llm = service()
    assert ai.ask(user=reader, question="budget")["chunks_used"] == 0
    llm.chat.assert_not_called()


def test_record_share_does_not_require_room_membership(material):
    _, membership, _, record, _ = material
    reader = UserFactory()
    MembershipFactory(user=reader, organization=membership.organization)
    models.MeetingCollaborator.objects.create(
        record=record, user=reader, scope="record", role="reader"
    )
    ai, llm = service()
    assert ai.ask(user=reader, question="budget")["chunks_used"] == 1
    assert "private budget decision" in llm.chat.call_args.kwargs["system"]


@pytest.mark.parametrize(
    "change", ["trash", "membership", "disabled", "wrong_room", "missing_session"]
)
def test_unreadable_or_misattributed_chunks_are_excluded(material, change):
    reader, membership, _, record, chunk = material
    if change == "trash":
        models.MeetingRecord.objects.filter(pk=record.pk).update(
            deleted_at=timezone.now()
        )
    elif change == "membership":
        membership.delete()
    elif change == "disabled":
        models.User.objects.filter(pk=reader.pk).update(is_active=False)
    elif change == "wrong_room":
        models.TranscriptChunk.objects.filter(pk=chunk.pk).update(room=RoomFactory())
    else:
        # A damaged/backfilled chunk must not evade a record policy via NULL session.
        models.TranscriptChunk.objects.filter(pk=chunk.pk).update(session=None)
        revoke(record, reader)
    ai, llm = service()
    assert ai.ask(user=reader, question="budget")["chunks_used"] == 0
    llm.chat.assert_not_called()


def test_sync_answer_is_withheld_if_permission_changes_during_provider_call(material):
    reader, _, _, record, _ = material
    ai, llm = service()

    def answer(**_kwargs):
        revoke(record, reader)
        return "private answer"

    llm.chat.side_effect = answer
    with pytest.raises(PermissionDenied):
        ai.ask(user=reader, question="budget")


def test_revocation_during_retrieval_prevents_sending_context_to_provider(material):
    reader, _, _, record, _ = material
    ai, llm = service()

    def embed(*_args):
        revoke(record, reader)
        return [1.0, 0.0]

    with mock.patch("core.services.personal_ai.cached_embed", side_effect=embed):
        with pytest.raises(PermissionDenied):
            ai.ask(user=reader, question="budget")
    llm.chat.assert_not_called()


def test_stream_does_not_complete_after_revocation_on_last_provider_read(material):
    reader, _, _, record, _ = material
    ai, llm = service()

    def provider():
        yield "allowed"
        revoke(record, reader)

    llm.chat_stream.return_value = provider()
    events = ai.ask_stream(user=reader, question="budget")
    assert next(events)["type"] == "meta"
    assert next(events)["type"] == "delta"
    with pytest.raises(PermissionDenied):
        next(events)


def test_stream_rechecks_after_meta_before_starting_provider(material):
    reader, _, _, record, _ = material
    ai, llm = service()
    events = ai.ask_stream(user=reader, question="budget")
    assert next(events)["type"] == "meta"
    revoke(record, reader)
    with pytest.raises(PermissionDenied):
        next(events)
    llm.chat_stream.assert_not_called()


def test_stream_withholds_late_delta_and_closes_provider(material):
    reader, _, _, record, _ = material
    ai, llm = service()
    closed = []

    def provider():
        try:
            yield "allowed"
            revoke(record, reader)
            yield "must not leave the server"
        finally:
            closed.append(True)

    llm.chat_stream.return_value = provider()
    events = ai.ask_stream(user=reader, question="budget")
    assert next(events)["type"] == "meta"
    assert next(events) == {"type": "delta", "text": "allowed"}
    with pytest.raises(PermissionDenied):
        next(events)
    assert closed == [True]


def test_client_disconnect_closes_provider(material):
    reader, *_ = material
    ai, llm = service()
    closed = []

    def provider():
        try:
            yield "allowed"
            yield "unused"
        finally:
            closed.append(True)

    llm.chat_stream.return_value = provider()
    events = ai.ask_stream(user=reader, question="budget")
    next(events)
    next(events)
    events.close()
    assert closed == [True]


def test_candidate_limit_is_applied_before_loading_vectors(material, settings):
    reader, _, _, _, chunk = material
    settings.PERSONAL_AI_MAX_CHUNKS = 2
    newest = []
    for index in range(1, 5):
        newest.append(
            models.TranscriptChunk.objects.create(
                room_id=chunk.room_id,
                session_id=chunk.session_id,
                summary_id=chunk.summary_id,
                chunk_index=index,
                text=f"budget decision {index}",
                started_at=chunk.started_at + timedelta(minutes=index),
                embedding=[1.0, 0.0],
                embedding_model="fixture-embed",
            )
        )
    ai, _ = service()
    with mock.patch.object(ai, "_retrieve", wraps=ai._retrieve) as retrieve:
        answer = ai.ask(user=reader, question="budget")
    loaded = retrieve.call_args.args[2]
    assert [item.pk for item in loaded] == [newest[-1].pk, newest[-2].pk]
    assert answer["chunks_used"] == 2


def test_other_occurrence_in_same_room_cannot_bypass_record_policy(material):
    reader, _, room, record, chunk = material
    models.MeetingSession.objects.filter(pk=chunk.session_id).update(
        status="ended", ended_at=timezone.now(), end_reason="room_finished"
    )
    session = models.MeetingSession.objects.create(
        room=room, livekit_room_sid="RM_second_occurrence", started_at=timezone.now()
    )
    summary = models.Summary.objects.create(
        room=room,
        session=session,
        status=models.Summary.Status.SUCCESS,
        content="summary",
        model_used="fixture",
        transcripts_count=1,
    )
    models.TranscriptChunk.objects.create(
        room=room,
        session=session,
        summary=summary,
        chunk_index=0,
        text="allowed second occurrence",
        started_at=timezone.now(),
        embedding=[1.0, 0.0],
        embedding_model="fixture-embed",
    )
    ensure_online_record(session)
    revoke(record, reader)
    ai, llm = service()
    assert ai.ask(user=reader, question="budget")["chunks_used"] == 1
    context = llm.chat.call_args.kwargs["system"]
    assert "private budget decision" not in context
    assert "allowed second occurrence" in context
