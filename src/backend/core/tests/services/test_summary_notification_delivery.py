"""Private assistant delivery with real database fences and simulated IM responses."""

import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Event
from types import SimpleNamespace
from unittest.mock import Mock, patch

from django.db import close_old_connections
from django.utils import timezone

import pytest

from core import models
from core.factories import UserFactory
from core.services import meeting_summary_notifications as notices
from core.services import summary_notification_delivery as service
from core.services.im_delivery_client import ImDeliveryError, ImDeliveryReceipt
from core.services.meeting_records import RecordConflict
from core.tests.services.test_meeting_records import client_for
from core.tests.services.test_meeting_summary_notifications import enabled
from core.tests.services.test_meeting_summary_review import fixture

pytestmark = pytest.mark.django_db
BOT = str(uuid.uuid4())
PEER = str(uuid.uuid4())


@pytest.fixture
def transport(monkeypatch):
    upstream = Mock()
    upstream.lookup.return_value = ImDeliveryReceipt("not_found")
    upstream.create.return_value = ImDeliveryReceipt("ready", 42)
    provisioning = Mock()
    provisioning.create_direct.side_effect = lambda **values: SimpleNamespace(
        cid=values["cid"],
        type="direct",
        owner_uid=values["owner_uid"],
        members=[values["owner_uid"], values["peer_uid"]],
    )
    monkeypatch.setattr(service, "ImDeliveryClient", lambda *_: upstream)
    monkeypatch.setattr(service, "_provisioning_client", lambda: provisioning)
    monkeypatch.setattr(
        service.im_bots, "get_builtin", lambda _: SimpleNamespace(im_uid=BOT)
    )
    monkeypatch.setattr(service.im_bots, "resolve_bot_uid", lambda *_: BOT)

    def resolve(_, user):
        models.User.objects.filter(pk=user.pk).update(im_uid=PEER)
        return PEER

    monkeypatch.setattr(service, "resolve_uid", resolve)
    return upstream, provisioning


def pending():
    user, record, _, version = fixture()
    return user, record, version, record.summary_notifications.get()


def run(row, status="queued"):
    result = service.execute_notification(row.pk, row.attempt, status)
    row.refresh_from_db()
    return result


def test_prepares_private_destination_and_emits_once(transport):
    upstream, provisioning = transport
    _, _, _, row = pending()
    assert run(row) and row.status == "delivered" and row.message_id == 42
    assert row.send_started and str(row.conversation_id) == service._cid(BOT, PEER)
    upstream.lookup.assert_called_once_with(BOT, str(row.pk), str(row.conversation_id))
    sent = upstream.create.call_args.args
    assert sent[0] == str(row.pk) and sent[1]["body"] == row.body
    assert sent[1]["sender_uid"] == BOT and sent[1]["cid"] == str(row.conversation_id)
    provisioning.create_direct.assert_called_once()
    assert not run(row)
    upstream.create.assert_called_once()


@pytest.mark.parametrize(
    "state,result",
    [
        ("ready", "delivered"),
        ("processing", "uncertain"),
        ("unavailable", "unavailable"),
    ],
)
def test_lookup_receipt_never_creates_conversation_or_resends(transport, state, result):
    upstream, provisioning = transport
    upstream.lookup.return_value = ImDeliveryReceipt(state, 42)
    _, _, _, row = pending()
    run(row)
    assert row.status == result
    upstream.create.assert_not_called()
    provisioning.create_direct.assert_not_called()


def test_post_timeout_is_reconciled_without_automatic_second_post(transport):
    upstream, provisioning = transport
    upstream.create.side_effect = ImDeliveryError("unreachable")
    _, _, _, row = pending()
    run(row)
    assert row.status == "uncertain" and row.send_started
    before = provisioning.create_direct.call_count
    run(row, "uncertain")
    assert row.status == "uncertain" and row.error_code == "result_not_found"
    assert (
        provisioning.create_direct.call_count == before
        and upstream.create.call_count == 1
    )
    upstream.lookup.return_value = ImDeliveryReceipt("ready", 42)
    run(row, "uncertain")
    assert row.status == "delivered" and upstream.create.call_count == 1


@pytest.mark.parametrize("change", ["flag", "access", "subject", "uid", "origin"])
def test_pre_send_recheck_blocks_revocation_or_changed_identity(
    transport, settings, change
):
    upstream, _ = transport
    user, _, _, row = pending()

    def revoke(*_):
        if change == "flag":
            settings.MEETING_SUMMARY_NOTIFICATIONS_ENABLED = False
        elif change == "access":
            models.ResourceAccess.objects.filter(user=user).delete()
        elif change == "subject":
            models.User.objects.filter(pk=user.pk).update(sub="new-subject")
        elif change == "uid":
            models.User.objects.filter(pk=user.pk).update(im_uid=str(uuid.uuid4()))
        else:
            settings.JUSI_IM_CONFIGURATION = {
                **settings.JUSI_IM_CONFIGURATION,
                "api_url": "https://other.invalid",
            }
        return ImDeliveryReceipt("not_found")

    upstream.lookup.side_effect = revoke
    run(row)
    assert row.status in {"failed", "canceled"} and not row.send_started
    upstream.create.assert_not_called()


def test_reconciliation_after_revocation_is_read_only(transport, settings):
    upstream, provisioning = transport
    upstream.create.side_effect = ImDeliveryError("unreachable")
    user, _, _, row = pending()
    run(row)
    settings.MEETING_SUMMARY_NOTIFICATIONS_ENABLED = False
    models.ResourceAccess.objects.filter(user=user).delete()
    upstream.lookup.return_value = ImDeliveryReceipt("ready", 42)
    run(row, "uncertain")
    assert row.status == "delivered" and upstream.create.call_count == 1
    assert provisioning.create_direct.call_count == 1


def test_private_conversation_extra_member_is_rejected(transport):
    upstream, provisioning = transport
    provisioning.create_direct.side_effect = lambda **v: SimpleNamespace(
        cid=v["cid"],
        type="direct",
        owner_uid=BOT,
        members=[BOT, PEER, str(uuid.uuid4())],
    )
    _, _, _, row = pending()
    run(row)
    assert row.status == "failed" and not row.send_started
    upstream.create.assert_not_called()


def test_recipient_created_existing_direct_conversation_is_supported(transport):
    _, provisioning = transport
    provisioning.create_direct.side_effect = lambda **v: SimpleNamespace(
        cid=v["cid"], type="direct", owner_uid=PEER, members=[BOT, PEER]
    )
    _, _, _, row = pending()
    run(row)
    assert row.status == "delivered"


def test_worker_expiry_rejects_late_success(transport):
    upstream, _ = transport
    _, _, _, row = pending()

    def expire(*_):
        models.MeetingSummaryNotification.objects.filter(pk=row.pk).update(
            deadline=timezone.now() - timedelta(seconds=1)
        )
        return ImDeliveryReceipt("ready", 42)

    upstream.create.side_effect = expire
    assert not run(row) and row.status == "running"
    with patch.object(service, "dispatch_notification", return_value=True):
        service.tick_notifications()
    row.refresh_from_db()
    assert row.status == "uncertain" and row.worker_id is None
    upstream.lookup.return_value = ImDeliveryReceipt("ready", 42)
    run(row, "uncertain")
    assert row.status == "delivered"
    upstream.create.assert_called_once()


def test_explicit_retry_is_owner_only_idempotent_and_preserves_remote_key(transport):
    upstream, _ = transport
    upstream.create.side_effect = ImDeliveryError("unreachable")
    user, record, _, row = pending()
    run(row)
    body = row.body
    key = uuid.uuid4()
    retried, replay = service.retry_notification(record.pk, row.pk, user, key, 1)
    assert retried.attempt == 2 and not replay and retried.body == body
    assert service.retry_notification(record.pk, row.pk, user, key, 1)[1]
    with pytest.raises(RecordConflict):
        service.retry_notification(record.pk, row.pk, user, uuid.uuid4(), 1)
    with pytest.raises(PermissionError):
        service.retry_notification(record.pk, row.pk, UserFactory(), uuid.uuid4(), 2)
    assert not service.execute_notification(row.pk, 1)
    upstream.create.side_effect = None
    row.refresh_from_db()
    run(row)
    assert row.status == "delivered"
    assert upstream.create.call_args.args == upstream.create.call_args_list[0].args


@pytest.mark.parametrize("state", ["delivered", "unavailable", "running"])
def test_terminal_or_active_notices_cannot_be_retried(state):
    user, record, _, row = pending()
    models.MeetingSummaryNotification.objects.filter(pk=row.pk).update(status=state)
    with pytest.raises(RecordConflict):
        service.retry_notification(record.pk, row.pk, user, uuid.uuid4(), 1)


def test_retry_api_uses_current_attempt_and_never_sends_in_http(transport):
    upstream, _ = transport
    user, record, _, row = pending()
    models.MeetingSummaryNotification.objects.filter(pk=row.pk).update(status="failed")
    url = f"/api/v1.0/meeting-records/{record.pk}/summary-notifications/{row.pk}/retry/"
    response = client_for(user).post(
        url,
        {"expected_attempt": 1},
        format="json",
        HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
    )
    assert response.status_code == 202, response.data
    assert response.data["notification"]["attempt"] == 2
    upstream.create.assert_not_called()


def test_disabled_celery_never_uses_synchronous_fallback(settings, transport):
    upstream, _ = transport
    _, _, _, row = pending()
    settings.CELERY_ENABLED = False
    assert (
        not run(row)
        and not service.dispatch_notification(row.pk)
        and not service.tick_notifications()
    )
    upstream.create.assert_not_called()


def test_outbox_broker_failure_is_durable_and_bounded():
    _, _, _, row = pending()
    with patch(
        "meet.celery_app.app.connection_for_write",
        side_effect=RuntimeError("private connection"),
    ) as connection:
        assert not service.dispatch_notification(row.pk)
        assert not service.dispatch_notification(row.pk)
        assert connection.call_count == 1
    row.refresh_from_db()
    assert row.status == "queued" and row.error_code == "dispatch_unavailable"
    models.MeetingSummaryNotification.objects.filter(pk=row.pk).update(
        dispatch_attempted_at=timezone.now() - timedelta(seconds=31)
    )
    with (
        patch("meet.celery_app.app.connection_for_write"),
        patch("meet.celery_app.app.send_task") as send,
    ):
        assert service.tick_notifications() == 1
        assert send.call_args.kwargs["args"] == [str(row.pk), 1, "queued"]


def test_completion_dispatch_occurs_after_commit(django_capture_on_commit_callbacks):
    with patch.object(notices, "_dispatch") as dispatch:
        with django_capture_on_commit_callbacks(execute=True):
            _, _, _, row = pending()
            dispatch.assert_not_called()
        dispatch.assert_called_once_with(row.pk)


@pytest.mark.django_db(transaction=True)
def test_concurrent_duplicate_workers_emit_one_message(transport):
    upstream, _ = transport
    _, _, _, row = pending()
    entered, release = Event(), Event()

    def lookup(*_):
        entered.set()
        assert release.wait(10)
        return ImDeliveryReceipt("not_found")

    upstream.lookup.side_effect = lookup

    def work():
        close_old_connections()
        try:
            return service.execute_notification(row.pk, 1)
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(work)
        assert entered.wait(10)
        try:
            assert pool.submit(work).result(timeout=5) is False
        finally:
            release.set()
        assert first.result(timeout=10)
    upstream.create.assert_called_once()
