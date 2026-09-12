"""Task capabilities shared by API enforcement and serialized UI controls."""

from core import models
from core.services.task_assignees import is_task_assignee

EDIT_ROLES = {models.TaskListAccess.Role.OWNER, models.TaskListAccess.Role.EDITOR}


def task_list_role(task_list, user):
    if task_list is None or user is None or not user.is_authenticated:
        return None
    prefetched = getattr(task_list, "_current_user_accesses", None)
    if prefetched is not None:
        role = prefetched[0].role if prefetched else None
    else:
        role = (
            task_list.accesses.filter(user=user).values_list("role", flat=True).first()
        )
    # Legacy lists may predate explicit ownership. A transferred creator must
    # never regain ownership by leaving their new editor role.
    if role != models.TaskListAccess.Role.OWNER and task_list.creator_id == user.id:
        has_owner = getattr(task_list, "_has_owner", None)
        if has_owner is None:
            has_owner = task_list.accesses.filter(
                role=models.TaskListAccess.Role.OWNER
            ).exists()
        if not has_owner:
            return models.TaskListAccess.Role.OWNER
    return role


def can_edit_task_list(task_list, user):
    return task_list_role(task_list, user) in EDIT_ROLES


def can_manage_task(task, user):
    return bool(
        user
        and user.is_authenticated
        and (
            task.creator_id == user.id
            or is_task_assignee(task, user)
            or can_edit_task_list(task.task_list, user)
        )
    )


def can_move_task(task, user):
    if not user or not user.is_authenticated:
        return False
    if task.task_list_id:
        annotated = getattr(task, "_can_edit_task_list", None)
        if annotated is not None:
            return bool(annotated)
        return can_edit_task_list(task.task_list, user)
    return can_manage_task(task, user)


def can_delete_task(task, user):
    if not user or not user.is_authenticated:
        return False
    if task.creator_id == user.id:
        return True
    if not task.task_list_id:
        return False
    annotated = getattr(task, "_is_task_list_owner", None)
    if annotated is not None:
        return bool(annotated)
    return task_list_role(task.task_list, user) == models.TaskListAccess.Role.OWNER


def has_active_task_list_owner(task_list):
    owner_ids = task_list.accesses.filter(
        role=models.TaskListAccess.Role.OWNER
    ).values_list("user_id", flat=True)
    if not owner_ids.exists():
        owner_ids = [task_list.creator_id] if task_list.creator_id else []
    return models.Membership.objects.filter(
        organization_id=task_list.organization_id,
        user_id__in=owner_ids,
        status=models.MembershipStatusChoices.ACTIVE,
        user__is_active=True,
        user__is_device=False,
    ).exists()


def annotate_task_list_owners(queryset):
    """Resolve explicit and legacy owners in SQL, including inactive members."""
    from django.db.models import Exists, OuterRef  # noqa: PLC0415

    owners = models.TaskListAccess.objects.filter(
        task_list_id=OuterRef("pk"), role=models.TaskListAccess.Role.OWNER
    )
    active_members = models.Membership.objects.filter(
        organization_id=OuterRef("organization_id"),
        status=models.MembershipStatusChoices.ACTIVE,
        user__is_active=True,
        user__is_device=False,
    )
    return queryset.annotate(
        _has_owner=Exists(owners),
        _has_active_owner=Exists(
            active_members.filter(
                user__task_list_accesses__task_list_id=OuterRef("pk"),
                user__task_list_accesses__role=models.TaskListAccess.Role.OWNER,
            )
        ),
        _has_active_creator=Exists(
            active_members.filter(user_id=OuterRef("creator_id"))
        ),
    )
