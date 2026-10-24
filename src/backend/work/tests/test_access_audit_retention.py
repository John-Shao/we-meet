"""Work access-audit retention (P1-A, acceptance §3.6).

The retention job is the one place that destroys audit evidence, so every test
here is about a boundary: which rows are old enough, which tenants are exempt,
how much a single tick may remove, and whether the rollout's dry-run gate holds.
"""

import logging
from datetime import datetime, timedelta
from datetime import timezone as dt_timezone
from io import StringIO
from types import SimpleNamespace
from unittest.mock import patch

from django.conf import settings
from django.core.management import call_command
from django.test import override_settings
from django.utils import timezone

import pytest

from core import factories
from core import models as core_models

from meet.settings import Base
from work.models import WorkAccessAudit
from work.tasks import prune_access_audit, prune_access_audit_rows

pytestmark = pytest.mark.django_db

NOW = datetime(2026, 10, 24, 12, 0, 0, tzinfo=dt_timezone.utc)


def _row(organization, *, age_days, request_id="req-1", after=None):
    row = WorkAccessAudit.objects.create(
        organization=organization,
        action="grant_updated",
        target_type="grant",
        target_id="target-1",
        request_id=request_id,
        after=after or {},
    )
    WorkAccessAudit.objects.filter(pk=row.pk).update(
        created_at=NOW - timedelta(days=age_days)
    )
    return row


def _expired(organization, count=1, *, age_days=400):
    return [
        _row(organization, age_days=age_days, request_id=f"old-{index}")
        for index in range(count)
    ]


@override_settings(
    WORK_ACCESS_AUDIT_RETENTION_DAYS=365,
    WORK_ACCESS_AUDIT_RETENTION_DRY_RUN=False,
    WORK_ACCESS_AUDIT_PRUNE_BATCH=5000,
)
def test_expired_rows_of_live_tenants_are_deleted():
    live = factories.OrganizationFactory()
    expired = _expired(live)
    fresh = _row(live, age_days=10)

    with patch("django.utils.timezone.now", return_value=NOW):
        result = prune_access_audit_rows()

    assert result == {"deleted": 1, "has_more": False}
    assert not WorkAccessAudit.objects.filter(pk=expired[0].pk).exists()
    assert WorkAccessAudit.objects.filter(pk=fresh.pk).exists()


@override_settings(
    WORK_ACCESS_AUDIT_RETENTION_DAYS=365,
    WORK_ACCESS_AUDIT_RETENTION_DRY_RUN=False,
)
def test_archived_tenants_keep_their_history():
    """An archived tenant's history is part of the archive, not litter."""
    archived = factories.OrganizationFactory()
    # An archived tenant is inactive by definition; the queryset update skips
    # the model's cross-field check, which needs the two writes together.
    core_models.Organization.objects.filter(pk=archived.pk).update(
        archived_at=timezone.now(), is_active=False
    )
    kept = _expired(archived)
    live = factories.OrganizationFactory()
    removed = _expired(live)

    with patch("django.utils.timezone.now", return_value=NOW):
        prune_access_audit_rows()

    assert WorkAccessAudit.objects.filter(pk=kept[0].pk).exists()
    assert not WorkAccessAudit.objects.filter(pk=removed[0].pk).exists()


@override_settings(
    WORK_ACCESS_AUDIT_RETENTION_DAYS=365,
    WORK_ACCESS_AUDIT_RETENTION_DRY_RUN=False,
)
def test_the_cutoff_is_strict_so_the_boundary_row_survives_one_more_tick():
    organization = factories.OrganizationFactory()
    boundary = _row(organization, age_days=365)
    just_past = _row(organization, age_days=365.001)

    with patch("django.utils.timezone.now", return_value=NOW):
        prune_access_audit_rows()

    assert WorkAccessAudit.objects.filter(pk=boundary.pk).exists()
    assert not WorkAccessAudit.objects.filter(pk=just_past.pk).exists()


@override_settings(
    WORK_ACCESS_AUDIT_RETENTION_DAYS=365,
    WORK_ACCESS_AUDIT_RETENTION_DRY_RUN=False,
    WORK_ACCESS_AUDIT_PRUNE_BATCH=5000,
)
def test_a_second_run_is_a_no_op():
    organization = factories.OrganizationFactory()
    _expired(organization)

    with patch("django.utils.timezone.now", return_value=NOW):
        assert prune_access_audit_rows()["deleted"] == 1
        assert prune_access_audit_rows() == {"deleted": 0, "has_more": False}


@override_settings(
    WORK_ACCESS_AUDIT_RETENTION_DAYS=365,
    WORK_ACCESS_AUDIT_RETENTION_DRY_RUN=False,
    WORK_ACCESS_AUDIT_PRUNE_BATCH=2,
)
def test_a_tick_is_bounded_and_reports_the_backlog():
    """One tick must not hold a transaction long enough to block writers."""
    organization = factories.OrganizationFactory()
    _expired(organization, 5)

    with patch("django.utils.timezone.now", return_value=NOW):
        first = prune_access_audit_rows()
        second = prune_access_audit_rows()
        third = prune_access_audit_rows()

    assert first == {"deleted": 2, "has_more": True}
    assert second == {"deleted": 2, "has_more": True}
    assert third == {"deleted": 1, "has_more": False}
    assert not WorkAccessAudit.objects.exists()


@override_settings(
    WORK_ACCESS_AUDIT_RETENTION_DAYS=365,
    WORK_ACCESS_AUDIT_RETENTION_DRY_RUN=False,
    WORK_ACCESS_AUDIT_PRUNE_BATCH=5000,
)
def test_deletes_in_chunks_rather_than_one_long_statement():
    organization = factories.OrganizationFactory()
    _expired(organization, 5)

    with (
        patch("django.utils.timezone.now", return_value=NOW),
        patch("work.tasks.PRUNE_CHUNK", 2),
    ):
        assert prune_access_audit_rows()["deleted"] == 5

    assert not WorkAccessAudit.objects.exists()


@override_settings(
    WORK_ACCESS_AUDIT_RETENTION_DAYS=365,
    WORK_ACCESS_AUDIT_RETENTION_DRY_RUN=True,
    WORK_ACCESS_AUDIT_PRUNE_BATCH=2,
)
def test_dry_run_reports_the_whole_backlog_without_deleting(caplog):
    """A dry run cannot consume its own candidates, so it reports all of them.

    Capping it at one batch would make ``--batches 20`` multiply the same rows
    by twenty — exactly the number the rollout expects to verify.
    """
    organization = factories.OrganizationFactory()
    _expired(organization, 5)
    caplog.set_level(logging.INFO, logger="work.tasks")

    with patch("django.utils.timezone.now", return_value=NOW):
        result = prune_access_audit_rows()

    assert result == {"deleted": 5, "has_more": False}
    assert WorkAccessAudit.objects.count() == 5
    output = "\n".join(record.getMessage() for record in caplog.records)
    assert "would_delete=5" in output


@override_settings(
    WORK_ACCESS_AUDIT_RETENTION_DAYS=365,
    WORK_ACCESS_AUDIT_RETENTION_DRY_RUN=True,
)
def test_the_setting_gate_wins_over_a_caller_that_omits_dry_run():
    """The rollout is "dry-run a week, then flip the switch" — callers cannot
    skip the gate by simply not passing the argument."""
    organization = factories.OrganizationFactory()
    _expired(organization)

    with patch("django.utils.timezone.now", return_value=NOW):
        result = prune_access_audit_rows()

    assert result["deleted"] == 1
    assert WorkAccessAudit.objects.count() == 1


@override_settings(WORK_ACCESS_AUDIT_RETENTION_DAYS=0)
def test_retention_zero_disables_the_job_entirely():
    organization = factories.OrganizationFactory()
    _expired(organization)

    assert prune_access_audit_rows() == {"deleted": 0, "has_more": False}
    assert WorkAccessAudit.objects.count() == 1


def _beat_schedule(**overrides):
    """Evaluate the property with explicit values.

    ``override_settings`` cannot reach it: Django resolves the property on the
    default settings holder, so the ``self`` inside never sees the override.
    """
    values = {
        "celery_beat_entries": Base.celery_beat_entries,
        "MEETING_VOICEPRINT_ENABLED": True,
        "MEETING_VOICEPRINT_MATCHING_ENABLED": True,
        "WORK_ACCESS_AUDIT_RETENTION_DAYS": 365,
    }
    values.update(overrides)
    holder = SimpleNamespace(**values)
    return Base.CELERY_BEAT_SCHEDULE.fget(holder)


@override_settings(WORK_ACCESS_AUDIT_RETENTION_DAYS=365)
def test_the_beat_entry_exists_only_while_retention_is_enabled():
    assert "prune-work-access-audit" in settings.CELERY_BEAT_SCHEDULE
    assert "prune-work-access-audit" in _beat_schedule()


def test_the_beat_entry_is_removed_with_retention():
    assert "prune-work-access-audit" not in _beat_schedule(
        WORK_ACCESS_AUDIT_RETENTION_DAYS=0
    )


@override_settings(
    WORK_ACCESS_AUDIT_RETENTION_DAYS=365,
    WORK_ACCESS_AUDIT_RETENTION_DRY_RUN=False,
)
def test_the_log_reports_counts_only(caplog):
    organization = factories.OrganizationFactory()
    _row(
        organization,
        age_days=400,
        request_id="secret-request-id",
        after={"phone": "+8613800000000"},
    )
    caplog.set_level(logging.INFO, logger="work.tasks")

    with patch("django.utils.timezone.now", return_value=NOW):
        prune_access_audit_rows()

    output = "\n".join(record.getMessage() for record in caplog.records)
    assert "deleted=1" in output
    assert "secret-request-id" not in output
    assert "13800000000" not in output


@override_settings(
    WORK_ACCESS_AUDIT_RETENTION_DAYS=365,
    WORK_ACCESS_AUDIT_RETENTION_DRY_RUN=False,
)
def test_the_celery_task_deletes_through_the_shared_function():
    organization = factories.OrganizationFactory()
    _expired(organization)

    with patch("django.utils.timezone.now", return_value=NOW):
        assert prune_access_audit() == {"deleted": 1, "has_more": False}

    assert not WorkAccessAudit.objects.exists()


@override_settings(
    WORK_ACCESS_AUDIT_RETENTION_DAYS=365,
    WORK_ACCESS_AUDIT_RETENTION_DRY_RUN=False,
    WORK_ACCESS_AUDIT_PRUNE_BATCH=1,
)
def test_the_command_drains_the_backlog_in_batches():
    """The first deployment faces a backlog an hourly tick would take days to
    drain; the command loops until done or until ``--batches``."""
    organization = factories.OrganizationFactory()
    _expired(organization, 3)
    out = StringIO()

    with patch("django.utils.timezone.now", return_value=NOW):
        call_command("prune_work_access_audit", "--batches", "5", stdout=out)

    assert not WorkAccessAudit.objects.exists()
    assert "deleted=1" in out.getvalue()
    assert "deleted 3 row(s)" in out.getvalue()


@override_settings(
    WORK_ACCESS_AUDIT_RETENTION_DAYS=365,
    WORK_ACCESS_AUDIT_RETENTION_DRY_RUN=False,
    WORK_ACCESS_AUDIT_PRUNE_BATCH=1,
)
def test_the_command_can_be_limited_to_a_single_batch():
    organization = factories.OrganizationFactory()
    _expired(organization, 3)
    out = StringIO()

    with patch("django.utils.timezone.now", return_value=NOW):
        call_command("prune_work_access_audit", stdout=out)

    assert WorkAccessAudit.objects.count() == 2
    assert "has_more=True" in out.getvalue()


@override_settings(
    WORK_ACCESS_AUDIT_RETENTION_DAYS=365,
    WORK_ACCESS_AUDIT_RETENTION_DRY_RUN=True,
    WORK_ACCESS_AUDIT_PRUNE_BATCH=5000,
)
def test_the_command_dry_run_reports_the_backlog_once():
    """``--batches`` must not multiply a count that never makes progress."""
    organization = factories.OrganizationFactory()
    _expired(organization, 3)
    out = StringIO()

    with patch("django.utils.timezone.now", return_value=NOW):
        call_command(
            "prune_work_access_audit", "--dry-run", "--batches", "5", stdout=out
        )

    assert WorkAccessAudit.objects.count() == 3
    assert "batch 1:" in out.getvalue()
    assert "batch 2:" not in out.getvalue()
    assert "would delete 3 row(s)" in out.getvalue()
