"""Task-to-action-item status synchronization and conflict semantics."""

from django.utils import timezone

import pytest

from core import models
from core.factories import RoomFactory, UserFactory
from core.services.task_action_item_sync import (
    sync_action_item_from_task_status,
    sync_task_from_action_item_status,
)

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


def _source_status_activity(*, action_item, task, actor, before, after):
    action_item.status = after
    action_item.completed_at = (
        timezone.now() if after == models.ActionItem.Status.COMPLETED else None
    )
    action_item.task_status_sync_activity = None
    action_item.save(
        update_fields=[
            "status",
            "completed_at",
            "task_status_sync_activity",
            "is_completed",
            "updated_at",
        ]
    )
    return models.TaskActivity.objects.create(
        task=task,
        actor=actor,
        event=models.TaskActivity.Event.SOURCE_ACTION_ITEM_CHANGED,
        changes={
            "source_action_item": {
                "id": str(action_item.id),
                "status": {"from": before, "to": after},
                "overrode_task_sync": False,
            }
        },
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


def test_action_item_completion_completes_open_task_and_notifies_creator():
    creator, assignee, action_item, task = _linked_pair()
    source_activity = _source_status_activity(
        action_item=action_item,
        task=task,
        actor=assignee,
        before=models.ActionItem.Status.CONFIRMED,
        after=models.ActionItem.Status.COMPLETED,
    )

    result = sync_task_from_action_item_status(activity=source_activity)

    task.refresh_from_db()
    source_activity.refresh_from_db()
    status_activity = models.TaskActivity.objects.get(
        task=task,
        event=models.TaskActivity.Event.STATUS_CHANGED,
    )
    assert task.status == models.Task.Status.COMPLETED
    assert task.completed_at == action_item.completed_at
    assert status_activity.actor == assignee
    assert status_activity.changes == {
        "status": {
            "from": models.Task.Status.TODO,
            "to": models.Task.Status.COMPLETED,
        },
        "source_action_item_origin": {
            "action_item_id": str(action_item.id),
            "activity_id": str(source_activity.id),
        },
    }
    assert result["result"] == "updated"
    assert result["status_activity_id"] == str(status_activity.id)
    assert source_activity.changes["linked_task_sync"] == result
    delivery = models.TaskImDelivery.objects.get(activity=status_activity)
    assert delivery.recipient == creator


def test_action_item_reopen_reopens_completed_task():
    creator, _assignee, action_item, task = _linked_pair(
        action_status=models.ActionItem.Status.COMPLETED
    )
    task.status = models.Task.Status.COMPLETED
    task.completed_at = timezone.now()
    task.save(update_fields=["status", "completed_at", "updated_at"])
    source_activity = _source_status_activity(
        action_item=action_item,
        task=task,
        actor=creator,
        before=models.ActionItem.Status.COMPLETED,
        after=models.ActionItem.Status.CONFIRMED,
    )

    result = sync_task_from_action_item_status(activity=source_activity)

    task.refresh_from_db()
    assert result["result"] == "updated"
    assert result["from"] == models.Task.Status.COMPLETED
    assert result["to"] == models.Task.Status.TODO
    assert task.status == models.Task.Status.TODO
    assert task.completed_at is None


@pytest.mark.parametrize(
    ("action_before", "action_after"),
    [
        (models.ActionItem.Status.CONFIRMED, models.ActionItem.Status.DISMISSED),
        (models.ActionItem.Status.DISMISSED, models.ActionItem.Status.PROPOSED),
    ],
)
def test_unmapped_action_item_status_does_not_change_task(
    action_before,
    action_after,
):
    creator, _assignee, action_item, task = _linked_pair(action_status=action_before)
    source_activity = _source_status_activity(
        action_item=action_item,
        task=task,
        actor=creator,
        before=action_before,
        after=action_after,
    )

    assert sync_task_from_action_item_status(activity=source_activity) is None
    task.refresh_from_db()
    source_activity.refresh_from_db()
    assert task.status == models.Task.Status.TODO
    assert "linked_task_sync" not in source_activity.changes
    assert not models.TaskActivity.objects.filter(
        task=task,
        event=models.TaskActivity.Event.STATUS_CHANGED,
    ).exists()
    assert not models.TaskImDelivery.objects.filter(task=task).exists()


def test_aligned_action_item_completion_does_not_duplicate_task_status_activity():
    creator, _assignee, action_item, task = _linked_pair()
    task.status = models.Task.Status.COMPLETED
    task.completed_at = timezone.now()
    task.save(update_fields=["status", "completed_at", "updated_at"])
    source_activity = _source_status_activity(
        action_item=action_item,
        task=task,
        actor=creator,
        before=models.ActionItem.Status.CONFIRMED,
        after=models.ActionItem.Status.COMPLETED,
    )

    result = sync_task_from_action_item_status(activity=source_activity)

    assert result == {
        "task_id": str(task.id),
        "result": "already_aligned",
        "from": models.Task.Status.COMPLETED,
        "to": models.Task.Status.COMPLETED,
    }
    assert not models.TaskActivity.objects.filter(
        task=task,
        event=models.TaskActivity.Event.STATUS_CHANGED,
    ).exists()
    assert not models.TaskImDelivery.objects.filter(task=task).exists()


def test_reverse_origin_status_activity_does_not_sync_back_to_action_item():
    creator, _assignee, action_item, task = _linked_pair()
    activity = _status_activity(
        task=task,
        actor=creator,
        before=models.Task.Status.TODO,
        after=models.Task.Status.COMPLETED,
    )
    activity.changes["source_action_item_origin"] = {
        "action_item_id": str(action_item.id),
        "activity_id": str(activity.id),
    }
    activity.save(update_fields=["changes", "updated_at"])

    assert sync_action_item_from_task_status(activity=activity) is None
    action_item.refresh_from_db()
    assert action_item.status == models.ActionItem.Status.CONFIRMED
