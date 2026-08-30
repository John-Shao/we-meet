"""Stage D recurring-task contracts."""

from datetime import date, datetime
from zoneinfo import ZoneInfo

from django.utils import timezone

import pytest
from rest_framework.test import APIClient

from core import models
from core.factories import MembershipFactory, OrganizationFactory, UserFactory
from core.services.task_recurrence import (
    create_task_recurrence_rule,
    materialize_due_task_recurrences,
    materialize_task_recurrence,
    update_task_recurrence_rule,
)

pytestmark = pytest.mark.django_db

TASKS_URL = "/api/v1.0/tasks/"


def _client(user):
    client = APIClient()
    client.force_login(user)
    return client


def _organization_user(*, timezone_name="UTC"):
    organization = OrganizationFactory()
    user = UserFactory(timezone=timezone_name)
    MembershipFactory(
        organization=organization,
        user=user,
        is_primary=True,
        status=models.MembershipStatusChoices.ACTIVE,
    )
    return organization, user


def test_create_month_end_rule_and_completion_materializes_one_next_instance():
    _organization, user = _organization_user(timezone_name="Asia/Shanghai")

    response = _client(user).post(
        TASKS_URL,
        {
            "title": "Month-end close",
            "start_date": "2028-01-30",
            "due_date": "2028-01-31",
            "recurrence": {
                "frequency": "monthly",
                "interval": 1,
                "max_occurrences": 3,
            },
        },
        format="json",
    )

    assert response.status_code == 201, response.json()
    payload = response.json()
    assert payload["recurrence"] == {
        "rule_id": payload["recurrence"]["rule_id"],
        "frequency": "monthly",
        "interval": 1,
        "timezone": "Asia/Shanghai",
        "end_date": None,
        "max_occurrences": 3,
        "generated_count": 1,
        "next_occurrence_date": "2028-02-29",
        "is_active": True,
        "last_error": "",
        "sequence": 1,
        "can_manage": True,
    }
    first = models.Task.objects.get(pk=payload["id"])

    completed = _client(user).patch(
        f"{TASKS_URL}{first.pk}/",
        {"status": models.Task.Status.COMPLETED},
        format="json",
    )

    assert completed.status_code == 200, completed.json()
    second = models.Task.objects.get(
        recurrence_rule=first.recurrence_rule,
        recurrence_sequence=2,
    )
    assert second.start_date == date(2028, 2, 28)
    assert second.due_date == date(2028, 2, 29)
    assert second.comments.count() == 0
    assert second.attachments.count() == 0

    _client(user).patch(
        f"{TASKS_URL}{second.pk}/",
        {"status": models.Task.Status.COMPLETED},
        format="json",
    )
    third = models.Task.objects.get(
        recurrence_rule=first.recurrence_rule,
        recurrence_sequence=3,
    )
    assert third.due_date == date(2028, 3, 31)
    first.recurrence_rule.refresh_from_db()
    assert first.recurrence_rule.is_active is False
    assert first.recurrence_rule.next_occurrence_date is None


def test_scheduler_uses_owner_local_date_and_is_idempotent():
    _organization, user = _organization_user(timezone_name="Asia/Shanghai")
    task = models.Task.objects.create(
        title="Daily handoff",
        creator=user,
        assignee=user,
        start_date=date(2026, 8, 27),
        due_date=date(2026, 8, 27),
    )
    task.assignees.add(user)
    rule = create_task_recurrence_rule(
        task=task,
        owner=user,
        recurrence={"frequency": "daily", "interval": 1},
    )
    before_midnight_utc = datetime(2026, 8, 27, 16, 30, tzinfo=ZoneInfo("UTC"))

    assert materialize_due_task_recurrences(now=before_midnight_utc) == 1
    assert materialize_due_task_recurrences(now=before_midnight_utc) == 0
    assert models.Task.objects.filter(recurrence_rule=rule).count() == 2


def test_scheduler_respects_local_midnight_across_dst_boundary():
    _organization, user = _organization_user(timezone_name="America/Los_Angeles")
    task = models.Task.objects.create(
        title="DST-safe daily task",
        creator=user,
        assignee=user,
        start_date=date(2026, 3, 7),
    )
    task.assignees.add(user)
    rule = create_task_recurrence_rule(
        task=task,
        owner=user,
        recurrence={"frequency": "daily"},
    )

    before_local_midnight = datetime(2026, 3, 8, 7, 30, tzinfo=ZoneInfo("UTC"))
    after_local_midnight = datetime(2026, 3, 8, 8, 30, tzinfo=ZoneInfo("UTC"))

    assert materialize_due_task_recurrences(now=before_local_midnight) == 0
    assert materialize_due_task_recurrences(now=after_local_midnight) == 1
    assert models.Task.objects.filter(recurrence_rule=rule).count() == 2


def test_retrying_same_cycle_does_not_duplicate_instance():
    _organization, user = _organization_user()
    task = models.Task.objects.create(
        title="Weekly review",
        creator=user,
        assignee=user,
        start_date=date(2026, 8, 27),
    )
    task.assignees.add(user)
    rule = create_task_recurrence_rule(
        task=task,
        owner=user,
        recurrence={"frequency": "weekly", "interval": 2},
    )

    generated, created = materialize_task_recurrence(rule.pk, force=True)
    assert created is True
    rule.refresh_from_db()
    rule.next_occurrence_date = generated.recurrence_key
    rule.generated_count = 1
    rule.save(update_fields=["next_occurrence_date", "generated_count", "updated_at"])

    retried, created = materialize_task_recurrence(rule.pk, force=True)

    assert created is False
    assert retried.pk == generated.pk
    assert models.Task.objects.filter(recurrence_rule=rule).count() == 2


def test_recurring_content_edit_requires_scope_and_following_updates_template():
    _organization, user = _organization_user()
    response = _client(user).post(
        TASKS_URL,
        {
            "title": "Original",
            "due_date": "2026-09-01",
            "recurrence": {"frequency": "weekly"},
        },
        format="json",
    )
    task_id = response.json()["id"]

    missing_scope = _client(user).patch(
        f"{TASKS_URL}{task_id}/", {"title": "Changed"}, format="json"
    )
    assert missing_scope.status_code == 400
    assert "recurrence_scope" in missing_scope.json()

    following = _client(user).patch(
        f"{TASKS_URL}{task_id}/",
        {"title": "Changed", "recurrence_scope": "following"},
        format="json",
    )
    assert following.status_code == 200, following.json()
    task = models.Task.objects.get(pk=task_id)
    assert task.recurrence_rule.template_title == "Changed"


def test_editing_non_first_instance_keeps_schedule_anchor():
    _organization, user = _organization_user()
    first = models.Task.objects.create(
        title="Weekly sync",
        creator=user,
        assignee=user,
        due_date=date(2026, 9, 1),
    )
    first.assignees.add(user)
    rule = create_task_recurrence_rule(
        task=first,
        owner=user,
        recurrence={"frequency": "weekly"},
    )
    original_anchor = rule.schedule_anchor_date
    original_next = rule.next_occurrence_date

    second = models.Task.objects.create(
        title="Weekly sync",
        creator=user,
        assignee=user,
        due_date=date(2026, 9, 8),
        recurrence_rule=rule,
        recurrence_sequence=2,
    )

    update_task_recurrence_rule(
        task=second,
        actor=user,
        recurrence=None,
        reset_schedule=False,
    )

    rule.refresh_from_db()
    assert rule.schedule_anchor_date == original_anchor
    assert rule.next_occurrence_date == original_next


def test_recurrence_can_be_stopped_without_rewriting_history():
    _organization, user = _organization_user()
    task = models.Task.objects.create(
        title="Stop me",
        creator=user,
        assignee=user,
        start_date=date(2026, 8, 27),
    )
    task.assignees.add(user)
    rule = create_task_recurrence_rule(
        task=task,
        owner=user,
        recurrence={"frequency": "daily"},
    )

    response = _client(user).delete(f"{TASKS_URL}{task.pk}/recurrence/")

    assert response.status_code == 200
    rule.refresh_from_db()
    task.refresh_from_db()
    assert rule.is_active is False
    assert task.recurrence_rule_id == rule.pk


def test_archived_list_stops_rule_with_stable_error():
    organization, user = _organization_user()
    task_list = models.TaskList.objects.create(
        organization=organization,
        creator=user,
        name="Archived",
        is_archived=True,
    )
    task = models.Task.objects.create(
        title="Do not materialize",
        creator=user,
        assignee=user,
        organization=organization,
        task_list=task_list,
        start_date=date(2026, 8, 27),
    )
    task.assignees.add(user)
    rule = create_task_recurrence_rule(
        task=task,
        owner=user,
        recurrence={"frequency": "daily"},
    )

    generated, created = materialize_task_recurrence(rule.pk, force=True)

    assert generated is None
    assert created is False
    rule.refresh_from_db()
    assert rule.is_active is False
    assert rule.last_error == "task_list_archived"
