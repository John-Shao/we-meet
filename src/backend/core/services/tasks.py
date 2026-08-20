"""Task creation workflows."""

from django.db import transaction

from core import models


class ActionItemTaskConversionError(ValueError):
    """Raised when an action item is not ready to become a task."""


@transaction.atomic
def create_task_from_action_item(*, action_item_id, creator):
    """Create one durable task from a reviewed action item, idempotently."""

    action_item = models.ActionItem.objects.select_for_update().get(
        pk=action_item_id
    )
    existing = models.Task.objects.filter(
        source_action_item=action_item
    ).first()
    if existing is not None:
        if action_item.task_id != existing.id:
            action_item.task_id = existing.id
            action_item.save(update_fields=["task_id", "updated_at"])
        return existing, False

    if action_item.status != models.ActionItem.Status.CONFIRMED:
        raise ActionItemTaskConversionError(
            "Only confirmed action items can be converted to tasks."
        )
    if action_item.assignee_id is None:
        raise ActionItemTaskConversionError(
            "Assign the action item before creating a task."
        )

    task = models.Task.objects.create(
        title=action_item.content,
        creator=creator,
        assignee=action_item.assignee,
        due_at=action_item.due_at,
        source_action_item=action_item,
    )
    action_item.task_id = task.id
    action_item.save(update_fields=["task_id", "updated_at"])
    return task, True
