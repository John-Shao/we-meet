"""Real DB boundaries: provider calls never hold row locks or accept stale writes."""

from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Event
from unittest.mock import Mock, patch

from django.db import close_old_connections, connection, transaction
from django.utils import timezone

import pytest

from core import models
from core.factories import (
    MeetingParticipationFactory,
    MeetingSessionFactory,
    UserFactory,
)
from core.services import legacy_summary_runs as runs
from core.services.meeting_records import ensure_online_record
from core.services.meeting_summary import MeetingSummaryService

pytestmark = pytest.mark.django_db(transaction=True)


def source():
    session = MeetingSessionFactory(
        status="ended",
        started_at=timezone.now() - timedelta(minutes=10),
        ended_at=timezone.now(),
        end_reason="room_finished",
    )
    MeetingParticipationFactory(session=session, identity="human", kind="standard")
    models.Transcript.objects.create(
        room=session.room,
        session=session,
        speaker_identity="human",
        text="A decision",
        started_at=session.started_at,
    )
    return session


def client():
    llm = Mock(model="fixture-model")
    llm.chat.return_value = "A summary"
    llm.chat_json.return_value = "{}"
    return llm


def test_provider_and_delivery_run_after_transactions_commit():
    session = source()
    llm = client()

    def generate(**_kwargs):
        assert not connection.in_atomic_block
        assert models.LegacySummaryRun.objects.get(session=session).status == "running"
        return "A summary"

    def deliver(*_args):
        assert not connection.in_atomic_block
        assert models.Summary.objects.get(session=session).status == "success"

    llm.chat.side_effect = generate
    service = MeetingSummaryService(llm=llm)
    with (
        patch.object(service, "_push_summary_to_doc", side_effect=deliver),
        patch.object(service, "_push_summary_to_im", side_effect=deliver),
    ):
        result = service.generate(session, automatic=True)
    assert result.status == "success"
    assert models.LegacySummaryRun.objects.get(session=session).status == "succeeded"


def test_caller_cannot_wrap_provider_work_in_an_outer_transaction():
    session = source()
    llm = client()
    with transaction.atomic(), pytest.raises(RuntimeError, match="durable"):
        MeetingSummaryService(llm=llm).generate(session)
    llm.chat.assert_not_called()
    assert not models.LegacySummaryRun.objects.exists()


def test_slow_provider_releases_row_lock_and_duplicate_generators_do_not_call_model():
    session = source()
    entered, release = Event(), Event()
    first = client()

    def slow(**_kwargs):
        assert not connection.in_atomic_block
        entered.set()
        assert release.wait(10)
        return "first"

    first.chat.side_effect = slow

    def worker():
        close_old_connections()
        try:
            return MeetingSummaryService(llm=first).generate(session, automatic=True)
        finally:
            close_old_connections()

    with (
        patch.object(MeetingSummaryService, "_push_summary_to_doc"),
        patch.object(MeetingSummaryService, "_push_summary_to_im"),
    ):
        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(worker)
            try:
                assert entered.wait(10)
                with transaction.atomic():
                    models.MeetingSession.objects.select_for_update(nowait=True).get(
                        pk=session.pk
                    )
                second = client()
                assert MeetingSummaryService(llm=second).generate(session) is None
                second.chat.assert_not_called()
            finally:
                release.set()
            assert future.result(timeout=10).content == "first"


@pytest.mark.parametrize("change", ["opt_in", "trash", "delete", "expire"])
def test_source_change_during_provider_call_discards_late_result(change):
    session = source()
    record, _ = ensure_online_record(session)
    llm = client()

    def changed(**_kwargs):
        if change == "opt_in":
            models.MeetingSummaryAutomation.objects.create(
                record=record, enabled=False, requested_by=UserFactory()
            )
        elif change == "trash":
            models.MeetingRecord.objects.filter(pk=record.pk).update(
                deleted_at=timezone.now()
            )
        elif change == "delete":
            session.delete()
        else:
            models.LegacySummaryRun.objects.filter(session=session).update(
                lease_until=timezone.now() - timedelta(seconds=1)
            )
        return "late private result"

    llm.chat.side_effect = changed
    service = MeetingSummaryService(llm=llm)
    with patch.object(service, "_push_summary_to_doc") as docs:
        assert service.generate(session, automatic=True) is None
    assert not models.Summary.objects.exists()
    llm.chat_json.assert_not_called()
    docs.assert_not_called()


def test_expired_attempt_needs_explicit_retry_and_old_token_cannot_commit():
    session = source()
    _, old, _ = runs.claim(session.pk, automatic=True)
    models.LegacySummaryRun.objects.filter(pk=old.pk).update(
        lease_until=timezone.now() - timedelta(seconds=1)
    )
    assert runs.claim(session.pk, automatic=True)[1] is None
    assert models.LegacySummaryRun.objects.get(pk=old.pk).status == "uncertain"
    _, current, _ = runs.claim(session.pk, automatic=False)
    assert current.token != old.token
    with pytest.raises(runs.StaleSummaryRun):
        runs.check(old)
    runs.finish(old, "failed")
    runs.check(current)


def test_delivery_failure_does_not_rollback_committed_summary():
    session = source()
    service = MeetingSummaryService(llm=client())
    with (
        patch.object(
            service, "_push_summary_to_doc", side_effect=RuntimeError("offline")
        ),
        patch.object(service, "_push_summary_to_im") as im,
    ):
        summary = service.generate(session, automatic=True)
    assert models.Summary.objects.get(pk=summary.pk).content == "A summary"
    im.assert_called_once()
