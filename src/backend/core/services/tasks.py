"""Task creation workflows."""

from django.db import transaction
from django.utils import timezone

from core import models
from core.services.task_assignees import set_task_assignees
from core.services.task_history import record_task_created
from core.services.task_notifications import record_task_assignment


class ActionItemTaskConversionError(ValueError):
    """Raised when an action item is not ready to become a task."""


class TaskAssigneeError(ValueError):
    """Raised when a user cannot be assigned by the task creator."""


def task_organization_for_user(user):
    """Resolve the active primary-first organization persisted on new tasks."""

    membership = (
        models.Membership.objects.filter(
            user=user,
            status=models.MembershipStatusChoices.ACTIVE,
        )
        .select_related("organization")
        .order_by("-is_primary", "created_at")
        .first()
    )
    return membership.organization if membership is not None else None


def ensure_task_assignee_allowed(*, creator, assignee):
    """Allow self-assignment or an active colleague from the same directory.

    The organization is resolved with the same primary-first rule as the
    directory API. This keeps raw user ids from becoming a cross-organization
    assignment escape hatch.
    """

    if creator.id == assignee.id:
        return

    creator_membership = (
        models.Membership.objects.filter(
            user=creator,
            status=models.MembershipStatusChoices.ACTIVE,
        )
        .order_by("-is_primary", "created_at")
        .first()
    )
    if creator_membership is None:
        raise TaskAssigneeError("Choose an active member of your organization.")

    is_colleague = (
        models.Membership.objects.filter(
            organization=creator_membership.organization,
            user=assignee,
            status=models.MembershipStatusChoices.ACTIVE,
            is_primary=True,
            user__is_device=False,
            user__sub__isnull=False,
        )
        .exclude(user__sub="")
        .exists()
    )
    if not is_colleague:
        raise TaskAssigneeError("Choose an active member of your organization.")


@transaction.atomic
def create_task_from_action_item(*, action_item_id, creator):
    """Create one durable task from a reviewed action item, idempotently."""

    action_item = models.ActionItem.objects.select_for_update().get(pk=action_item_id)
    existing = models.Task.objects.filter(source_action_item=action_item).first()
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
        organization=task_organization_for_user(creator),
        due_date=(
            timezone.localdate(action_item.due_at)
            if action_item.due_at is not None
            else None
        ),
        source_action_item=action_item,
    )
    set_task_assignees(task, [action_item.assignee])
    action_item.task_id = task.id
    action_item.save(update_fields=["task_id", "updated_at"])
    record_task_created(task=task, actor=creator)
    record_task_assignment(
        task=task,
        event=models.TaskImDelivery.Event.ASSIGNED,
    )
    return task, True
