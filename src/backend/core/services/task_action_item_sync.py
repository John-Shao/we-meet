"""Explainable status synchronization between tasks and meeting action items."""

from django.utils import timezone

from core import models
from core.services.task_notifications import record_task_status_change

SYNC_CHANGE_KEY = "source_action_item_sync"
REVERSE_SYNC_CHANGE_KEY = "linked_task_sync"
SOURCE_ORIGIN_KEY = "source_action_item_origin"


def sync_action_item_from_task_status(*, activity: models.TaskActivity) -> dict | None:
    """Apply a linked task completion/reopen without overriding manual decisions."""

    if activity.event != models.TaskActivity.Event.STATUS_CHANGED:
        raise ValueError("A task status-change activity is required.")
    if SOURCE_ORIGIN_KEY in activity.changes:
        return None

    task = activity.task
    if task.source_action_item_id is None:
        return None

    task_change = activity.changes.get("status", {})
    previous_task_status = task_change.get("from")
    current_task_status = task_change.get("to")
    if current_task_status == models.Task.Status.COMPLETED:
        return _complete_action_item(task=task, activity=activity)
    if (
        previous_task_status == models.Task.Status.COMPLETED
        and current_task_status == models.Task.Status.TODO
    ):
        return _reopen_action_item(task=task, activity=activity)
    return None


def record_manual_action_item_status_change(
    *,
    action_item: models.ActionItem,
    actor,
    previous_status: str,
    overrode_task_sync: bool,
) -> models.TaskActivity | None:
    """Expose a manual source-status decision in the linked task history."""

    task = (
        models.Task.objects.select_for_update(of=("self",))
        .filter(source_action_item=action_item)
        .first()
    )
    if task is None:
        return None
    activity = models.TaskActivity.objects.create(
        task=task,
        actor=actor,
        event=models.TaskActivity.Event.SOURCE_ACTION_ITEM_CHANGED,
        changes={
            "source_action_item": {
                "id": str(action_item.id),
                "status": {
                    "from": previous_status,
                    "to": action_item.status,
                },
                "overrode_task_sync": overrode_task_sync,
            }
        },
    )
    sync_task_from_action_item_status(activity=activity)
    return activity


def sync_task_from_action_item_status(*, activity: models.TaskActivity) -> dict | None:
    """Apply manual completion/reopen decisions to the linked task."""

    if activity.event != models.TaskActivity.Event.SOURCE_ACTION_ITEM_CHANGED:
        raise ValueError("A source action-item change activity is required.")

    source_change = activity.changes.get("source_action_item", {})
    status_change = source_change.get("status", {})
    previous_source_status = status_change.get("from")
    current_source_status = status_change.get("to")
    if current_source_status == models.ActionItem.Status.COMPLETED:
        return _set_task_status_from_action_item(
            source_activity=activity,
            target_status=models.Task.Status.COMPLETED,
        )
    if (
        previous_source_status == models.ActionItem.Status.COMPLETED
        and current_source_status == models.ActionItem.Status.CONFIRMED
    ):
        return _set_task_status_from_action_item(
            source_activity=activity,
            target_status=models.Task.Status.TODO,
        )
    return None


def _set_task_status_from_action_item(
    *,
    source_activity: models.TaskActivity,
    target_status: str,
) -> dict:
    task = (
        models.Task.objects.select_for_update(of=("self",))
        .select_related("source_action_item")
        .get(pk=source_activity.task_id)
    )
    previous_status = task.status

    if (
        target_status == models.Task.Status.TODO
        and previous_status == models.Task.Status.TODO
    ):
        return _record_reverse_sync_result(
            source_activity=source_activity,
            task=task,
            result="already_aligned",
            previous_status=previous_status,
        )

    if previous_status == target_status:
        return _record_reverse_sync_result(
            source_activity=source_activity,
            task=task,
            result="already_aligned",
            previous_status=previous_status,
        )

    if (
        target_status == models.Task.Status.COMPLETED
        and previous_status != models.Task.Status.TODO
    ):
        return _record_reverse_sync_result(
            source_activity=source_activity,
            task=task,
            result="skipped_conflict",
            previous_status=previous_status,
            reason="task_status_not_open",
        )
    if (
        target_status == models.Task.Status.TODO
        and previous_status != models.Task.Status.COMPLETED
    ):
        return _record_reverse_sync_result(
            source_activity=source_activity,
            task=task,
            result="skipped_conflict",
            previous_status=previous_status,
            reason="task_status_not_completed",
        )

    task.status = target_status
    task.completed_at = (
        task.source_action_item.completed_at or timezone.now()
        if target_status == models.Task.Status.COMPLETED
        else None
    )
    task.save(update_fields=["status", "completed_at", "updated_at"])
    status_activity = models.TaskActivity.objects.create(
        task=task,
        actor=source_activity.actor,
        event=models.TaskActivity.Event.STATUS_CHANGED,
        changes={
            "status": {"from": previous_status, "to": task.status},
            SOURCE_ORIGIN_KEY: {
                "action_item_id": str(task.source_action_item_id),
                "activity_id": str(source_activity.id),
            },
        },
    )
    result = _record_reverse_sync_result(
        source_activity=source_activity,
        task=task,
        result="updated",
        previous_status=previous_status,
        status_activity=status_activity,
    )
    record_task_status_change(activity=status_activity)
    return result


def _record_reverse_sync_result(  # noqa: PLR0913
    *,
    source_activity: models.TaskActivity,
    task: models.Task,
    result: str,
    previous_status: str,
    reason: str = "",
    status_activity: models.TaskActivity | None = None,
) -> dict:
    payload = {
        "task_id": str(task.id),
        "result": result,
        "from": previous_status,
        "to": task.status,
    }
    if reason:
        payload["reason"] = reason
    if status_activity is not None:
        payload["status_activity_id"] = str(status_activity.id)
    source_activity.changes = {
        **source_activity.changes,
        REVERSE_SYNC_CHANGE_KEY: payload,
    }
    source_activity.save(update_fields=["changes", "updated_at"])
    return payload


def _complete_action_item(*, task: models.Task, activity: models.TaskActivity) -> dict:
    action_item = models.ActionItem.objects.select_for_update().get(
        pk=task.source_action_item_id
    )
    previous_status = action_item.status
    if previous_status == models.ActionItem.Status.CONFIRMED:
        action_item.status = models.ActionItem.Status.COMPLETED
        action_item.completed_at = task.completed_at or timezone.now()
        action_item.task_status_sync_activity = activity
        action_item.save(
            update_fields=[
                "status",
                "completed_at",
                "task_status_sync_activity",
                "is_completed",
                "updated_at",
            ]
        )
        return _record_sync_result(
            activity=activity,
            action_item=action_item,
            result="updated",
            previous_status=previous_status,
        )

    if previous_status == models.ActionItem.Status.COMPLETED:
        return _record_sync_result(
            activity=activity,
            action_item=action_item,
            result="already_aligned",
            previous_status=previous_status,
            reason=(
                "task_managed_completion"
                if action_item.task_status_sync_activity_id is not None
                else "manual_completion"
            ),
        )

    _clear_stale_sync_activity(action_item)
    return _record_sync_result(
        activity=activity,
        action_item=action_item,
        result="skipped_conflict",
        previous_status=previous_status,
        reason="manual_action_item_status",
    )


def _reopen_action_item(*, task: models.Task, activity: models.TaskActivity) -> dict:
    action_item = models.ActionItem.objects.select_for_update().get(
        pk=task.source_action_item_id
    )
    previous_status = action_item.status
    if (
        previous_status == models.ActionItem.Status.COMPLETED
        and action_item.task_status_sync_activity_id is not None
    ):
        action_item.status = models.ActionItem.Status.CONFIRMED
        action_item.completed_at = None
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
        return _record_sync_result(
            activity=activity,
            action_item=action_item,
            result="updated",
            previous_status=previous_status,
        )

    if previous_status == models.ActionItem.Status.CONFIRMED:
        _clear_stale_sync_activity(action_item)
        return _record_sync_result(
            activity=activity,
            action_item=action_item,
            result="already_aligned",
            previous_status=previous_status,
        )

    if previous_status == models.ActionItem.Status.COMPLETED:
        return _record_sync_result(
            activity=activity,
            action_item=action_item,
            result="skipped_manual_override",
            previous_status=previous_status,
            reason="manual_completion",
        )

    _clear_stale_sync_activity(action_item)
    return _record_sync_result(
        activity=activity,
        action_item=action_item,
        result="skipped_conflict",
        previous_status=previous_status,
        reason="manual_action_item_status",
    )


def _clear_stale_sync_activity(action_item: models.ActionItem) -> None:
    if action_item.task_status_sync_activity_id is None:
        return
    action_item.task_status_sync_activity = None
    action_item.save(update_fields=["task_status_sync_activity", "updated_at"])


def _record_sync_result(
    *,
    activity: models.TaskActivity,
    action_item: models.ActionItem,
    result: str,
    previous_status: str,
    reason: str = "",
) -> dict:
    payload = {
        "action_item_id": str(action_item.id),
        "result": result,
        "from": previous_status,
        "to": action_item.status,
    }
    if reason:
        payload["reason"] = reason
    activity.changes = {**activity.changes, SYNC_CHANGE_KEY: payload}
    activity.save(update_fields=["changes", "updated_at"])
    return payload
