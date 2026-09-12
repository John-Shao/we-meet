"""Real database fences/outbox with a simulated Docs receipt protocol; no external writes."""

import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Event
from unittest.mock import patch

from django.db import close_old_connections
from django.utils import timezone

import pytest

from core import models
from core.services import meeting_summary_exports as exports
from core.services import summary_export_delivery as service
from core.services.docs_delivery_client import DocsCreationReceipt, DocsDeliveryError
from core.services.meeting_records import RecordConflict
from core.tests.services.test_meeting_records import client_for
from core.tests.services.test_meeting_summary_exports import (
    enabled,
    export_request,
    path,
    selection,
)
from core.tests.services.test_meeting_summary_review import fixture

pytestmark = pytest.mark.django_db


def pending():
    user, record, _, summary = fixture()
    row, _ = export_request(record.pk, user, uuid.uuid4(), selection(summary))
    return user, record, row


def run(row, lookup="not_found", *, created=None, status="queued"):
    document = str(uuid.uuid4())
    with patch.object(service, "DocsDeliveryClient") as client:
        client.return_value.lookup.return_value = DocsCreationReceipt(lookup, document)
        client.return_value.create.return_value = created or DocsCreationReceipt(
            "ready", document
        )
        service.execute_export(row.pk, row.attempt, status)
    row.refresh_from_db()
    return client.return_value, document


def test_first_delivery_queries_then_creates_and_duplicate_queue_does_nothing():
    _, _, row = pending()
    client, document = run(row)
    assert row.status == "ready" and str(row.document_id) == document
    assert row.create_started
    client.lookup.assert_called_once_with(row.payload["sub"], str(row.pk))
    client.create.assert_called_once_with(str(row.pk), row.payload)
    with patch.object(service, "DocsDeliveryClient") as repeat:
        assert service.execute_export(row.pk, 1) is False
        repeat.assert_not_called()


@pytest.mark.parametrize(
    "lookup,status",
    [("ready", "ready"), ("processing", "uncertain"), ("unavailable", "unavailable")],
)
def test_receipt_lookup_never_recreates_existing_or_deleted_documents(lookup, status):
    _, _, row = pending()
    client, _ = run(row, lookup)
    assert row.status == status
    client.create.assert_not_called()


def test_post_timeout_recovery_is_read_only_even_if_lookup_has_not_seen_the_write():
    _, _, row = pending()
    with patch.object(service, "DocsDeliveryClient") as client:
        client.return_value.lookup.return_value = DocsCreationReceipt("not_found")
        client.return_value.create.side_effect = DocsDeliveryError("unreachable")
        service.execute_export(row.pk, 1)
    row.refresh_from_db()
    assert row.status == "uncertain" and row.create_started
    client, _ = run(row, status="uncertain")
    assert row.status == "uncertain" and row.error_code == "result_not_found"
    client.create.assert_not_called()
    client, document = run(row, "ready", status="uncertain")
    assert row.status == "ready" and str(row.document_id) == document
    client.create.assert_not_called()


def test_unsupported_lookup_is_not_proof_to_create():
    _, _, row = pending()
    with patch.object(service, "DocsDeliveryClient") as client:
        client.return_value.lookup.side_effect = DocsDeliveryError("unsupported")
        service.execute_export(row.pk, 1)
        client.return_value.create.assert_not_called()
    row.refresh_from_db()
    assert row.status == "failed" and not row.create_started


@pytest.mark.parametrize("change", ["flag", "role", "identity", "origin", "payload"])
def test_changes_during_lookup_prevent_a_new_external_write(settings, change):
    user, _, row = pending()

    def revoke(*_):
        if change == "flag":
            settings.MEETING_SUMMARY_EXPORT_ENABLED = False
        elif change == "role":
            models.ResourceAccess.objects.filter(user=user).delete()
        elif change == "identity":
            models.User.objects.filter(pk=user.pk).update(sub="changed-identity")
        elif change == "origin":
            settings.DOCS_CONFIGURATION = {
                **settings.DOCS_CONFIGURATION,
                "api_url": "https://other.invalid",
            }
        else:
            models.MeetingSummaryExport.objects.filter(pk=row.pk).update(
                payload={"sub": "tampered"}
            )
        return DocsCreationReceipt("not_found")

    with patch.object(service, "DocsDeliveryClient") as client:
        client.return_value.lookup.side_effect = revoke
        service.execute_export(row.pk, 1)
        client.return_value.create.assert_not_called()
    row.refresh_from_db()
    assert row.status in {"failed", "canceled"} and not row.create_started


def test_flag_off_and_revoked_access_still_allow_read_only_receipt_reconciliation(
    settings,
):
    user, _, row = pending()
    models.MeetingSummaryExport.objects.filter(pk=row.pk).update(
        status="uncertain", create_started=True
    )
    settings.MEETING_SUMMARY_EXPORT_ENABLED = False
    models.ResourceAccess.objects.filter(user=user).delete()
    client, _ = run(row, "ready", status="uncertain")
    assert row.status == "ready"
    client.create.assert_not_called()
    assert client_for(user).get(path(row.record)).status_code == 404


def test_expiry_fences_late_result_and_recovery_uses_original_key():
    _, _, row = pending()
    claimed = service._claim(row.pk, 1, "queued")
    models.MeetingSummaryExport.objects.filter(pk=row.pk).update(
        deadline=timezone.now() - timedelta(seconds=1)
    )
    with patch.object(service, "dispatch_export", return_value=True):
        service.tick_exports()
    assert service._finish(claimed, "ready", document_id=uuid.uuid4()) is False
    row.refresh_from_db()
    assert row.status == "uncertain" and row.worker_id is None
    client, _ = run(row, "ready", status="uncertain")
    assert row.status == "ready"
    client.create.assert_not_called()


def test_explicit_retry_preserves_payload_and_docs_key_but_fences_old_attempt():
    user, record, row = pending()
    frozen = row.payload.copy()
    models.MeetingSummaryExport.objects.filter(pk=row.pk).update(
        status="uncertain", create_started=True
    )
    key = uuid.uuid4()
    retried, replayed = service.retry_export(
        record.pk, row.pk, user, key, 1, row.payload_hash
    )
    assert retried.attempt == 2 and not replayed
    assert retried.payload == frozen and retried.pk == row.pk and retried.create_started
    assert service.retry_export(record.pk, row.pk, user, key, 1, row.payload_hash)[1]
    with pytest.raises(RecordConflict):
        service.retry_export(record.pk, row.pk, user, uuid.uuid4(), 1, row.payload_hash)
    with patch.object(service, "DocsDeliveryClient") as client:
        assert service.execute_export(row.pk, 1) is False
        client.assert_not_called()
    row.refresh_from_db()
    client, _ = run(row)
    client.create.assert_called_once_with(str(row.pk), frozen)


@pytest.mark.parametrize("status", ["queued", "running", "ready", "unavailable"])
def test_retry_cannot_overwrite_inflight_ready_or_deleted_document(status):
    user, record, row = pending()
    models.MeetingSummaryExport.objects.filter(pk=row.pk).update(status=status)
    with pytest.raises(RecordConflict):
        service.retry_export(record.pk, row.pk, user, uuid.uuid4(), 1, row.payload_hash)


def test_retry_api_previews_frozen_title_and_requires_exact_attempt_and_hash():
    user, record, row = pending()
    record.title = "Later title"
    record.save(update_fields=["title"])
    models.MeetingSummaryExport.objects.filter(pk=row.pk).update(status="failed")
    client = client_for(user)
    url = path(record) + f"{row.pk}/retry/"
    preview = client.get(url)
    assert preview.status_code == 200 and preview.data["title"] == row.payload["title"]
    assert "sub" not in preview.data
    assert (
        client.post(
            url,
            {"expected_attempt": 1, "expected_hash": "0" * 64},
            format="json",
            HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
        ).status_code
        == 409
    )
    response = client.post(
        url,
        {"expected_attempt": 1, "expected_hash": row.payload_hash},
        format="json",
        HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
    )
    assert response.status_code == 202 and response.data["export"]["attempt"] == 2


def test_outbox_broker_failure_keeps_intent_and_throttles_duplicate_dispatch():
    _, _, row = pending()
    with patch("meet.celery_app.app.connection_for_write") as connect:
        connect.side_effect = RuntimeError("private broker details")
        assert service.dispatch_export(row.pk) is False
        row.refresh_from_db()
        assert row.status == "queued" and row.error_code == "dispatch_unavailable"
        assert service.dispatch_export(row.pk) is False
        assert connect.call_count == 1
    models.MeetingSummaryExport.objects.filter(pk=row.pk).update(
        dispatch_attempted_at=timezone.now() - timedelta(seconds=31)
    )
    with (
        patch("meet.celery_app.app.connection_for_write"),
        patch("meet.celery_app.app.send_task") as send,
    ):
        assert service.tick_exports() == 1
        assert send.call_args.kwargs["args"] == [str(row.pk), 1, "queued"]
        assert send.call_args.kwargs["retry"] is False


def test_http_dispatch_happens_only_after_commit(django_capture_on_commit_callbacks):
    user, record, _, summary = fixture()
    with patch.object(exports, "_dispatch") as dispatch:
        with django_capture_on_commit_callbacks(execute=True):
            row, _ = export_request(record.pk, user, uuid.uuid4(), selection(summary))
            dispatch.assert_not_called()
        dispatch.assert_called_once_with(row.pk)


def test_disabled_celery_never_runs_sync_fallback(settings):
    _, _, row = pending()
    settings.CELERY_ENABLED = False
    with patch.object(service, "DocsDeliveryClient") as client:
        assert not service.dispatch_export(row.pk)
        assert not service.tick_exports()
        assert not service.execute_export(row.pk, 1)
        client.assert_not_called()


def test_payload_conflict_is_terminal_for_automatic_and_explicit_creation():
    user, record, row = pending()
    run(row, created=DocsCreationReceipt("conflict"))
    assert row.status == "failed" and row.error_code == "document_conflict"
    with pytest.raises(RecordConflict):
        service.retry_export(record.pk, row.pk, user, uuid.uuid4(), 1, row.payload_hash)


@pytest.mark.django_db(transaction=True)
def test_concurrent_duplicate_workers_make_one_create_call():
    _, _, row = pending()
    entered, release = Event(), Event()

    def lookup(*_):
        entered.set()
        assert release.wait(10)
        return DocsCreationReceipt("not_found")

    def work():
        close_old_connections()
        try:
            return service.execute_export(row.pk, 1)
        finally:
            close_old_connections()

    with (
        patch.object(service, "DocsDeliveryClient") as client,
        ThreadPoolExecutor(max_workers=2) as pool,
    ):
        client.return_value.lookup.side_effect = lookup
        client.return_value.create.return_value = DocsCreationReceipt(
            "ready", str(uuid.uuid4())
        )
        first = pool.submit(work)
        assert entered.wait(10)
        try:
            assert pool.submit(work).result(timeout=5) is False
        finally:
            release.set()
        assert first.result(timeout=10)
        client.return_value.create.assert_called_once()
