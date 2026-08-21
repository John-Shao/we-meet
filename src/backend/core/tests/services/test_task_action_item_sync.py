"""Task-to-action-item status synchronization and conflict semantics."""

from django.utils import timezone

import pytest

from core import models
from core.factories import RoomFactory, UserFactory
from core.services.task_action_item_sync import sync_action_item_from_task_status

pytestmark = pytest.mark.django_db


def _linked_pair(*, action_status=models.ActionItem.Status.CONFIRMED):
    creator = UserFactory()
    assignee = UserFactory()
    action_item = models.ActionItem.objects.create(
        room=RoomFactory(users=[(creator, "owner"), (assignee, "member")]),
        content="Publish the meeting follow-up",
        assignee=assignee,
        status=action_status,
    )
    task = models.Task.objects.create(
        title=action_item.content,
        creator=creator,
        assignee=assignee,
        source_action_item=action_item,
    )
    action_item.task_id = task.id
    action_item.save(update_fields=["task_id", "updated_at"])
    return creator, assignee, action_item, task


def _status_activity(*, task, actor, before, after):
    task.status = after
    task.completed_at = (
        timezone.now() if after == models.Task.Status.COMPLETED else None
    )
    task.save(update_fields=["status", "completed_at", "updated_at"])
    return models.TaskActivity.objects.create(
        task=task,
        actor=actor,
        event=models.TaskActivity.Event.STATUS_CHANGED,
        changes={"status": {"from": before, "to": after}},
    )


def test_task_completion_and_reopen_update_confirmed_action_item():
    _creator, assignee, action_item, task = _linked_pair()
    completed = _status_activity(
        task=task,
        actor=assignee,
        before=models.Task.Status.TODO,
        after=models.Task.Status.COMPLETED,
    )

    result = sync_action_item_from_task_status(activity=completed)

    action_item.refresh_from_db()
    completed.refresh_from_db()
    assert result == {
        "action_item_id": str(action_item.id),
        "result": "updated",
        "from": models.ActionItem.Status.CONFIRMED,
        "to": models.ActionItem.Status.COMPLETED,
    }
    assert action_item.status == models.ActionItem.Status.COMPLETED
    assert action_item.is_completed is True
    assert action_item.completed_at == task.completed_at
    assert action_item.task_status_sync_activity == completed
    assert completed.changes["source_action_item_sync"] == result

    reopened = _status_activity(
        task=task,
        actor=assignee,
        before=models.Task.Status.COMPLETED,
        after=models.Task.Status.TODO,
    )
    reopen_result = sync_action_item_from_task_status(activity=reopened)

    action_item.refresh_from_db()
    assert reopen_result["result"] == "updated"
    assert reopen_result["from"] == models.ActionItem.Status.COMPLETED
    assert reopen_result["to"] == models.ActionItem.Status.CONFIRMED
    assert action_item.status == models.ActionItem.Status.CONFIRMED
    assert action_item.is_completed is False
    assert action_item.completed_at is None
    assert action_item.task_status_sync_activity is None


def test_manual_action_item_completion_is_not_reopened_by_task():
    _creator, assignee, action_item, task = _linked_pair(
        action_status=models.ActionItem.Status.COMPLETED
    )
    completed = _status_activity(
        task=task,
        actor=assignee,
        before=models.Task.Status.TODO,
        after=models.Task.Status.COMPLETED,
    )
    completion_result = sync_action_item_from_task_status(activity=completed)
    assert completion_result["result"] == "already_aligned"
    assert completion_result["reason"] == "manual_completion"

    reopened = _status_activity(
        task=task,
        actor=assignee,
        before=models.Task.Status.COMPLETED,
        after=models.Task.Status.TODO,
    )
    reopen_result = sync_action_item_from_task_status(activity=reopened)

    action_item.refresh_from_db()
    assert reopen_result["result"] == "skipped_manual_override"
    assert reopen_result["reason"] == "manual_completion"
    assert action_item.status == models.ActionItem.Status.COMPLETED
    assert action_item.task_status_sync_activity is None


@pytest.mark.parametrize(
    "action_status",
    [models.ActionItem.Status.PROPOSED, models.ActionItem.Status.DISMISSED],
)
def test_task_completion_records_conflict_without_overwriting_manual_status(
    action_status,
):
    _creator, assignee, action_item, task = _linked_pair(action_status=action_status)
    activity = _status_activity(
        task=task,
        actor=assignee,
        before=models.Task.Status.TODO,
        after=models.Task.Status.COMPLETED,
    )

    result = sync_action_item_from_task_status(activity=activity)

    action_item.refresh_from_db()
    assert result == {
        "action_item_id": str(action_item.id),
        "result": "skipped_conflict",
        "from": action_status,
        "to": action_status,
        "reason": "manual_action_item_status",
    }
    assert action_item.status == action_status
    assert action_item.task_status_sync_activity is None
