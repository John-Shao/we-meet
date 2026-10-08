"""Cross-worker admission, ownership and stale-client recovery without provider calls."""

from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Barrier
from unittest.mock import patch

from django.core.management import call_command
from django.db import close_old_connections, connection
from django.utils import timezone

import pytest
from rest_framework.exceptions import PermissionDenied, Throttled
from rest_framework.test import APIClient

from core.factories import UserFactory
from core.models import DirectAIAllocation
from core.services import direct_ai_allocations as service

pytestmark = pytest.mark.django_db(transaction=True)
MODEL = "qwen-audio-3.1-asr-flash-streaming"


def client(user):
    result = APIClient()
    result.force_authenticate(user)
    return result


def url(row):
    return f"/api/v1.0/direct-ai/sessions/{row.pk}/"


def issued(user):
    with service.allocating(user, MODEL, "websocket") as allocation:
        info = allocation.issue()
    return DirectAIAllocation.objects.get(pk=info["id"])


def test_issuance_records_only_metadata_and_does_not_hold_a_db_lock():
    user = UserFactory()
    with service.allocating(user, MODEL, "websocket") as allocation:
        assert not connection.in_atomic_block
        assert allocation.row.status == "allocating"
        info = allocation.issue()
    row = DirectAIAllocation.objects.get(pk=info["id"])
    assert row.status == "issued" and row.model == MODEL
    assert info == {"id": str(row.pk), "ttl_seconds": 120, "heartbeat_seconds": 30, "enforce": False}


def test_failed_or_ambiguous_allocation_is_retained_without_active_slot():
    user = UserFactory()
    with pytest.raises(TimeoutError), service.allocating(user, MODEL, "websocket"):
        raise TimeoutError
    row = DirectAIAllocation.objects.get(user=user)
    assert row.status == "failed" and row.ended_at is not None


def test_owner_heartbeat_and_idempotent_close_never_revive_a_session():
    user = UserFactory()
    row = issued(user)
    owner = client(user)
    response = owner.post(url(row), {"operation": "heartbeat"}, format="json")
    assert response.status_code == 200 and response.data == {"status": "active"}
    row.refresh_from_db()
    assert row.last_seen_at and row.lease_until > row.last_seen_at
    for _ in range(2):
        assert owner.post(url(row), {"operation": "close"}, format="json").status_code == 200
    assert owner.post(url(row), {"operation": "heartbeat"}, format="json").status_code == 410
    row.refresh_from_db()
    assert row.status == "closed"


def test_anonymous_and_other_account_cannot_operate_the_lease():
    row = issued(UserFactory())
    assert APIClient().post(url(row), {"operation": "close"}, format="json").status_code in (401, 403)
    assert client(UserFactory()).post(url(row), {"operation": "close"}, format="json").status_code == 404
    row.refresh_from_db()
    assert row.status == "issued"


def test_crashed_client_is_expired_and_cannot_renew(settings):
    settings.DIRECT_AI_MAX_ACTIVE_ALLOCATIONS = 1
    user = UserFactory()
    row = issued(user)
    with patch.object(service.timezone, "now", return_value=row.lease_until + timedelta(seconds=1)):
        assert client(user).post(url(row), {"operation": "heartbeat"}, format="json").status_code == 410
        replacement = issued(user)
    row.refresh_from_db()
    assert row.status == "expired" and replacement.pk != row.pk


def test_management_reclaims_only_expired_live_declarations():
    live = issued(UserFactory())
    stale = issued(UserFactory())
    ended = issued(UserFactory())
    service.update(ended.user, ended.pk, "close")
    DirectAIAllocation.objects.filter(pk=stale.pk).update(lease_until=timezone.now() - timedelta(seconds=1))
    call_command("expire_direct_ai_allocations")
    for row, status in ((live, "issued"), (stale, "expired"), (ended, "closed")):
        row.refresh_from_db()
        assert row.status == status


def test_default_limits_observe_without_changing_existing_access(settings):
    settings.DIRECT_AI_MAX_ACTIVE_ALLOCATIONS = 0
    settings.DIRECT_AI_MAX_DAILY_ALLOCATIONS = 0
    user = UserFactory()
    for _ in range(4):
        issued(user)
    assert DirectAIAllocation.objects.filter(user=user, status="issued").count() == 4


def test_daily_limit_counts_closed_and_failed_attempts(settings):
    settings.DIRECT_AI_MAX_DAILY_ALLOCATIONS = 2
    user = UserFactory()
    row = issued(user)
    service.update(user, row.pk, "close")
    with service.allocating(user, MODEL, "websocket"):
        pass
    with pytest.raises(Throttled):
        issued(user)
    assert DirectAIAllocation.objects.filter(user=user).count() == 2


def test_active_limit_is_account_scoped_and_fails_before_provider_io(settings):
    settings.DIRECT_AI_MAX_ACTIVE_ALLOCATIONS = 1
    user = UserFactory()
    row = issued(user)
    with pytest.raises(Throttled):
        issued(user)
    issued(UserFactory())
    service.update(user, row.pk, "close")
    issued(user)


def test_two_workers_cannot_race_past_the_same_account_limit(settings):
    settings.DIRECT_AI_MAX_ACTIVE_ALLOCATIONS = 1
    user = UserFactory()
    barrier = Barrier(2)

    def worker():
        close_old_connections()
        try:
            barrier.wait(timeout=10)
            try:
                return str(service.reserve(user, MODEL, "websocket").pk)
            except Throttled:
                return "denied"
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: worker(), range(2)))
    assert results.count("denied") == 1
    assert DirectAIAllocation.objects.filter(user=user).count() == 1


def test_maximum_lifetime_is_not_extended_by_heartbeats():
    user = UserFactory()
    row = issued(user)
    now = timezone.now()
    DirectAIAllocation.objects.filter(pk=row.pk).update(created_at=now - timedelta(seconds=43200), lease_until=now + timedelta(seconds=100))
    assert service.update(user, row.pk, "heartbeat") == "expired"


def test_unknown_operation_is_rejected_without_mutating_metadata():
    user = UserFactory()
    row = issued(user)
    assert client(user).post(url(row), {"operation": "restart", "token": "ignored"}, format="json").status_code == 400
    row.refresh_from_db()
    assert row.status == "issued"


def test_revoked_account_cannot_issue_or_refresh_a_grant():
    user = UserFactory()
    row = issued(user)
    user.is_active = False
    user.save(update_fields=["is_active"])
    with pytest.raises(PermissionDenied):
        issued(user)
    assert client(user).post(url(row), {"operation": "heartbeat"}, format="json").status_code == 403
